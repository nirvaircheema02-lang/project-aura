import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const a = p.locator('[data-pv-section="explore-other-surveys"] a[data-ga4-cta][href="/employee-engagement-survey"]').first();
const read = () => a.evaluate(e => ({ svgs: [...e.querySelectorAll('svg')].map(s => getComputedStyle(s).transform), hovered: e.matches(':hover'), bg: getComputedStyle(e).backgroundImage.slice(0, 60), r: (({x,y,width,height}) => [Math.round(x),Math.round(y),Math.round(width),Math.round(height)])(e.getBoundingClientRect()) }));
await a.scrollIntoViewIfNeeded(); await p.waitForTimeout(500);
const before = await read(); await a.hover(); await p.waitForTimeout(900); const hover = await read();
await p.screenshot({ path: '.claude/tmp/cta-hover.png' });
console.log(JSON.stringify({ before, hover })); await b.close();
