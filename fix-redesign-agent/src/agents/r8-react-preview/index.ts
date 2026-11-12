import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../../config/index.ts';
import { fidelityCheckOf, fidelitySummaryOf, gapSplit, unverifiedByFamily } from '../../fidelity/coverage.ts';
import { buildExemptions } from '../../fidelity/exemptions.ts';
import type { AttributionContext } from '../../fidelity/feedback.ts';
import { budgetStoppedOutput, engineHashOf, reuseRetainedEvidence, scopeHashOf, stampEvidence } from '../../preview/budget-stop.ts';
import type { PreserveInput } from '../../fidelity/preserve.ts';
import { evaluatePreserveTargets, verifyFidelity } from '../../fidelity/verify.ts';
import type { DesignBaseline, FidelityReport, PreserveResult } from '../../fidelity/types.ts';
import { correctionsFrom, correctionsToJson, editKey, verifyAndCorrect, type CorrectionSet } from '../../preview/correct.ts';
import { basisHashOf } from '../../preview/correction-state.ts';
import { readDesignDecisions } from '../../preview/decisions.ts';
import { readScrollEffects } from '../../preview/scroll-effects.ts';
import { extractSections } from '../../preview/extract.ts';
import { expectedScope, planIslands, routeFindings, type IslandPlan } from '../../preview/plan.ts';
import { renderFindingAccounting, renderPreviewMd } from '../../preview/report.ts';
import { generatePreviewApp, type GeneratedPreview } from '../../preview/scaffold.ts';
import { mergeUserStyleRules, readUserStyleRules } from '../../preview/user-style-rules.ts';
import { exportFigmaBundle } from '../../preview/figma-export.ts';
import { buildPreview, ensureInstalled, portForRun, startPreviewServer } from '../../preview/server.ts';
import { settleStatus, statusHeadline, statusOf } from '../../preview/status.ts';
import type { ExtractionResult, PreviewCheck, PreviewServerRecord, PreviewVerification } from '../../preview/types.ts';
import { verifyPreview, writePreviewStatus } from '../../preview/verify.ts';
import { setVerification, writeResolution } from '../../resolution/store.ts';
import type { Exemption, ResolutionFile } from '../../resolution/schema.ts';
import { deriveSectionCandidates } from '../../session/scope.ts';
import type { CorrectionSummary, R8Input, R8Output } from '../types.ts';

/**
 * R8 — React Preview (deterministic). The default deliverable of every run: runnable React source
 * (`preview-app/`) and a localhost URL, GENERATED from the run's own evidence and VERIFIED before
 * gate G2. It never falls back to static HTML: if the preview cannot be generated, built, served
 * or measured, this node throws and the run fails at R8.
 *
 * Verification is design-aware: besides scope, content, measured fixes and interaction parity it
 * measures every RESOLVED target in the rendered page and compares the preview with the immutable
 * pre-edit baseline (default/hover/focus styles, composition, alignment, sticky pin/release), where
 * only an authorized change — a resolved target, identified by finding + property + state — may differ.
 * A regression or an unmet target is fed to ONE bounded correction loop (preview-generator corrections
 * here; what only the planner can fix is returned for the pipeline) before G2 is ever asked.
 */

export const R8_STATUS = 'implemented' as const;

export interface R8Deps {
  designSystemPath: Config['designSystemPath'];
  preview: Omit<Config['preview'], 'dsFirst' | 'figmaExport'> & { dsFirst?: boolean; figmaExport?: boolean };
  fidelity?: Config['fidelity'];
  log?: (line: string) => void;
  /** Starts the preview server; injectable so the reuse path is testable without spawning one. */
  startServer?: typeof startPreviewServer;
}

const DEFAULT_FIDELITY: Config['fidelity'] = { maxCorrectionCycles: 2, maxVerifications: 3, maxDurationMinutes: 15, maxElementsPerSection: 160, maxHoverTargets: 20, maxFocusTargets: 16 };

interface Produced {
  extraction: ExtractionResult;
  islands: IslandPlan[];
  skipped: Array<{ findingIds: string[]; reason: string }>;
  generation: GeneratedPreview;
  server: PreviewServerRecord;
  routes: ReturnType<typeof routeFindings>;
  edits: R8Input['edits'];
  simulated: string[];
}

