import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { AuditProperty, Finding } from '../../src/audit-link/index.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';
import { buildReferenceHooks } from '../../src/reference/hooks.ts';
import { buildDsTokenIndex } from '../../src/resolution/ds-evidence.ts';
import type { ResolutionDecision } from '../../src/resolution/judgment-schema.ts';
import { resolveTargets, type ReferenceHooks } from '../../src/resolution/resolve.ts';
import { authorizedProperties, blockedProperties, ResolutionFileSchema } from '../../src/resolution/schema.ts';
import { fingerprintOf } from '../../src/session/fingerprint.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Finding 5 — reference components are matched by SEMANTIC PURPOSE. The Resolver used to hand the registry the raw tag ("div") as the element
 * kind, so a card rendered as a <div> was rejected because the registry says card/panel, and candidate selection ignored the kind altogether.
 * These tests use only the Resolver's and the registry's public entry points, against the shipped approved-reference registry and a real page.
 */

const REF_ROOT = '/Users/sachin/Project-aura/project_aura1-main/projects';
const HAVE_REFS = existsSync(join(REF_ROOT, 'competition-benchmarking-v2-react'));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
.light{background:#fff;color:#333}
.grid{display:flex;gap:16px;padding:16px}
.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px}
.outer{width:600px}
</style></head><body>
<div class="light" data-variant="editorial-light">
  <div class="grid">
    <div class="tile" data-fra-element="eCardA"><h3>Plan A</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div>
    <div class="tile" data-fra-element="eCardB"><h3>Plan B</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#b">Read more</a></div>
    <div class="tile" data-fra-element="eCardC"><h3>Plan C</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#c">Read more</a></div>
  </div>
  <div class="outer" data-fra-element="eWrap"><div><h3>Heading</h3><p>Plain wrapper content with a few words in it.</p><svg width="24" height="24"></svg></div></div>
  <div class="outer"><div class="tile" data-fra-element="eSingle"><h3>Featured</h3><p>One featured offer, with no look-alike siblings.</p><svg width="24" height="24"></svg><a href="#f">Read more</a></div></div>
  <a class="tile" href="#anchor" data-fra-element="eAnchor"><h3>Blog</h3><p>An anchor card with text in it.</p></a>
  <div data-fra-element="eIcon" style="width:40px;height:40px;border:1px solid #ccc;cursor:pointer"><svg width="16" height="16"></svg></div>
  <input data-fra-element="eInput" type="text">
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
  const root = mkdtempSync(join(tmpdir(), 'resolver-kind-ds-'));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
const dsIndex = () => buildDsTokenIndex(makeDs({
  'tokens/build/tokens.css': ':root { --spacing-2: 0.5rem; }',
  'core-v2/src/styles/editorial-light.css': '@layer tokens { [data-variant="editorial-light"] { --border-soft: rgba(0, 0, 0, 0.08); } }',
}));

const prop = (over: Partial<AuditProperty> = {}): AuditProperty => ({ property: 'border-top-color', actual: 'rgb(0, 0, 0)', expected: null, expectedToken: null, source: null, status: 'UNRESOLVED', note: 'Observed value; no verified DS requirement for this property/part.', ...over });

function residual(id: string, productionType: string, signals: string[] = []): Finding {
  const f = makeFinding({ findingId: id, classification: 'NEEDS_REVIEW', mismatches: [] });
  f.comparison.properties = [prop()];
  f.component = { ...f.component, productionType, productionLabel: 'Credit Card offers', dsComponent: null, dsVariant: null };
  f.review = { status: 'NEEDS_REVIEW', reason: 'too little evidence to call it a DS component', node: 'B6', signals, possibleMatches: [{ dsComponent: 'ResourceCard', dsFile: 'atoms/ResourceCard.tsx', dsVariant: null, score: 0.2, why: 'x' }], observed: [] };
  return f;
}

