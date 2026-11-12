import type { Page } from 'playwright';
import type { Finding } from '../audit-link/index.ts';
import type { C2Input, C2Output } from '../agents/types.ts';
import type { Config } from '../config/index.ts';
import { buildComponentCatalog } from '../ds/catalog.ts';
import type { LlmClient } from '../llm/client.ts';
import { serializeSnapshotDom } from '../html/snapshot-dom.ts';
import { extractComputedStyle, EXTRACTED_PROPERTIES } from '../t-layer/computed-style.ts';
import { findCandidateElements, type LiveCandidate } from './candidates.ts';
import { classifyDeterministic, evaluateChecks, iou, textCheck } from './objective-checks.ts';
import { classifyDrift } from './drift.ts';
import { findReusablePick, signatureOf, type PickSignature } from './reuse.ts';
import { resolveDsReference } from './ds-reference.ts';
import { MAPPING_SYSTEM_PROMPT, MAX_MAPPED_PER_CALL, MappingProposalSchema, type MappingProposal } from './model-schema.ts';
import { labelKey, mapByTextIdentity } from './text-identity.ts';
import { affordancesOf, bestCandidateFor, landmarkSaysGlobal, locateAndStampSectionWrapper, locateSectionByHeading, stampElementDetailed, type StampFailure } from './stamp.ts';
import type { MappingConflict, MappingEntry, MappingResult, UnmappedFinding } from './types.ts';

/**
 * C2 — Element Mapper (§6.4). Deterministic objective checks first; the model proposes among
 * ALREADY-PASSING candidates for the `needs-model` remainder, in ONE batched call — never one
 * call per finding, and its output is never itself an authorization (§6.4's closing rule).
 */

export interface C2Deps {
  llm: LlmClient;
  config: Pick<Config, 'mapping' | 'plausibilityBar' | 'anthropicModel'>;
  log?: (line: string) => void;
  /** This run's earlier model picks (findingId → signature of the chosen element), so a resume does not ask the same judgment again. */
  picks?: { read: () => Promise<Record<string, PickSignature | null>>; write: (picks: Record<string, PickSignature | null>) => Promise<void> };
}

function evidenceBox(finding: Finding) {
  const ref = finding.quality.evidence.find((e) => e.kind === 'element-screenshot' && e.box);
  return ref?.box ?? null;
}

function auditSignals(finding: Finding) {
  const signals = finding.review?.signals ?? [];
  const tag = signals.find((s) => s.startsWith('tag='))?.slice(4) ?? null;
  const role = signals.find((s) => s.startsWith('role='))?.slice(5) ?? null;
  const classes = signals.filter((s) => s.startsWith('class=')).map((s) => s.slice(6));
  return { tag, role, classes };
}

const MAX_RELOCATE_ATTEMPTS = 2;

async function stampWinner(page: Page, candidate: LiveCandidate, finding: Finding, allocateId: () => Promise<string>) {
  return stampElementDetailed(page, candidate, { elementId: await allocateId(), findingId: finding.identity.findingId, signature: finding.component.signature, instanceIndex: null, productionType: finding.component.productionType });
}

function sameIdentity(a: LiveCandidate, b: LiveCandidate): boolean {
  return a.tagName === b.tagName && a.text === b.text && a.classes.join(' ') === b.classes.join(' ');
}

function boxesCorrespond(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 && inter / union >= 0.5;
}

function unresolvedReason(reason: StampFailure | null, attempts: number): string {
  const tried = attempts > 1 ? ` (re-located ${attempts - 1} time(s))` : '';
  switch (reason) {
    case 'off-screen': return `the winning candidate could not be brought into view to stamp${tried}`;
    case 'no-element-at-box': return `the winning candidate could not be re-located on the live page to stamp — occluded by another element at that point, or no longer rendered${tried}`;
    case 'identity-mismatch': return `the element at the winning candidate's position is a different element (other tag or text) — the candidate is hidden, off-screen or replaced (e.g. a carousel slide or collapsed menu), so it was not stamped${tried}`;
    case 'owned-by-other-element': return `the element at that position is already stamped for other findings and is not this finding's element — not merged${tried}`;
    case 'stamp-not-unique': return `the stamp could not be made unique on the live page (duplicate or vanished element) — rolled back${tried}`;
    default: return `the winning candidate could not be stamped${tried}`;
  }
}

