import { chromium } from 'playwright';
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 375, height: 800 } }); const p = await c.newPage();
await p.goto('http://127.0.0.1:4702/', { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
console.log(await p.evaluate(() => { const h = document.querySelector('[data-pv-section="our-impact"]'); const isl = h.querySelector('[data-pv-island]'); return [h.outerHTML.slice(0, 120), isl && isl.outerHTML.slice(0, 200), isl && getComputedStyle(isl).paddingLeft, [...document.styleSheets].length]; }));
await b.close();
