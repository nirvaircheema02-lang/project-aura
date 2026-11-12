import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { measureResolvedTarget } from '../../src/preview/targets.ts';
import { measureTarget } from '../../src/resolution/resolve.ts';
import type { ResolvedTarget } from '../../src/resolution/schema.ts';
import { colourMapping, colourTarget } from '../helpers/colour-target.ts';

/**
 * Round 2, defect 4: a hover / focus colour and its backdrop are read in the SAME state AFTER it has settled - the element's and its ancestors' transitions and
 * animations are waited out (two consecutive reads must agree) - and a state that does not settle within the cap is UNVERIFIED, never a mid-transition pass. What
 * is stored in resolved-targets.json (hashed into the G2 fingerprint) is therefore a function of the settled state, not of when the sample was taken.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
.t{width:120px;height:40px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08);margin:8px;background:#fff}
.slow900{transition:background-color 900ms linear}
.slow900:hover{background:#111114}
.slow4500{transition:background-color 4500ms linear}
.slow4500:hover{background:#111114}
.endless:hover{animation:flash 300ms linear infinite alternate}
@keyframes flash{from{background:#fff}to{background:#111114}}
.parent{background:#fff;transition:background-color 900ms linear;padding:4px}
.parent:hover{background:#111114}
.parent > .t{background:transparent}
.focus{transition:border-top-color 900ms linear;border-top-color:rgba(0,0,0,.08)}
.focus:focus-visible{outline:none;border-top-color:rgba(0,0,0,.2)}
.steady:hover{background:#111114}
</style></head><body>
<div class="t slow900" tabindex="0" data-finding-ids="fSlow" data-fra-element="eSlow"></div>
<div class="t slow4500" data-finding-ids="fBeyond" data-fra-element="eBeyond"></div>
<div class="t endless" data-finding-ids="fEndless" data-fra-element="eEndless"></div>
<div class="parent"><div class="t" data-finding-ids="fParent" data-fra-element="eParent"></div></div>
<div class="t focus" tabindex="0" data-finding-ids="fFocus" data-fra-element="eFocus"></div>
<div class="t steady" data-finding-ids="fSteady" data-fra-element="eSteady"></div>
<script>window.__pvVerify = { findByFinding: (id) => document.querySelector('[data-finding-ids~="' + id + '"]') };</script>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
  await page.setContent(PAGE);
});
afterAll(async () => { await browser.close(); });

const sel = (id: string) => `[data-fra-element="${id}"]`;
/** Waits on animation STATE (nothing running), never on a fixed sleep: the element must be back at rest before the next measurement starts. */
const atRest = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), undefined, { timeout: 15_000 });

const hoverTarget = (id: string, value = 'rgba(0, 0, 0, 0.08)'): ResolvedTarget =>
  colourTarget(id, { state: 'hover', target: { value, comparison: 'color-deltaE', token: '--border-card' } }, [{ kind: 'state-distinct', property: 'border-top-color', state: 'hover', viewport: 'any', comparison: 'color-deltaE', expected: '0' }], [colourMapping({ state: 'hover' })]);
const focusTarget = (id: string): ResolvedTarget =>
  colourTarget(id, { state: 'focus-visible', target: { value: 'rgba(0, 0, 0, 0.2)', comparison: 'color-deltaE', token: '--border-active' } }, [], [colourMapping({ state: 'focus-visible' })]);

