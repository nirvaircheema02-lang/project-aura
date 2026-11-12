import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const r = await p.evaluate(() => { const h = document.querySelector('[data-pv-section="our-impact"]'); return [...h.querySelectorAll('[data-pv-island="CTALink"]')].map(w => { const a = w.querySelector('a'); const t = a.getBoundingClientRect(); const cs = [...h.shadowRoot.querySelectorAll('[class*="group"]')].filter(e => e.getBoundingClientRect().width > 250 && e.getBoundingClientRect().width < 280 && e.getBoundingClientRect().height > 250)[0]; return [Math.round(t.x), Math.round(t.right)]; }); });
console.log(JSON.stringify(r)); await b.close();
