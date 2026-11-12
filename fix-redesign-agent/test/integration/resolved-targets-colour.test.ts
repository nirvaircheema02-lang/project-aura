import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { measureResolvedTarget } from '../../src/preview/targets.ts';
import { measureTarget } from '../../src/resolution/resolve.ts';
import { ColourMappingSchema, type ColourMapping, type ResolvedTarget } from '../../src/resolution/schema.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Finding 3, verification: a colour target is "verified" only if the rendered colour EQUALS the value AND it is visible on the backdrop it is actually drawn
 * over (and, for a hover/focus target, distinguishable from the default). An invisible or collapsed colour is `failed`; an unmeasurable backdrop is
 * `unverified`. The result is written into the target's reference provenance, so R5 (live DOM) and R8 (rendered preview) report the same thing.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
.pad{padding:20px}
.box{width:120px;height:40px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08)}
.hov{border-color:rgba(0,0,0,.08)} .hov:hover{border-color:rgba(0,0,0,.08)}
.hov2{border-color:rgba(0,0,0,.08)} .hov2:hover{border-color:rgba(0,0,0,.15)}
</style></head><body>
<div class="pad" style="background:#fff"><div class="box" data-finding-ids="fLight" data-fra-element="eLight"></div></div>
<div class="pad" style="background:#111114"><div class="box" data-finding-ids="fDark" data-fra-element="eDark"></div></div>
<div class="pad" style="background:linear-gradient(#fff,#eee)"><div class="box" data-finding-ids="fGrad" data-fra-element="eGrad"></div></div>
<div class="pad" style="background:#fff"><div class="box hov" data-finding-ids="fHovSame" data-fra-element="eHovSame"></div></div>
<div class="pad" style="background:#fff"><div class="box hov2" data-finding-ids="fHovOk" data-fra-element="eHovOk"></div></div>
<div class="pad" style="background:#fff;opacity:.5"><div class="box" data-finding-ids="fFaded" data-fra-element="eFaded"></div></div>
<script>window.__pvVerify = { findByFinding: (id) => document.querySelector('[data-finding-ids~="' + id + '"]') };</script>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await page.setContent(PAGE);
});
afterAll(async () => { await browser.close(); });

const mapping = (state: ResolvedTarget['state'] = 'default'): ColourMapping => ColourMappingSchema.parse({
  property: 'border', declaration: '1px solid var(--soft-edge)', referenceValue: 'var(--soft-edge)', referenceResolved: 'rgba(0,0,0,.08)', referenceRgba: { r: 0, g: 0, b: 0, alpha: 0.08 },
  referenceToken: '--soft-edge', referenceChain: ['--soft-edge'], role: 'border', state, theme: 'light', backdrops: ['rgb(255, 255, 255)'], backdropSource: 'measured',
  outcome: 'exact', sameName: false, nameCollision: null, dsToken: '--border-card', dsValue: 'rgba(0, 0, 0, 0.08)', dsScope: null, dsFile: 'base.css', tier: 'role', keyword: null,
  distance: { deltaE: 0, perBackdrop: [0], alphaDelta: 0, strengthRatio: 1 }, reason: 'exact', rejected: [],
  verification: { designTime: { polarityOk: true, strengthOk: true, contrastOk: null, stateDistinct: null }, rendered: { status: 'not-run', measuredBy: null, backdrop: null, strength: null, detail: null } },
});

function target(findingId: string, over: Partial<ResolvedTarget> = {}, extraAcceptance: ResolvedTarget['acceptance'] = []): ResolvedTarget {
  const state = over.state ?? 'default';
  return {
    id: `t-${findingId}-${state}`, findingId, property: 'border-top-color', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state,
    audit: { status: 'NOT-LISTED', actual: null, expected: null, expectedToken: null, note: null, source: null }, reason: 'missing-ds-treatment', outcome: 'resolved-target',
    target: { value: 'rgba(0, 0, 0, 0.08)', comparison: 'color-deltaE', token: '--border-card' },
    provenance: { kind: 'approved-project-pattern', ds: null, reference: { project: 'p', pattern: 'x', sourcePath: '/p', file: 'a.css', fileSha256: 'a', projectHash: 'b', classification: 'approved-project-pattern', dsGrounded: true, tokens: [], renderingEvidence: 'source-only', note: null, colours: [mapping(state)] }, evidence: [] },
    decisionReason: 'test', route: 'css-edit',
    acceptance: [
      { kind: 'property-equals', property: 'border-top-color', state, viewport: 'any', comparison: 'color-deltaE', expected: 'rgba(0, 0, 0, 0.08)' },
      { kind: 'colour-visible', property: 'border-top-color', state, viewport: 'any', comparison: 'color-deltaE', expected: 'border:1.5' },
      ...extraAcceptance,
    ],
    status: { design: 'resolved', implementation: 'applied', verification: 'not-run', implementationDetail: null, verificationDetail: null },
    ...over,
  };
}
const rendered = (t: ResolvedTarget) => t.provenance.reference!.colours[0]!.verification.rendered;

