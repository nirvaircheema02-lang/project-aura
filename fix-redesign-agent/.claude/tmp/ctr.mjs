import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const get = () => p.evaluate(() => { for (const h of document.querySelectorAll('*')) { const e = h.shadowRoot && h.shadowRoot.querySelector('[data-fra-element="e17"]'); if (e) return e.textContent; } });
const seen = [await get()];
await p.evaluate(() => { for (const h of document.querySelectorAll('*')) { const e = h.shadowRoot && h.shadowRoot.querySelector('[data-fra-element="e17"]'); if (e) e.scrollIntoView({ block: 'center' }); } });
for (let i = 0; i < 6; i++) { await p.waitForTimeout(400); seen.push(await get()); }
console.log(seen);
await b.close();