function entryFor(element: string, findingId: string, tagName = 'div', extra: Partial<MappingEntry['affordances']> = {}): MappingEntry {
  return {
    element, stamp: element, findingIds: [findingId], signature: null, instanceIndex: null, instanceCount: null, sectionId: 'main', scope: 'content',
    resolution: { method: 'objective', confidence: 'confirmed', checks: { geometry: true, identity: true, text: true, classFingerprint: true, passedCount: 4 }, candidatesConsidered: 1 },
    drift: { class: 'identical', auditBox: null, liveBox: null, styleDeltas: [], note: '' },
    affordances: { tagName, role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false, ...extra },
    dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' },
  };
}

const FLAT = { project: 'competition-benchmarking-v2-react', patternId: 'flat-hairline-card' } as const;
const decision = (findingId: string, over: Partial<ResolutionDecision> = {}): ResolutionDecision => ({ findingId, property: 'border-top-color', part: 'self', state: 'default', outcome: 'resolved-target', value: 'var(--border-soft)', source: 'approved-project-pattern', dsToken: null, reference: FLAT, reason: 'the card needs a light hairline separation from its section', unresolvedReason: null, ...over });

const RUN = { runId: 'r', projectName: 'p', dataJsonSha256: 'd', fixPlanSha256: 'f' };
const now = () => new Date('2026-10-09T10:00:00Z');

async function hooks(): Promise<ReferenceHooks> {
  return (await buildReferenceHooks({ dsTokens: dsIndex() }))!;
}

async function run(f: Finding, entry: MappingEntry, decisions: ResolutionDecision[], reference: ReferenceHooks | null, withPage = true) {
  return resolveTargets({ page: withPage ? page : null, dsIndex: dsIndex(), dsRegistryVersion: 'v1', decisions: null, reference, now }, { run: RUN, findings: [f], entries: [entry], judgment: { decisions, notes: [] } });
}

const target = (out: Awaited<ReturnType<typeof run>>) => out.file.targets.find((t) => t.property === 'border-top-color')!;
const ids = (out: Awaited<ReturnType<typeof run>>) => out.residuals[0]!.candidatePatterns.map((c) => c.pattern);

