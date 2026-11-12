import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const info = await p.evaluate(async () => {
  const h = document.querySelector('[data-pv-section="explore-other-surveys"]'); const sr = h.shadowRoot;
  const a = [...sr.querySelectorAll('a')].find(x => x.getAttribute('data-ga4-cta') && /employee-engagement/.test(x.href)); a.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 500));
  const r = a.getBoundingClientRect(); const top = sr.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { a: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], top: top && (top.tagName + ' ' + (top.className?.toString().slice(0, 80)) + ' | ' + (top.closest('a') === a)), stack: sr.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).slice(0, 5).map(e => e.tagName + ':' + (e.className?.toString().slice(0, 40))) };
});
console.log(JSON.stringify(info, null, 1)); await b.close();
