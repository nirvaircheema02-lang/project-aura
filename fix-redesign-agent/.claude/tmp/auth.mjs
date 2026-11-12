import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const r = await p.evaluate(() => { const h = document.querySelector('[data-pv-section="what-our-clients-say"]'); const out = []; for (const n of ['John Miller', 'Director of Dealer Relations', 'Carlo Bianchi', 'Sales Manager']) { const e = [...h.shadowRoot.querySelectorAll('*')].find(x => x.children.length === 0 && x.textContent.trim() === n); if (e) { const cs = getComputedStyle(e); out.push([n, cs.fontSize, cs.fontWeight, cs.color, cs.lineHeight, e.getAttribute('data-fra-element')]); } } return out; });
console.log(JSON.stringify(r)); await b.close();
