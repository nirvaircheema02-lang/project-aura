import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { AuditProperty, Finding } from '../../src/audit-link/index.ts';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';
import { buildReferenceHooks } from '../../src/reference/hooks.ts';
import { redesignPolicyViolation } from '../../src/redesign-policy.ts';
import { buildDsTokenIndex } from '../../src/resolution/ds-evidence.ts';
import type { ResolutionDecision } from '../../src/resolution/judgment-schema.ts';
import { resolveTargets, type ReferenceHooks, type ResolveInput } from '../../src/resolution/resolve.ts';
import { authorizedProperties, rollupFinding, type ReferenceProvenance, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * The Resolver against a real browser page and a real (temporary) Design System token tree: every audit shape that used to
 * end as "Not resolved" is classified, resolved from evidence or preserved, and nothing is changed merely because a value is absent.
 */

const NOTE_NO_REQUIREMENT = 'Observed value; no verified DS requirement for this property/part.';
const NOTE_GAP = 'length not comparable without layout context (actual "normal", expected "0.5rem")';
const NOTE_TOKEN = 'expected token --surface-text-muted is not defined in the Design System';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
.light{background:#fff;color:#333}
.row{display:flex}
.row span{display:block;width:40px;height:20px;background:#ddd}
.wide{margin-right:12px}
.tight{margin-right:8px}
.card{padding:16px;border:2px solid #000}
</style></head><body>
<div class="light" data-variant="editorial-light">
  <p data-fra-element="eInherit">Inherited colour</p>
  <div class="row" data-fra-element="eWide"><span class="wide"></span><span class="wide"></span><span></span></div>
  <div class="row" data-fra-element="eTight"><span class="tight"></span><span class="tight"></span><span></span></div>
  <p data-fra-element="eMuted" style="color:rgb(0,0,0)">Muted text</p>
  <div class="card" data-fra-element="eCard" style="width:50%;text-align:left">Card</div>
  <a href="#x" data-fra-element="eCta" style="background:#b01f24;color:#fff;padding:8px">Go</a>
</div></body></html>`;

let browser: Browser;
let page: Page;
const tempDirs: string[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await page.setContent(PAGE);
});
afterAll(async () => {
  await browser.close();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeDs(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'resolver-ds-'));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const dsIndex = () => buildDsTokenIndex(makeDs({
  'tokens/build/tokens.css': ':root { --spacing-2: 0.5rem; --color-foundation-white: #ffffff; }',
  'core-v2/src/styles/editorial-light.css': '@layer tokens { [data-variant="editorial-light"] { --surface-text-muted: rgba(0, 0, 0, 0.80); --border-soft: rgba(0, 0, 0, 0.08); } }',
}));

const prop = (over: Partial<AuditProperty>): AuditProperty => ({ property: 'color', actual: 'rgb(0, 0, 0)', expected: null, expectedToken: null, source: null, status: 'UNRESOLVED', note: null, ...over });

function finding(id: string, properties: AuditProperty[], over: Partial<Finding['component']> & { classification?: Finding['classification']; mismatches?: Finding['comparison']['mismatches'] } = {}): Finding {
  const f = makeFinding({ findingId: id, classification: over.classification ?? 'DEVIATION', mismatches: over.mismatches ?? [] });
  f.comparison.properties = properties;
  f.component = { ...f.component, ...(over.dsComponent !== undefined ? { dsComponent: over.dsComponent } : {}), ...(over.dsVariant !== undefined ? { dsVariant: over.dsVariant } : {}), ...(over.productionType ? { productionType: over.productionType } : {}) };
  return f;
}

function entryFor(element: string, findingId: string): MappingEntry {
  return {
    element, stamp: element, findingIds: [findingId], signature: null, instanceIndex: null, instanceCount: null, sectionId: 'main', scope: 'content',
    resolution: { method: 'objective', confidence: 'confirmed', checks: { geometry: true, identity: true, text: true, classFingerprint: true, passedCount: 4 }, candidatesConsidered: 1 },
    drift: { class: 'identical', auditBox: null, liveBox: null, styleDeltas: [], note: '' },
    affordances: { tagName: 'div', role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false },
    dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' },
  };
}

const RUN = { runId: 'r', projectName: 'p', dataJsonSha256: 'd', fixPlanSha256: 'f' };
const now = () => new Date('2026-10-09T10:00:00Z');

async function resolve(findings: Finding[], entries: MappingEntry[], extra: Partial<ResolveInput> = {}, reference: ReferenceHooks | null = null) {
  return resolveTargets({ page, dsIndex: dsIndex(), dsRegistryVersion: 'v1', decisions: null, reference, now }, { run: RUN, findings, entries, ...extra });
}

const byProp = (targets: ResolvedTarget[], p: string) => targets.find((t) => t.property === p);

describe('Resolver — missing expectations', () => {
  it('resolves a keyword the audit could not compare by MEASURING the rendered spacing, and preserves it when it already matches', async () => {
    const wide = finding('f-wide', [prop({ property: 'column-gap', actual: 'normal', source: 'atoms/Card.tsx', note: NOTE_GAP })]);
    const tight = finding('f-tight', [prop({ property: 'column-gap', actual: 'normal', source: 'atoms/Card.tsx', note: NOTE_GAP })]);
    const { file } = await resolve([wide, tight], [entryFor('eWide', 'f-wide'), entryFor('eTight', 'f-tight')]);

    const w = byProp(file.targets.filter((t) => t.findingId === 'f-wide'), 'column-gap')!;
    expect(w.outcome).toBe('resolved-target');
    expect(w.reason).toBe('layout-measurement-required');
    expect(w.target).toMatchObject({ value: '0.5rem', comparison: 'rendered-length-px' });
    expect(w.provenance.kind).toBe('ds-component');
    expect(w.provenance.evidence.join(' ')).toMatch(/measured used column-gap: 12px/);
    expect(w.audit).toMatchObject({ status: 'UNRESOLVED', actual: 'normal', expected: null }); // the audit observation is copied, never rewritten
    expect(w.status).toMatchObject({ design: 'resolved', verification: 'not-run' });

    const t = byProp(file.targets.filter((x) => x.findingId === 'f-tight'), 'column-gap')!;
    expect(t.outcome).toBe('preserve-existing');
    expect(t.provenance.kind).toBe('rendered-measurement');
    expect(t.status.design).toBe('preserved');
  });

  it('resolves a token the unscoped DS lacks from the page\'s variant scope, with provenance naming that scope', async () => {
    const f = finding('f-muted', [prop({ property: 'color', actual: 'rgb(0, 0, 0)', expectedToken: '--surface-text-muted', note: NOTE_TOKEN })]);
    const { file } = await resolve([f], [entryFor('eMuted', 'f-muted')]);
    const t = file.targets[0]!;
    expect(t.outcome).toBe('resolved-target');
    expect(t.reason).toBe('variant-or-theme-context');
    expect(t.target?.token).toBe('--surface-text-muted');
    expect(t.target?.value).toMatch(/rgba\(0, 0, 0, 0\.80?\)/);
    expect(t.provenance).toMatchObject({ kind: 'ds-token', ds: { token: '--surface-text-muted', scope: '[data-variant="editorial-light"]' } });
  });

  it('a token defined nowhere in the DS stays unresolved with the specific reason — never an invented value', async () => {
    const f = finding('f-ghost', [prop({ property: 'color', note: 'expected token --semantic-ghost is not defined in the Design System' })]);
    const { file } = await resolve([f], [entryFor('eMuted', 'f-ghost')]);
    expect(file.targets[0]).toMatchObject({ outcome: 'unresolved', reason: 'variant-or-theme-context', target: null });
  });

  it('inherited / no-DS-requirement properties are PRESERVED, not changed because the expected value is absent', async () => {
    const f = finding('f-inherit', [prop({ property: 'color', actual: 'rgb(51, 51, 51)', note: NOTE_NO_REQUIREMENT })]);
    const { file } = await resolve([f], [entryFor('eInherit', 'f-inherit')]);
    const t = file.targets[0]!;
    expect(t.outcome).toBe('preserve-existing');
    expect(t.target).toBeNull();
    expect(['no-ds-requirement', 'inherited-context']).toContain(t.reason);
    expect(t.acceptance[0]).toMatchObject({ kind: 'property-unchanged', property: 'color' });
    expect(t.status).toMatchObject({ design: 'preserved', implementation: 'not-applicable' });
    expect(authorizedProperties(file, 'f-inherit').size).toBe(0);
  });

  it('a state-dependent or responsive property is unresolved with that reason and carries no target', async () => {
    const f = finding('f-state', [prop({ property: 'background-color', note: 'the hover treatment was not captured' }), prop({ property: 'padding-top', note: 'differs below the mobile breakpoint' })]);
    const { file } = await resolve([f], [entryFor('eCard', 'f-state')]);
    expect(byProp(file.targets, 'background-color')).toMatchObject({ outcome: 'unresolved', reason: 'state-context', target: null });
    expect(byProp(file.targets, 'padding-top')).toMatchObject({ outcome: 'unresolved', reason: 'responsive-context', target: null });
    expect(authorizedProperties(file, 'f-state').size).toBe(0);
  });

  it('unknown width / alignment never becomes a layout change: preserved or unresolved, refused by the policy guard', async () => {
    const f = finding('f-layout', [
      prop({ property: 'width', actual: 'auto', source: 'atoms/Card.tsx', note: 'length not comparable without layout context (actual "auto", expected "20rem")' }),
      prop({ property: 'text-align', actual: 'left', note: 'something the audit tool never emitted before' }),
    ]);
    const entry = entryFor('eCard', 'f-layout');
    const { file } = await resolve([f], [entry]);
    const width = byProp(file.targets, 'width')!;
    const align = byProp(file.targets, 'text-align')!;
    expect(width.outcome).toBe('preserve-existing');
    expect(align.outcome).toBe('unresolved');
    expect(file.targets.some((t) => t.outcome === 'resolved-target')).toBe(false);
    const edit = (property: string, value: string): TargetedEdit => ({ findingId: 'f-layout', selector: '[data-fra-element="eCard"]', expectedMatches: 1, kind: 'style', property, value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 1 });
    expect(redesignPolicyViolation(edit('width', '20rem'), f, entry, file)).toMatch(/Project redesign policy/);
    expect(redesignPolicyViolation(edit('text-align', 'center'), f, entry, file)).toMatch(/Project redesign policy/);
  });

  it('an audit-measured expectation that conflicts with a project rule is NOT a target (black CTA fill)', async () => {
    const f = finding('f-cta', [prop({ property: 'background-color', actual: 'rgb(176, 31, 36)', expected: 'rgb(0, 0, 0)', status: 'DIFFERENT', source: 'atoms/Button.tsx' })], { dsComponent: 'Button', dsVariant: 'primary · md · light', productionType: 'button', mismatches: [{ property: 'background-color', actual: 'rgb(176, 31, 36)', expected: 'rgb(0, 0, 0)', expectedToken: null, comparison: 'color-deltaE', delta: 0 }] });
    const { file } = await resolve([f], [entryFor('eCta', 'f-cta')]);
    expect(file.targets[0]).toMatchObject({ outcome: 'unresolved', reason: 'policy-conflict', target: null });
    expect(file.targets[0]!.decisionReason).toMatch(/black/i);
  });

  it('an audit DIFFERENT with an expected value stays a resolved target with the audit as its provenance', async () => {
    const f = finding('f-diff', [prop({ property: 'border-top-left-radius', actual: '4px', expected: '8px', expectedToken: '--radius-md', status: 'DIFFERENT', source: 'atoms/Card.tsx' })], { mismatches: [{ property: 'border-top-left-radius', actual: '4px', expected: '8px', expectedToken: '--radius-md', comparison: 'length-px', delta: 4 }] });
    const { file } = await resolve([f], [entryFor('eCard', 'f-diff')]);
    expect(file.targets[0]).toMatchObject({ outcome: 'resolved-target', reason: 'audit-expected-present', target: { value: '8px', token: '--radius-md', comparison: 'length-px' } });
    expect(file.targets[0]!.provenance.kind).toBe('audit-expected');
  });

  it('the finding rollup never calls a finding fixed while a required check is open', async () => {
    const f = finding('f-open', [prop({ property: 'border-top-left-radius', actual: '4px', expected: '8px', status: 'DIFFERENT', source: 'atoms/Card.tsx' })], { mismatches: [{ property: 'border-top-left-radius', actual: '4px', expected: '8px', expectedToken: null, comparison: 'length-px', delta: 4 }] });
    const { file } = await resolve([f], [entryFor('eCard', 'f-open')]);
    expect(rollupFinding(file, 'f-open')).toMatchObject({ resolved: 1, openRequired: 1, allRequiredVerified: false });
    file.targets[0]!.status.verification = 'verified-resolved-target';
    expect(rollupFinding(file, 'f-open')).toMatchObject({ openRequired: 0, allRequiredVerified: true });
  });
});

// ── residual design questions: a judgment whose every claim is re-verified ────────────────────

const provenance = (over: Partial<ReferenceProvenance> = {}): ReferenceProvenance => ({
  project: 'competition-benchmarking-v2-react', pattern: 'flat-hairline-card', sourcePath: '/ref/competition-benchmarking-v2-react', file: 'src/globals.css', fileSha256: 'a'.repeat(64), projectHash: 'b'.repeat(64),
  classification: 'approved-project-pattern', dsGrounded: true, tokens: [{ token: '--border-soft', existsInDs: true, dsScope: '[data-variant="editorial-light"]' }], renderingEvidence: 'source-only', note: null, colours: [], ...over,
});

const stubReference = (over: Partial<Awaited<ReturnType<ReferenceHooks['verify']>>> = {}): ReferenceHooks => ({
  registry: { version: 't', sha256: 's', approvedProjects: ['competition-benchmarking-v2-react'] },
  find: () => [{ project: 'competition-benchmarking-v2-react', pattern: 'flat-hairline-card', purpose: 'light card separation', declarations: { border: '1px solid var(--border-soft)' }, preferred: true, elementKinds: ['card', 'panel'] }],
  verify: async ({ project }) => project === 'competition-benchmarking-v2-react'
    ? { ok: true, applied: { border: '1px solid var(--border-soft)' }, classification: 'approved-project-pattern', provenance: provenance(), reasons: [], ...over }
    : { ok: false, applied: {}, classification: null, provenance: null, reasons: [`"${project}" is not an approved reference project`] },
});

const decision = (over: Partial<ResolutionDecision>): ResolutionDecision => ({ findingId: 'f-review', property: 'border-top-color', part: 'self', state: 'default', outcome: 'resolved-target', value: 'var(--border-soft)', source: 'ds-token', dsToken: '--border-soft', reference: null, reason: 'the card needs a subtle hairline', unresolvedReason: null, ...over });

const reviewFinding = () => finding('f-review', [prop({ property: 'border-top-color', actual: 'rgb(0, 0, 0)', note: NOTE_NO_REQUIREMENT })], { classification: 'NEEDS_REVIEW', productionType: 'card' });

async function withJudgment(decisions: ResolutionDecision[], reference: ReferenceHooks | null = null) {
  return resolve([reviewFinding()], [entryFor('eCard', 'f-review')], { judgment: { decisions, notes: [] } }, reference);
}

describe('Resolver — residual questions and the judgment', () => {
  it('asks for a judgment only for NEEDS_REVIEW / UNVERIFIED findings, once, and shows the candidate approved patterns', async () => {
    const asked: string[][] = [];
    const { residuals } = await resolve([reviewFinding(), finding('f-plain', [prop({ note: NOTE_NO_REQUIREMENT })])], [entryFor('eCard', 'f-review'), entryFor('eInherit', 'f-plain')], {
      judge: async (r) => { asked.push(r.map((x) => x.findingId)); return { decisions: [], notes: [] }; },
    }, stubReference());
    expect(asked).toEqual([['f-review']]);
    expect(residuals[0]!.candidatePatterns[0]).toMatchObject({ project: 'competition-benchmarking-v2-react', pattern: 'flat-hairline-card', preferred: true });
  });

  it('accepts a DS-token claim, substituting the token for the page\'s scope', async () => {
    const { file } = await withJudgment([decision({})]);
    const t = byProp(file.targets, 'border-top-color')!;
    expect(t).toMatchObject({ outcome: 'resolved-target', target: { token: '--border-soft' } });
    expect(t.target!.value).toMatch(/rgba\(0, 0, 0, 0\.08\)/);
    expect(t.provenance.kind).toBe('ds-token');
  });

  it('records an approved-project fallback with its source path, file hash and project hash — as a pattern, never a DS component', async () => {
    const { file } = await withJudgment([decision({ source: 'approved-project-pattern', dsToken: null, reference: { project: 'competition-benchmarking-v2-react', patternId: 'flat-hairline-card' } })], stubReference());
    const t = byProp(file.targets, 'border-top-color')!;
    expect(t.outcome).toBe('resolved-target');
    expect(t.provenance.kind).toBe('approved-project-pattern');
    expect(t.provenance.reference).toMatchObject({ project: 'competition-benchmarking-v2-react', pattern: 'flat-hairline-card', sourcePath: '/ref/competition-benchmarking-v2-react', file: 'src/globals.css', classification: 'approved-project-pattern' });
    expect(t.provenance.reference!.fileSha256).toHaveLength(64);
    expect(t.provenance.reference!.projectHash).toHaveLength(64);
    expect(t.decisionReason).toMatch(/approved project competition-benchmarking-v2-react/);
    expect(file.referenceRegistry?.approvedProjects).toContain('competition-benchmarking-v2-react');
  });

  it('a pattern whose tokens are not all DS tokens is a PROPOSED LOCAL VARIANT, not an approved pattern', async () => {
    const hooks = stubReference({ classification: 'proposed-local-variant', provenance: provenance({ classification: 'proposed-local-variant', dsGrounded: false, tokens: [{ token: '--border-soft', existsInDs: false, dsScope: null }] }) });
    const { file } = await withJudgment([decision({ source: 'approved-project-pattern', dsToken: null, reference: { project: 'competition-benchmarking-v2-react', patternId: 'flat-hairline-card' } })], hooks);
    expect(byProp(file.targets, 'border-top-color')!.provenance.reference!.classification).toBe('proposed-local-variant');
  });

  it('REJECTS a reference project that is not approved — the target stays unresolved and names why', async () => {
    const { file } = await withJudgment([decision({ source: 'approved-project-pattern', dsToken: null, reference: { project: 'some-other-draft', patternId: 'fancy-card' } })], stubReference());
    const t = byProp(file.targets, 'border-top-color')!;
    expect(t.outcome).toBe('unresolved');
    expect(t.target).toBeNull();
    // never offered, so refused before verification (the registry's own approved-project check on the real hooks is in the shipped-registry test below)
    expect(t.decisionReason).toMatch(/some-other-draft \/ fancy-card is not among the candidates offered/);
    expect(authorizedProperties(file, 'f-review').size).toBe(0);
  });

  it('rejects a reference claim when there is no registry at all', async () => {
    const { file } = await withJudgment([decision({ source: 'approved-project-pattern', dsToken: null, reference: { project: 'competition-benchmarking-v2-react', patternId: 'flat-hairline-card' } })], null);
    expect(byProp(file.targets, 'border-top-color')).toMatchObject({ outcome: 'unresolved' });
  });

  it.each([
    ['a hardcoded colour', { value: '#cccccc', source: 'proposed-local-variant' as const, dsToken: null }, /hardcoded/],
    ['a token the DS does not define', { value: 'var(--made-up)', dsToken: '--made-up' }, /not defined|made-up/],
    ['a protected composition property', { property: 'width', value: 'var(--spacing-2)', dsToken: '--spacing-2' }, /protected/],
    ['a value that does not use the claimed token', { value: 'var(--spacing-2)', dsToken: '--border-soft' }, /claimed token/],
    ['a resolved target with no value', { value: null }, /needs a value/],
  ])('rejects %s', async (_name, over, why) => {
    const { file } = await withJudgment([decision(over as Partial<ResolutionDecision>)]);
    const t = file.targets.find((x) => x.property === ((over as { property?: string }).property ?? 'border-top-color'))!;
    expect(t.outcome).toBe('unresolved');
    expect(t.reason).toBe('policy-conflict');
    expect(t.decisionReason).toMatch(why);
  });

  it('ignores a decision for a finding that was never put to the judgment', async () => {
    const { file } = await withJudgment([decision({ findingId: 'f-elsewhere' })]);
    expect(file.notes.join(' ')).toMatch(/not a residual question/);
  });
});

// ── the real, shipped approved registry (read-only) ───────────────────────────────────────────

const REF_ROOT = '/Users/sachin/Project-aura/project_aura1-main/projects';

describe.skipIf(!existsSync(join(REF_ROOT, 'competition-benchmarking-v2-react')))('Resolver — the shipped approved-reference registry', () => {
  it('verifies the preferred subtle-border pattern against the real project source and rejects an unapproved folder', async () => {
    const hooks = (await buildReferenceHooks({ dsTokens: dsIndex() }))!;
    expect(hooks.registry.approvedProjects).toEqual(['survey-product-detail-page', 'case-study-v2', 'ken-auth-redesign', 'expert-interview-page', 'report-store-legacy', 'competition-benchmarking-v2-react']);
    const query = { category: 'card-separation' as const, purpose: 'light separation of a card from its section', surface: 'light' as const, viewport: 'any' as const, elementKinds: ['card'], properties: [] };
    const found = hooks.find(query);
    expect(found.find((c) => c.preferred)?.project).toBe('competition-benchmarking-v2-react');
    const ok = await hooks.verify({ project: 'competition-benchmarking-v2-react', pattern: 'flat-hairline-card', query });
    expect(ok.ok).toBe(true);
    expect(ok.provenance?.sourcePath).toBe(join(REF_ROOT, 'competition-benchmarking-v2-react'));
    expect(ok.provenance?.projectHash).toMatch(/^[0-9a-f]{64}$/);
    const bad = await hooks.verify({ project: 'competition-benchmarking-v2', pattern: 'flat-hairline-card', query });
    expect(bad.ok).toBe(false);
    expect(bad.reasons.join(' ')).toMatch(/approved/i);
  });
});