describe.skipIf(!HAVE_REFS)('Resolver — a reference component is matched by what the element IS, not by its tag (shipped registry)', () => {
  it('a card rendered as a <div> accepts a compatible reference, by candidate selection AND by verification', async () => {
    const out = await run(residual('f-card', 'card'), entryFor('eCardA', 'f-card'), [decision('f-card')], await hooks());
    expect(ids(out)).toContain('flat-hairline-card');
    const t = target(out);
    expect(t.decisionReason).not.toMatch(/element-kind-compatible/);
    expect(t).toMatchObject({ outcome: 'resolved-target', provenance: { kind: 'approved-project-pattern' } });
    expect(t.provenance.reference!.elementKinds!.matched).toContain('card');
    expect(t.provenance.reference!.elementKinds!.evidence).toMatch(/<div> classified as card/);
    expect(out.file.elementKinds!.find((k) => k.findingId === 'f-card')).toMatchObject({ rulesVersion: 'element-kind-v3', kinds: [{ kind: 'card' }], raw: { tag: 'div', productionType: 'card' } });
    expect(out.residuals[0]!.elementKinds.kinds[0]).toMatchObject({ kind: 'card' });
  });

  it('a card rendered as an <a> (the real audit shape: every card residual is an anchor) accepts it too', async () => {
    const out = await run(residual('f-a', 'card', ['role=link', 'tag=a', 'cursor=pointer', 'has img', 'large clickable (area 82056px²) → card', '4 instance(s) of this pattern on the page']), entryFor('eAnchor', 'f-a', 'a', { href: '#anchor' }), [decision('f-a')], await hooks());
    expect(target(out)).toMatchObject({ outcome: 'resolved-target' });
    expect(out.residuals[0]!.elementKinds.kinds.map((k) => k.kind).sort()).toEqual(['card', 'link']);
  });

  it('an unrelated div does not: an icon button on a <div> is not offered a card pattern and a claim of one is refused — even when the reason says "card"', async () => {
    const out = await run(residual('f-icon', 'icon-button', ['cursor=pointer', 'has svg', 'small (40×40) clickable with no text → icon-button']), entryFor('eIcon', 'f-icon'), [decision('f-icon')], await hooks());
    expect(ids(out)).not.toContain('flat-hairline-card');
    expect(ids(out)).not.toContain('pdp-card-rest');
    expect(ids(out)).not.toContain('tinted-hairline-panel');
    const t = target(out);
    expect(t).toMatchObject({ outcome: 'unresolved', reason: 'policy-conflict', target: null });
    expect(t.decisionReason).toMatch(/not among the candidates offered/); // refused before verification, because it was never offered
    expect(authorizedProperties(out.file, 'f-icon').size).toBe(0);
    // ... and verification, which is still the second line, refuses it for the element kind on its own
    const q = out.residuals[0]!;
    const v = await (await hooks()).verify({ project: FLAT.project, pattern: FLAT.patternId, query: { category: 'subtle-border', purpose: 'card hairline separation', surface: 'light', viewport: 'any', elementKinds: q.elementKinds.kinds.map((k) => k.kind), elementEvidence: { tag: q.elementKinds.raw.tag, role: q.elementKinds.raw.role, productionType: q.elementKinds.raw.productionType, summary: q.elementKinds.summary }, properties: [] } });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/element-kind-compatible.*classified as button/s);
  });

  it('a bare <div> with no evidence names no component category: no candidates, a stated reason, and the claim is refused with why', async () => {
    const out = await run(residual('f-bare', 'something-unrecognised'), entryFor('eWrap', 'f-bare'), [decision('f-bare')], await hooks(), false);
    expect(out.residuals[0]!.candidatePatterns).toEqual([]);
    expect(out.residuals[0]!.candidatePatternsNote).toMatch(/no component category/);
    const t = target(out);
    expect(t.outcome).toBe('unresolved');
    expect(t.decisionReason).toMatch(/not among the candidates offered for this finding \(none\)/);
    expect(out.file.elementKinds!.find((k) => k.findingId === 'f-bare')!.kinds).toEqual([]);
    // verification refuses it for the kind on its own as well
    const v = await (await hooks()).verify({ project: FLAT.project, pattern: FLAT.patternId, query: { category: 'subtle-border', purpose: 'card hairline separation', surface: 'light', viewport: 'any', elementKinds: [], elementEvidence: { tag: 'div', role: null, productionType: null, summary: out.residuals[0]!.elementKinds.summary }, properties: [] } });
    expect(v.reasons.join(' ')).toMatch(/element-kind-compatible.*a tag or ARIA role alone does not name a component category/s);
  });

  it('a title inside a card is not the card', async () => {
    const out = await run(residual('f-title', 'section-heading', ['role=heading', 'tag=h3', 'inside clickable e602 — a card or link title, not evidently a section heading']), entryFor('eCardA', 'f-title', 'h3'), [decision('f-title')], await hooks(), false);
    expect(ids(out)).not.toContain('flat-hairline-card');
    expect(target(out)).toMatchObject({ outcome: 'unresolved' });
    expect(out.file.elementKinds![0]).toMatchObject({ partOf: 'card' });
  });

  it('an input is offered the input pattern only, and a card pattern is refused for it', async () => {
    const out = await run(residual('f-in', 'input'), entryFor('eInput', 'f-in', 'input', { type: 'text' }), [decision('f-in')], await hooks());
    expect(ids(out)).toEqual(['hairline-border-scale']);
    expect(target(out).outcome).toBe('unresolved');
  });

  it('structure alone (no audit type): a repeated bordered card is classified from the rendered page; a plain wrapper div is not', async () => {
    const card = await run(residual('f-sc', 'unknown'), entryFor('eCardB', 'f-sc'), [], await hooks());
    expect(card.residuals[0]!.elementKinds.kinds.map((k) => k.kind)).toEqual(['card']);
    expect(card.residuals[0]!.elementKinds.kinds[0]!.evidence.join(' ')).toMatch(/structure: .*bordered.*composed.*repeated/);
    expect(ids(card)).toContain('flat-hairline-card');
    const wrap = await run(residual('f-sw', 'unknown'), entryFor('eWrap', 'f-sw'), [], await hooks());
    expect(wrap.residuals[0]!.elementKinds.kinds).toEqual([]);
    expect(wrap.residuals[0]!.candidatePatterns).toEqual([]);
    expect(wrap.residuals[0]!.candidatePatternsNote).toMatch(/no component category/);
    // deterministic: a second run records byte-identical kinds
    const again = await run(residual('f-sc', 'unknown'), entryFor('eCardB', 'f-sc'), [], await hooks());
    expect(JSON.stringify(again.file.elementKinds)).toBe(JSON.stringify(card.file.elementKinds));
  });

  it('every candidate offered passes the surface, viewport and element-kind checks of the verifier (selection equals verification)', async () => {
    const h = await hooks();
    for (const [id, type, element, tag] of [['p-card', 'card', 'eCardA', 'div'], ['p-input', 'input', 'eInput', 'input'], ['p-btn', 'icon-button', 'eIcon', 'div']] as const) {
      const out = await run(residual(id, type), entryFor(element, id, tag), [], h);
      const q = out.residuals[0]!;
      for (const c of q.candidatePatterns) {
        const v = await h.verify({ project: c.project, pattern: c.pattern, query: { category: 'subtle-border', purpose: c.purpose, surface: 'light', viewport: 'any', elementKinds: q.elementKinds.kinds.map((k) => k.kind), properties: [] } });
        expect(v.reasons.filter((r) => /^(element-kind-compatible|surface-compatible|viewport-applicable)/.test(r)), `${type} ${c.pattern}`).toEqual([]);
      }
    }
  });

  it('the resolved-targets file with the new optional field still parses, and so does an old file without it', async () => {
    const out = await run(residual('f-card', 'card'), entryFor('eCardA', 'f-card'), [decision('f-card')], await hooks());
    expect(ResolutionFileSchema.parse(JSON.parse(JSON.stringify(out.file)))).toEqual(out.file);
    const { elementKinds: _dropped, ...old } = out.file;
    expect(ResolutionFileSchema.parse(JSON.parse(JSON.stringify(old))).elementKinds).toBeUndefined();
  });
});

