import { existsSync } from 'node:fs';
import { renderTokensForPrompt } from '../../ds/catalog.ts';
import type { Config } from '../../config/index.ts';
import type { LlmClient } from '../../llm/client.ts';
import { buildReferenceHooks } from '../../reference/hooks.ts';
import { readDesignDecisions } from '../../preview/decisions.ts';
import { REDESIGN_RULES } from '../../redesign-policy.ts';
import { buildDsTokenIndex } from '../../resolution/ds-evidence.ts';
import { ResolutionJudgmentSchema } from '../../resolution/judgment-schema.ts';
import { resolveTargets, type ResidualQuestion } from '../../resolution/resolve.ts';
import { writeResolution } from '../../resolution/store.ts';
import { TerminalError } from '../../retry.ts';
import { inScopeFindings } from '../../session/in-scope.ts';
import type { RVInput, RVOutput } from '../types.ts';

/**
 * RV — Resolver (hybrid). Runs BEFORE R3 makes any edit decision. For every selected, in-scope Fix finding
 * it understands why each unresolved property is unresolved and resolves it from reliable evidence when it
 * can (the audit's measurement, the DS token index in the page's theme scope, a rendered measurement),
 * preserves what the DS does not require, and records a specific gap otherwise. Only genuine design
 * questions (selected NEEDS_REVIEW / UNVERIFIED findings) reach a judgment, and every claim in the answer
 * is re-verified against the DS and the approved reference registry before it becomes a target.
 *
 * The audit's data.json is read only; the derived targets are written to `context/resolved-targets.json`
 * and are consumed by R3 (what may be planned), R4 (what may be applied), R5 and R8 (what is measured).
 */

export const RV_STATUS = 'implemented' as const;

export interface RVDeps {
  llm: LlmClient;
  designSystemPath: string;
  references: Config['references'];
  now?: () => Date;
  log?: (line: string) => void;
}

export const SYSTEM_PROMPT = `You are the Resolver of a Design System redesign pipeline. For each residual finding below, decide which CSS properties — if any — should change, using ONLY the evidence supplied.
Resolution order (stop at the first that fits):
 1. The persistent project rules and the authorized scope (they override everything).
 2. A suitable existing DS component/variant, token or rule, read in the page's variant/theme scope.
 3. A suitable approved reference-project treatment for a REAL DS gap: ONLY one listed under "approved candidate patterns" for that finding. The approved projects were built with this DS, so use a suitable treatment confidently and do not redesign what an approved project already solved. The project marked [preferred] is the first source for subtle borders and light card/section separation (never a blanket restyle).
 4. A local composition built only from DS tokens (a proposed local variant).
 5. Otherwise: unresolved, naming the specific evidence gap — never an invented value.
Hard rules:
 - A value is built ONLY from DS tokens as var(--token) (several allowed, e.g. "1px solid var(--border-soft)") plus the keywords none/transparent/currentcolor/solid and 0 or a 1px hairline. No hardcoded colours, no magic lengths.
 - Never change composition: width, height, display, position, text-align, flex/grid, margin, transform, alignment, columns. Never change a property merely because its expected value is absent.
 - Keep visible field/card boundaries, keyboard focus indication and contrast. Preserve the surface's own interactions (hover/focus reveals).
 - The black Button primary variant is prohibited; primary actions use the existing brand variant. Do not turn links or option rows into red CTA buttons.
 - A reference pattern is NOT an official DS component: name it only if it is listed (as reference {project, patternId}). A reference COLOUR is never used raw: the verifier reads its actual value (alpha included, in the target's state and theme) and maps it to the exact DS token of that value — whatever the reference called it — or else the nearest SUITABLE one for that role on the real backdrop (visibility, polarity and contrast, not distance alone). The backdrop is re-measured for the property you decide (a border and text sit on the element's own background, a background or an outer shadow on what is behind it; the one shown is the border's), and a colour a DS token or pattern names is refused when it is not visible on it. Each candidate shows that mapping, or "NO DS MAPPING" with the gap. Name only a candidate whose colours map. For a candidate marked "NOT MAPPABLE" or "evidence only", return an unresolved decision that names its gap (never relabel it a proposed local variant to keep the raw colour). A candidate that maps to a nearest token is recorded as a proposed local variant; one whose colours are all exact is an approved project pattern.
 - The kind shown for each finding is inferred from audit, DS and rendered-structure evidence. A tag or ARIA role is not a component kind. A reference pattern is accepted only if it is listed for that finding and fits the inferred kind: it is re-verified against this inference. A reference treatment applies to the finding's element itself (part "self"), never to its label or descendants. Never argue for a different kind in a "reason" — the reason is not evidence.
 - If no change is justified, return NO decision for that finding (it is recorded as preserved). Use preserve-existing / unresolved only for a specific property, with its specific reason.
 - Every decision's "reason" must be a checkable sentence grounded in the evidence; say plainly what the evidence cannot settle.`;

