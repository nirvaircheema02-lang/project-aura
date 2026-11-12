// Extracts the rendered React Preview into a geometry/style tree (one entry per `[data-pv-section]`).
// The preview is a shadow-DOM page; every section is scrolled into view first so scroll-driven states (carousels, fades) are the ones a visitor sees.
import { chromium } from 'playwright';

export async function extractSections(url, { width = 1440, height = 900 } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  // reduced motion keeps carousels still and counters at their final value; `scrollfx=live` replays the scroll effects at the real scroll position (reduced motion would freeze them at the page-top state: a heading 70px low, under the picture)
  await p.goto(url + (url.includes('?') ? '&' : '?') + 'scrollfx=live', { waitUntil: 'networkidle' });
  await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await p.waitForTimeout(1200);
  const list = await p.evaluate(() => [...document.querySelectorAll('[data-pv-section]')].map((e) => [e.getAttribute('data-pv-section'), e.getAttribute('data-pv-name') || e.getAttribute('data-pv-section')]));
  const out = {};
  const synth = {};
  const names = {};
  for (const [sid, name] of list) {
    names[sid] = name;
    await p.locator('[data-pv-section="' + sid + '"]').evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await p.waitForTimeout(1400);
    // videos are exported as a frame. Some play from the scroll position (a clip's first frames are blank: cards that animate in), so on the section's own videos try a few moments
    // of the clip and pause on the most detailed one before the page is read
    await p.evaluate(async (id) => {
      const root = document.querySelector('[data-pv-section="' + id + '"]'); if (!root) return;
      const vs = []; const walk = (rt) => { for (const e of rt.querySelectorAll('*')) { if (e.tagName === 'VIDEO') vs.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; walk(root); if (root.shadowRoot) walk(root.shadowRoot);
      for (const v of vs) {
        const b = v.getBoundingClientRect(); if (b.width < 2 || b.height < 2 || !v.duration || !isFinite(v.duration) || !v.videoWidth) continue;
        v.pause();
        const seek = (t) => new Promise((res) => { v.addEventListener('seeked', () => res(), { once: true }); v.currentTime = t; setTimeout(res, 2500); });
        const detail = () => { const c = document.createElement('canvas'); c.width = 64; c.height = 36; const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36); const d = g.getImageData(0, 0, 64, 36).data; let m = 0, n = 0; for (let k = 0; k < d.length; k += 4) { m += d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11; n++; } m /= n; let sv = 0; for (let k = 0; k < d.length; k += 4) { const l = d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11; sv += (l - m) * (l - m); } return sv / n; };
        let best = 0.5, bs = -1;
        for (const f of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95]) { await seek(v.duration * f); const sc = detail(); if (sc > bs) { bs = sc; best = f; } }
        await seek(v.duration * best);
      }
    }, sid);
    await p.waitForTimeout(200);
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
    const synthHash = (str) => { let h = 5381; for (let i = 0; i < str.length; i += 7) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(16) + str.length.toString(16); };
    // `radial-gradient(#fff 1px, transparent 0)` tiled by `background-size` is a dot pattern; a plain gradient fill would turn it into one big soft blob, so the dots are drawn as a transparent picture
    const DOTS = /^radial-gradient\(rgb\(255, 255, 255\) 1px, rgba\(0, 0, 0, 0\) 0px\)$/;
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
        return [{ k: 'i', ...bx, r: Math.min(num(cs.borderTopLeftRadius), 9999), src: (el.currentSrc || el.src || '').split('/').pop().split('?')[0], fit: cs.objectFit, pos: cs.objectPosition, ib: /rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) ? null : cs.backgroundColor, ibw: num(cs.borderTopWidth), ibc: cs.borderTopColor, ipad: num(cs.paddingTop), ibb: ((/blur\(([\d.]+)px\)/.exec(cs.backdropFilter || cs.webkitBackdropFilter || '') || [])[1]) || 0, ish: cs.boxShadow !== 'none' ? cs.boxShadow.slice(0, 200) : null, op: Math.round(op * 100) / 100, mb, gs: gs ? parseFloat(gs[1]) : 0, zi: parseInt(cs.zIndex) || 0 }]; }
      // a <video> is exported as the frame it shows now (a picture): Figma has no video layer, and without this the area stays empty (hero cards, Sweet Spot chart)
      if (tag === 'video') {
        if (!vis(el) || el.readyState < 2 || !el.videoWidth) return [];
        try {
          const sc = Math.min(1, 1600 / el.videoWidth); const cv = document.createElement('canvas'); cv.width = Math.round(el.videoWidth * sc); cv.height = Math.round(el.videoHeight * sc);
          cv.getContext('2d').drawImage(el, 0, 0, cv.width, cv.height); const data = cv.toDataURL('image/jpeg', 0.92);
          return [{ k: 'i', ...bx, r: Math.min(num(cs.borderTopLeftRadius), 9999), src: 'video-' + synthHash(data) + '.jpg', data, fit: cs.objectFit, pos: cs.objectPosition, op: eo(el), gs: 0, abs: cs.position === 'absolute' ? 1 : 0, zi: parseInt(cs.zIndex) || 0 }];
        } catch (e) { return []; }
      }
      const kids = [];
      const visible = vis(el);
      const nodes = el.shadowRoot ? [...el.shadowRoot.childNodes, ...(el.tagName.toLowerCase() === 'div' && el.hasAttribute('data-pv-section') ? [] : [])] : el.tagName === 'SLOT' ? el.assignedNodes({ flatten: true }) : el.childNodes;
      for (const n of nodes) {
        if (n.nodeType === 3 && n.textContent.trim() && visible) {
          const rg = document.createRange(); rg.selectNodeContents(n); const q = rg.getBoundingClientRect(); if (q.width < 1 || clippedBy(el, q)) continue;
          kids.push({ k: 't', ...absBox(q), op: eo(el), lc: (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') ? parseInt(cs.webkitLineClamp) : 0, s: n.textContent.replace(/\s+/g, ' ').trim(), ff: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), z: num(cs.fontSize), fw: parseInt(cs.fontWeight), c: cs.color, ls: cs.letterSpacing === 'normal' ? 0 : num(cs.letterSpacing), lh: cs.lineHeight === 'normal' ? 0 : num(cs.lineHeight), ta: cs.textAlign, tt: cs.textTransform, td: cs.textDecorationLine });
        } else if (n.nodeType === 1) kids.push(...walk(n));
      }
      const bg = cs.backgroundColor, bw = num(cs.borderTopWidth), sh = cs.boxShadow;
      let bgi = cs.backgroundImage;
      if (visible && DOTS.test(bgi) && r.width >= 2 && r.height >= 2) {
        const [tw, th] = cs.backgroundSize.split(' ').map((x) => parseFloat(x) || 12); const W = Math.round(r.width), H = Math.round(r.height);
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'); g.fillStyle = '#fff';
        for (let y = 0; y < H; y += th) for (let x = 0; x < W; x += tw) { g.beginPath(); g.arc(x + tw / 2, y + (th || tw) / 2, 1, 0, 6.2832); g.fill(); }
        const data = cv.toDataURL('image/png');
        kids.unshift({ k: 'i', ...bx, r: Math.min(num(cs.borderTopLeftRadius), W / 2, H / 2), src: 'dots-' + synthHash(data) + '.png', data, abs: 1 });
        bgi = 'none';
      }
      const hasBg = bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg);
      const blur = /blur\(([\d.]+)px\)/.exec(cs.filter), bblur = /blur\(([\d.]+)px\)/.exec(cs.backdropFilter || cs.webkitBackdropFilter || '');
      const visual = visible && (hasBg || (bgi && bgi !== 'none') || bw > 0 || (sh && sh !== 'none') || !!blur || !!bblur);
      const sem = SEM.has(el.tagName) || el.getAttribute('data-fra-type');
      const clip = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      // a wrapper with no paint of its own but `overflow: hidden` whose content really spills past its box (a marquee strip) must stay a clipping frame, or the spill shows
      const clipsKids = clip && visible && r.width > 1 && kids.some((k) => k.ax < bx.ax - 1 || k.ay < bx.ay - 1 || k.ax + k.w > bx.ax + bx.w + 1 || k.ay + k.h > bx.ay + bx.h + 1);
      if (!visual && !sem && !clipsKids && !(kids.length >= 2 && visible && r.width > 1) ) return kids;
      if (!visual && !sem && !clipsKids && kids.length === 0) return [];
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
    const strip = (n) => { if (n.data) { synth[n.src] = n.data; delete n.data; } (n.kids || []).forEach(strip); };
    for (const id of Object.keys(part)) strip(part[id].root);
  }
  await browser.close();
  return { sections: out, names, order: list.map((x) => x[0]), synth };
}
