import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { AuditProperty, Finding } from '../../src/audit-link/index.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';
import { buildReferenceHooks } from '../../src/reference/hooks.ts';
import { assessColour, parseBackdrop, parseCssColour } from '../../src/resolution/ds-colours.ts';
import { buildDsTokenIndex } from '../../src/resolution/ds-evidence.ts';
import { measureBackdrop } from '../../src/resolution/rendered.ts';
import type { ResolutionDecision } from '../../src/resolution/judgment-schema.ts';
import { resolveTargets, type ReferenceHooks } from '../../src/resolution/resolve.ts';
import { authorizedProperties, type ReferenceProvenance, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';
import { cleanupDsFixtures, miniDsIndex, REAL_DS } from '../helpers/ds-colour-fixture.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Finding 3 through the Resolver: a reference colour reaches R3/R4/R5/R8 only as ONE target built from a DS token chosen by the verified mapper, with its
 * provenance. Whatever a `ReferenceHooks` implementation returns, a raw colour can never become the target.
 */

const REF_ROOT = '/Users/sachin/Project-aura/project_aura1-main/projects';
const HAVE_REAL = existsSync(join(REF_ROOT, 'competition-benchmarking-v2-react')) && existsSync(REAL_DS);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
.light{background:#fff;color:#333;padding:8px}
.dark{background:#111114;color:#fafafa;padding:8px}
.tile{display:block;box-sizing:border-box;width:300px;height:120px;border:1px solid #ccc;padding:16px;margin:8px}
</style></head><body>
<div class="light" data-variant="editorial-light">
  <div class="tile" data-fra-element="eLight"><h3>Plan A</h3><p>Descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div>
</div>
<div class="dark" data-variant="cinematic-dark">
  <div class="tile" data-fra-element="eDark"><h3>Plan B</h3><p>Descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#b">Read more</a></div>
</div>
<div class="dark" data-variant="cinematic-dark">
  <div class="tile" style="background:#fff" data-fra-element="eWhiteInDark"><h3>Plan C</h3><p>Descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#c">Read more</a></div>
</div>
<div class="light" data-variant="editorial-light">
  <div class="tile" style="background:#111114;color:#fafafa" data-fra-element="eDarkInLight"><h3>Plan D</h3><p>Descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#d">Read more</a></div>
</div></body></html>`;

let browser: Browser;
let page: Page;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await page.setContent(PAGE);
});
afterAll(async () => {
  await browser.close();
  cleanupDsFixtures();
  for (const c of cleanups.splice(0)) await c();
});

const prop = (over: Partial<AuditProperty> = {}): AuditProperty => ({ property: 'border-top-color', actual: 'rgb(204, 204, 204)', expected: null, expectedToken: null, source: null, status: 'UNRESOLVED', note: 'Observed value; no verified DS requirement for this property/part.', ...over });

function residual(id: string): Finding {
  const f = makeFinding({ findingId: id, classification: 'NEEDS_REVIEW', mismatches: [] });
  f.comparison.properties = [prop()];
  f.component = { ...f.component, productionType: 'card', productionLabel: 'Plan card', dsComponent: null, dsVariant: null };
  f.review = { status: 'NEEDS_REVIEW', reason: 'a card that needs a subtle border', node: 'B6', signals: [], possibleMatches: [{ dsComponent: 'ResourceCard', dsFile: 'atoms/ResourceCard.tsx', dsVariant: null, score: 0.2, why: 'x' }], observed: [] };
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
const decision = (over: Partial<ResolutionDecision>): ResolutionDecision => ({ findingId: 'f-card', property: 'border-top-color', part: 'self', state: 'default', outcome: 'resolved-target', value: 'var(--border-soft)', source: 'approved-project-pattern', dsToken: null, reference: { project: 'competition-benchmarking-v2-react', patternId: 'near' }, reason: 'the card needs a subtle hairline separation', unresolvedReason: null, ...over });

async function resolveWith(reference: ReferenceHooks | null, decisions: ResolutionDecision[], element = 'eLight', dsIndex = miniDsIndex()) {
  return resolveTargets({ page, dsIndex, dsRegistryVersion: 'v1', decisions: null, reference, now }, { run: RUN, findings: [residual('f-card')], entries: [entryFor(element, 'f-card')], judgment: { decisions, notes: [] } });
}
const targetOf = (out: Awaited<ReturnType<typeof resolveWith>>, state: ResolvedTarget['state'] = 'default'): ResolvedTarget => out.file.targets.find((t) => t.property === 'border-top-color' && t.state === state)!;

const baseProvenance = (over: Partial<ReferenceProvenance> = {}): ReferenceProvenance => ({
  project: 'competition-benchmarking-v2-react', pattern: 'near', sourcePath: '/ref/competition-benchmarking-v2-react', file: 'src/globals.css', fileSha256: 'a'.repeat(64), projectHash: 'b'.repeat(64),
  classification: 'approved-project-pattern', dsGrounded: true, tokens: [], renderingEvidence: 'source-only', note: null, colours: [], ...over,
});

const stub = (applied: Record<string, string>, over: Partial<Awaited<ReturnType<ReferenceHooks['verify']>>> = {}): ReferenceHooks => ({
  registry: { version: 't', sha256: 's', approvedProjects: ['competition-benchmarking-v2-react'] },
  // a claim can only name a candidate that was offered for the finding, so the double offers the one the decisions below name
  find: () => [{ project: 'competition-benchmarking-v2-react', pattern: 'near', purpose: 'light card separation', declarations: {}, preferred: true, elementKinds: ['card'] }],
  verify: async () => ({ ok: true, applied, classification: 'approved-project-pattern', provenance: baseProvenance(), reasons: [], ...over }),
});

describe('defence in depth: ANY ReferenceHooks implementation', () => {
  it('a raw colour in the applied value is refused - not "recorded as a proposed local variant"', async () => {
    const out = await resolveWith(stub({ border: '1px solid #cccccc' }), [decision({})]);
    const t = targetOf(out);
    expect(t.outcome).toBe('unresolved');
    expect(t.target).toBeNull();
    expect(t.provenance.kind).not.toBe('approved-project-pattern');
    expect(t.decisionReason).toMatch(/no DS mapping|hardcoded/i);
    expect(authorizedProperties(out.file, 'f-card').size).toBe(0);
  });

  it('a raw colour hidden in another part of the value (a shadow layer, a second border colour) is refused too', async () => {
    for (const applied of [{ 'border-top-color': 'rgba(0,0,0,.06)' }, { border: '1px solid rgb(10 20 30 / 40%)' }, { 'border-top-color': 'red' }]) {
      const t = targetOf(await resolveWith(stub(applied), [decision({})]));
      expect(t.outcome, JSON.stringify(applied)).toBe('unresolved');
      expect(t.target).toBeNull();
    }
  });

  it('a hook that reports an unmapped colour in its provenance is refused even if the applied value looks clean', async () => {
    const unmapped = { property: 'border', outcome: 'unmapped', dsToken: null } as unknown as ReferenceProvenance['colours'][number];
    const out = await resolveWith(stub({ border: '1px solid var(--border-soft)' }, { provenance: baseProvenance({ colours: [unmapped] }) }), [decision({})]);
    expect(targetOf(out).outcome).toBe('unresolved');
    expect(targetOf(out).decisionReason).toMatch(/no DS mapping|unmapped/i);
  });

  it('a DS-token value of an approved pattern is still accepted and resolved for the surface', async () => {
    const out = await resolveWith(stub({ border: '1px solid var(--border-soft)' }), [decision({})]);
    expect(targetOf(out)).toMatchObject({ outcome: 'resolved-target', target: { value: 'rgba(0, 0, 0, 0.08)', token: '--border-soft' } });
  });
});

async function registryWorld() {
  const base = await mkdtemp(join(tmpdir(), 'resolver-colours-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'projects');
  const css = join(root, 'competition-benchmarking-v2-react', 'src', 'globals.css');
  await mkdir(dirname(css), { recursive: true });
  await writeFile(css, `
:root { --hair6: rgba(0,0,0,.06); --soft-edge: rgba(0,0,0,.08); --odd: rgba(255,0,170,.5); --border-on-dark: rgba(255,255,255,.14); }
.near { border: 1px solid var(--hair6); background: #123456; }
.exact { border: 1px solid var(--soft-edge); }
.odd { border: 1px solid var(--odd); }
.ladder { --border-on-dark: rgba(255,255,255,.14); }
`);
  const pattern = (id: string, over: Record<string, unknown> = {}) => ({
    id, category: 'card-separation', purpose: 'light separation of a card from its section with a subtle hairline', description: 'a card with a soft hairline border',
    source: { file: 'src/globals.css', kind: 'css-rule', locator: `.${id}` },
    declarations: id === 'near' ? { border: '1px solid var(--hair6)', background: '#123456' } : { border: `1px solid var(--${id === 'exact' ? 'soft-edge' : 'odd'})` },
    appliesTo: { surfaces: ['light'], viewports: ['any'], elementKinds: ['card', 'panel'] }, whenNotToUse: 'fixture', ...over,
  });
  const registryPath = join(base, 'registry.json');
  await writeFile(registryPath, JSON.stringify({
    schemaVersion: 1, version: 'test.1', approvedBy: 'test', approvedOn: '2026-10-09', referenceProjectsRoot: root,
    projects: [{ name: 'competition-benchmarking-v2-react', relativeDir: 'competition-benchmarking-v2-react', kind: 'react-vite', inspectionUrl: null, role: 'fixture', preferredFor: ['card-separation', 'subtle-border'], notes: [],
      patterns: [pattern('near'), pattern('exact'), pattern('odd'), pattern('ladder', { category: 'subtle-border', source: { file: 'src/globals.css', kind: 'css-tokens', locator: ':root' }, declarations: { '--border-on-dark': 'rgba(255,255,255,.14)' }, appliesTo: { surfaces: ['dark'], viewports: ['any'], elementKinds: ['card'] } })] }],
  }));
  return { registryPath };
}

describe('a mapped reference colour becomes ONE target with its provenance', () => {
  it('nearest: the target holds the DS literal and token, and the provenance records the whole decision', async () => {
    const { registryPath } = await registryWorld();
    const hooks = (await buildReferenceHooks({ registryPath, dsTokens: miniDsIndex() }))!;
    const out = await resolveWith(hooks, [decision({})]);
    const t = targetOf(out);
    expect(t, t.decisionReason).toMatchObject({ outcome: 'resolved-target', target: { value: 'rgba(0, 0, 0, 0.07)', token: '--semantic-hairline-faint' } });
    expect(t.provenance.kind).toBe('approved-project-pattern');
    expect(t.provenance.ds).toMatchObject({ token: '--semantic-hairline-faint' });
    expect(t.provenance.reference!.classification).toBe('proposed-local-variant');
    const c = t.provenance.reference!.colours;
    expect(c).toHaveLength(1); // the background colour of the pattern does not supply a border colour: it is neither applied nor recorded as a gap
    expect(c[0]).toMatchObject({ property: 'border', outcome: 'nearest', dsToken: '--semantic-hairline-faint', referenceToken: '--hair6', role: 'border', theme: 'light', backdropSource: 'measured' });
    expect(c[0]!.backdrops[0]).toBe('rgb(255, 255, 255)'); // the page's real backdrop was measured, not assumed
    expect(c[0]!.verification.rendered.status).toBe('not-run');
    expect(t.decisionReason).toMatch(/nearest/);
    expect(t.decisionReason).toMatch(/--semantic-hairline-faint/);
    expect(t.acceptance.map((a) => a.kind).sort()).toEqual(['colour-visible', 'property-equals']);
    expect(t.acceptance.find((a) => a.kind === 'colour-visible')).toMatchObject({ property: 'border-top-color', state: 'default', expected: 'border:1.5' });
    expect(t.acceptance.find((a) => a.kind === 'property-equals')!.expected).toBe('rgba(0, 0, 0, 0.07)'); // R3, R4, R5 and R8 all read the same value
  });

  it('exact: a same-value DS token keeps the pattern an approved project pattern', async () => {
    const { registryPath } = await registryWorld();
    const hooks = (await buildReferenceHooks({ registryPath, dsTokens: miniDsIndex() }))!;
    const t = targetOf(await resolveWith(hooks, [decision({ reference: { project: 'competition-benchmarking-v2-react', patternId: 'exact' } })]));
    expect(t, t.decisionReason).toMatchObject({ outcome: 'resolved-target', target: { token: '--border-card', value: 'rgba(0, 0, 0, 0.08)' } });
    expect(t.provenance.reference!.classification).toBe('approved-project-pattern');
    expect(t.provenance.reference!.colours[0]).toMatchObject({ outcome: 'exact', dsToken: '--border-card' });
  });

  it('no safe match: unresolved with the specific gap, nothing authorised', async () => {
    const { registryPath } = await registryWorld();
    const hooks = (await buildReferenceHooks({ registryPath, dsTokens: miniDsIndex() }))!;
    const out = await resolveWith(hooks, [decision({ reference: { project: 'competition-benchmarking-v2-react', patternId: 'odd' } })]);
    const t = targetOf(out);
    expect(t).toMatchObject({ outcome: 'unresolved', target: null });
    expect(t.decisionReason).toMatch(/255,\s*0,\s*170/);
    expect(t.decisionReason).toMatch(/no DS border token/i);
    expect(authorizedProperties(out.file, 'f-card').size).toBe(0);
  });

  it('a hover/state target for a pattern that declares no such state stays unresolved', async () => {
    const { registryPath } = await registryWorld();
    const hooks = (await buildReferenceHooks({ registryPath, dsTokens: miniDsIndex() }))!;
    const t = targetOf(await resolveWith(hooks, [decision({ state: 'hover' })]), 'hover');
    expect(t.outcome).toBe('unresolved');
    expect(t.decisionReason).toMatch(/hover/);
  });

  it('hooks.find shows the colour preview, and flags what cannot be mapped (a gap) or can only be evidence (a token ladder)', async () => {
    const { registryPath } = await registryWorld();
    const hooks = (await buildReferenceHooks({ registryPath, dsTokens: miniDsIndex() }))!;
    const q = { category: 'card-separation' as const, purpose: 'light separation of a card', surface: 'light' as const, viewport: 'any' as const, elementKinds: ['card'], properties: [] };
    const found = hooks.find(q);
    const by = (id: string) => found.find((c) => c.pattern === id) as (typeof found)[number] & { mappable?: boolean; gap?: string | null; colourPreview?: string[]; evidenceOnly?: boolean };
    expect(by('exact')).toMatchObject({ mappable: true });
    expect(by('exact').colourPreview?.join(' ')).toMatch(/--border-card/);
    expect(by('near').colourPreview?.join(' ')).toMatch(/nearest/);
    expect(by('odd')).toMatchObject({ mappable: false });
    expect(by('odd').gap).toMatch(/no DS border token/i);
    const dark = hooks.find({ ...q, surface: 'dark' }).find((c) => c.pattern === 'ladder') as { evidenceOnly?: boolean; mappable?: boolean } | undefined;
    expect(dark?.evidenceOnly).toBe(true);
    expect(dark?.mappable).toBe(false);
  });
});

describe('a DS-token judgment is checked for visibility on the real surface too', () => {
  const dsDecision = (value: string, dsToken: string) => decision({ source: 'ds-token', reference: null, value, dsToken });

  it('an unscoped black hairline is invisible on a dark card and is refused; the scoped border token is accepted', async () => {
    const bad = targetOf(await resolveWith(null, [dsDecision('var(--semantic-hairline-soft)', '--semantic-hairline-soft')], 'eDark'));
    expect(bad.outcome).toBe('unresolved');
    expect(bad.decisionReason).toMatch(/not visible/);
    const good = targetOf(await resolveWith(null, [dsDecision('var(--border-soft)', '--border-soft')], 'eDark'));
    expect(good, good.decisionReason).toMatchObject({ outcome: 'resolved-target', target: { token: '--border-soft', value: 'rgba(255, 255, 255, 0.10)' } });
    expect(good.acceptance.some((a) => a.kind === 'colour-visible')).toBe(true);
  });

  it('on a light card both are fine', async () => {
    for (const token of ['--semantic-hairline-soft', '--border-soft']) {
      const t = targetOf(await resolveWith(null, [dsDecision(`var(${token})`, token)], 'eLight'));
      expect(t.outcome, token).toBe('resolved-target');
    }
  });
});

const RAW = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;

describe.skipIf(!HAVE_REAL)('the shipped registry on the real projects and the real DS (read-only)', () => {
  const surfaces = ['light', 'dark'] as const;

  it('every catalogued pattern x declared surface either fails with a colour reason or applies no raw colour at all', { timeout: 180_000 }, async () => {
    const hooks = (await buildReferenceHooks({ dsTokens: buildDsTokenIndex(REAL_DS) }))!;
    const registryJson = JSON.parse((await import('node:fs')).readFileSync(join(process.cwd(), 'references', 'approved-projects.json'), 'utf8')) as { projects: Array<{ name: string; patterns: Array<{ id: string; category: string; purpose: string; appliesTo: { surfaces: string[]; elementKinds: string[] } }> }> };
    let checked = 0;
    let applied = 0;
    for (const project of registryJson.projects) {
      for (const p of project.patterns) {
        for (const surface of surfaces.filter((s) => p.appliesTo.surfaces.includes(s))) {
          const v = await hooks.verify({ project: project.name, pattern: p.id, query: { category: p.category as never, purpose: p.purpose, surface, viewport: 'any', elementKinds: p.appliesTo.elementKinds, properties: [] } });
          checked++;
          const label = `${project.name}/${p.id}/${surface}`;
          if (v.ok) {
            applied++;
            for (const [k, value] of Object.entries(v.applied)) expect(value, `${label} ${k}`).not.toMatch(RAW);
            expect(v.provenance, label).not.toBeNull();
            for (const c of v.provenance!.colours) expect(c.outcome, label).not.toBe('unmapped');
          } else {
            expect(v.applied, label).toEqual({});
            expect(v.reasons.join(' '), label).toMatch(/colours-mapped|not visible|no DS/i);
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7);
    expect(applied).toBeGreaterThan(0);
  });

  it('flat-hairline-card stays an approved pattern on --border-soft; the dark ladder maps to an on-dark token; the faq grey maps exactly to a primitive', { timeout: 120_000 }, async () => {
    const hooks = (await buildReferenceHooks({ dsTokens: buildDsTokenIndex(REAL_DS) }))!;
    const q = (category: 'card-separation' | 'subtle-border' | 'accordion', surface: 'light' | 'dark', kind: string) => ({ category, purpose: 'light separation of a card from its section subtle hairline border accordion row', surface, viewport: 'any' as const, elementKinds: [kind], properties: [] });
    const flat = await hooks.verify({ project: 'competition-benchmarking-v2-react', pattern: 'flat-hairline-card', query: q('card-separation', 'light', 'card') });
    expect(flat.ok, flat.reasons.join(' | ')).toBe(true);
    expect(flat.applied.border).toBe('1px solid var(--border-soft)');
    expect(flat.classification).toBe('approved-project-pattern');
    const faq = await hooks.verify({ project: 'competition-benchmarking-v2-react', pattern: 'faq-accordion-row', query: q('accordion', 'light', 'accordion') });
    expect(faq.ok, faq.reasons.join(' | ')).toBe(true);
    expect(faq.provenance!.colours[0]).toMatchObject({ outcome: 'exact', tier: 'primitive' });
    const ladder = await hooks.verify({ project: 'competition-benchmarking-v2-react', pattern: 'hairline-border-on-dark', query: q('subtle-border', 'dark', 'card') });
    expect(ladder.ok, ladder.reasons.join(' | ')).toBe(true);
    expect(ladder.provenance!.colours[0]!.dsValue).toMatch(/255, 255, 255/);
    const pdp = await hooks.verify({ project: 'survey-product-detail-page', pattern: 'pdp-card-rest', query: q('card-separation', 'light', 'card') });
    expect(pdp.ok, pdp.reasons.join(' | ')).toBe(true);
    expect(pdp.applied.border).toMatch(/^1px solid var\(--[a-z-]+\)$/);
    expect(pdp.applied['box-shadow']).toBe('var(--shadow-card-rest)');
  });
});

// ── colour lane, review round 2 ──────────────────────────────────────────────────────────────────

describe('defect 1 (inverted rule): a hardcoded literal is taken only for a length/keyword property that holds no colour-like token', () => {
  it.each([
    ['transition', 'all 200ms ease'],
    ['cursor', 'pointer'],
    ['stop-color', 'CanvasText'],
    ['flood-color', 'red'],
    ['scrollbar-color', 'red blue'],
    ['filter', 'drop-shadow(0 0 2px red)'],
    ['text-emphasis', 'filled Highlight'],
    ['border-radius', '4px blue'],
    ['padding', '4px currentcolor'],
  ])('%s: %s is refused, whatever hook returned it', async (property, value) => {
    const out = await resolveWith(stub({ [property]: value }), [decision({ property })]);
    const t = out.file.targets.find((x) => x.property === property)!;
    expect(t.outcome).toBe('unresolved');
    expect(t.target).toBeNull();
    expect(t.decisionReason).toMatch(/no DS mapping|hardcoded/i);
    expect(authorizedProperties(out.file, 'f-card').size).toBe(0);
  });

  it('a plain length of a length property is still taken, flagged as not DS guidance (a proposed local variant)', async () => {
    const out = await resolveWith(stub({ 'border-radius': '10px' }), [decision({ property: 'border-radius' })]);
    const t = out.file.targets.find((x) => x.property === 'border-radius')!;
    expect(t, t.decisionReason).toMatchObject({ outcome: 'resolved-target', target: { value: '10px', token: null }, provenance: { kind: 'approved-project-pattern', reference: { classification: 'proposed-local-variant' } } });
    expect(t.acceptance.map((a) => a.kind)).toEqual(['property-equals']);
  });
});

describe('defect 3: the backdrop is measured per decision and property - never one value that the last audit property overwrote', () => {
  const CARDS = [
    // a white card inside a dark section: its border sits on the card's own white, its background on the dark section
    { element: 'eWhiteInDark', token: '--border-card', surface: 'light', own: 'rgb(255, 255, 255)', parent: 'rgb(17, 17, 20)' },
    // a dark card inside a white section
    { element: 'eDarkInLight', token: '--border-on-dark-card', surface: 'dark', own: 'rgb(17, 17, 20)', parent: 'rgb(255, 255, 255)' },
  ] as const;
  const ORDERS = [['border-top-color', 'background-color'], ['background-color', 'border-top-color']] as const;

  const resolveWithProps = (reference: ReferenceHooks | null, decisions: ResolutionDecision[], element: string, properties: readonly string[]) => {
    const f = residual('f-card');
    f.comparison.properties = properties.map((p) => prop({ property: p }));
    return resolveTargets({ page, dsIndex: miniDsIndex(), dsRegistryVersion: 'v1', decisions: null, reference, now }, { run: RUN, findings: [f], entries: [entryFor(element, 'f-card')], judgment: { decisions, notes: [] } });
  };

  it.each(CARDS.flatMap((c) => ORDERS.map((o) => [c.element, o.join(' then '), c, o] as const)))('%s, audit properties %s: the border is judged on the card\'s own background, so the same token is accepted in either order', async (_e, _o, card, order) => {
    const d = decision({ source: 'ds-token', reference: null, value: `var(${card.token})`, dsToken: card.token });
    const out = await resolveWithProps(null, [d], card.element, order);
    const t = out.file.targets.find((x) => x.property === 'border-top-color')!;
    expect(t, t.decisionReason).toMatchObject({ outcome: 'resolved-target', target: { token: card.token } });
  });

  it('a token that disappears on the card\'s own background is refused in either order (the converse false accept)', async () => {
    for (const order of ORDERS) {
      const d = decision({ source: 'ds-token', reference: null, value: 'var(--border-card)', dsToken: '--border-card' });
      const t = (await resolveWithProps(null, [d], 'eDarkInLight', order)).file.targets.find((x) => x.property === 'border-top-color')!;
      expect(t.outcome, order.join(',')).toBe('unresolved');
      expect(t.decisionReason, order.join(',')).toMatch(/not visible.*rgb\(17, 17, 20\)/);
    }
  });

  it('candidates are queried per property: border-color on the element\'s own backdrop, box-shadow on the parent\'s - the same in both orders', async () => {
    for (const order of ORDERS) {
      const seen = new Map<string, string[]>();
      const recording: ReferenceHooks = {
        ...stub({}),
        find: (q) => { seen.set(q.properties[0]!, q.colour?.backdrops ?? []); return stub({}).find(q); },
      };
      await resolveWithProps(recording, [], 'eWhiteInDark', order);
      expect(Object.fromEntries(seen), order.join(',')).toEqual({ 'border-color': ['rgb(255, 255, 255)'], 'box-shadow': ['rgb(17, 17, 20)'] });
    }
  });

  it('a decision is verified on the backdrop of ITS property: a pattern for the shadow is queried on the parent, one for the border on the card', async () => {
    const queries: Array<{ property: string | undefined; backdrops: string[] | undefined }> = [];
    const recording: ReferenceHooks = { ...stub({ border: '1px solid var(--border-card)' }), verify: async (a) => { queries.push({ property: a.query.colour?.property, backdrops: a.query.colour?.backdrops }); return { ok: true, applied: { border: '1px solid var(--border-card)' }, classification: 'approved-project-pattern', provenance: baseProvenance(), reasons: [] }; } };
    await resolveWithProps(recording, [decision({})], 'eWhiteInDark', ORDERS[0]);
    expect(queries).toEqual([{ property: 'border-top-color', backdrops: ['rgb(255, 255, 255)'] }]);
  });
});

describe('defect 9: an approved pattern is judged for visibility on the real backdrop like a DS-token judgment', () => {
  const dsNamed = stub({ border: '1px solid var(--border-card)' }); // a DS token kept by name: the colour mapper never saw it

  it('a DS hairline the pattern names is refused on a dark card (it used to be recorded with a colour-visible check it could already be seen to fail)', async () => {
    const t = targetOf(await resolveWith(dsNamed, [decision({})], 'eDark'));
    expect(t.outcome).toBe('unresolved');
    expect(t.decisionReason).toMatch(/not visible/);
  });

  it('on a light card the same pattern resolves, with the visibility check', async () => {
    const t = targetOf(await resolveWith(dsNamed, [decision({})], 'eLight'));
    expect(t, t.decisionReason).toMatchObject({ outcome: 'resolved-target', target: { token: '--border-card', value: 'rgba(0, 0, 0, 0.08)' } });
    expect(t.acceptance.some((a) => a.kind === 'colour-visible')).toBe(true);
  });

  it('an unknown surface (no page) is not judged - as the ds-token route - and is not silently taken for light', async () => {
    const out = await resolveTargets({ page: null, dsIndex: miniDsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: dsNamed, now }, { run: RUN, findings: [residual('f-card')], entries: [entryFor('eDark', 'f-card')], judgment: { decisions: [decision({})], notes: [] } });
    const t = out.file.targets.find((x) => x.property === 'border-top-color')!;
    expect(t.outcome).toBe('resolved-target');
    expect(t.acceptance.some((a) => a.kind === 'colour-visible')).toBe(true); // the rendered check still runs in R5/R8
  });
});

describe('determinism: resolved-targets.json is hashed into the G2 fingerprint', () => {
  it('two identical resolver runs write the same bytes (mapped colours, measured backdrops and all)', { timeout: 60_000 }, async () => {
    const { registryPath } = await registryWorld();
    const hooks = (await buildReferenceHooks({ registryPath, dsTokens: miniDsIndex() }))!;
    const run = async () => JSON.stringify((await resolveWith(hooks, [decision({}), decision({ state: 'hover' })])).file, null, 2);
    const first = await run();
    expect(await run()).toBe(first);
    expect(first).toMatch(/--semantic-hairline-faint/); // a mapped colour is in there, so the comparison is not vacuous
  });
});

describe.skipIf(!HAVE_REAL)('colour lane round 2 on the shipped registry, the real projects and the real DS (read-only)', () => {
  it('every pattern the shipped registry OFFERS for a light and for a dark card either resolves to a visible DS colour on the measured backdrop or is refused with its reason', { timeout: 240_000 }, async () => {
    const dsIndex = buildDsTokenIndex(REAL_DS);
    const hooks = (await buildReferenceHooks({ dsTokens: dsIndex }))!;
    let claimed = 0;
    let resolved = 0;
    for (const element of ['eLight', 'eDark', 'eWhiteInDark', 'eDarkInLight']) {
      const asked = await resolveTargets({ page, dsIndex, dsRegistryVersion: 'real', decisions: null, reference: hooks, now }, { run: RUN, findings: [residual('f-card')], entries: [entryFor(element, 'f-card')], judgment: null });
      const q = asked.residuals[0]!;
      const backdrop = (await measureBackdrop(page, `[data-fra-element="${element}"]`, 'border-top-color')).rgb;
      for (const c of q.candidatePatterns) {
        claimed++;
        const out = await resolveTargets({ page, dsIndex, dsRegistryVersion: 'real', decisions: null, reference: hooks, now }, { run: RUN, findings: [residual('f-card')], entries: [entryFor(element, 'f-card')], judgment: { decisions: [decision({ reference: { project: c.project, patternId: c.pattern } })], notes: [] } });
        const t = targetOf(out);
        const label = `${element} / ${c.project} / ${c.pattern}`;
        if (t.outcome !== 'resolved-target') {
          expect(t.target, label).toBeNull();
          expect(t.decisionReason, label).toMatch(/not accepted|no DS mapping|not visible|does not declare/i);
          continue;
        }
        resolved++;
        expect(t.target!.value, label).not.toMatch(/#[0-9a-f]{3,8}\b|\bred\b|\bblue\b/i);
        for (const m of t.provenance.reference!.colours) expect(m.outcome, label).not.toBe('unmapped');
        const colour = parseCssColour(t.target!.value);
        if (colour && backdrop) expect(assessColour({ role: 'border', colour, backdrops: [parseBackdrop(backdrop)!] }).ok, `${label}: ${t.target!.value} on ${backdrop}`).toBe(true);
      }
    }
    expect(claimed).toBeGreaterThan(0);
    expect(resolved).toBeGreaterThan(0);
  });

  it('two identical resolver runs on the real registry and DS write the same bytes', { timeout: 120_000 }, async () => {
    const dsIndex = buildDsTokenIndex(REAL_DS);
    const hooks = (await buildReferenceHooks({ dsTokens: dsIndex }))!;
    const asked = await resolveTargets({ page, dsIndex, dsRegistryVersion: 'real', decisions: null, reference: hooks, now }, { run: RUN, findings: [residual('f-card')], entries: [entryFor('eLight', 'f-card')], judgment: null });
    const c = asked.residuals[0]!.candidatePatterns.find((x) => x.pattern === 'flat-hairline-card') ?? asked.residuals[0]!.candidatePatterns[0]!;
    const run = async () => JSON.stringify((await resolveTargets({ page, dsIndex, dsRegistryVersion: 'real', decisions: null, reference: hooks, now }, { run: RUN, findings: [residual('f-card')], entries: [entryFor('eLight', 'f-card')], judgment: { decisions: [decision({ reference: { project: c.project, patternId: c.pattern } })], notes: [] } })).file);
    const first = await run();
    expect(await run()).toBe(first);
  });
});
