import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }); const p = await c.newPage();
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
await p.waitForTimeout(1200);
const ALL = ['your-dealers-know-what-your-data-doesn-t','dealer-insights-dashboard','our-clients','what-s-impacting-your-dealers','how-we-capture-dealer-needs','what-makes-our-way-different','our-impact','what-our-clients-say','faqs','our-resources','explore-other-surveys'];
const out = {};
for (const sid of ALL) {
  await p.locator('[data-pv-section="' + sid + '"]').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(1400);
  const part = await p.evaluate((IDS) => {
  const ids = IDS;
  const injectPE = (rt) => { for (const e of rt.querySelectorAll('*')) if (e.shadowRoot) { if (!e.shadowRoot.querySelector('style[data-pe]')) { const st = document.createElement('style'); st.setAttribute('data-pe', '1'); st.textContent = '*{pointer-events:auto!important}'; e.shadowRoot.appendChild(st); } injectPE(e.shadowRoot); } };
  injectPE(document);
  if (!document.querySelector('style[data-pe]')) { const st = document.createElement('style'); st.setAttribute('data-pe', '1'); st.textContent = '*{pointer-events:auto!important}'; document.head.appendChild(st); }
  const num = (v) => Math.round(parseFloat(v) * 10) / 10;
  const rnd = (v) => Math.round(v);
  const res = {};
  const label = (el) => { const t = (el.textContent || '').replace(/\s+/g, ' ').trim(); return t.length > 38 ? t.slice(0, 36) + '…' : t; };
  for (const id of ids) {
    const root = document.querySelector('[data-pv-section="' + id + '"]'); if (!root) continue;
    const clippedBy = (el, q) => { for (let a = el; a && a !== root.parentElement && a.nodeType === 1; a = a.parentElement || (a.getRootNode() && a.getRootNode().host) || null) { const s = getComputedStyle(a); if ((s.overflowX === 'visible' && s.overflowY === 'visible') || s.display === 'contents') continue; const ar = a.getBoundingClientRect(); if (ar.width <= 2 && ar.height <= 2) return true; if (q.bottom <= ar.top + 0.5 || q.top >= ar.bottom - 0.5 || q.right <= ar.left + 0.5 || q.left >= ar.right - 0.5) return true; } return false; };
    const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !clippedBy(el, r); };
    const eo = (el) => { let o = 1; for (let a = el; a && a.nodeType === 1; a = a.parentElement || (a.getRootNode() && a.getRootNode().host) || null) { o *= parseFloat(getComputedStyle(a).opacity); if (a.hasAttribute('data-pv-section')) break; } return Math.round(o * 100) / 100; };
    const absBox = (r) => ({ ax: r.x + scrollX, ay: r.y + scrollY, w: r.width, h: r.height });
    const SEM = new Set(['LI','NAV','BUTTON','A','H1','H2','H3','H4','H5','H6','UL','OL','FORM','FIGURE','ARTICLE']);
    const nameOf = (el, kids) => {
      const ty = el.getAttribute('data-fra-type'); const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) return 'Heading · ' + label(el);
      if (tag === 'A') return 'Link · ' + label(el); if (tag === 'BUTTON' || ty === 'button') return 'Button · ' + label(el);
      if (tag === 'LI') return 'Item'; if (tag === 'UL' || tag === 'OL') return 'List'; if (tag === 'NAV') return 'Nav';
      if (ty === 'card') return 'Card'; if (ty === 'badge') return 'Badge · ' + label(el); if (ty === 'eyebrow') return 'Eyebrow';
      const aria = el.getAttribute('aria-label'); if (aria) return aria.slice(0, 40);
      const n = kids.length; if (n >= 3 && kids.every((k) => k.k === 'f')) return 'Row of ' + n; 
      if (kids.some((k) => k.k === 'i') && kids.some((k) => k.k === 't')) return 'Card'; return 'Group';
    };
    const walk = (el) => {
      if (!(el instanceof Element) || ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','FOREIGNOBJECT'].includes(el.tagName.toUpperCase())) return [];
      const cs = getComputedStyle(el); if (cs.display === 'none') return [];
      const r = el.getBoundingClientRect(); const bx = absBox(r);
      const tag = el.tagName.toLowerCase();
      if (tag === 'svg') { if (!vis(el)) return []; let s = el.outerHTML.replace(/currentColor/g, cs.color); if (!/viewBox/.test(s)) return []; s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/g, '').replace(/\sclass="[^"]*"/, ''); const out = [{ k: 'v', ...bx, op: eo(el), v: s.length < 12000 ? s : null }];
        for (const fo of el.querySelectorAll('foreignObject')) for (const ch of fo.children) out.push(...walk(ch)); return out; }
      if (tag === 'img') { if (!vis(el)) return []; let op = 1, mb = null; for (let a = el; a && a.nodeType === 1; a = a.parentElement || (a.getRootNode() && a.getRootNode().host) || null) { const s = getComputedStyle(a); op *= parseFloat(s.opacity); if (!mb && s.mixBlendMode !== 'normal') mb = s.mixBlendMode; if (a.hasAttribute('data-pv-section')) break; } const gs = /grayscale\(([\d.]+)\)/.exec(cs.filter);
        return [{ k: 'i', ...bx, r: Math.min(num(cs.borderTopLeftRadius), 9999), src: (el.currentSrc || el.src || '').split('/').pop().split('?')[0], fit: cs.objectFit, pos: cs.objectPosition, ib: /rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) ? null : cs.backgroundColor, ibw: num(cs.borderTopWidth), ibc: cs.borderTopColor, ipad: num(cs.paddingTop), ibb: ((/blur\(([\d.]+)px\)/.exec(cs.backdropFilter || cs.webkitBackdropFilter || '') || [])[1]) || 0, ish: cs.boxShadow !== 'none' ? cs.boxShadow.slice(0, 200) : null, op: Math.round(op * 100) / 100, mb, gs: gs ? parseFloat(gs[1]) : 0 }]; }
      const kids = [];
      const visible = vis(el);
      const nodes = el.shadowRoot ? [...el.shadowRoot.childNodes, ...(el.tagName.toLowerCase() === 'div' && el.hasAttribute('data-pv-section') ? [] : [])] : el.tagName === 'SLOT' ? el.assignedNodes({ flatten: true }) : el.childNodes;
      for (const n of nodes) {
        if (n.nodeType === 3 && n.textContent.trim() && visible) {
          const rg = document.createRange(); rg.selectNodeContents(n); const q = rg.getBoundingClientRect(); if (q.width < 1 || clippedBy(el, q)) continue;
          kids.push({ k: 't', ...absBox(q), op: eo(el), lc: (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') ? parseInt(cs.webkitLineClamp) : 0, s: n.textContent.replace(/\s+/g, ' ').trim(), ff: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), z: num(cs.fontSize), fw: parseInt(cs.fontWeight), c: cs.color, ls: cs.letterSpacing === 'normal' ? 0 : num(cs.letterSpacing), lh: cs.lineHeight === 'normal' ? 0 : num(cs.lineHeight), ta: cs.textAlign, tt: cs.textTransform, td: cs.textDecorationLine });
        } else if (n.nodeType === 1) kids.push(...walk(n));
      }
      const bg = cs.backgroundColor, bgi = cs.backgroundImage, bw = num(cs.borderTopWidth), sh = cs.boxShadow;
      const hasBg = bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg);
      const blur = /blur\(([\d.]+)px\)/.exec(cs.filter), bblur = /blur\(([\d.]+)px\)/.exec(cs.backdropFilter || cs.webkitBackdropFilter || '');
      const visual = visible && (hasBg || (bgi && bgi !== 'none') || bw > 0 || (sh && sh !== 'none') || !!blur || !!bblur);
      const sem = SEM.has(el.tagName) || el.getAttribute('data-fra-type');
      const clip = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (!visual && !sem && !(kids.length >= 2 && visible && r.width > 1) ) return kids;
      if (!visual && !sem && kids.length === 0) return [];
      const f = { k: 'f', ...bx, n: nameOf(el, kids), kids };
      if (visible) { if (hasBg) f.b = bg; if (bgi && bgi !== 'none') f.g = bgi.slice(0, 400); if (bw > 0) { f.bw = bw; f.bc = cs.borderTopColor; } const rad = num(cs.borderTopLeftRadius); if (rad) f.r = rad; if (sh && sh !== 'none') f.sh = sh.slice(0, 200); }
      if (visible && kids.length === 0 && (hasBg || (bgi && bgi !== 'none'))) { try { const rt = el.getRootNode(); const cx = Math.min(Math.max(r.x + r.width / 2, 1), innerWidth - 1), cy = Math.min(Math.max(r.y + r.height / 2, 1), innerHeight - 1); const stack = rt.elementsFromPoint ? rt.elementsFromPoint(cx, cy) : []; const ie = stack.findIndex((x) => x.tagName === 'IMG'), me = stack.indexOf(el); if (ie >= 0 && me > ie) f.bel = 1; } catch (e) {} }
      if (blur) f.fl = parseFloat(blur[1]); if (bblur) f.bb = parseFloat(bblur[1]); const eop = eo(el); if (eop < 0.99) f.op = eop; if (clip) f.cl = 1; const fr = el.getAttribute('data-fra-element'); if (fr) f.el = fr;
      return [f];
    };
    const rootNodes = walk(root);
    // force the section root as a frame
    const rr = absBox(root.getBoundingClientRect());
    let rootFrame = rootNodes.length === 1 && rootNodes[0].k === 'f' && Math.abs(rootNodes[0].ay - rr.ay) < 1 && Math.abs(rootNodes[0].w - rr.w) < 1 ? rootNodes[0] : { k: 'f', ...rr, n: 'Section', kids: rootNodes };
    const masks = [], pseudos = []; const scan = (rt) => { for (const e of rt.querySelectorAll('*')) { const s = getComputedStyle(e); const mi = s.maskImage || s.webkitMaskImage; if (mi && mi !== 'none') { const q = absBox(e.getBoundingClientRect()); masks.push({ ...q, m: mi.slice(0, 400) }); } for (const ps of ['::before', '::after']) { const pc = getComputedStyle(e, ps); if (pc.content !== 'none' && ((pc.backgroundImage && pc.backgroundImage !== 'none') || !/rgba\(0, 0, 0, 0\)/.test(pc.backgroundColor))) pseudos.push({ ps, tag: e.tagName, cls: (e.className && e.className.baseVal === undefined ? e.className : '').toString().slice(0, 60), bg: pc.backgroundImage.slice(0, 120), bc: pc.backgroundColor, w: pc.width, h: pc.height, pos: pc.position }); } if (e.shadowRoot) scan(e.shadowRoot); } };
    scan(root); if (root.shadowRoot) scan(root.shadowRoot);
    rootFrame.n = id; res[id] = { w: rnd(rr.w), h: rnd(rr.h), ax: rr.ax, ay: rr.ay, root: rootFrame, masks, pseudos };
  }
  return res;
  }, [sid]);
  Object.assign(out, part);
}
writeFileSync('.claude/tmp/tree.raw.json', JSON.stringify(out));
const cnt = (n) => 1 + (n.kids || []).reduce((a, k) => a + cnt(k), 0);
for (const [k, v] of Object.entries(out)) console.log(k, v.w, v.h, cnt(v.root));
await b.close();
