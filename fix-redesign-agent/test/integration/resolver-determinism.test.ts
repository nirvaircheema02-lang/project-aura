import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { resolveTargets } from '../../src/resolution/resolve.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';
import { decision, entryFor, now, prop, residual, RUN } from '../helpers/resolver-stub.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 90_000 });

/**
 * Reference lane round 3 (minors): resolved-targets.json is hashed into the G2 fingerprint, so what the Resolver records must not depend on the moment it
 * started or on where the page happened to be scrolled. (7) An ENDLESS animation that changes a colour is reported unsettled outright - a hold-style one passes
 * three equal reads 60-100 ms apart and was recorded at whichever phase it was caught. (8) The Resolver reads from scroll 0 after the scroll-triggered reveals
 * have run, so an IntersectionObserver reveal gives the same file on a fresh page and on one that was scrolled before. Timer-driven reveals are the page's
 * own script and stay inherent.
 */

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
});
afterAll(async () => { await browser.close(); cleanupDsFixtures(); });

async function resolveNow(): Promise<{ json: string; residual: Awaited<ReturnType<typeof resolveTargets>>['residuals'][number]; notes: string[] }> {
  const f = residual('f-card', 'card', [prop()]);
  const out = await resolveTargets(
    { page, dsIndex: miniDsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: null, now },
    { run: RUN, findings: [f], entries: [entryFor('eCard', 'f-card')], judgment: { decisions: [decision({ source: 'ds-token', dsToken: '--border-soft', reference: null, value: 'var(--border-soft)' })], notes: [] } },
  );
  return { json: JSON.stringify({ file: out.file, residuals: out.residuals }), residual: out.residuals[0]!, notes: out.file.notes };
}

describe('7. an endless animation that changes a colour is unsettled outright, at any phase', () => {
  const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
@keyframes cycle{0%,45%{background:#fff}50%,95%{background:#111114}100%{background:#fff}}
@keyframes spin{to{transform:rotate(360deg)}}
.cyc{animation:cycle 4s linear infinite;padding:12px}
.spin{animation:spin 3s linear infinite;display:inline-block;padding:12px;background:#fff}
.card{width:160px;height:50px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08)}
</style></head><body>
<div class="cyc"><div class="card" data-fra-element="eCard"></div></div>
</body></html>`;
  const phase = (ms: number) => page.evaluate((t) => document.getAnimations().forEach((a) => { a.currentTime = t; }), ms);

  it('four phases of a hold-style colour cycle give ONE file, with the surface and backdrop not read and the reason noted', async () => {
    await page.setContent(PAGE);
    const runs: string[] = [];
    let last: Awaited<ReturnType<typeof resolveNow>> | null = null;
    for (const ms of [200, 2600, 1000, 3500]) {
      await phase(ms);
      last = await resolveNow();
      runs.push(last.json);
    }
    expect(new Set(runs).size, 'the recorded file differs between phases').toBe(1);
    expect(last!.residual.surface).toBe('unknown');
    expect(last!.residual.backdrop).toMatchObject({ color: null, source: 'ds-section-tokens' });
    expect(last!.residual.backdrop!.why).toMatch(/endless animation/);
    expect(last!.notes.join(' ')).toMatch(/endless animation/);
  });

  it('an endless animation that does not touch a colour (a spinner) is not an obstacle: the surface is read', async () => {
    await page.setContent(PAGE.replace('<div class="cyc">', '<div class="spin">'));
    const out = await resolveNow();
    expect(out.residual.surface).toBe('light');
    expect(out.residual.backdrop!.color).toBe('rgb(255, 255, 255)');
  });
});

describe('8. the Resolver reads from scroll 0 after scroll-triggered reveals have run', () => {
  const REVEAL = (twoWay: boolean) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:#fff}
.spacer{height:1800px}
.reveal{opacity:0;transition:opacity .25s linear;background:#f5f2f1;padding:12px}
.reveal.in{opacity:1}
.card{width:160px;height:50px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08)}
</style></head><body>
<div class="spacer"></div>
<div class="reveal" id="rv"><div class="card" data-fra-element="eCard"></div></div>
<div class="spacer"></div>
<script>
  new IntersectionObserver((entries) => entries.forEach((e) => { ${twoWay ? "e.target.classList.toggle('in', e.isIntersecting);" : "if (e.isIntersecting) e.target.classList.add('in');"} }), { threshold: 0.2 }).observe(document.getElementById('rv'));
</script></body></html>`;
  const scrollInAndBack = async () => {
    await page.evaluate(() => document.getElementById('rv')!.scrollIntoView({ behavior: 'instant' }));
    await page.waitForFunction(() => document.getElementById('rv')!.classList.contains('in'), undefined, { timeout: 10_000 });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), undefined, { timeout: 10_000 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForFunction(() => scrollY === 0, undefined, { timeout: 5_000 });
  };

  it.each([['a one-way IntersectionObserver reveal', false], ['a two-way (toggling) reveal', true]])('%s: the same file on a fresh page and after a scroll-in / scroll-back', async (_name, twoWay) => {
    await page.setContent(REVEAL(twoWay));
    const fresh = await resolveNow();
    await scrollInAndBack();
    const after = await resolveNow();
    expect(after.json).toBe(fresh.json);
    // the other way round: a page that was scrolled in BEFORE the first run
    await page.setContent(REVEAL(twoWay));
    await scrollInAndBack();
    expect((await resolveNow()).json).toBe(fresh.json);
  });

  it('the page is back at scroll 0 when the Resolver is done, and a scroll position at the start does not matter', async () => {
    await page.setContent(`<!doctype html><html><head><style>
body{margin:0;background:#fff}.spacer{height:1500px}
.hdr{position:fixed;top:0;left:0;right:0;height:80px;background:#111114}
.card{position:absolute;top:20px;left:20px;width:160px;height:50px;box-sizing:border-box;border:1px solid rgba(0,0,0,.08)}
</style></head><body><div class="hdr"></div><div style="position:relative;height:100px"><div class="card" data-fra-element="eCard"></div></div><div class="spacer"></div></body></html>`);
    const fromTop = await resolveNow();
    await page.evaluate(() => window.scrollTo({ top: 1200, behavior: 'instant' }));
    const fromBottom = await resolveNow();
    expect(fromBottom.json).toBe(fromTop.json);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(fromTop.residual.backdrop!.why).toMatch(/out-of-flow/);
  });
});
