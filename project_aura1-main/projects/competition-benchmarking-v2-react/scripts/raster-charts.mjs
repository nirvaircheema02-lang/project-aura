/**
 * Regenerates public/charts/*.png from the live financial charts.
 *
 * The six snapshot charts are authored as inline SVG inside Financials.tsx but
 * ship as PNG, so the per-year figures are not sitting in the DOM. This script
 * is the bridge: it loads the running dev server, clones each chart into an
 * isolated stage (escaping the card's overflow, the gate blur and the reveal
 * start-states), and screenshots it at 1680x1080 on transparency.
 *
 * Usage:  npm run dev           # in one terminal
 *         npx playwright install chromium   # first run only
 *         node scripts/raster-charts.mjs [http://localhost:3095]
 *
 * NOTE: the SVG source in Financials.tsx was replaced by <img> tags when the
 * charts were rasterised. To change a figure, restore a chart's SVG from git
 * history, edit it, re-run this script, then put the <img> back.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] ?? 'http://localhost:3095';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'charts');
const SLUGS = ['revenue', 'revenue-growth', 'cogs', 'ebitda', 'ebitda-margin', 'pat-margin'];
const W = 560, H = 360; // 280:180, the chart viewBox ratio. x3 DPR = 1680x1080.

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 3 });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

const count = await page.evaluate(({ W, H }) => {
  const stage = document.createElement('div');
  stage.id = '__stage';
  stage.style.cssText = `position:fixed;left:0;top:0;z-index:99999;width:${W}px;height:${H}px;overflow:hidden`;
  document.body.appendChild(stage);
  const s = document.createElement('style');
  s.textContent = `*,*::before,*::after{transition:none!important;animation:none!important}
    /* omitBackground only drops the page's own white, so anything still
       painted behind the fixed stage would bleed into the shot */
    body > *:not(#__stage){visibility:hidden!important}
    #__stage,#__stage *{visibility:visible!important}
    #__stage .fc-svg{width:${W}px!important;height:${H}px!important;margin:0!important;filter:none!important;opacity:1!important}`;
  document.head.appendChild(s);
  window.__svgs = [...document.querySelectorAll('#financials .fc-svg')];
  return window.__svgs.length;
}, { W, H });

if (count !== SLUGS.length) {
  await browser.close();
  throw new Error(`expected ${SLUGS.length} .fc-svg charts in #financials, found ${count} — ` +
    'the charts are probably already rasterised; restore the SVG source first.');
}

for (let i = 0; i < SLUGS.length; i++) {
  // one chart on the stage at a time: the stage is pinned to the viewport
  // origin, so every capture is guaranteed on-screen
  await page.evaluate((i) => {
    document.getElementById('__stage').replaceChildren(window.__svgs[i].cloneNode(true));
  }, i);
  await page.waitForTimeout(250);
  const file = path.join(OUT, `${SLUGS[i]}.png`);
  await (await page.$('#__stage')).screenshot({ path: file, omitBackground: true });
  console.log(`${SLUGS[i]}.png  ${Math.round(fs.statSync(file).size / 1024)} KB`);
}
await browser.close();
