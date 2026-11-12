import { chromium } from 'playwright';
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }); const p = await c.newPage();
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
console.log(JSON.stringify(await p.evaluate(() => {
  const h = document.querySelector('[data-pv-section="our-clients"]'); const el = [...h.shadowRoot.querySelectorAll('h2')].find(x => x.textContent.includes('ABOUT KEN'));
  const r = el.getBoundingClientRect(); const chain = []; for (let a = el; a; a = a.parentElement || (a.getRootNode() && a.getRootNode().host) || null) { const s = getComputedStyle(a); const ar = a.getBoundingClientRect(); chain.push([a.tagName, a.className?.toString().slice(0, 25), s.overflowX, s.display, Math.round(ar.width), Math.round(ar.height)]); if (a === h) break; }
  return { r: [r.x, r.y, r.width, r.height], vis: el.checkVisibility({ opacityProperty: true, visibilityProperty: true }), chain };
})));
await b.close();
