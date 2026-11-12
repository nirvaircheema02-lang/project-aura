import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { resolveTargets } from '../../src/resolution/resolve.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';
import { decision, entryFor, now, prop, residual, RUN } from '../helpers/resolver-stub.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 90_000 });

/**
 * Reference lane round 4 (10): an ENDLESS colour animation that is not on the element or its ancestors still decides what lies behind it - an out-of-flow SIBLING
 * layer that overlaps the box, and a ::before / ::after layer of an ancestor (pseudo-element animations are not in `element.getAnimations()`). A hold-style cycle
 * (transparent for 45 %, dark for 45 %) passes three equal reads and gave "measured white" at one phase and "unmeasurable" at another: two files for one page. Both are
 * now unsettled outright - the same recorded answer at any phase - while an animation that cannot reach the box (a far sibling, a spinner) is no obstacle.
 */

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
});
afterAll(async () => { await browser.close(); cleanupDsFixtures(); });

async function resolveNow() {
  const f = residual('f-card', 'card', [prop()]);
  const out = await resolveTargets(
    { page, dsIndex: miniDsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: null, now },
    { run: RUN, findings: [f], entries: [entryFor('eCard', 'f-card')], judgment: { decisions: [decision({ source: 'ds-token', dsToken: '--border-soft', reference: null, value: 'var(--border-soft)' })], notes: [] } },
  );
  return { json: JSON.stringify({ file: out.file, residuals: out.residuals }), residual: out.residuals[0]!, notes: out.file.notes };
}

const pageWith = (body: string, extraCss = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
@keyframes cyc{0%,45%{background:transparent}50%,95%{background:#111114}100%{background:transparent}}
@keyframes spin{to{transform:rotate(360deg)}}
.wrap{position:relative;background:#f5f2f1;padding:12px;width:400px}
.layer{position:absolute;left:0;top:0;right:0;bottom:0;animation:cyc 4s linear infinite}
.card{position:relative;width:160px;height:50px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08)}
${extraCss}
</style></head><body>${body}</body></html>`;
const phase = (ms: number) => page.evaluate((t) => document.getAnimations().forEach((a) => { a.currentTime = t; }), ms);
const phases = async (): Promise<{ runs: string[]; last: Awaited<ReturnType<typeof resolveNow>> }> => {
  const runs: string[] = [];
  let last!: Awaited<ReturnType<typeof resolveNow>>;
  for (const ms of [200, 2600, 1000, 3500]) {
    await phase(ms);
    last = await resolveNow();
    runs.push(last.json);
  }
  return { runs, last };
};

describe('an endless colour animation on a layer that is not on the element chain', () => {
  it.each([
    ['an out-of-flow SIBLING layer', '<div class="wrap"><div class="layer"></div><div class="card" data-fra-element="eCard"></div></div>', ''],
    ['an ancestor\'s ::before layer', '<div class="wrap"><div class="card" data-fra-element="eCard"></div></div>', '.wrap::before{content:"";position:absolute;left:0;top:0;right:0;bottom:0;animation:cyc 4s linear infinite}'],
    ['an ancestor\'s ::after layer', '<div class="wrap"><div class="card" data-fra-element="eCard"></div></div>', '.wrap::after{content:"";position:absolute;left:0;top:0;right:0;bottom:0;animation:cyc 4s linear infinite}'],
    ['a sibling of an ANCESTOR (the layer sits beside the section wrapper)', '<div class="outer" style="position:relative"><div class="layer"></div><div class="wrap"><div class="card" data-fra-element="eCard"></div></div></div>', ''],
    ['an overlapping sibling\'s ::before layer', '<div class="wrap"><div class="sib"></div><div class="card" data-fra-element="eCard"></div></div>', '.sib{position:absolute;left:0;top:0;right:0;bottom:0}.sib::before{content:"";position:absolute;left:0;top:0;right:0;bottom:0;animation:cyc 4s linear infinite}'],
    ['a layer INSIDE an overlapping sibling', '<div class="wrap"><div style="position:absolute;left:0;top:0;right:0;bottom:0"><div class="layer"></div></div><div class="card" data-fra-element="eCard"></div></div>', ''],
  ])('%s: four phases give ONE file, the surface and backdrop are not read and the reason is noted', async (_name, body, css) => {
    await page.setContent(pageWith(body, css));
    const { runs, last } = await phases();
    expect(new Set(runs).size, 'the recorded file differs between phases').toBe(1);
    expect(last.residual.surface).toBe('unknown');
    expect(last.residual.backdrop).toMatchObject({ color: null, source: 'ds-section-tokens' });
    expect(last.residual.backdrop!.why).toMatch(/endless animation/);
    expect(last.notes.join(' ')).toMatch(/endless animation/);
  });

  it.each([
    ['a sibling layer far from the box', '<div class="wrap"><div class="layer" style="left:600px;width:20px;height:20px;right:auto;bottom:auto"></div><div class="card" data-fra-element="eCard"></div></div>', ''],
    ['an endless animation of a transform only (a spinner beside it)', '<div class="wrap"><div class="layer" style="animation:spin 3s linear infinite;background:none"></div><div class="card" data-fra-element="eCard"></div></div>', ''],
    ['the ::before layer of a sibling that does not overlap', '<div class="wrap"><div class="sib" style="left:600px;width:20px;height:20px;right:auto;bottom:auto"></div><div class="card" data-fra-element="eCard"></div></div>', '.sib{position:absolute}.sib::before{content:"";position:absolute;left:0;top:0;width:20px;height:20px;animation:cyc 4s linear infinite}'],
    ['a layer in ANOTHER section', '<div class="wrap"><div class="card" data-fra-element="eCard"></div></div><div class="wrap" style="position:relative;margin-top:400px"><div class="layer"></div></div>', ''],
    ['a colour animation on a descendant of the element', '<div class="wrap"><div class="card" data-fra-element="eCard"><span style="display:block;height:10px;animation:cyc 4s linear infinite"></span></div></div>', ''],
  ])('%s is no obstacle: the surface is read', async (_name, body, css) => {
    await page.setContent(pageWith(body, css));
    const out = await resolveNow();
    expect(out.residual.surface).toBe('light');
    expect(out.residual.backdrop!.why ?? '').not.toMatch(/endless animation/);
    expect(out.notes.join(' ')).not.toMatch(/endless animation/);
  });
});