describe.skipIf(!HAVE_REFS)('hooks.find — candidate selection applies the same semantic kind, surface and viewport as verification', () => {
  const base = { category: 'card-separation' as const, purpose: 'light separation of a card from its section', surface: 'light' as const, viewport: 'any' as const, properties: [] };
  const names = async (q: Partial<Parameters<ReferenceHooks['find']>[0]>) => (await hooks()).find({ ...base, elementKinds: [], ...q }).map((c) => c.pattern);

  it('a card is offered the card patterns, not the dark-surface pattern, the strip, the panel or the accordion', async () => {
    const got = await names({ elementKinds: ['card'] });
    expect(got).toEqual(expect.arrayContaining(['flat-hairline-card', 'pdp-card-rest', 'hairline-border-scale']));
    for (const wrong of ['hairline-border-on-dark', 'hairline-rule-strip', 'tinted-hairline-panel', 'faq-accordion-row']) expect(got, wrong).not.toContain(wrong);
  });

  it('a panel is offered the tinted panel; an accordion reaches the accordion pattern; a dark surface reaches the dark pattern', async () => {
    expect(await names({ elementKinds: ['panel'] })).toContain('tinted-hairline-panel');
    // the Resolver's purpose for an accordion names it (the kind classification is part of the purpose text); a card-separation purpose shares no word with the FAQ row
    // pattern, which verification would refuse on purpose-matches, so it is no longer offered for one (round 2: what is offered is what can be verified)
    expect(await names({ elementKinds: ['accordion'], purpose: 'a faq accordion row classified as accordion' })).toEqual(['faq-accordion-row']);
    expect(await names({ elementKinds: ['accordion'] })).toEqual([]);
    expect(await names({ elementKinds: ['card'], surface: 'dark' })).toEqual(['hairline-border-on-dark']);
  });

  it('no kind, or a raw tag, offers nothing — and the 6-candidate cap can no longer be filled by patterns that would be rejected', async () => {
    expect(await names({ elementKinds: [] })).toEqual([]);
    expect(await names({ elementKinds: ['div'] })).toEqual([]);
    expect(await names({ elementKinds: ['button'] })).toEqual([]);
    expect(await names({ elementKinds: ['link'] })).toEqual([]);
  });
});