interface FindingResolution {
  finding: Finding;
  candidates: LiveCandidate[];
  passing: LiveCandidate[];
  state: 'confirmed' | 'needs-model' | 'absent';
}

export async function runC2(deps: C2Deps, input: C2Input): Promise<C2Output> {
  const log = deps.log ?? (() => {});
  const { r1, session } = input;
  const page = session.page;
  const catalog = buildComponentCatalog(r1.registry);
  const pageFindings = r1.findings.filter((f) => f.location.url === r1.targetUrl);
  log(`C2 · mapping ${pageFindings.length} finding(s) on this page`);

  // 1. Objective checks per finding. (The capture fingerprint is R2's job, §8.6 — already on `session`.)
  const resolutions: FindingResolution[] = [];
  const unmapped: UnmappedFinding[] = [];
  const noBox: Finding[] = [];
  for (const finding of pageFindings) {
    const box = evidenceBox(finding);
    if (!box) {
      unmapped.push({ findingId: finding.identity.findingId, reason: 'no element-screenshot evidence box recorded by the audit', candidatesConsidered: 0 });
      noBox.push(finding);
      continue;
    }
    const candidates = await findCandidateElements(page, box);
    const { tag, role, classes } = auditSignals(finding);
    const scored = candidates.map((c) => ({
      candidate: c,
      checks: evaluateChecks({
        auditBox: box,
        liveBox: c.box,
        iouFloor: deps.config.mapping.iouFloor,
        text: { auditText: finding.component.productionLabel, liveText: c.text, floor: deps.config.mapping.textSimilarityFloor },
        identity: { auditTagName: tag, liveTagName: c.tagName, auditRole: role, liveRole: c.role },
        classes: { auditClasses: classes, liveClasses: c.classes },
      }),
    }));
    const passing = scored.filter((s) => s.checks.passedCount >= 2).map((s) => s.candidate);
    const state = classifyDeterministic(scored.map((s) => s.checks.passedCount));
    resolutions.push({ finding, candidates, passing, state });
    if (state === 'absent') unmapped.push({ findingId: finding.identity.findingId, reason: candidates.length === 0 ? 'no live element found near the evidence box' : 'no candidate passed at least two objective checks', candidatesConsidered: candidates.length });
  }

  // 2b. Text-identity fallback: a finding whose evidence box found no candidate is paired with the live element that carries exactly its text, but only
  // when that pairing is unambiguous (see text-identity.ts). Everything else stays unmapped with its reason.
  const byText = new Set<string>();
  {
    const absent = resolutions.filter((r) => r.state === 'absent');
    for (const f of noBox) { const r: FindingResolution = { finding: f, candidates: [], passing: [], state: 'absent' }; absent.push(r); resolutions.push(r); }
    if (absent.length > 0) {
      const takenBoxes = resolutions.filter((r) => r.state !== 'absent' && r.passing[0]).map((r) => r.passing[0]!.box);
      const matches = await mapByTextIdentity(
        page,
        absent.map((r) => ({ findingId: r.finding.identity.findingId, label: r.finding.component.productionLabel, type: r.finding.component.productionType, auditBox: evidenceBox(r.finding) })),
        (c) => takenBoxes.some((b) => iou(b, c.box) >= 0.9),
        log,
      );
      for (const m of matches) {
        const r = absent.find((x) => x.finding.identity.findingId === m.findingId)!;
        r.state = 'confirmed';
        r.candidates = [m.candidate];
        r.passing = [m.candidate];
        byText.add(m.findingId);
        const at = unmapped.findIndex((u) => u.findingId === m.findingId);
        if (at >= 0) unmapped.splice(at, 1);
      }
      for (const f of noBox) { const at = resolutions.findIndex((r) => r.finding === f && r.state === 'absent'); if (at >= 0) resolutions.splice(at, 1); } // still unmapped (already listed above)
      if (matches.length > 0) log(`C2 · ${matches.length} finding(s) placed by exact text identity (no geometry match; unambiguous pairing only)`);
    }
  }

  // 3. Batch the `needs-model` remainder into as few calls as the chunk bound allows.
  const needsModel = resolutions.filter((r) => r.state === 'needs-model');
  const proposalsByFindingId = new Map<string, MappingProposal['proposals'][number]>();
  let usage: C2Output['mapping'] extends infer U ? (U extends { usage: infer X } ? X : never) : never = null as any;
  const priorPicks = deps.picks ? await deps.picks.read() : {};
  const newPicks: Record<string, PickSignature | null> = {};
  // a finding whose earlier pick is still among the passing candidates is not asked again
  const reused = new Set<string>();
  for (const r of needsModel) {
    const fid = r.finding.identity.findingId;
    // an earlier "none of these" answer stays "none of these": the finding is left unmapped, never guessed
    if (priorPicks[fid] === null) {
      reused.add(fid);
      proposalsByFindingId.set(fid, { findingId: fid, selectedCandidateId: null, confidence: 0.4, reasoning: 'Reused this run\'s earlier answer: none of the candidates was clearly the right element.' });
      continue;
    }
    const hit = findReusablePick(r.passing, priorPicks[fid] ?? undefined);
    if (hit) {
      reused.add(r.finding.identity.findingId);
      proposalsByFindingId.set(r.finding.identity.findingId, { findingId: r.finding.identity.findingId, selectedCandidateId: hit.candidateId, confidence: 0.8, reasoning: 'Reused this run\'s earlier pick: the same element (tag, classes, text) is still among the objectively passing candidates.' });
    }
  }
  if (reused.size > 0) log(`C2 · reused ${reused.size} earlier pick(s) of this run (same element still among the passing candidates)`);
  const toAsk = needsModel.filter((r) => !reused.has(r.finding.identity.findingId));
  if (toAsk.length > 0) {
    log(`C2 · ${toAsk.length} finding(s) need a model proposal among passing candidates`);
    for (let i = 0; i < toAsk.length; i += MAX_MAPPED_PER_CALL) {
      const chunk = toAsk.slice(i, i + MAX_MAPPED_PER_CALL);
      const prompt = chunk
        .map((r) => {
          const cands = r.passing.map((c) => `  - candidateId=${c.candidateId} tag=${c.tagName} role=${c.role ?? ''} text="${c.text.slice(0, 80)}" classes=[${c.classes.slice(0, 6).join(' ')}]`).join('\n');
          return `findingId=${r.finding.identity.findingId}\nsection="${r.finding.location.section}" type=${r.finding.component.productionType} label="${r.finding.component.productionLabel}"\ncandidates:\n${cands}`;
        })
        .join('\n\n');
      const res = await deps.llm.structured({
        nodeId: 'C2',
        system: MAPPING_SYSTEM_PROMPT,
        prompt: `Resolve each finding below to exactly one of its own offered candidateIds, or null.\n\n${prompt}`,
        schema: MappingProposalSchema,
        effort: 'medium',
      });
      usage = res.usage as any;
      for (const p of res.data.proposals) proposalsByFindingId.set(p.findingId, p);
    }
  }

  // 4. Assign confidence classes and stamp. §6.4's two prohibitions apply throughout: nothing
  // here ever treats an audit evidence box as the live page, and no findingId is ever read
  // back from the DOM — data-fra-* is written HERE, as the result of mapping.
  const entries: MappingEntry[] = [];
  const conflicts: MappingConflict[] = [];
  let nextIdNumber = 1;
  // The next id not used by any entry or any stamp in the DOM; only consumed when a NEW stamp lands.
  const allocateId = async (): Promise<string> => {
    for (;;) {
      const id = `e${nextIdNumber}`;
      if (!entries.some((e) => e.element === id) && (await page.locator(`[data-fra-element="${id}"]`).count()) === 0) return id;
      nextIdNumber++;
    }
  };
  const registryVersion = r1.registry.version.dsRegistryVersion;
  const auditRegistryVersion = pageFindings[0]?.identity.dsRegistryVersion ?? registryVersion;

  for (const res of resolutions) {
    const finding = res.finding;
    let confidence: 'confirmed' | 'probable' | 'ambiguous' = 'confirmed';
    let winner: LiveCandidate | null = null;
    let method: 'objective' | 'objective+model' | 'text-identity' = byText.has(finding.identity.findingId) ? 'text-identity' : 'objective';
    let candidatesConsidered = res.candidates.length;

    if (res.state === 'confirmed') {
      winner = res.passing[0] ?? null;
      if (method === 'text-identity') confidence = 'probable'; // exact text, not an objective geometry/identity confirmation
    } else if (res.state === 'needs-model') {
      method = 'objective+model';
      const proposal = proposalsByFindingId.get(finding.identity.findingId);
      const picked = proposal?.selectedCandidateId ? res.passing.find((c) => c.candidateId === proposal.selectedCandidateId) : null;
      if (picked) {
        confidence = 'probable';
        winner = picked;
        newPicks[finding.identity.findingId] = signatureOf(picked);
      } else {
        confidence = 'ambiguous';
        if (proposal) newPicks[finding.identity.findingId] = null;
      }
    } else {
      continue; // 'absent' — already recorded in `unmapped`
    }

    if (!winner && res.state === 'needs-model' && ['link', 'button', 'nav-link'].includes(finding.component.productionType)) {
      // a link/button finding whose passing candidates hold exactly ONE interactive element (a/button) carrying exactly its label: that is the element
      const key = labelKey(finding.component.productionLabel);
      const exact = res.passing.filter((c) => (c.tagName === 'a' || c.tagName === 'button' || c.role === 'button') && labelKey(c.text) === key);
      if (key.length >= 3 && exact.length === 1) { winner = exact[0]!; method = 'text-identity'; confidence = 'probable'; }
    }

    if (!winner) {
      unmapped.push({ findingId: finding.identity.findingId, reason: `mapping stayed ambiguous after the model proposal — ${res.passing.length} candidates still passed objectively`, candidatesConsidered });
      continue;
    }

    // Stamp with identity + uniqueness guarantees, re-locating the winner a bounded number of
    // times (a carousel/re-render can move or replace it between discovery and stamping). Ids
    // come from a monotonic counter that never reuses one and skips any id already in the DOM.
    const evBox = evidenceBox(finding);
    let current: LiveCandidate = winner;
    let outcome = await stampWinner(page, bestCandidateFor(res.candidates, current.box) ?? current, finding, allocateId);
    let attempts = 1;
    while (!outcome.stamped && attempts <= MAX_RELOCATE_ATTEMPTS && evBox && outcome.reason !== 'owned-by-other-element') {
      const fresh = (await findCandidateElements(page, evBox)).find((c) => sameIdentity(c, current) && boxesCorrespond(c.box, current.box));
      if (!fresh) break;
      current = fresh;
      outcome = await stampWinner(page, fresh, finding, allocateId);
      attempts++;
    }
    if (!outcome.stamped || !outcome.elementId) {
      unmapped.push({ findingId: finding.identity.findingId, reason: unresolvedReason(outcome.reason, attempts), candidatesConsidered });
      continue;
    }
    winner = current;
    const elementId = outcome.elementId;
    if (!outcome.merged) nextIdNumber++;
    const existingElementId = outcome.merged ? elementId : null;

    // Style deltas: re-measure every mismatched property the audit named, so drift can tell
    // "the audit's actual is now different" from "the live page just confirms what was found".
    // The stamp is verified to resolve to exactly one element first, so this can never sit in a
    // Playwright auto-wait on an id that does not exist.
    const stampLocator = page.locator(`[data-fra-element="${elementId}"]`);
    const style = (await stampLocator.count()) === 1 ? await extractComputedStyle(stampLocator.first()) : ({ connected: false } as const);
    const styleComparisons = style.connected
      ? finding.comparison.mismatches
          .filter((m) => (EXTRACTED_PROPERTIES as readonly string[]).includes(m.property))
          .map((m) => ({ property: m.property, auditActual: m.actual, liveActual: style.raw[m.property] ?? '' }))
      : [];

    const dsReference = await resolveDsReference(r1.registry, catalog, finding, deps.config.plausibilityBar);
    if (dsReference.dsComponent && registryVersion !== auditRegistryVersion) {
      conflicts.push({
        kind: 'expectation-changed',
        findingIds: [finding.identity.findingId],
        description: `The Design System changed between the audit (${auditRegistryVersion.slice(0, 12)}…) and this build (${registryVersion.slice(0, 12)}…) — this finding's expected value may have moved.`,
        requiresAcknowledgement: true,
      });
    }
    // §6.1: "a DS component ... referenced by a finding no longer exists" is never silently
    // downgraded to "never had a match" — the audit DID record one; recording this loudly is
    // what lets R6's manifest and a human at G2 tell the two cases apart, even though R3
    // already falls back correctly (a finding with an independent measured mismatch or rule
    // violation is still fixable on that basis alone; one relying purely on the vanished DS
    // match becomes unaddressed via its own existing no-basis check).
    if (finding.component.dsComponent && !dsReference.dsComponent) {
      conflicts.push({
        kind: 'ds-target-missing',
        findingIds: [finding.identity.findingId],
        description: `The audit matched this finding to DS component "${finding.component.dsComponent}", but that component no longer resolves in the current Design System catalog — never substituted; any fix here must rest on an independent measured mismatch or rule violation, not this vanished match.`,
        requiresAcknowledgement: false,
      });
    }

    const auditedText = finding.component.productionLabel;
    // §6.5's 'content-changed' class: the live winner's text genuinely doesn't match what the
    // audit recorded (beyond the same similarity floor the objective checks use) — not merely
    // "some candidates existed", which is what the dead expression this replaces always
    // evaluated to `false` for regardless of input (a no-op that made 'content-changed' fire
    // only via the separate empty-text special case, never for a real but different-text drift).
    const contentLooksChanged = !textCheck({ auditText: auditedText, liveText: winner.text, floor: deps.config.mapping.textSimilarityFloor });
    const drift = classifyDrift({
      confidence: existingElementId ? 'confirmed' : confidence,
      auditBox: evidenceBox(finding),
      liveBox: winner.box,
      styleComparisons,
      contentLooksChanged,
    });

    if (existingElementId) {
      const existing = entries.find((e) => e.element === elementId);
      if (existing && !existing.findingIds.includes(finding.identity.findingId)) existing.findingIds.push(finding.identity.findingId);
      continue;
    }

    entries.push({
      element: elementId,
      stamp: elementId,
      findingIds: [finding.identity.findingId],
      signature: finding.component.signature,
      instanceIndex: null,
      instanceCount: null,
      sectionId: null, // filled in the section pass below
      scope: 'content',
      resolution: { method, confidence, checks: evaluateChecks({ auditBox: evidenceBox(finding) ?? winner.box, liveBox: winner.box, iouFloor: deps.config.mapping.iouFloor, text: { auditText: auditedText, liveText: winner.text, floor: deps.config.mapping.textSimilarityFloor }, identity: { auditTagName: auditSignals(finding).tag, liveTagName: winner.tagName, auditRole: auditSignals(finding).role, liveRole: winner.role }, classes: { auditClasses: auditSignals(finding).classes, liveClasses: winner.classes } }), candidatesConsidered },
      drift,
      affordances: affordancesOf(winner),
      dsReference,
    });
  }

  // 5. instanceCount per signature, now that every entry exists.
  const bySignature = new Map<string, number>();
  for (const e of entries) if (e.signature) bySignature.set(e.signature, (bySignature.get(e.signature) ?? 0) + e.findingIds.length);
  for (const e of entries) if (e.signature) e.instanceCount = bySignature.get(e.signature) ?? null;
  const seenSignature = new Map<string, number>();
  for (const e of entries.sort((a, b) => (a.drift.liveBox?.y ?? 0) - (b.drift.liveBox?.y ?? 0))) {
    if (!e.signature) continue;
    const n = (seenSignature.get(e.signature) ?? 0) + 1;
    seenSignature.set(e.signature, n);
    e.instanceIndex = n;
  }

  // 6. Section wrappers — every distinct `location.section` among the page's findings, global
  // sections identified by name AND cross-checked against live landmarks (§8.2, §8.3).
  const sectionNames = new Map<string, string[]>(); // name -> elementIds
  for (const f of pageFindings) {
    const mapped = entries.find((e) => e.findingIds.includes(f.identity.findingId));
    if (!mapped) continue;
    const list = sectionNames.get(f.location.section) ?? [];
    list.push(mapped.element);
    sectionNames.set(f.location.section, list);
  }
  const usedSectionIds = new Set<string>();
  for (const [name, elementIds] of sectionNames) {
    const globalByName = ['header', 'footer'].includes(name.trim().toLowerCase());
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    let sectionId = base;
    let n = 2;
    while (usedSectionIds.has(sectionId)) sectionId = `${base}-${n++}`;
    usedSectionIds.add(sectionId);

    const landmark = await landmarkSaysGlobal(page, elementIds[0]!);
    const isGlobal = globalByName || landmark === 'banner' || landmark === 'contentinfo' || landmark === 'nav-in-banner';
    if (globalByName !== (landmark === 'banner' || landmark === 'contentinfo')) {
      // §8.2: name vs. landmark disagreement — recorded, shown at G1, never silently picked.
      conflicts.push({ kind: 'expectation-changed', findingIds: elementIds.flatMap((id) => entries.find((e) => e.element === id)?.findingIds ?? []), description: `Section "${name}" is named ${globalByName ? '' : 'NOT '}global by the audit but its live wrapper ${landmark ? `looks like a ${landmark} landmark` : 'matches no banner/contentinfo landmark'} — using the name-based classification.`, requiresAcknowledgement: true });
    }
    const scope = isGlobal ? 'excluded' : 'content';
    const foreignMemberIds = [...sectionNames].filter(([other]) => other !== name).flatMap(([, ids]) => ids);
    let wrapper = await locateAndStampSectionWrapper(page, sectionId, scope, elementIds, foreignMemberIds);
    if (!wrapper.located && !isGlobal) {
      // its mapped elements share no wrapper (they sit in another section's markup): the section's own heading still names it
      const byHeading = await locateSectionByHeading(page, sectionId, name, scope, foreignMemberIds);
      if (byHeading.located) {
        log(`C2 · section "${name}": the mapped elements have no wrapper of their own; wrapper found from its heading "${byHeading.headingText ?? ''}" (<${byHeading.tagName}>)`);
        wrapper = byHeading;
      }
    }
    if (!wrapper.located) {
      conflicts.push({ kind: 'expectation-changed', findingIds: elementIds.flatMap((id) => entries.find((e) => e.element === id)?.findingIds ?? []), description: `Section "${name}" has no wrapper of its own on the live page${wrapper.conflictWith ? ` (the only candidate already belongs to section "${wrapper.conflictWith}")` : wrapper.documentRoot ? ' (its elements share no ancestor below <body>, which would contain every other section)' : ''} — it cannot be exported as a section.`, requiresAcknowledgement: true });
    }
    if (wrapper.outliers?.length) {
      conflicts.push({ kind: 'expectation-changed', findingIds: wrapper.outliers.flatMap((id) => entries.find((e) => e.element === id)?.findingIds ?? []), description: `Section "${name}": ${wrapper.outliers.length} of its ${elementIds.length} audit element(s) (${wrapper.outliers.join(', ')}) are rendered inside ANOTHER section's markup on the live page; the section's wrapper holds the rest, and those elements stay with the section they are rendered in.`, requiresAcknowledgement: false });
    }
    for (const id of elementIds) {
      const e = entries.find((x) => x.element === id);
      if (e) {
        e.sectionId = sectionId;
        e.scope = scope;
      }
    }
  }

  // 6b. A section with findings but NO mapped finding has no member for a wrapper. Look for it by its heading, so its content is still rendered (its findings stay unmapped).
  for (const name of new Set(pageFindings.map((f) => f.location.section))) {
    if (sectionNames.has(name) || ['header', 'footer'].includes(name.trim().toLowerCase())) continue;
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    let sectionId = base;
    let n = 2;
    while (usedSectionIds.has(sectionId)) sectionId = `${base}-${n++}`;
    const foreignMemberIds = entries.map((e) => e.element);
    const wrapper = await locateSectionByHeading(page, sectionId, name, 'content', foreignMemberIds);
    if (wrapper.located) {
      usedSectionIds.add(sectionId);
      log(`C2 · section "${name}": no finding was mapped, wrapper found from its heading "${wrapper.headingText ?? ''}" (<${wrapper.tagName}>)`);
      conflicts.push({ kind: 'expectation-changed', findingIds: pageFindings.filter((f) => f.location.section === name).map((f) => f.identity.findingId), description: `Section "${name}": none of its ${pageFindings.filter((f) => f.location.section === name).length} finding(s) could be mapped to a live element, so its wrapper was located from its heading; the section's content is rendered, its findings stay unmapped (not fixed).`, requiresAcknowledgement: false });
    }
  }

  // 7. Serialize the whole document, stamps and all, before any edit (§6.2, §8.5's original.html).
  // Mapping scrolled the page around, and scroll-driven pages keep the style of the LAST scroll offset (the hero card stack froze at
  // translateY(-350px) instead of its +20px start). Return to the top and let the page settle so the snapshot is the page as it first appears.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
  const originalHtml = await serializeSnapshotDom(page);

  if (deps.picks && Object.keys(newPicks).length > 0) await deps.picks.write({ ...priorPicks, ...newPicks });
  for (const u of unmapped) {
    const f = pageFindings.find((p) => p.identity.findingId === u.findingId);
    if (f && /^read more$/i.test(f.component.productionLabel.trim())) log(`C2 · "${f.component.productionLabel}" left unmapped: ${u.reason}`);
  }
  const mapping: MappingResult = { entries, unmapped, conflicts, usage };
  return { ...session, originalHtml, mapping };
}