describe('R8 - the rendered preview', () => {
  it('equal AND visible on its real backdrop: matches, and the measured backdrop and strength are recorded in the provenance', async () => {
    const t = target('fLight');
    const m = await measureResolvedTarget(page, t);
    expect(m).toMatchObject({ measured: true, matches: true });
    expect(rendered(t)).toMatchObject({ status: 'passed', measuredBy: 'R8', backdrop: 'rgb(255, 255, 255)' });
    expect(rendered(t).strength).toBeGreaterThan(3);
  });

  it('a value that EQUALS the target but is invisible on its backdrop FAILS (equality is not usability)', async () => {
    const t = target('fDark');
    const m = await measureResolvedTarget(page, t);
    expect(m.measured).toBe(true);
    expect(m.matches).toBe(false);
    expect(m.note).toMatch(/not visible/);
    expect(rendered(t)).toMatchObject({ status: 'failed', measuredBy: 'R8', backdrop: 'rgb(17, 17, 20)' });
    expect(rendered(t).strength).toBeLessThan(1.5);
  });

  it('a backdrop that cannot be measured (gradient, translucent ancestor) leaves the target unverified - never passed', async () => {
    for (const id of ['fGrad', 'fFaded']) {
      const t = target(id);
      const m = await measureResolvedTarget(page, t);
      expect(m.measured, id).toBe(false);
      expect(m.matches, id).toBe(false);
      expect(m.note, id).toMatch(/backdrop/);
      expect(rendered(t).status, id).toBe('unverified');
    }
  });

  it('a hover target whose colour is the same as the default state collapses the two states: failed', async () => {
    const t = target('fHovSame', { state: 'hover' }, [{ kind: 'state-distinct', property: 'border-top-color', state: 'hover', viewport: 'any', comparison: 'color-deltaE', expected: '2' }]);
    const m = await measureResolvedTarget(page, t);
    expect(m.matches).toBe(false);
    expect(m.note).toMatch(/default|distinguish/);
    expect(rendered(t).status).toBe('failed');
  });

  it('a hover colour that differs enough from the default passes the state-distinct check', async () => {
    const t = target('fHovOk', { state: 'hover', target: { value: 'rgba(0, 0, 0, 0.15)', comparison: 'color-deltaE', token: '--border-input' } }, [{ kind: 'state-distinct', property: 'border-top-color', state: 'hover', viewport: 'any', comparison: 'color-deltaE', expected: '2' }]);
    t.acceptance[0]!.expected = 'rgba(0, 0, 0, 0.15)';
    const m = await measureResolvedTarget(page, t);
    expect(m, m.note).toMatchObject({ measured: true, matches: true });
    expect(rendered(t).status).toBe('passed');
  });

  it('a target without a colour-visible check is measured exactly as before', async () => {
    const t = target('fDark');
    t.acceptance = t.acceptance.filter((a) => a.kind === 'property-equals');
    const m = await measureResolvedTarget(page, t);
    expect(m.matches).toBe(true);
    expect(rendered(t).status).toBe('not-run');
  });
});

describe('R5 - the live page (same acceptance, same provenance)', () => {
  it('fails an invisible colour whose value matches, passes a visible one, and reports an unmeasurable backdrop as unverified', async () => {
    const dark = target('fDark');
    const rDark = await measureTarget(page, '[data-fra-element="eDark"]', dark);
    expect(rDark.matches).toBe(false);
    expect(rDark.note).toMatch(/not visible/);
    expect(rendered(dark)).toMatchObject({ status: 'failed', measuredBy: 'R5' });

    const light = target('fLight');
    expect((await measureTarget(page, '[data-fra-element="eLight"]', light)).matches).toBe(true);
    expect(rendered(light)).toMatchObject({ status: 'passed', measuredBy: 'R5' });

    const grad = target('fGrad');
    const rGrad = await measureTarget(page, '[data-fra-element="eGrad"]', grad);
    expect(rGrad.matches).toBe(false);
    expect((rGrad as { unverified?: boolean }).unverified).toBe(true);
    expect(rendered(grad).status).toBe('unverified');
  });
});
