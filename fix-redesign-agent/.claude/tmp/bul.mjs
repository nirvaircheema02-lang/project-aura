import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const bl = p.locator('[data-pv-section="what-our-clients-say"] .swiper-pagination-bullet'); await bl.first().scrollIntoViewIfNeeded(); await p.waitForTimeout(400);
console.log(JSON.stringify(await bl.evaluateAll(es => es.map(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return [Math.round(r.x), Math.round(r.width) + 'x' + Math.round(r.height), cs.backgroundColor, cs.borderRadius]; }))));
await b.close();