describe.skipIf(!HAVE_REFS)('Resolver — defects found in review of the semantic kinds', () => {
  const targetOf = (out: Awaited<ReturnType<typeof run>>, part: string) => out.file.targets.find((t) => t.property === 'border-top-color' && t.part === part)!;

  it('a reference treatment applies to the finding element: a decision for the label or the descendants is refused and authorizes nothing', async () => {
    for (const part of ['label', 'descendants']) {
      const id = `f-part-${part}`;
      const out = await run(residual(id, 'card'), entryFor('eCardA', id), [decision(id, { part })], await hooks());
      const t = targetOf(out, part);
      expect(t, part).toMatchObject({ outcome: 'unresolved', reason: 'policy-conflict', target: null });
      expect(t.decisionReason, part).toMatch(/reference treatments apply to the finding element/);
      expect(t.decisionReason, part).not.toMatch(/fits this card/);
      expect(authorizedProperties(out.file, id).size, part).toBe(0);
    }
  });

  it('the same decision for the element itself (part self) still resolves and authorizes the property', async () => {
    const out = await run(residual('f-part-self', 'card'), entryFor('eCardA', 'f-part-self'), [decision('f-part-self')], await hooks());
    expect(targetOf(out, 'self')).toMatchObject({ outcome: 'resolved-target' });
    expect([...authorizedProperties(out.file, 'f-part-self')]).toEqual(['border-top-color']);
  });

  it('authorizedProperties and blockedProperties count only targets of the element itself', async () => {
    const out = await run(residual('f-auth', 'card'), entryFor('eCardA', 'f-auth'), [decision('f-auth')], await hooks());
    const self = targetOf(out, 'self');
    const labelTarget = { ...self, id: 'l', part: 'label' };
    const file = { ...out.file, targets: [labelTarget] };
    expect(authorizedProperties(file, 'f-auth').size).toBe(0);
    const preservedLabel = { ...self, id: 'p', part: 'label', outcome: 'preserve-existing' as const, target: null };
    expect(blockedProperties({ ...out.file, targets: [preservedLabel] }, 'f-auth').size).toBe(0);
  });

  it('a card typed by the audit is offered the card patterns only: no panel pattern, no accordion row — single or repeated', async () => {
    for (const element of ['eSingle', 'eCardA']) {
      const out = await run(residual(`f-${element}`, 'card'), entryFor(element, `f-${element}`), [], await hooks());
      expect(out.residuals[0]!.elementKinds.kinds.map((k) => k.kind), element).toEqual(['card']);
      expect(ids(out), element).toContain('flat-hairline-card');
      expect(ids(out), element).not.toContain('tinted-hairline-panel');
      expect(ids(out), element).not.toContain('faq-accordion-row');
    }
  });

  it('a claim that is not among the candidates OFFERED for the finding is refused, however the reason is worded (a panel cannot take the FAQ row)', async () => {
    const h = await hooks();
    const reason = 'faq style very faint hairline border separated panel';
    const out = await run(residual('f-panel', 'panel'), entryFor('eSingle', 'f-panel'), [decision('f-panel', { reference: { project: 'competition-benchmarking-v2-react', patternId: 'faq-accordion-row' }, reason })], h);
    expect(ids(out)).not.toContain('faq-accordion-row');
    const t = target(out);
    expect(t).toMatchObject({ outcome: 'unresolved', reason: 'policy-conflict', target: null });
    expect(t.decisionReason).toMatch(/not among the candidates offered/);
    expect(authorizedProperties(out.file, 'f-panel').size).toBe(0);
  });

  it('a candidate that WAS offered is accepted (the offered set is what the judge saw)', async () => {
    const out = await run(residual('f-offered', 'panel'), entryFor('eSingle', 'f-offered'), [decision('f-offered', { reference: { project: 'competition-benchmarking-v2-react', patternId: 'tinted-hairline-panel' } })], await hooks());
    expect(ids(out)).toContain('tinted-hairline-panel');
    expect(target(out)).toMatchObject({ outcome: 'resolved-target' });
  });

  it('the purpose a claim is verified against is built from audit evidence only: not the judgment reason, not the page label', async () => {
    const h = await hooks();
    const seen: string[] = [];
    const spy: ReferenceHooks = { ...h, verify: async (a) => { seen.push(a.query.purpose); return h.verify(a); } };
    const f = residual('f-purpose', 'card');
    await run(f, entryFor('eCardA', 'f-purpose'), [decision('f-purpose', { reason: 'zzqq-marker-from-the-judgment wording' })], spy);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/zzqq-marker/);
    expect(seen[0]).not.toMatch(/Credit Card offers/);
    expect(seen[0]).toMatch(/\bcard\b/);
    expect(seen[0]).toMatch(/too little evidence/); // the audit's own review reason
  });

  it('a failed probe leaves a note and a sources entry; an unmatched selector, no page and an unmapped finding are each stated', async () => {
    const h = await hooks();
    const broken = { $: async () => { throw new Error('boom: target closed'); } } as unknown as Page;
    const failed = await resolveTargets({ page: broken, dsIndex: dsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: h, now }, { run: RUN, findings: [residual('f-fail', 'card')], entries: [entryFor('eCardA', 'f-fail')] });
    expect(failed.file.notes.join('\n')).toMatch(/structure probe for f-fail.*failed: boom: target closed/);
    expect(failed.file.elementKinds![0]).toMatchObject({ structureProbe: 'failed', sources: ['audit', 'mapping'], viewport: null });
    expect(failed.residuals[0]!.elementKinds.kinds.map((k) => k.kind)).toEqual(['card']); // audit evidence still classifies

    const missing = await run(residual('f-gone', 'card'), entryFor('eNotOnThePage', 'f-gone'), [], h);
    expect(missing.file.notes.join('\n')).toMatch(/structure probe for f-gone.*no element matched/);
    expect(missing.file.elementKinds![0]).toMatchObject({ structureProbe: 'not-found', viewport: null });

    const noPage = await run(residual('f-nopage', 'card'), entryFor('eCardA', 'f-nopage'), [], h, false);
    expect(noPage.file.elementKinds![0]).toMatchObject({ structureProbe: 'no-page', sources: ['audit', 'mapping'], viewport: null });

    const unmapped = await resolveTargets({ page, dsIndex: dsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: h, now }, { run: RUN, findings: [residual('f-unmapped', 'card')], entries: [] });
    expect(unmapped.file.elementKinds![0]).toMatchObject({ structureProbe: 'not-mapped', sources: ['audit'] });

    const read = await run(residual('f-read', 'card'), entryFor('eCardA', 'f-read'), [], h);
    expect(read.file.elementKinds![0]).toMatchObject({ structureProbe: 'read', sources: ['audit', 'mapping', 'structure'], viewport: 'desktop' });
    expect(read.file.notes.filter((n) => /structure probe/.test(n))).toEqual([]);
  });

  it('resuming without a page: the accepted decision is re-verified from the audit evidence and the record says structure was not read', async () => {
    const h = await hooks();
    const withPage = await run(residual('f-resume', 'card'), entryFor('eCardA', 'f-resume'), [decision('f-resume')], h);
    const without = await run(residual('f-resume', 'card'), entryFor('eCardA', 'f-resume'), [decision('f-resume')], h, false);
    expect(target(without)).toMatchObject({ outcome: 'resolved-target' });
    expect(target(withPage)).toMatchObject({ outcome: 'resolved-target' });
    expect(without.file.elementKinds![0]!.sources).not.toContain('structure');
    expect(withPage.file.elementKinds![0]!.sources).toContain('structure');
    expect(without.file.elementKinds![0]!.viewport).toBeNull();
  });

  it('a card that fades and scales in is classified the same, with the same candidates, mid-animation and after it: the element-kind records (hashed into the G2 fingerprint) do not flap', async () => {
    const animated = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await animated.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
@keyframes reveal{from{opacity:0;transform:scale(.2) translateY(40px)}to{opacity:1;transform:none}}
.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px;animation:reveal 800ms linear 500ms both}
</style></head><body><div data-variant="editorial-light" style="background:#fff"><div class="tile" data-fra-element="eFade"><h3>Plan A</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div></div></body></html>`);
    const h = await hooks();
    const at = async () => resolveTargets({ page: animated, dsIndex: dsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: h, now }, { run: RUN, findings: [residual('f-fade', 'card')], entries: [entryFor('eFade', 'f-fade')], judgment: { decisions: [decision('f-fade')], notes: [] } });
    const during = await at();
    await animated.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished'), undefined, { timeout: 30_000 }); // animation STATE, not a sleep
    const after = await at();
    expect(during.file.elementKinds![0]!.kinds.map((k) => k.kind)).toEqual(['card']);
    expect(ids(during)).toContain('flat-hairline-card');
    expect(target(during)).toMatchObject({ outcome: 'resolved-target' });
    // the element-kind records and the candidates are what this lane hashes into the G2 fingerprint: they are identical
    expect(JSON.stringify(during.file.elementKinds)).toBe(JSON.stringify(after.file.elementKinds));
    // ... and so is the WHOLE resolved-targets.json (round 2: the colour backdrop of a fading element no longer depends on its opacity, so the recorded
    // backdrop source does not flap between 'ds-section-tokens' and 'measured')
    expect(JSON.stringify(during.file)).toBe(JSON.stringify(after.file));
    expect(fingerprintOf(during.file.elementKinds)).toBe(fingerprintOf(after.file.elementKinds));
    expect(ids(during)).toEqual(ids(after));
    expect(target(after)).toMatchObject({ outcome: 'resolved-target' });
    expect(target(during).provenance.reference!.colours[0]!.backdropSource).toBe('measured');
  }, 60_000);

  it('resolved-targets.json is BYTE-STABLE at any point of a fade-in: the animation is paused at the start, half-way and the end and the whole file is identical (the element\'s own opacity is not an input)', async () => {
    const animated = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await animated.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
@keyframes reveal{from{opacity:0;transform:scale(.2) translateY(40px)}to{opacity:1;transform:none}}
.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px;animation:reveal 800ms linear 500ms both}
</style></head><body><div data-variant="editorial-light" style="background:#fff"><div class="tile" data-fra-element="eFade"><h3>Plan A</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div></div></body></html>`);
    const h = await hooks();
    const at = async (ms: number) => {
      await animated.evaluate((t) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t; }), ms);
      return resolveTargets({ page: animated, dsIndex: dsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: h, now }, { run: RUN, findings: [residual('f-fade', 'card')], entries: [entryFor('eFade', 'f-fade')], judgment: { decisions: [decision('f-fade')], notes: [] } });
    };
    const frames = [await at(0), await at(900), await at(1400)]; // opacity 0, ~0.5, 1
    expect(await animated.evaluate(() => getComputedStyle(document.querySelector('[data-fra-element="eFade"]')!).opacity)).toBe('1');
    const json = frames.map((f) => JSON.stringify(f.file));
    expect(new Set(json).size).toBe(1);
    expect(target(frames[0]!)).toMatchObject({ outcome: 'resolved-target' });
    expect(target(frames[0]!).provenance.reference!.colours[0]!.backdropSource).toBe('measured');
  }, 60_000);

  it('resolved-targets.json is byte-stable when an ANCESTOR (the section wrapper) fades in or transitions its background: the backdrop is read once the chain has settled', async () => {
    const animated = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await animated.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
@keyframes sect{from{opacity:0;background-color:#fff}to{opacity:1;background-color:#f6f6f6}}
.sect{animation:sect 1800ms linear 0s both}
.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px}
</style></head><body><div class="sect" data-variant="editorial-light"><div class="tile" data-fra-element="eAnc"><h3>Plan A</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div></div></body></html>`);
    const h = await hooks();
    const at = async () => resolveTargets({ page: animated, dsIndex: dsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: h, now }, { run: RUN, findings: [residual('f-anc', 'card')], entries: [entryFor('eAnc', 'f-anc')], judgment: { decisions: [decision('f-anc')], notes: [] } });
    const during = await at(); // the wrapper is still fading (partial opacity) and changing colour when the resolver starts
    await animated.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished'), undefined, { timeout: 30_000 });
    const after = await at();
    expect(JSON.stringify(during.file)).toBe(JSON.stringify(after.file));
    // the settled backdrop is what the mapping was judged on, whichever moment the resolver started
    expect(target(during)).toMatchObject({ outcome: 'resolved-target' });
    expect(target(during).provenance.reference!.colours[0]!.backdropSource).toBe('measured');
    expect(target(during).provenance.reference!.colours[0]!.backdrops).toEqual(['rgb(246, 246, 246)']);
  }, 60_000);

  it('an ancestor that never stops changing colour: its surface and backdrop are NOT read (unknown / unmeasurable, said in the notes) and the file is the same at any moment', async () => {
    const animated = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await animated.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
@keyframes pulse{from{background-color:#ffffff}to{background-color:#c8c8c8}}
.sect{animation:pulse 700ms linear infinite alternate}
.tile{display:block;box-sizing:border-box;width:300px;height:200px;border:1px solid #ccc;padding:16px}
</style></head><body><div class="sect" data-variant="editorial-light"><div class="tile" data-fra-element="eEnd"><h3>Plan A</h3><p>Some descriptive text about the plan.</p><svg width="24" height="24"></svg><a href="#a">Read more</a></div></div></body></html>`);
    const h = await hooks();
    const at = async () => resolveTargets({ page: animated, dsIndex: dsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: h, now }, { run: RUN, findings: [residual('f-end', 'card')], entries: [entryFor('eEnd', 'f-end')], judgment: { decisions: [decision('f-end')], notes: [] } });
    const first = await at();
    await animated.waitForTimeout(333);
    const second = await at();
    expect(JSON.stringify(first.file)).toBe(JSON.stringify(second.file));
    expect(first.file.notes.join(' ')).toMatch(/still animating/);
    expect(first.residuals[0]!.backdrop).toMatchObject({ color: null, source: 'ds-section-tokens' });
    expect(first.residuals[0]!.surface).toBe('unknown');
  }, 60_000);

  it('the new record fields parse, and a file written before them still parses', async () => {
    const out = await run(residual('f-schema', 'card'), entryFor('eCardA', 'f-schema'), [], await hooks());
    expect(ResolutionFileSchema.parse(JSON.parse(JSON.stringify(out.file)))).toEqual(out.file);
    const stripped = JSON.parse(JSON.stringify(out.file)) as { elementKinds: Array<Record<string, unknown>> };
    for (const k of stripped.elementKinds) { delete k.viewport; delete k.structureProbe; }
    expect(ResolutionFileSchema.safeParse(stripped).success).toBe(true);
  });
});
