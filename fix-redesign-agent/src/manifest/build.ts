import type { Finding } from '../audit-link/index.ts';
import type { R6Input } from '../agents/types.ts';
import type { MappingEntry } from '../mapping/types.ts';
import { findCrossRunSightings, type CrossRunMatchInput } from './cross-run.ts';
import { classifyMismatches, suggestBucket } from './suggest.ts';
import type { ComponentManifest, ManifestComponent, ManifestSection } from './schema.ts';

function classesOf(f: Finding): string[] {
  return (f.review?.signals ?? []).filter((s) => s.startsWith('class=')).map((s) => s.slice(6));
}

/**
 * R6 — Component Review (deterministic, §8.6). The manifest over EVERY detected component on
 * this page, changed or not (Decision Log #16) — runs even when the page verdict is PARTIAL
 * or FAIL, since its inputs (findings, mapping, other runs, the catalog) are independent of it.
 */
export async function buildComponentManifest(deps: { auditAgentRepoRoot: string; plausibilityBar: number; otherRunDataJsonPaths: string[] }, input: R6Input): Promise<ComponentManifest> {
  const { r1, session, iterations } = input;
  const mapping = session.mapping!;
  const pageFindings = r1.findings.filter((f) => f.location.url === r1.targetUrl);
  const auditDsRegistryVersion = pageFindings[0]?.identity.dsRegistryVersion ?? r1.registry.version.dsRegistryVersion;
  const fixPlanByFinding = new Map(r1.fixEntries.map((e) => [e.findingId, e] as const));
  const bySignatureCount = new Map<string, number>();
  for (const f of pageFindings) bySignatureCount.set(f.component.signature, (bySignatureCount.get(f.component.signature) ?? 0) + 1);

  const lastValidation = iterations.at(-1)?.validation ?? null;
  const appliedByFinding = new Map<string, { applied: boolean; matched: number }>();
  for (const it of iterations) for (const a of it.applied.applied) if (a.applied) appliedByFinding.set(a.edit.findingId, { applied: true, matched: a.matched });
  const verifiedByFinding = new Map<string, boolean>();
  if (lastValidation) for (const c of lastValidation.checks) verifiedByFinding.set(c.findingId, c.fixed);

  const components: ManifestComponent[] = [];
  const sectionMembers = new Map<string, string[]>();

  for (const finding of pageFindings) {
    const entry: MappingEntry | undefined = mapping.entries.find((e) => e.findingIds.includes(finding.identity.findingId));
    const signature = finding.component.signature;
    const instanceCount = bySignatureCount.get(signature) ?? 1;
    const relatedFindingIds = pageFindings.filter((f) => f.component.signature === signature && f.identity.findingId !== finding.identity.findingId).map((f) => f.identity.findingId);

    const target: CrossRunMatchInput = { productionType: finding.component.productionType, dsComponent: finding.component.dsComponent, dsVariant: finding.component.dsVariant, classes: classesOf(finding), normalizedLabel: finding.component.productionLabel.trim().toLowerCase() };
    const sightings = deps.otherRunDataJsonPaths.length > 0 ? await findCrossRunSightings(deps.otherRunDataJsonPaths, target) : [];
    const reuse: ManifestComponent['crossRun']['reuse'] = sightings.length > 0 ? 'multi-page' : instanceCount >= 2 ? 'repeated-on-page' : 'single';

    const verified = verifiedByFinding.get(finding.identity.findingId) ?? false;
    const suggestion = suggestBucket({ finding, instanceCount, verified, plausibilityBar: deps.plausibilityBar, reuse });

    const sectionId = entry?.sectionId ?? null;
    if (sectionId) sectionMembers.set(sectionId, [...(sectionMembers.get(sectionId) ?? []), finding.identity.findingId]);

    const appliedInfo = appliedByFinding.get(finding.identity.findingId);
    const swapEdit = iterations.flatMap((it) => it.applied.applied).find((a) => a.edit.findingId === finding.identity.findingId && a.edit.kind === 'component-swap' && a.applied);

    components.push({
      findingId: finding.identity.findingId,
      signature,
      instanceIndex: entry?.instanceIndex ?? null,
      instanceCount,
      relatedFindingIds,
      sectionId,
      sectionName: finding.location.section,
      scope: entry?.scope ?? 'content',
      productionType: finding.component.productionType,
      productionLabel: finding.component.productionLabel,
      auditClassification: finding.classification,
      severity: finding.quality.severity,
      ds: {
        dsComponent: entry?.dsReference.dsComponent ?? finding.component.dsComponent,
        dsVariant: entry?.dsReference.dsVariant ?? finding.component.dsVariant,
        dsFile: entry?.dsReference.dsFile ?? null,
        possibleMatches: finding.review?.possibleMatches ?? [],
        registryUpdateRef: finding.action.registryUpdateRef,
        dsCandidateNote: finding.action.dsCandidateNote,
      },
      mismatchProperties: finding.comparison.mismatches.map((m) => m.property),
      mismatchClass: classifyMismatches(finding.comparison.mismatches),
      tokens: [
        ...finding.comparison.mismatches.filter((m) => m.expectedToken).map((m) => ({ token: m.expectedToken as string, property: m.property, source: 'mismatch' as const, value: m.expected })),
        ...iterations.flatMap((it) => it.plan.plan.edits).filter((e) => e.findingId === finding.identity.findingId && e.dsToken).map((e) => ({ token: e.dsToken as string, property: e.property ?? e.kind, source: 'edit' as const, value: e.value })),
      ],
      fixPlan: { decision: fixPlanByFinding.has(finding.identity.findingId) ? 'fix' : 'undecided', note: fixPlanByFinding.get(finding.identity.findingId)?.note ?? null },
      redesign: {
        requested: fixPlanByFinding.has(finding.identity.findingId),
        planned: iterations.some((it) => it.plan.plan.edits.some((e) => e.findingId === finding.identity.findingId)),
        applied: appliedInfo?.applied ?? false,
        verified,
        swappedTo: swapEdit ? { dsComponent: swapEdit.edit.dsComponent ?? '', dsVariant: swapEdit.edit.dsVariant } : null,
        unaddressedReason: iterations.flatMap((it) => it.plan.plan.unaddressed).find((u) => u.findingId === finding.identity.findingId)?.reason ?? null,
      },
      location: {
        located: entry !== undefined,
        method: entry?.resolution.method ?? null,
        stamp: entry?.element ?? null,
        tagName: entry?.affordances.tagName ?? null,
        auditBox: entry?.drift.auditBox ?? null,
        liveBox: entry?.drift.liveBox ?? null,
      },
      crops: { before: null, after: null }, // filled by R7 once crops are actually written to disk
      auditEvidence: finding.quality.evidence.map((e) => ({ kind: e.kind, ref: e.ref, note: e.note })),
      states: { captured: ['default'], missing: ['hover', 'focus', 'active', 'disabled'] },
      crossRun: { sightings, reuse },
      suggestion,
    });
  }

  const sections: ManifestSection[] = [];
  let order = 0;
  const seenSections = new Set<string>();
  for (const entry of mapping.entries) {
    if (!entry.sectionId || seenSections.has(entry.sectionId)) continue;
    seenSections.add(entry.sectionId);
    const memberFindingIds = sectionMembers.get(entry.sectionId) ?? [];
    const bucketCounts: Record<string, number> = {};
    for (const id of memberFindingIds) {
      const c = components.find((x) => x.findingId === id);
      if (c) bucketCounts[c.suggestion.bucket] = (bucketCounts[c.suggestion.bucket] ?? 0) + 1;
    }
    const firstFinding = pageFindings.find((f) => f.identity.findingId === memberFindingIds[0]);
    sections.push({
      sectionId: entry.sectionId,
      name: firstFinding?.location.section ?? entry.sectionId,
      scope: entry.scope,
      excludedReason: entry.scope === 'excluded' ? 'global header/footer section — never edited in Workflow A' : null,
      order: order++,
      wrapper: { located: true, stamp: entry.sectionId, tagName: null },
      memberFindingIds,
      bucketCounts,
    });
  }

  const otherPageFindings = r1.findings.length - pageFindings.length;
  const byBucket: Record<string, number> = {};
  for (const c of components) byBucket[c.suggestion.bucket] = (byBucket[c.suggestion.bucket] ?? 0) + 1;

  return {
    schemaVersion: 1,
    redesignRunId: r1.sourceRun.runId, // placeholder; overwritten by the caller with the actual redesignRunId once known
    createdAt: new Date(0).toISOString(),
    pageId: pageFindings[0]?.location.pageId ?? '',
    auditAiMode: (r1.audit.run as { aiMode?: string }).aiMode ?? null,
    auditDsRegistryVersion,
    designSystem: { path: r1.registry.designSystemPath, dsRegistryVersion: r1.registry.version.dsRegistryVersion, changedSinceAudit: r1.registry.version.dsRegistryVersion !== auditDsRegistryVersion },
    viewport: session.viewport,
    scope: { contentSectionIds: sections.filter((s) => s.scope !== 'excluded').map((s) => s.sectionId), excludedSectionIds: sections.filter((s) => s.scope === 'excluded').map((s) => s.sectionId) },
    sections,
    components,
    counts: {
      findings: pageFindings.length,
      located: components.filter((c) => c.location.located).length,
      unlocated: components.filter((c) => !c.location.located).length,
      excluded: components.filter((c) => c.scope === 'excluded').length,
      fixRequested: components.filter((c) => c.redesign.requested).length,
      fixApplied: components.filter((c) => c.redesign.applied).length,
      fixVerified: components.filter((c) => c.redesign.verified).length,
      byBucket,
      otherPageFindings,
    },
  };
}
