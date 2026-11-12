import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const pos = await p.evaluate(() => { const h = document.querySelector('[data-pv-section="explore-other-surveys"]'); const a = [...h.shadowRoot.querySelectorAll('a')].find(x => x.getAttribute('data-ga4-cta') && /employee-engagement/.test(x.href)); const r = a.getBoundingClientRect(); window.scrollTo(0, r.y + scrollY - 400); return 1; });
await p.waitForTimeout(500);
const read = () => p.evaluate(() => { const h = document.querySelector('[data-pv-section="explore-other-surveys"]'); const a = [...h.shadowRoot.querySelectorAll('a')].find(x => x.getAttribute('data-ga4-cta') && /employee-engagement/.test(x.href)); const r = a.getBoundingClientRect(); return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], svgs: [...a.querySelectorAll('svg')].map(s => getComputedStyle(s).transform), hovered: a.matches(':hover'), bg: getComputedStyle(a).backgroundImage.slice(0, 60) }; });
const before = await read(); await p.mouse.move(before.rect[0] + before.rect[2] / 2, before.rect[1] + before.rect[3] / 2); await p.waitForTimeout(900); const hover = await read();
await p.screenshot({ path: '.claude/tmp/cta-hover.png', clip: { x: before.rect[0] - 60, y: before.rect[1] - 60, width: before.rect[2] + 120, height: before.rect[3] + 120 } });
console.log(JSON.stringify({ before, hover })); await b.close();
