import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { runR3 } from '../../src/agents/r3-redesign-plan/index.ts';
import type { CaptureSession, R1Output } from '../../src/agents/types.ts';
import type { Finding } from '../../src/audit-link/index.ts';
import type { DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { applyEdit } from '../../src/dom/apply-edit.ts';
import { ScriptedLlmClient } from '../../src/llm/provider.ts';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import type { MappingEntry, MappingResult } from '../../src/mapping/types.ts';
import { measureResolvedTarget } from '../../src/preview/targets.ts';
import { redesignPolicyViolation } from '../../src/redesign-policy.ts';
import { buildReferenceHooks } from '../../src/reference/hooks.ts';
import { measureComputed } from '../../src/resolution/rendered.ts';
import { measureTarget, resolveTargets } from '../../src/resolution/resolve.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';
import { colourTarget } from '../helpers/colour-target.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Colour lane, defect 7: a resolved colour target binds the VALUE of the edit that plans it. The guard alone makes R3's "covered" logic fall through to
 * synthesis, and the same literal then reaches R3's plan, R4's applied rule and the verifiers' measured target.
 */

const FA = 'a'.repeat(32);
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  cleanupDsFixtures();
  for (const c of cleanups.splice(0)) await c();
});

// ── a scripted R3 (the harness of r3-redesign-plan.test.ts, reduced to what the guard needs) ──

function sessionWith(mapping: MappingResult): CaptureSession {
  return {
    page: {} as CaptureSession['page'], context: {} as CaptureSession['context'], observer: {} as CaptureSession['observer'], capture: {} as CaptureSession['capture'],
    before: { tiles: [], totalHeight: 0, truncated: false, composite: null }, viewport: { width: 1440, height: 900 },
    captureFingerprint: { domHash: 'h', stylesheets: [], fonts: [], assets: [], viewport: { width: 1440, height: 900 }, renderingPolicyHash: 'r' },
    originalHtml: '<html></html>', mapping, release: async () => {},
  };
}

const registry = (): DsRegistry =>
  ({
    designSystemPath: '/fake/design-system', loadedAt: Date.now(),
    version: { dsRegistryVersion: 'f'.repeat(64), tokensHash: '1'.repeat(64), componentsHash: '2'.repeat(64), advisory: { tokensPackageVersion: '0.1.0', coreV2PackageVersion: '0.1.0' }, findings: [] },
    tokens: { sourceTokens: [{ name: '--button-px-md' }], effective: [] }, components: { totalTsxFiles: 1, componentFiles: ['atoms/Button.tsx'], stringUnionVariants: [], iifeLogic: [], cvaConfigs: [] },
    rules: { checkerScripts: [], rules: [{ id: 'R1.1', title: 'Button spacing', fields: { WHAT: 'padding must equal the DS token' }, startLine: 1, endLine: 5 }], findings: [] }, allFindings: [],
  }) as unknown as DsRegistry;

const entryFor = (element: string, findingId: string): MappingEntry => ({
  element, stamp: element, findingIds: [findingId], signature: null, instanceIndex: null, instanceCount: null, sectionId: 'hero', scope: 'content',
  resolution: { method: 'objective', confidence: 'confirmed', checks: { geometry: true, identity: true, text: true, classFingerprint: true, passedCount: 4 }, candidatesConsidered: 1 },
  drift: { class: 'identical', auditBox: null, liveBox: null, styleDeltas: [], note: '' },
  affordances: { tagName: 'div', role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false },
  dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' },
});

const r1Of = (f: Finding): R1Output =>
  ({
    sourceRun: { auditAgentRepoRoot: '/aa', projectName: 'p', runId: 'r', displayName: 'R', targetUrl: 'http://127.0.0.1/x', runDir: '/aa/r', dataJsonPath: '/aa/d', dataJsonSha256: 'd', fixPlanJsonPath: null, fixPlanSha256: null, newComponentPlanJsonPath: null, newComponentPlanSha256: null, reportHtmlPath: null, screenshotsDir: '/aa/s' },
    audit: { schemaVersion: 1, run: { runId: 'r', targetUrl: 'http://127.0.0.1/x' }, findingCount: 1 }, targetUrl: 'http://127.0.0.1/x', fixPlan: { schemaVersion: 1, runId: 'r', updatedAt: null, entries: [] },
    fixEntries: [], decisionCounts: { fix: 1, skip: 0, keep_for_review: 0, undecided: 0 }, droppedUnknownFindingIds: [], newComponentPlan: null, warnings: [], registry: registry(), fixFindings: [f], findings: [f],
  }) as unknown as R1Output;

const resolutionOf = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: 'd', fixPlanSha256: null }, generatedAt: '2026-10-09T10:00:00.000Z', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });

