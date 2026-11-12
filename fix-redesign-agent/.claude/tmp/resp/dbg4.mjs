import { chromium } from 'playwright';
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c.newPage();
await p.goto('http://127.0.0.1:4702/?motion=full', { waitUntil: 'networkidle' });
await p.locator('[data-pv-section="our-clients"]').evaluate(e => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
const s1 = await p.evaluate(() => { const o=[]; const w=(rt)=>{for(const e of rt.querySelectorAll('*')){ if(e.hasAttribute&&e.hasAttribute('data-pv-stat')) o.push([e.textContent.trim(), getComputedStyle(e).color, getComputedStyle(e).fontSize]); if(e.shadowRoot)w(e.shadowRoot);}}; w(document); return o; });
await p.waitForTimeout(2200);
const s2 = await p.evaluate(() => { const o=[]; const w=(rt)=>{for(const e of rt.querySelectorAll('*')){ if(e.hasAttribute&&e.hasAttribute('data-pv-stat')) o.push(e.textContent.trim()); if(e.shadowRoot)w(e.shadowRoot);}}; w(document); return o; });
console.log(JSON.stringify(s1), JSON.stringify(s2)); await b.close();
