import { chromium } from 'playwright';
const [port, sec, txt] = [process.argv[2], process.argv[3], process.argv[4]];
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: 'reduce' }); const p = await c.newPage();
await p.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
const r = await p.evaluate(([sec, txt]) => {
  const s = document.querySelector('[data-pv-section="' + sec + '"]'); const root = s.shadowRoot || s;
  const find = (rt) => { for (const e of rt.querySelectorAll('*')) { if (e.children.length === 0 && (e.textContent || '').includes(txt) && e.getBoundingClientRect().width > 0) return e; if (e.shadowRoot) { const f = find(e.shadowRoot); if (f) return f; } } return null; };
  const el = find(root) || find(s); if (!el) return 'nf';
  const out = []; for (let a = el; a && out.length < 9; a = a.parentElement || (a.getRootNode() && a.getRootNode().host)) { const cs = getComputedStyle(a); const r = a.getBoundingClientRect(); out.push(a.tagName + '.' + (a.getAttribute('class') || '').toString().slice(0, 70) + ' w=' + Math.round(r.width) + ' x=' + Math.round(r.left) + ' ov=' + cs.overflowX + ' disp=' + cs.display + ' ta=' + cs.textAlign + ' ws=' + cs.whiteSpace + ' fe=' + (a.getAttribute('data-fra-element') || '')); }
  return out;
}, [sec, txt]);
console.log(Array.isArray(r) ? r.join('\n') : r); await b.close();