const stamp = '[data-fra-element="eCard"]';
const modelEdit = (value: string, selector = stamp): TargetedEdit => ({ findingId: FA, selector, expectedMatches: 1, kind: 'style', property: 'border-top-color', value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'the card needs a subtle border', confidence: 0.9 });

async function plan(resolution: ResolutionFile, edits: TargetedEdit[]) {
  const finding = makeFinding({ findingId: FA, mismatches: [] });
  const session = sessionWith({ entries: [entryFor('eCard', FA)], unmapped: [], conflicts: [], usage: null });
  const llm = new ScriptedLlmClient({ R3: [{ edits, unaddressed: [] }] });
  const result = await runR3({ llm, log: () => {} }, { r1: r1Of(finding), session, iteration: 1, previous: null, acknowledgedConstraints: [], mode: 'full-page', sectionIds: [], resolution });
  return result;
}

describe('R3 with a resolved colour target (the guard alone decides what the model\'s edit is worth)', () => {
  it.each(['#ff00aa', 'rgba(255,0,170,.5)', 'red'])('the model\'s raw colour %s is refused, R3 falls through to synthesis and plans the TARGET\'s value', async (raw) => {
    const result = await plan(resolutionOf(colourTarget(FA)), [modelEdit(raw)]);
    expect(result.plan.edits).toHaveLength(1);
    expect(result.plan.edits[0]).toMatchObject({ findingId: FA, selector: stamp, kind: 'style', property: 'border-top-color', value: 'rgba(0, 0, 0, 0.08)', dsToken: '--border-card' });
    expect(result.synthesizedEdits).toBe(1);
    expect(result.plan.unaddressed.some((u) => u.findingId === FA && /border-top-color \(default state\).*border-top-color = rgba\(0, 0, 0, 0\.08\) \(--border-card\)/.test(u.reason))).toBe(true);
    expect(result.targetNotes).toEqual([{ targetId: expect.any(String), implementation: 'planned', detail: expect.stringMatching(/derived from the resolved target/) }]);
    expect(JSON.stringify(result.plan.edits)).not.toMatch(/ff00aa|255,\s*0,\s*170|red/);
  });

  it('an equivalent representation of the target is accepted as the model\'s own edit: nothing is synthesized', async () => {
    const result = await plan(resolutionOf(colourTarget(FA)), [modelEdit('rgba(0,0,0,.08)')]);
    expect(result.plan.edits).toHaveLength(1);
    expect(result.plan.edits[0]!.value).toBe('rgba(0,0,0,.08)');
    expect(result.synthesizedEdits).toBe(0);
    expect(result.plan.unaddressed.filter((u) => u.findingId === FA)).toEqual([]);
  });

  it('a hover target holds the hover edit to the hover colour and leaves the default edit to the default target', async () => {
    const hover = colourTarget(FA, { state: 'hover', target: { value: 'rgba(0, 0, 0, 0.15)', comparison: 'color-deltaE', token: '--border-input' } });
    const result = await plan(resolutionOf(colourTarget(FA), hover), [modelEdit('rgba(0, 0, 0, 0.08)'), modelEdit('#ff00aa', `${stamp}:hover`)]);
    const byState = (s: string) => result.plan.edits.filter((e) => e.selector.endsWith(':hover') === (s === 'hover'));
    expect(byState('default').map((e) => e.value)).toEqual(['rgba(0, 0, 0, 0.08)']);
    expect(byState('hover').map((e) => e.value)).toEqual(['rgba(0, 0, 0, 0.15)']); // synthesized from the hover target
    expect(result.synthesizedEdits).toBe(1);
  });

  it('R4 repeats the guard on a resumed or hand-made plan: the same refusal for the same raw colour', () => {
    const resolution = resolutionOf(colourTarget(FA));
    expect(redesignPolicyViolation(modelEdit('#ff00aa'), makeFinding({ findingId: FA }), entryFor('eCard', FA), resolution)).toMatch(/Project redesign policy:.*border-top-color/);
    expect(redesignPolicyViolation(modelEdit('rgba(0, 0, 0, 0.08)'), makeFinding({ findingId: FA }), entryFor('eCard', FA), resolution)).toBeNull();
  });
});

// ── one literal, three consumers ──

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
.light{background:#fff;padding:8px}
.card{display:block;box-sizing:border-box;width:300px;height:120px;border:1px solid #ccc;padding:16px;margin:8px}
</style></head><body>
<div class="light" data-variant="editorial-light"><div class="card" data-fra-element="eCard" data-finding-ids="${FA}"><h3>Plan A</h3><p>Descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div></div>
<script>window.__pvVerify = { findByFinding: (id) => document.querySelector('[data-finding-ids~="' + id + '"]') };</script>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
});
afterAll(async () => {
  await browser.close();
});