/** The three measurements R8 chains, injected so the ORDER is testable without a browser. */
export interface VerifyAttemptSteps {
  fidelity: (exemptions: Exemption[]) => Promise<FidelityReport>;
  preserve: (input: PreserveInput) => PreserveResult[];
  preview: (preserveResults: PreserveResult[]) => Promise<PreviewVerification>;
}

/**
 * One verification of a produced preview, in the only order that is correct: fidelity FIRST (the preserve decisions are judged on its evidence), then the
 * preserve evaluation on that report, then the preview verification with those results (so the finding accounting is computed once, with them).
 */
export async function verifyAttempt(steps: VerifyAttemptSteps, a: { resolution: ResolutionFile | null; baseline: DesignBaseline | null; overrideSectionIds: ReadonlySet<string>; exemptions: Exemption[] }): Promise<{ verification: PreviewVerification; fidelity: FidelityReport }> {
  const fidelity = await steps.fidelity(a.exemptions);
  const preserveResults = steps.preserve({ resolution: a.resolution, report: fidelity, baseline: a.baseline, exemptions: a.exemptions, overrideSectionIds: a.overrideSectionIds });
  const verification = await steps.preview(preserveResults);
  return { verification, fidelity };
}

/**
 * The targets' own verification statuses — measured in the rendered preview, and every preserve decision judged from the fidelity evidence — are exactly
 * `verification.targetResults`; writing them from there is what keeps resolved-targets.json and verification.json from disagreeing.
 */
export async function commitTargetStatuses(resolution: ResolutionFile | null, verification: Pick<PreviewVerification, 'targetResults'>, write: (file: ResolutionFile) => Promise<void>): Promise<void> {
  if (!resolution) return;
  for (const r of verification.targetResults ?? []) setVerification(resolution, (t) => t.id === r.targetId, r.verification, r.detail);
  await write(resolution);
}

