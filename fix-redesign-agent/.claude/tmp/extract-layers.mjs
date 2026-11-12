import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const R = '/Users/sachin/Project-aura/fix-redesign-agent/projects/www.kenresearch.com-dealers-voice-survey/redesigns/dealers-voice-survey-page-audit-v3-redesign-20261012-104005';
const html = readFileSync(R + '/context/capture-snapshot.html', 'utf8');
const css = readFileSync(R + '/preview-app/src/generated/scoped.css', 'utf8').split('\n').filter((l) => /^\[data-fra-element="e\d+"\]/.test(l)).join('\n');
const b = await chromium.launch(); const c = await b.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } }); const p = await c.newPage();
await p.route('**/*', (r) => r.request().url().startsWith('data:') ? r.continue() : r.abort());
await p.setContent(html, { waitUntil: 'domcontentloaded' });
await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}' + css });
await p.waitForTimeout(800);
const out = await p.evaluate(() => {
  const ids = ['your-dealers-know-what-your-data-doesn-t','dealer-insights-dashboard','our-clients','what-s-impacting-your-dealers','how-we-capture-dealer-needs','what-makes-our-way-different','our-impact','what-our-clients-say','faqs','our-resources','explore-other-surveys'];
  const num = (v) => Math.round(parseFloat(v) * 10) / 10;
  const res = {};
  for (const id of ids) {
    const root = document.querySelector('[data-fra-section="' + id + '"]'); if (!root) continue;
    const rr = root.getBoundingClientRect(); const ox = rr.x + scrollX, oy = rr.y + scrollY;
    const layers = [];
    const clippedBy = (el, q) => { for (let a = el; a && a !== root.parentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX === 'visible' && s.overflowY === 'visible') continue; const ar = a.getBoundingClientRect(); if (q.bottom <= ar.top + 0.5 || q.top >= ar.bottom - 0.5 || q.right <= ar.left + 0.5 || q.left >= ar.right - 0.5) return true; } return false; };
    const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) && !clippedBy(el, r); };
    const walk = (el) => {
      if (!(el instanceof Element) || ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(el.tagName)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      const r = el.getBoundingClientRect();
      const base = { x: num(r.x + scrollX - ox), y: num(r.y + scrollY - oy), w: num(r.width), h: num(r.height), el: el.getAttribute('data-fra-element') || undefined };
      if (el.tagName.toLowerCase() === 'svg' && vis(el)) { let s = el.outerHTML.replace(/currentColor/g, cs.color); if (!/viewBox/.test(s)) return; s = s.replace(/<svg /, '<svg width="' + base.w + '" height="' + base.h + '" '); layers.push({ t: 'svg', ...base, svg: s.length < 6000 ? s : null }); for (const fo of el.querySelectorAll('foreignObject')) for (const ch of fo.children) walk(ch); return; }
      if (el.tagName === 'IMG' && vis(el)) { layers.push({ t: 'img', ...base, r: cs.borderTopLeftRadius }); return; }
      if (vis(el)) {
        const bg = cs.backgroundColor, bgi = cs.backgroundImage, bw = num(cs.borderTopWidth), sh = cs.boxShadow;
        const hasBg = bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg);
        if (hasBg || (bgi && bgi !== 'none') || bw > 0 || (sh && sh !== 'none')) layers.push({ t: 'box', ...base, bg: hasBg ? bg : null, bgi: bgi !== 'none' ? bgi.slice(0, 400) : null, bw, bc: bw > 0 ? cs.borderTopColor : null, rad: num(cs.borderTopLeftRadius), sh: sh !== 'none' ? sh.slice(0, 200) : null, op: cs.opacity });
      }
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim() && vis(el)) {
          const rg = document.createRange(); rg.selectNodeContents(n); const q = rg.getBoundingClientRect(); if (q.width < 1 || clippedBy(el, q)) continue;
          layers.push({ t: 'text', x: num(q.x + scrollX - ox), y: num(q.y + scrollY - oy), w: num(q.width), h: num(q.height), s: n.textContent.replace(/\s+/g, ' ').trim(), ff: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), fs: num(cs.fontSize), fw: cs.fontWeight, c: cs.color, ls: cs.letterSpacing === 'normal' ? 0 : num(cs.letterSpacing), lh: cs.lineHeight === 'normal' ? 0 : num(cs.lineHeight), ta: cs.textAlign, tt: cs.textTransform, td: cs.textDecorationLine, el: el.getAttribute('data-fra-element') || (el.closest('[data-fra-element]') || {getAttribute: () => undefined}).getAttribute('data-fra-element'), tag: el.tagName.toLowerCase() });
        } else if (n.nodeType === 1) walk(n);
      }
    };
    walk(root);
    res[id] = { w: num(rr.width), h: num(rr.height), layers };
  }
  return res;
});
writeFileSync('.claude/tmp/layers.json', JSON.stringify(out));
for (const [k, v] of Object.entries(out)) console.log(k, v.w, v.h, v.layers.length, JSON.stringify(v).length, [...new Set(v.layers.filter(l => l.t === 'text').map(l => l.ff))].join('|'));
await b.close();