async function nearestWorld() {
  const base = await mkdtemp(join(tmpdir(), 'colour-edit-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'projects');
  const css = join(root, 'competition-benchmarking-v2-react', 'src', 'globals.css');
  await mkdir(dirname(css), { recursive: true });
  await writeFile(css, ':root { --hair6: rgba(0,0,0,.06); }\n.near { border: 1px solid var(--hair6); }\n');
  const registryPath = join(base, 'registry.json');
  await writeFile(registryPath, JSON.stringify({
    schemaVersion: 1, version: 'test.1', approvedBy: 'test', approvedOn: '2026-10-09', referenceProjectsRoot: root,
    projects: [{ name: 'competition-benchmarking-v2-react', relativeDir: 'competition-benchmarking-v2-react', kind: 'react-vite', inspectionUrl: null, role: 'fixture', preferredFor: ['card-separation', 'subtle-border'], notes: [],
      patterns: [{ id: 'near', category: 'card-separation', purpose: 'light separation of a card from its section with a subtle hairline', description: 'a card with a soft hairline border', source: { file: 'src/globals.css', kind: 'css-rule', locator: '.near' }, declarations: { border: '1px solid var(--hair6)' }, appliesTo: { surfaces: ['light'], viewports: ['any'], elementKinds: ['card', 'panel'] }, whenNotToUse: 'fixture' }] }],
  }));
  return registryPath;
}

describe('a mapped reference colour: R3\'s plan, R4\'s applied rule and the verifiers\' target carry ONE literal', () => {
  it('resolver -> R3 (the model plans a raw colour) -> R4 (applyEdit) -> R5 and R8 measure the same value', { timeout: 60_000 }, async () => {
    await page.setContent(PAGE);
    const hooks = (await buildReferenceHooks({ registryPath: await nearestWorld(), dsTokens: miniDsIndex() }))!;
    const finding = makeFinding({ findingId: FA, classification: 'NEEDS_REVIEW', mismatches: [] });
    finding.comparison.properties = [{ property: 'border-top-color', actual: 'rgb(204, 204, 204)', expected: null, expectedToken: null, source: null, status: 'UNRESOLVED', note: 'Observed value; no verified DS requirement for this property' }];
    finding.component = { ...finding.component, productionType: 'card', productionLabel: 'Plan card', dsComponent: null, dsVariant: null };
    finding.review = { status: 'NEEDS_REVIEW', reason: 'a card that needs a subtle border', node: 'B6', signals: [], possibleMatches: [{ dsComponent: 'ResourceCard', dsFile: 'atoms/ResourceCard.tsx', dsVariant: null, score: 0.2, why: 'x' }], observed: [] };
    const out = await resolveTargets(
      { page, dsIndex: miniDsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: hooks, now: () => new Date('2026-10-09T10:00:00Z') },
      { run: { runId: 'r', projectName: 'p', dataJsonSha256: 'd', fixPlanSha256: 'f' }, findings: [finding], entries: [entryFor('eCard', FA)], judgment: { decisions: [{ findingId: FA, property: 'border-top-color', part: 'self', state: 'default', outcome: 'resolved-target', value: 'var(--border-soft)', source: 'approved-project-pattern', dsToken: null, reference: { project: 'competition-benchmarking-v2-react', patternId: 'near' }, unresolvedReason: null, reason: 'a card needs a subtle hairline' }], notes: [] } },
    );
    const t = out.file.targets.find((x) => x.property === 'border-top-color')!;
    expect(t, t.decisionReason).toMatchObject({ outcome: 'resolved-target', target: { token: '--semantic-hairline-faint', value: 'rgba(0, 0, 0, 0.07)' } });
    const literal = t.target!.value;

    // R3: the model plans a raw colour for the authorized border; the guard refuses it and the plan carries the target's literal
    const r3 = await plan(out.file, [modelEdit('#ff00aa')]);
    const planned = r3.plan.edits.find((e) => e.property === 'border-top-color')!;
    expect(planned.value).toBe(literal);

    // R4: the guard passes the planned edit, and the rule that lands on the live page is that literal
    expect(redesignPolicyViolation(planned, finding, entryFor('eCard', FA), out.file)).toBeNull();
    const applied = await applyEdit(page, planned, null);
    expect(applied).toMatchObject({ applied: true, matched: 1 });
    const onPage = await measureComputed(page, stamp, 'border-top-color');
    expect(onPage).toBe(literal);

    // R5 (live DOM) and R8 (rendered preview) measure the SAME target and agree with what R4 put on the page
    const r5 = await measureTarget(page, stamp, t);
    expect(r5, r5.note).toMatchObject({ matches: true, actual: literal });
    const r8 = await measureResolvedTarget(page, t);
    expect(r8, r8.note).toMatchObject({ matches: true, measured: true, expected: literal, actual: literal });
  });
});