describe('a transition that outlasts the old fixed wait is measured SETTLED', () => {
  it('R5: three consecutive measurements of a 900 ms hover background transition store the identical, settled backdrop and result', { timeout: 60_000 }, async () => {
    const stored: string[] = [];
    for (let i = 0; i < 3; i++) {
      await atRest();
      const t = hoverTarget('fSlow');
      const m = await measureTarget(page, sel('eSlow'), t);
      expect(m.matches, m.note).toBe(false);
      expect(m.note).toMatch(/not visible/);
      const rendered = t.provenance.reference!.colours[0]!.verification.rendered;
      expect(rendered.backdrop, `run ${i}`).toBe('rgb(17, 17, 20)'); // the SETTLED hover backdrop, not 145,145,146 / 70,70,72 half-way
      stored.push(JSON.stringify(t));
    }
    expect(new Set(stored).size).toBe(1);
  });

  it('R8: the same', { timeout: 60_000 }, async () => {
    const stored: string[] = [];
    for (let i = 0; i < 3; i++) {
      await atRest();
      const t = hoverTarget('fSlow');
      const m = await measureResolvedTarget(page, t);
      expect(m.matches, m.note).toBe(false);
      expect(m.note).toMatch(/not visible/);
      expect(t.provenance.reference!.colours[0]!.verification.rendered.backdrop, `run ${i}`).toBe('rgb(17, 17, 20)');
      stored.push(JSON.stringify(t));
    }
    expect(new Set(stored).size).toBe(1);
  });

  it('an ANCESTOR that transitions its background on hover is waited out too', { timeout: 60_000 }, async () => {
    await atRest();
    const t = hoverTarget('fParent');
    const m = await measureTarget(page, sel('eParent'), t);
    expect(t.provenance.reference!.colours[0]!.verification.rendered.backdrop, m.note).toBe('rgb(17, 17, 20)');
    await atRest();
    const t8 = hoverTarget('fParent');
    await measureResolvedTarget(page, t8);
    expect(t8.provenance.reference!.colours[0]!.verification.rendered.backdrop).toBe('rgb(17, 17, 20)');
  });

  it('a focus colour that transitions is compared once it has settled (it used to be read 300 ms into a 900 ms transition)', { timeout: 60_000 }, async () => {
    await atRest();
    const r5 = await measureTarget(page, sel('eFocus'), focusTarget('fFocus'));
    expect(r5.matches, r5.note).toBe(true);
    await atRest();
    const r8 = await measureResolvedTarget(page, focusTarget('fFocus'));
    expect(r8.matches, r8.note).toBe(true);
  });

  it('a state that changes nothing over time still measures (no animation to wait for)', { timeout: 30_000 }, async () => {
    await atRest();
    const m = await measureTarget(page, sel('eSteady'), hoverTarget('fSteady'));
    expect(m.note).toMatch(/not visible/); // black hairline on the dark hover background: settled immediately
    expect((m as { unverified?: boolean }).unverified).toBeUndefined();
  });
});

describe('a state that does not settle is UNVERIFIED - never a mid-transition pass', () => {
  it('R5/R8: a 4.5 s transition (beyond the 2.4 s cap)', { timeout: 60_000 }, async () => {
    await atRest();
    const t = hoverTarget('fBeyond');
    const m = await measureTarget(page, sel('eBeyond'), t);
    expect(m.matches).toBe(false);
    expect((m as { unverified?: boolean }).unverified).toBe(true);
    expect(m.note).toMatch(/settle|still (?:running|changing)/i);
    expect(t.provenance.reference!.colours[0]!.verification.rendered.status).not.toBe('passed');
    await atRest();
    const r8 = await measureResolvedTarget(page, hoverTarget('fBeyond'));
    expect(r8.matches).toBe(false);
    expect(r8.measured).toBe(false);
    expect(r8.note).toMatch(/settle|still (?:running|changing)/i);
  });

  it('R5/R8: an endless animation that keeps changing the colour', { timeout: 60_000 }, async () => {
    await atRest().catch(() => undefined);
    const m = await measureTarget(page, sel('eEndless'), hoverTarget('fEndless'));
    expect(m.matches).toBe(false);
    expect((m as { unverified?: boolean }).unverified).toBe(true);
    const r8 = await measureResolvedTarget(page, hoverTarget('fEndless'));
    expect(r8.matches).toBe(false);
    expect(r8.measured).toBe(false);
  });
});