function describeKinds(q: ResidualQuestion): string[] {
  const k = q.elementKinds;
  const rejected = k.considered.filter((c) => c.status === 'vetoed').map((c) => `${c.kind} (${c.vetoes[0]})`);
  return [
    k.kinds.length > 0 ? `  ${k.kinds.map((v) => `kind=${v.kind} (${v.confidence}: ${v.evidence.join('; ')})`).join(' | ')}` : `  kind=unclassified — ${k.summary}`,
    rejected.length ? `  not: ${rejected.join('; ')}` : '',
    k.partOf ? `  part of a ${k.partOf}, not the ${k.partOf} itself` : '',
    k.context.length ? `  context: ${k.context.join('; ')}` : '',
  ];
}

export function describeResidual(q: ResidualQuestion): string {
  const props = q.properties.map((p) => `    - ${p.property}: actual=${p.actual ?? 'unknown'} · audit ${p.auditStatus} · ${p.reason} → currently ${p.currentOutcome} (${p.rationale})`).join('\n');
  const matches = q.possibleMatches.map((m) => `    - ${m.dsComponent}${m.dsVariant ? ` (${m.dsVariant})` : ''} score ${m.score}: ${m.why}`).join('\n');
  const cands = q.candidatePatterns.map((c) => [
    `    - project "${c.project}" pattern "${c.pattern}"${c.preferred ? ' [preferred]' : ''} fits: ${c.elementKinds.join(', ')}: ${c.purpose} — ${Object.entries(c.declarations).map(([k, v]) => `${k}: ${v}`).join('; ')}`,
    c.colourPreview && c.colourPreview.length > 0 ? `        colours, previewed on the DS section backgrounds of a ${q.surface === 'dark' ? 'dark' : 'light'} surface (the final mapping uses the measured backdrop): ${c.colourPreview.join(' | ')}` : '',
    c.evidenceOnly ? `        evidence only: ${c.gap ?? 'not applicable to a CSS property'}` : c.mappable === false ? `        NOT MAPPABLE: ${c.gap ?? 'a colour has no DS mapping'}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  const element = q.element.tag ? `<${q.element.tag}${q.element.role ? ` role="${q.element.role}"` : ''}> (a tag, not a component category)` : 'not mapped to a live element';
  return [
    `findingId=${q.findingId}`,
    `section="${q.section}" type=${q.productionType} label="${q.productionLabel}" classification=${q.classification} surface=${q.surface}${q.backdrop ? ` backdrop=${q.backdrop.color ?? `unmeasured (${q.backdrop.why ?? 'unknown'})`}` : ''} element=${element}`,
    ...describeKinds(q),
    q.reviewReason ? `  audit review reason: ${q.reviewReason}` : '',
    q.signals.length ? `  signals: ${q.signals.join(', ')}` : '',
    `  DS reference (${q.dsReference.basis}): ${q.dsReference.dsComponent ?? 'none'}${q.dsReference.dsVariant ? ` / ${q.dsReference.dsVariant}` : ''}`,
    matches ? `  audit possible matches (low scores are not verified):\n${matches}` : '',
    `  observed properties and what the deterministic rules already decided:\n${props || '    (none listed)'}`,
    cands ? `  approved candidate patterns:\n${cands}` : `  approved candidate patterns: none${q.candidatePatternsNote ? ` — ${q.candidatePatternsNote}` : ''}`,
  ].filter(Boolean).join('\n');
}

export async function runRV(deps: RVDeps, input: RVInput): Promise<RVOutput> {
  const log = deps.log ?? (() => {});
  const { r1, session, paths, mode, sectionIds } = input;
  if (!session.mapping) throw new TerminalError('RV: session.mapping is not set — C2 must run before RV.');
  const findings = inScopeFindings(r1.fixFindings, session.mapping, mode, sectionIds);

  const dsIndex = buildDsTokenIndex(deps.designSystemPath);
  const references = await buildReferenceHooks({
    ...(deps.references.registryPath ? { registryPath: deps.references.registryPath } : {}),
    ...(deps.references.referenceProjectsRoot ? { referenceProjectsRoot: deps.references.referenceProjectsRoot } : {}),
    checkServers: deps.references.checkServers,
    dsTokens: dsIndex,
    log,
  });
  const decisions = await readDesignDecisions(paths.designDecisionsJson);

  const judge = async (residuals: ResidualQuestion[]) => {
    log(`RV · ${residuals.length} selected finding(s) need a design decision (NEEDS_REVIEW / UNVERIFIED): asking for a judgment`);
    const variants = new Set(residuals.map((r) => (r.surface === 'dark' ? 'cinematic-dark' : 'editorial-light') as 'cinematic-dark' | 'editorial-light'));
    const tokens = [...variants].map((v) => `DS tokens effective in ${v} (a value must be built from these):\n${renderTokensForPrompt(r1.registry, v, /border|surface|tint|shadow|radius|text|space|section-bg|brand|cta/).split('\n').slice(0, 140).join('\n')}`).join('\n\n');
    const res = await deps.llm.structured({
      nodeId: 'RV',
      system: `${SYSTEM_PROMPT}\n\nThe following project rules override conflicting audit targets:\n${REDESIGN_RULES}`,
      prompt: `Residual findings (decide only these):\n\n${residuals.map(describeResidual).join('\n\n')}\n\n${tokens}`,
      schema: ResolutionJudgmentSchema,
      effort: 'high',
    });
    return res.data;
  };

  const out = await resolveTargets(
    { page: session.page, dsIndex, dsRegistryVersion: r1.registry.version.dsRegistryVersion, decisions, reference: references, ...(deps.now ? { now: deps.now } : {}) },
    {
      run: { runId: r1.sourceRun.runId, projectName: r1.sourceRun.projectName, dataJsonSha256: r1.sourceRun.dataJsonSha256, fixPlanSha256: r1.sourceRun.fixPlanSha256 },
      findings, entries: session.mapping.entries, judge,
    },
  );

  await writeResolution(paths.resolvedTargetsJson, out.file);
  const byReason: Record<string, number> = {};
  for (const t of out.file.targets) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;
  const counts = {
    targets: out.file.targets.length,
    resolved: out.file.targets.filter((t) => t.outcome === 'resolved-target').length,
    preserved: out.file.targets.filter((t) => t.outcome === 'preserve-existing').length,
    unresolved: out.file.targets.filter((t) => t.outcome === 'unresolved').length,
    byReason,
  };
  log(`RV · ${counts.targets} target(s) for ${findings.length} finding(s): ${counts.resolved} resolved, ${counts.preserved} preserved, ${counts.unresolved} unresolved${existsSync(paths.resolvedTargetsJson) ? ` → ${paths.resolvedTargetsJson}` : ''}`);
  return { resolution: out.file, residualQuestions: out.residuals.length, counts };
}
