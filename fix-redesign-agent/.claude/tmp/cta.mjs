import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const sel = async () => p.evaluateHandle(() => { const h = document.querySelector('[data-pv-section="explore-other-surveys"]'); return [...h.shadowRoot.querySelectorAll('a')].find(a => /\/employee-engagement-survey/.test(a.getAttribute('href') || '') && a.getAttribute('data-ga4-cta')); });
const a = await sel(); await a.evaluate(e => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(600);
const read = () => a.evaluate(e => { const cs = getComputedStyle(e); const svgs = [...e.querySelectorAll('svg')].map(s => getComputedStyle(s).transform); const r = e.getBoundingClientRect(); return { bg: cs.backgroundImage.slice(0, 70), color: cs.color, h: Math.round(r.height), w: Math.round(r.width), fs: cs.fontSize, fw: cs.fontWeight, cursor: cs.cursor, href: e.href, svgs }; });
const before = await read(); const box = await a.boundingBox(); await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.waitForTimeout(800); const hover = await read();
await p.screenshot({ path: '.claude/tmp/cta-hover.png' });
console.log(JSON.stringify({ before, hover }, null, 1)); await b.close();