export async function runR8(deps: R8Deps, input: R8Input): Promise<R8Output> {
  const log = deps.log ?? (() => {});
  const fidelityCfg = deps.fidelity ?? DEFAULT_FIDELITY;
  const { paths, r1, mode, entries } = input;
  const browser = input.context.browser();
  if (!browser) throw new Error('R8 needs a browser context that belongs to a browser (extraction and verification run in it)');
  if (!existsSync(paths.originalHtml)) throw new Error(`R8 needs ${paths.originalHtml} (written by R7); it is missing, so the preview cannot be generated from this run`);

  const decisions = await readDesignDecisions(paths.designDecisionsJson);
  const resolution = input.resolution ?? null;
  const baseline = input.baseline ?? null;
  await mkdir(paths.contextDir, { recursive: true });
  await writeFile(paths.appliedEditsJson, JSON.stringify(input.edits, null, 2));
  await writeFile(paths.plannerGapsJson, JSON.stringify(input.unaddressed, null, 2));
  await writeFile(paths.mappingJson, JSON.stringify({ entries }, null, 2));

  const candidates = deriveSectionCandidates(r1.findings);
  const names = Object.fromEntries(candidates.map((c) => [c.sectionId, c.name]));
  const idByName = new Map(candidates.map((c) => [c.name, c.sectionId]));
  const sectionIdByName = (name: string) => idByName.get(name) ?? name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const originalHtml = await readFile(paths.originalHtml, 'utf8');
  const expected = expectedScope(mode, r1.findings, r1.fixFindings);
  const port = portForRun(input.redesignRunId, deps.preview.basePort);
  const overrideIds = new Set(Object.keys(decisions?.overrides ?? {}));
  const budget = input.budget;
  const serve = deps.startServer ?? startPreviewServer;

  const produce = async (c: CorrectionSet): Promise<Produced> => {
    const edits = input.edits.filter((e) => !c.droppedEdits.has(editKey(e.findingId, e.property)));
    log(`R8 · extracting ${mode === 'full-page' ? 'every content section' : `${input.sectionIds.length} selected section(s)`} from the run's captured snapshot${c.stateGuards.size || c.droppedEdits.size || c.droppedIslands.size ? ` (corrections in force: ${c.stateGuards.size} state-guarded edit(s), ${c.droppedEdits.size} dropped edit(s), ${c.droppedIslands.size} dropped component(s))` : ''}`);
    const extraction = await extractSections(input.context, originalHtml, { sectionIds: mode === 'full-page' ? null : input.sectionIds, fullPage: mode === 'full-page', names, edits, stateGuards: c.stateGuards, ...(deps.preview.dsFirst ? { dsFirst: true } : {}) });
    if (extraction.sections.length === 0) throw new Error('R8: no section could be extracted for the resolved scope — a preview with no sections is not produced');
    const simulated = [
      'Forms do not submit: submitting any form in the preview shows a notice and sends nothing.',
      'Links point at the real site; they were not followed during verification.',
      'The page\'s own scripts do not run: only behaviour the browser provides natively, CSS, and the generic adapters (anchors, disclosure toggles, carousel navigation) work. Everything else is probed and listed as not reproduced.',
      ...(extraction.sections.some((s) => JSON.stringify(s.tree).includes('fra-carousel-track')) ? ['Carousel motion is a preview adapter: all captured slides are retained, with local arrow/pagination navigation and a CSS loop. The original script\'s autoplay timing and slide-selection side effects are not reproduced.'] : []),
      ...(extraction.sections.some((s) => JSON.stringify(s.tree).includes('data-pv-iframe')) ? ['Embedded frames (maps, videos, widgets) are replaced by a placeholder.'] : []),
      ...(decisions?.overrides && Object.keys(decisions.overrides).length ? [`Section(s) ${Object.keys(decisions.overrides).join(', ')} are hand-authored React (Design Review Resolver), not generated from the page.`] : []),
    ];
    const planned = deps.preview.islands ? planIslands({ sections: extraction.sections, entries, findings: r1.fixFindings, decisions, ...(deps.preview.dsFirst ? { dsFirst: true } : {}) }) : { plans: [] as IslandPlan[], skipped: [] };
    const islands = planned.plans.filter((p) => !p.findingIds.some((id) => c.droppedIslands.has(id)));
    const generation: GeneratedPreview = await generatePreviewApp({
      runDir: paths.runDir, previewDir: paths.previewAppDir, runId: input.redesignRunId, mode, designSystemPath: deps.designSystemPath, port,
      title: `${r1.sourceRun.displayName} — React preview`, extraction, islands, decisions, overridesDir: existsSync(paths.previewOverridesDir) ? paths.previewOverridesDir : null, simulated,
      scrollEffects: await readScrollEffects(paths.scrollEffectsJson),
      ...(deps.preview.dsFirst ? { structuralRules: true } : {}),
      userStyleRules: mergeUserStyleRules(await readUserStyleRules(join(dirname(dirname(paths.projectDir)), 'user-style-rules.shared.json')), await readUserStyleRules(join(paths.projectDir, 'user-style-rules.json'))),
    });
    for (const u of (generation.userRules ?? []).filter((x) => !x.shared || x.matched > 0)) log(u.matched === 0 ? `R8 · user style rule "${u.id}" matched no element in section "${u.section}" (nothing applied)` : `R8 · user style rule "${u.id}": ${u.matched} element(s) in "${u.section}"`);
    if (generation.eyebrows?.length || generation.arrowLinks || generation.badges || generation.indicatorGroups) log(`R8 · structural DS rules: ${generation.arrowLinks ?? 0} arrow link(s) → CTALink, ${generation.badges ?? 0} badge(s) → Badge, ${generation.indicatorGroups ?? 0} indicator group(s), ${generation.eyebrows?.length ?? 0} eyebrow label(s) without icon`);
    await ensureInstalled(paths.previewAppDir, log);
    await buildPreview(paths.previewAppDir, log);
    const server = await serve({ previewDir: paths.previewAppDir, runId: input.redesignRunId, port, recordPath: paths.previewServerJson, log });
    const routes = routeFindings({ fixFindings: r1.fixFindings, entries, edits, islands, sectionIdByName, overrides: decisions?.overrides ?? {} });
    return { extraction, islands, skipped: planned.skipped, generation, server, routes, edits, simulated };
  };

  const attributionOf = (a: Produced): AttributionContext => {
    const editsByFinding = new Map<string, Array<{ property: string | null; kind: string }>>();
    for (const e of a.edits) editsByFinding.set(e.findingId, [...(editsByFinding.get(e.findingId) ?? []), { property: e.property, kind: e.kind }]);
    return { editsByFinding, islandFindingIds: new Set(a.islands.flatMap((i) => i.findingIds)), overrideSectionIds: overrideIds };
  };

  const verify = async (a: Produced, _c: CorrectionSet) => {
    const exemptions = buildExemptions({ resolution, findings: r1.fixFindings, islandFindingIds: new Set(a.islands.flatMap((i) => i.findingIds)) });
    const { verification, fidelity } = await verifyAttempt({
      fidelity: async (ex) => (await verifyFidelity({ browser, url: a.server.url, baseline, sectionIds: a.extraction.sections.map((s) => s.id), overrideSectionIds: overrideIds, exemptions: ex, ...(deps.preview.dsFirst ? { dsFirst: true } : {}), budget, log })).report,
      preserve: evaluatePreserveTargets,
      preview: (preserveResults) => verifyPreview({
        browser, url: a.server.url, mode, expected, extraction: a.extraction, fixFindings: r1.fixFindings, routes: a.routes, decisions, islands: a.islands, skippedIslands: a.skipped,
        originalBehavior: input.behavior && !input.behavior.error ? input.behavior : null, customChecksFile: existsSync(join(paths.previewOverridesDir, 'checks.mjs')) ? join(paths.previewOverridesDir, 'checks.mjs') : null, sectionNames: names, originalHtml, siteBase: r1.targetUrl, plannerGaps: new Map(input.unaddressed.map((u) => [u.findingId, u.reason] as const)), simulated: a.simulated,
        ...(resolution ? { resolution, preserveResults } : {}), generation: { assetsFailed: a.generation.assets.failed, remoteLeft: a.generation.assets.remoteLeft }, log,
      }),
    }, { resolution, baseline, overrideSectionIds: overrideIds, exemptions });
    return { verification, fidelity, attribution: attributionOf(a) };
  };

  // What this evidence is measured for: the plan (the edits R8 was given, the targets, the baseline - `preview --regenerate` recomputes the same value from
  // the run folder), the scope, and the engine that measures it. See preview/budget-stop.ts.
  const stamp = { basisHash: basisHashOf({ edits: input.edits, resolution, baselineSha256: baseline?.baselineSha256 ?? null }), scopeHash: await scopeHashOf(input), engineHash: await engineHashOf({ designSystemPath: deps.designSystemPath, preview: deps.preview, fidelity: deps.fidelity }) };
  // A plain continuation of an unchanged plan is not a new verification: reuse the earlier one as measured, for free (never on `--regenerate`, never after a reset).
  if (input.reuseEvidence) {
    const reused = await reuseRetainedEvidence({ input, budget, stamp, fallbackPort: port, serve, log });
    if (reused) return reused;
  }
  const outcome = await verifyAndCorrect<Produced>({ initial: correctionsFrom(input.corrections), produce, verify, resolution, budget, log, ...(deps.preview.dsFirst ? { dsFirst: true } : {}) });
  // The budget allowed NO verification (a null `final` only happens with a budget stop): nothing is regenerated, built, served or measured; the previous
  // evidence of this plan is kept and reported with the open item saying so, never as a pass (see preview/budget-stop.ts).
  if (!outcome.final) return budgetStoppedOutput({ input, budget, reason: outcome.budgetReason!, stamp, fallbackPort: port, log });
  const final = outcome.final;
  const { verification, generation, server } = { verification: final.verification, generation: final.attempt.generation, server: final.attempt.server };
  const fidelity: FidelityReport = final.fidelity;

  // fidelity joins the verification as a check: a regression FAILS it; a comparison that did not verify every REQUIRED check is NOT CHECKED, never passed
  const fidelityCheck: PreviewCheck = fidelityCheckOf(fidelity);
  const scopeDiverges = JSON.stringify([...expected.expectedSectionIds].sort()) !== JSON.stringify([...input.sectionIds].sort());
  const extraChecks: PreviewCheck[] = [
    { id: 'scope.matches-run-scope', group: 'scope', name: 'The independently derived scope equals the scope the pipeline resolved', status: scopeDiverges && mode !== 'full-page' ? 'fail' : 'pass', detail: `derived from fix-plan + audit: ${expected.expectedSectionIds.join(', ') || 'none'}; pipeline resolved: ${input.sectionIds.join(', ') || 'none'}` },
    fidelityCheck,
  ];
  verification.checks.unshift(...extraChecks);
  verification.summary.passed += extraChecks.filter((c) => c.status === 'pass').length;
  verification.summary.failed += extraChecks.filter((c) => c.status === 'fail').length;
  verification.summary.notChecked += extraChecks.filter((c) => c.status === 'not-checked').length;

  // resolved-targets.json carries exactly verification.targetResults (see commitTargetStatuses)
  await commitTargetStatuses(resolution, verification, (file) => writeResolution(paths.resolvedTargetsJson, file));

  // the ONE overall verdict + status: PASS only when every required check is verified, FAIL when one failed, INCOMPLETE when required evidence is missing
  // (an unreachable sticky trace, an unverified preserve decision, a gate that did not run); the required gaps are the `required.open` lines below
  const stillOpen = settleStatus(verification, fidelity, resolution).map((g) => g.text);
  const correction: CorrectionSummary = {
    stopReason: outcome.stopReason, budgetReason: outcome.budgetReason, cycles: outcome.cycles, open: outcome.open, plannerFeedback: outcome.plannerFeedback,
    corrections: correctionsToJson(outcome.corrections), verifications: outcome.verifications, budget: { used: budget.usage(), max: budget.config, resets: [...budget.resets] }, required: { satisfied: stillOpen.length === 0, open: stillOpen, ...(unverifiedByFamily(fidelity).length ? { unverified: unverifiedByFamily(fidelity), unverifiedSplit: gapSplit(fidelity) } : {}) },
  };
  // the decision at G2 reads only verification.json: it carries the fidelity verdict, the required-check counts and the open lines, so an approval is never silent about them
  verification.fidelity = fidelitySummaryOf(fidelity, stillOpen);

  await mkdir(paths.previewDir, { recursive: true });
  await writeFile(paths.previewVerificationJson, JSON.stringify(verification, null, 2));
  await writeFile(paths.fidelityReportJson, JSON.stringify(fidelity, null, 2));
  await writeFile(paths.correctionLogJson, JSON.stringify(correction, null, 2));
  await writeFile(paths.previewGenerationJson, JSON.stringify({ generatedAt: new Date().toISOString(), runId: input.redesignRunId, mode, port: server.port, url: server.url, sections: final.attempt.extraction.sections.map((s) => ({ id: s.id, name: s.name, unlabelled: s.unlabelled })), generation, islands: final.attempt.islands.map((i) => ({ slot: i.slot, sectionId: i.sectionId, findingIds: i.findingIds, component: i.spec.component, props: i.spec.props, basis: i.basis })), skippedIslands: final.attempt.skipped, islandFallbacks: [...outcome.corrections.droppedIslands].map((findingId) => ({ findingId, reason: 'the design-system component did not measure up or changed something no authorized target covers; the original element is kept' })), corrections: correction.corrections, orphanContent: final.attempt.extraction.orphanContent, stats: final.attempt.extraction.stats }, null, 2));
  await writePreviewStatus(paths.previewAppDir, input.redesignRunId, mode, verification);
  const acct = renderFindingAccounting(verification);
  await mkdir(paths.redesignDeliverableDir, { recursive: true });
  await writeFile(join(paths.redesignDeliverableDir, 'finding-accounting.md'), acct.md);
  await writeFile(join(paths.redesignDeliverableDir, 'finding-accounting.json'), JSON.stringify(acct.json, null, 2));
  await writeFile(join(paths.redesignDeliverableDir, 'PREVIEW.md'), renderPreviewMd({ runId: input.redesignRunId, v: verification, g: generation, source: paths.previewAppDir, fidelity, correction }));
  await stampEvidence(paths, stamp); // last: the stamp that makes the files above retainable if a later invocation may not verify

  log(`R8 · ${statusHeadline(statusOf(verification))} — ${verification.summary.passed} passed, ${verification.summary.failed} failed, ${verification.summary.notChecked} not checked · ${verification.summary.findingsVerified}/${verification.summary.findingsTotal} findings verified by measurement · ${verification.summary.interactionsMatched}/${verification.summary.interactionsTotal} probed interactions reproduced, ${verification.summary.interactionsUnavailable} not reproduced · fidelity ${fidelity.verdict}${outcome.cycles.length ? ` after ${outcome.cycles.length} correction cycle(s) (${outcome.stopReason})` : ''}`);
  if (deps.preview.figmaExport !== false) {
    const fx = await exportFigmaBundle(dirname(paths.previewAppDir));
    log(fx.ok ? `R8 · Figma export prepared: ${fx.sections} section(s), ${fx.chunks} chunk(s), ${fx.images} image(s) in ${fx.outDir} (push it with the Figma tools: see FIGMA_EXPORT.md there)` : `R8 · Figma export not prepared (${fx.reason}); the preview and its verification are unaffected`);
  }
  return { url: server.url, port: server.port, previewDir: paths.previewAppDir, sourceHash: generation.sourceHash, verificationJson: paths.previewVerificationJson, verification: verification as PreviewVerification, generation, fidelity, correction };
}
