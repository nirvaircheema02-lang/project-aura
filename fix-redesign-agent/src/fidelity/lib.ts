/**
 * The fidelity measuring library, as plain JavaScript source. It is evaluated as an expression
 * (never `new Function`, never a script tag) in the pre-edit snapshot AND in the running preview, so
 * both sides are measured by exactly the same code. It only reads: it never edits, clicks or submits.
 *
 * It builds on `window.__pvProbe` (probe-lib.ts) for the interactive-element inventory and deep text.
 * Elements are addressed by a LOGICAL PATH from the section root — child indexes where a design-system
 * island's wrapper (`data-pv-island`) is transparent — so the same element has the same key in the
 * original and in the preview, whether or not a component replaced it.
 */
export const CANONICAL_PROPERTIES = [
  'color', 'background-color', 'background-image',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'opacity', 'transform', 'text-decoration-line', 'text-decoration-color',
  'outline-style', 'outline-width', 'outline-color', 'outline-offset',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform',
  'cursor', 'transition-property', 'transition-duration', 'transition-timing-function',
  'display', 'position', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'row-gap', 'column-gap', 'visibility',
  'overflow-x', 'overflow-y', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
] as const;

/** The small fixed set read from a `::before` / `::after` (a pseudo-element has no box of its own to measure beyond these). */
export const PSEUDO_PROPERTIES = [
  'content', 'display', 'background-color', 'background-image', 'color', 'opacity', 'transform',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'box-shadow', 'width', 'height', 'text-decoration-line',
] as const;

/**
 * A CSS `url(...)`. The preview externalises every `data:` and remote url to its own `/assets/<hash>` path, so the TARGET of a url is never comparable across the two
 * sides: both the capture and the comparison reduce each url to "an image is here" (`url(~)`). Whether it is the same picture is the content checks' business.
 */
export const URL_PATTERN = String.raw`url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)`;
export const URL_REF = 'url(~)';
/** A quoted string (capture group 1: text, never a url, whatever it looks like) or else a url(...): the reduction replaces only the latter, wherever it sits in the value (`content: "a" url(...)`, `cursor: url(...), auto`). */
export const URL_OUTSIDE_QUOTES = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|${URL_PATTERN}`;
export const unurl = (v: string): string => v.replace(new RegExp(URL_OUTSIDE_QUOTES, 'g'), (m, quoted: string | undefined) => (quoted === undefined ? URL_REF : m));

export const FIDELITY_LIB = String.raw`(() => {
  if (window.__pvFidelity) return 'present';
  const P = window.__pvProbe;
  if (!P) throw new Error('fidelity lib needs the probe lib (window.__pvProbe)');
  const PROPS = ${JSON.stringify(CANONICAL_PROPERTIES)};
  const PPROPS = ${JSON.stringify(PSEUDO_PROPERTIES)};
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','LINK','META','TEMPLATE','TITLE','HEAD']);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const URLS = new RegExp(${JSON.stringify(URL_OUTSIDE_QUOTES)}, 'g');
  // a quoted string is text, not a url: only a url(...) outside the quotes is reduced
  const unurl = (v) => v.replace(URLS, (m, quoted) => (quoted === undefined ? ${JSON.stringify(URL_REF)} : m));
  const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
  const flatKids = (el) => { const out = []; for (const c of el.children) { if (c.tagName === 'SLOT') { for (const n of c.assignedNodes({ flatten: true })) if (n.nodeType === 1) out.push(n); } else out.push(c); } return out; };
  // a design-system island's wrapper is transparent: its children take its place and inherit its finding ids
  const logicalKids = (el) => {
    const out = [];
    for (const c of flatKids(el)) {
      if (SKIP.has(c.tagName) || c.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      if (c.hasAttribute('data-pv-island')) { const ids = c.getAttribute('data-finding-ids') || ''; for (const g of flatKids(c)) if (!SKIP.has(g.tagName) && g.namespaceURI === 'http://www.w3.org/1999/xhtml') out.push({ el: g, island: true, wrapperIds: ids }); }
      else out.push({ el: c, island: false, wrapperIds: '' });
    }
    return out;
  };
  const MAX_NODES = 4000, MAX_DEPTH = 16;
  /**
   * Walks the section. A node whose children were not entered (depth or node limit) is marked "cut": what lies below it is NOT captured, and that is recorded, never silent.
   * The limits never cut a FINDING element: every node on the way down to one is entered whatever the limits say (only what hangs below a node that leads to no finding
   * is left out), so a section bigger than the limits still has every element a finding names, with its keys, in the comparison.
   */
  function walk(root) {
    const must = new Set();
    const climb = (el) => { for (let p = el.assignedSlot || el.parentElement; p; p = p.assignedSlot || p.parentElement) { if (must.has(p)) break; must.add(p); if (p === root) break; } };
    for (const el of P.flat(root)) if (el.hasAttribute('data-fra-findings') || el.hasAttribute('data-finding-ids')) climb(el);
    const top = { el: root, key: '', parent: null, island: false, wrapperIds: '', depth: 0 };
    const stack = [top];
    let count = 1, cut = 0;
    while (stack.length) {
      const n = stack.pop();
      const kids = logicalKids(n.el);
      if ((n.depth >= MAX_DEPTH || count >= MAX_NODES) && !must.has(n.el)) { if (kids.length) { n.cut = true; cut++; } continue; }
      const made = kids.map((k, i) => ({ el: k.el, key: n.key ? n.key + '/' + i : String(i), parent: n, island: k.island, wrapperIds: k.wrapperIds, depth: n.depth + 1 }));
      count += made.length;
      n.kids = made;
      for (let i = made.length - 1; i >= 0; i--) stack.push(made[i]);
    }
    // document order
    const out = []; const visit = (n) => { out.push(n); for (const k of (n.kids || [])) visit(k); }; visit(top);
    return { nodes: out, cut };
  }
  function elementByKey(root, key) {
    if (key === '') return root;
    let cur = root;
    for (const seg of key.split('/')) { const k = logicalKids(cur)[Number(seg)]; if (!k) return null; cur = k.el; }
    return cur;
  }
  const cssOf = (el) => getComputedStyle(el);
  function styleRecord(el) {
    const cs = cssOf(el); const out = {};
    for (const p of PROPS) {
      let v = cs.getPropertyValue(p);
      if (p === 'background-image' || p === 'cursor') v = unurl(v);
      if (p === 'background-image' && v.length > 160) v = 'sha:' + fnv(v) + ':' + v.length;
      out[p] = norm(v);
    }
    return out;
  }
  /** A pseudo-element's style. It is recorded only when it is generated (content other than none / normal), except where the original had one and this side must say whether it still does. */
  function pseudoRecord(el, which) {
    const cs = getComputedStyle(el, which); const out = {};
    for (const p of PPROPS) {
      let v = cs.getPropertyValue(p);
      if (p === 'background-image' || p === 'content') v = unurl(v);
      if (v.length > 160 && p === 'background-image') v = 'sha:' + fnv(v) + ':' + v.length;
      out[p] = norm(v);
    }
    return out;
  }
  const PSEUDOS = ['::before', '::after'];
  const generated = (rec) => rec.content !== 'none' && rec.content !== 'normal' && rec.content !== '';
  /** Does a generated pseudo-element of this element paint anything (a fill, a border, a shadow)? Decoration that lives only in a ::before / ::after still makes the element design-bearing. */
  function pseudoDesign(el) {
    for (const w of PSEUDOS) { const cs = getComputedStyle(el, w); if (cs.content !== 'none' && cs.content !== 'normal' && cs.content !== '' && designBearing(cs)) return true; }
    return false;
  }
  const hasOwnText = (el) => { for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true; return false; };
  const visibleBox = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const designBearing = (cs) => {
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    for (const s of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none') return true;
    return !!cs.boxShadow && cs.boxShadow !== 'none';
  };
  const flagsOf = (el) => {
    const f = {};
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') f.disabled = true;
    for (const [attr, k] of [['aria-expanded', 'expanded'], ['aria-selected', 'selected'], ['aria-current', 'current'], ['aria-invalid', 'invalid']]) { const v = el.getAttribute(attr); if (v !== null) f[k] = v; }
    if (el.checked === true) f.checked = true;
    return f;
  };
  const ids = (el, wrapperIds) => {
    const raw = el.getAttribute('data-fra-findings') || el.getAttribute('data-finding-ids') || wrapperIds || '';
    return raw.split(/\s+/).filter(Boolean);
  };
  const ALIGN_TOL = 4;
  function hAlignOf(n, rootW) {
    if (!n.parent) return 'none';
    const cs = cssOf(n.el);
    if (cs.display === 'inline' || cs.display === 'contents' || cs.display === 'none') return 'none';
    const r = n.el.getBoundingClientRect(), pr = n.parent.el.getBoundingClientRect();
    if (r.width === 0 || pr.width === 0) return 'none';
    if (r.width >= pr.width - 8) return 'full';
    const left = r.left - pr.left, right = pr.right - r.right;
    if (Math.abs(left - right) <= ALIGN_TOL) return 'center';
    return left < right ? 'left' : 'right';
  }

  // border-box size as laid out: evidence for width/height preserve decisions. Not a style, so it never enters the global comparison.
  // Whole pixels: the report is hashed into the G2 fingerprint, and sub-pixel layout jitter between re-runs must not change it.
  const whole = (v) => Math.round(v);
  function boxOf(el) {
    const r = el.getBoundingClientRect();
    // a transform scales the rect but not the layout box: use the layout size when the element is transformed
    if (el.offsetWidth !== undefined && cssOf(el).transform !== 'none') return { w: whole(el.offsetWidth), h: whole(el.offsetHeight) };
    return { w: whole(r.width), h: whole(r.height) };
  }
  /**
   * The box a generated pseudo-element is SIZED from (see PseudoRef in types.ts). An absolutely positioned pseudo resolves against its containing block's padding box: the owner itself when
   * that is positioned (or otherwise makes a containing block: transform, filter, perspective, contain), else the nearest ancestor that does, within the section. An in-flow pseudo resolves against the
   * content box of the nearest block container (the owner's own for a block). Whole pixels; null where no box can be measured (outside the section, an inline element).
   */
  function pseudoRefOf(root, el, which) {
    const pos = getComputedStyle(el, which).position;
    const measure = (a, content) => {
      const c = cssOf(a);
      const w = a.clientWidth - (content ? (parseFloat(c.paddingLeft) || 0) + (parseFloat(c.paddingRight) || 0) : 0);
      const h = a.clientHeight - (content ? (parseFloat(c.paddingTop) || 0) + (parseFloat(c.paddingBottom) || 0) : 0);
      return w > 0 && h > 0 ? { w: whole(w), h: whole(h) } : null;
    };
    if (pos === 'fixed') return { from: 'containing-block', box: { w: innerWidth, h: innerHeight } };
    const parent = (a) => (a === root ? null : a.assignedSlot || a.parentElement);
    if (pos === 'absolute') {
      for (let a = el; a; a = parent(a)) {
        const c = cssOf(a);
        if (c.position !== 'static' || c.transform !== 'none' || c.perspective !== 'none' || c.filter !== 'none' || /layout|paint|strict|content/.test(c.contain)) return { from: 'containing-block', box: measure(a, false) };
      }
      return { from: 'containing-block', box: null };
    }
    for (let a = el; a; a = parent(a)) {
      const d = cssOf(a).display;
      if (d !== 'inline' && d !== 'contents') return { from: 'content-box', box: measure(a, true) };
    }
    return { from: 'content-box', box: null };
  }
  /**
   * Keyboard focus is decided by the browser itself: a real focus trial. Each candidate is focused and blurred again; the ones that took focus are returned. (A tabindex test calls a
   * href-less <a> focusable and a contenteditable not; a tag list gets neither right.) Run once per section on the desktop viewport, before any state is captured.
   */
  function focusTrial(root, keys) {
    const took = [];
    for (const key of keys) {
      const el = elementByKey(root, key);
      if (!el || el.disabled === true || !visibleBox(el) || cssOf(el).visibility === 'hidden') continue;
      try { el.focus({ preventScroll: true }); if (el.matches(':focus')) took.push(key); } catch (e) { /* not focusable */ } finally { try { el.blur(); } catch (e) {} }
    }
    return took;
  }
  /** How long the slowest transition among these elements runs (ms) — what to wait after a focus trial before the next default read. */
  function transitionMs(root, keys) {
    let max = 0;
    for (const key of keys) {
      const el = elementByKey(root, key); if (!el) continue;
      const cs = cssOf(el); const d = cs.transitionDuration.split(','), l = cs.transitionDelay.split(',');
      d.forEach((v, i) => { const ms = (parseFloat(v) || 0) * (/ms/.test(v) ? 1 : 1000) + (parseFloat(l[i % l.length]) || 0) * (/ms/.test(l[i % l.length]) ? 1 : 1000); if (ms > max) max = ms; });
    }
    return Math.round(max);
  }
  /** The first descendant of the element that pointer events reach (it switched them back on and is what the browser hits at its centre): its centre, and whether that is inside the viewport now. */
  function pointableInside(el) {
    const rn = el.getRootNode(); let outside = null;
    for (const d of el.querySelectorAll('*')) {
      const cs = cssOf(d);
      if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = Array.from(d.getClientRects()).find((x) => x.width > 0 && x.height > 0);
      if (!r) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { outside = outside || { x, y, inView: false }; continue; }
      const hit = rn.elementFromPoint(x, y);
      if (hit && (hit === d || d.contains(hit))) return { x, y, inView: true };
    }
    return outside;
  }
  /**
   * Where a pointer can be put to hover an element that has pointer-events: none itself: the centre of a descendant that switches pointer events back on. Hovering that descendant matches
   * the :hover state on the element too (it is an ancestor of the hit target). Null = not such a case, or nothing inside it can be pointed at (right now).
   */
  function hoverThrough(root, key) {
    const el = elementByKey(root, key);
    if (!el || cssOf(el).pointerEvents !== 'none') return null;
    const p = pointableInside(el);
    return p && p.inView ? { x: p.x, y: p.y } : null;
  }
  /**
   * Why a pointer cannot hover this element, from the element itself: pointer-events none (with nothing inside it to point at), not rendered, no box, or another element on top of its clickable
   * point (the same point a click would use: the first client rect). Null = nothing found, so a failed hover is a transient and not a property of the page.
   */
  function hoverBlocker(root, key) {
    const el = elementByKey(root, key); if (!el) return 'no element at this position';
    const cs = cssOf(el);
    if (cs.pointerEvents === 'none') return pointableInside(el) ? null : 'pointer-events: none';
    if (cs.display === 'none' || cs.visibility === 'hidden') return 'not rendered';
    const r = Array.from(el.getClientRects()).find((x) => x.width > 0 && x.height > 0);
    if (!r) return 'no box';
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    const hit = el.getRootNode().elementFromPoint(x, y);
    if (!hit) return null;
    return hit === el || el.contains(hit) ? null : 'covered by another element';
  }

  /**
   * Running animations make a default-state read time-dependent (a marquee's transform differs between two reads of the SAME page). Both sides freeze
   * them the same way before the default-state capture: finite ones are finished, endless ones are paused at time 0. thaw() resumes the paused ones so
   * the hover / focus capture behaves as before. Returns how many elements of the section carry a CSS animation (a static count: stable between runs).
   */
  function freezeAnimations(root) {
    const seen = new Set(); const paused = [];
    const all = [...document.getAnimations(), ...(root.getAnimations ? root.getAnimations({ subtree: true }) : [])];
    for (const a of all) {
      if (seen.has(a)) continue; seen.add(a);
      try {
        if (a.playState !== 'running' && a.playState !== 'pending') continue;
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        if (!t || t.endTime === Infinity || t.iterations === Infinity) { a.pause(); a.currentTime = 0; paused.push(a); } else a.finish();
      } catch (e) { /* an animation that refuses is simply left running */ }
    }
    window.__pvFrozen = paused;
    let animated = 0;
    for (const n of walk(root).nodes) { const cs = cssOf(n.el); if (cs.animationName && cs.animationName !== 'none' && cs.animationName.split(',').some((v, i) => v.trim() !== 'none' && parseFloat(cs.animationDuration.split(',')[i % cs.animationDuration.split(',').length]) > 0)) animated++; }
    return animated;
  }
  function thawAnimations() { for (const a of (window.__pvFrozen || [])) { try { a.play(); } catch (e) {} } window.__pvFrozen = []; }

  // where the text actually renders inside its element: independent of HOW it is aligned (text-align, flex, margins)
  function textAlignGeo(el) {
    if (!hasOwnText(el)) return 'none';
    const cs = cssOf(el);
    if (cs.display === 'inline' || cs.display === 'contents') return 'none';
    const range = document.createRange();
    try { range.selectNodeContents(el); } catch (e) { return 'none'; }
    const t = range.getBoundingClientRect(); const r = el.getBoundingClientRect();
    if (!t.width || !r.width) return 'none';
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    const left = t.left - (r.left + padL), right = (r.right - padR) - t.right;
    const TOL = 6;
    if (left <= TOL && right <= TOL) return 'full';
    if (Math.abs(left - right) <= TOL) return 'center';
    return left < right ? 'left' : 'right';
  }

  /** Everything except interaction states: which elements, their default styles, geometry and composition. */
  function enumerate(root, opts) {
    const maxElements = opts.maxElements;
    const walked = walk(root);
    const all = walked.nodes;
    const inv = new Map(); try { for (const i of P.inventory(root)) inv.set(i.el, i.kind); } catch (e) {}
    const rootRect = root.getBoundingClientRect();
    const groupParents = new Set();
    // groups the ORIGINAL detected are measured again whatever the heuristic says about this page: a mounted component that changes one
    // child's class must not make the group look absent
    const forced = new Set(opts.forceGroups || []);
    for (const n of all) {
      const kids = n.kids || [];
      if (kids.length < 2) continue;
      const cls = typeof kids[0].el.className === 'string' ? kids[0].el.className : '';
      const sameClass = cls && kids.every((k) => k.el.className === cls);
      const sameTag = kids.length >= 3 && kids.every((k) => k.el.tagName === kids[0].el.tagName);
      if ((sameClass || sameTag || forced.has(n.key)) && kids.every((k) => visibleBox(k.el))) groupParents.add(n);
    }
    const groupKids = new Set(); for (const g of groupParents) for (const k of g.kids) groupKids.add(k);
    const info = all.map((n) => {
      const cs = cssOf(n.el);
      const roles = [];
      if (!n.parent) roles.push('root');
      const fids = ids(n.el, n.wrapperIds);
      if (fids.length) roles.push('finding');
      if (inv.has(n.el) && inv.get(n.el) !== 'group-item') roles.push('interactive');
      if (groupKids.has(n) || inv.get(n.el) === 'group-item') roles.push('group-item');
      if (groupParents.has(n)) roles.push('group-parent');
      if (hasOwnText(n.el)) roles.push('text');
      if (designBearing(cs) || (!roles.length && pseudoDesign(n.el))) roles.push('design');
      return { n, roles, fids };
    }).filter((x) => x.roles.length > 0 && (x.n.parent === null || visibleBox(x.n.el) || x.roles.includes('finding')));
    const PRIORITY = ['root', 'finding', 'interactive', 'group-parent', 'group-item', 'text', 'design'];
    const rank = (x) => Math.min(...x.roles.map((r) => PRIORITY.indexOf(r)));
    let chosen = info;
    let dropped = 0;
    if (info.length > maxElements) {
      const keep = new Set(info.slice().sort((a, b) => rank(a) - rank(b)).slice(0, maxElements).map((x) => x.n.key));
      chosen = info.filter((x) => keep.has(x.n.key));
      dropped = info.length - chosen.length;
    }
    // members of a part that qualified as elements but lost the cap (a key in a part list with no element record, though it WOULD have had one): told apart from role-less wrappers
    const qualified = new Set(info.map((x) => x.n.key)), kept = new Set(chosen.map((x) => x.n.key));
    const capLost = (k) => qualified.has(k) && !kept.has(k);
    const elements = chosen.map(({ n, roles, fids }) => {
      const rec = {
        key: n.key, tag: n.el.tagName.toLowerCase(), label: norm(P.deepText(n.el)).slice(0, 60), textHash: fnv(norm(P.deepText(n.el))),
        stamp: n.el.getAttribute('data-fra-element'), findingIds: fids, roles, flags: flagsOf(n.el), style: styleRecord(n.el),
        hAlign: hAlignOf(n, rootRect.width), tAlign: textAlignGeo(n.el), widthRatio: rootRect.width ? Math.round((n.el.getBoundingClientRect().width / rootRect.width) * 1000) / 1000 : 0,
        states: {}, box: boxOf(n.el),
      };
      const ps = {}, pr = {};
      for (const w of PSEUDOS) { const r = pseudoRecord(n.el, w); if (generated(r)) { ps[w.slice(2)] = r; pr[w.slice(2)] = pseudoRefOf(root, n.el, w); } }
      if (ps.before || ps.after) { rec.pseudo = ps; rec.pseudoRef = pr; }
      if (n.island) rec.island = true;
      // preview side only: a user style rule or a structural DS rule restyled this element (src/preview/user-style-rules.ts, structural.ts) — an authorized difference, not a regression
      const userStyle = n.el.getAttribute('data-pv-user-style'); if (userStyle) rec.userStyle = userStyle;
      if (n.el.hasAttribute('data-pv-eyebrow')) rec.structural = 'eyebrow'; else if (n.el.hasAttribute('data-pv-indicator')) rec.structural = 'indicator';
      if (fids.length) {
        // the lists are capped (80 / 40) and the walk is limited: what was cut is COUNTED, so a decision about a part never rests on a truncated list
        const desc = []; const labels = [];
        let descTotal = 0, cutUnder = n.cut ? 1 : 0;
        const collect = (m) => { for (const k of (m.kids || [])) { descTotal++; if (desc.length < 80) desc.push(k.key); if (hasOwnText(k.el) && !(k.kids || []).some((g) => hasOwnText(g.el))) labels.push(k.key); if (k.cut) cutUnder++; collect(k); } };
        collect(n);
        if (hasOwnText(n.el)) labels.unshift(n.key);
        const truncated = {};
        if (descTotal > desc.length) truncated.descendants = descTotal - desc.length;
        if (labels.length > 40) truncated.label = labels.length - 40;
        if (cutUnder) truncated.walk = cutUnder;
        const lost = {};
        const lostLabels = labels.slice(0, 40).filter(capLost), lostDesc = desc.filter(capLost);
        if (lostLabels.length) lost.label = lostLabels;
        if (lostDesc.length) lost.descendants = lostDesc;
        rec.partKeys = { label: labels.slice(0, 40), descendants: desc, named: {}, ...(Object.keys(truncated).length ? { truncated } : {}), ...(Object.keys(lost).length ? { capDropped: lost } : {}) };
      }
      return rec;
    });
    const groups = [];
    const GROUP_CAP = 12;
    const orderedGroups = [...groupParents].sort((a, b) => (forced.has(b.key) ? 1 : 0) - (forced.has(a.key) ? 1 : 0));
    const groupsDropped = Math.max(0, orderedGroups.length - GROUP_CAP);
    for (const g of orderedGroups.slice(0, GROUP_CAP)) {
      const kids = g.kids.map((k) => ({ k, r: k.el.getBoundingClientRect() }));
      const pr = g.el.getBoundingClientRect();
      const bucket = (v) => Math.round(v / 8);
      const xs = new Set(kids.map((x) => bucket(x.r.left))), ys = new Set(kids.map((x) => bucket(x.r.top)));
      const idx = kids.map((_x, i) => i);
      const visualOrder = idx.slice().sort((a, b) => bucket(kids[a].r.top) - bucket(kids[b].r.top) || kids[a].r.left - kids[b].r.left);
      const columns = xs.size;
      const firstRow = kids.slice(0, Math.max(1, columns));
      groups.push({
        parentKey: g.key, childKeys: g.kids.map((k) => k.key), columns, rows: ys.size, visualOrder,
        topOffsets: firstRow.map((x) => Math.round((x.r.top - kids[0].r.top) / 2) * 2),
        widthRatios: kids.map((x) => (pr.width ? Math.round((x.r.width / pr.width) * 100) / 100 : 0)),
      });
    }
    // an element that is sticky but has no inset at all can never pin: it is disclosed, not traced
    const stickyAll = all.filter((n) => cssOf(n.el).position === 'sticky').map((n) => { const cs = cssOf(n.el); return { key: n.key, top: cs.top, inert: [cs.top, cs.bottom, cs.left, cs.right].every((v) => v === 'auto') }; });
    const stickyLive = stickyAll.filter((x) => !x.inert);
    const STICKY_CAP = 12;
    const sticky = stickyLive.slice(0, STICKY_CAP).map((x) => ({ key: x.key, top: x.top }));
    // What the cut hid that a REQUIRED check needs. The probe's inventory and flat tree do not depend on the walk, so controls / group items / sticky elements the walk never reached are counted exactly;
    // a cut node that directly holds two or more children may hold an unobserved group. A cut that hid none of these only left decoration out.
    let walkHidden = null;
    if (walked.cut > 0) {
      const seen = new Set(all.map((n) => n.el));
      walkHidden = { controls: 0, groups: 0, sticky: 0 };
      for (const [el] of inv) if (!seen.has(el) && visibleBox(el)) walkHidden.controls++;
      for (const n of all) if (n.cut && logicalKids(n.el).length >= 2) walkHidden.groups++;
      for (const el of P.flat(root)) {
        if (seen.has(el) || SKIP.has(el.tagName) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || el.hasAttribute('data-pv-island')) continue;
        const cs = cssOf(el);
        if (cs.position === 'sticky' && [cs.top, cs.bottom, cs.left, cs.right].some((v) => v !== 'auto')) walkHidden.sticky++;
      }
    }
    return { elements, groups, stickyCandidates: sticky, dropped, nodeCount: all.length, walkCut: walked.cut, walkHidden, groupsDropped, stickyDropped: Math.max(0, stickyLive.length - STICKY_CAP), stickyInert: stickyAll.length - stickyLive.length };
  }

  /**
   * The target's own styles plus its first descendants that carry text or a visible design IN THE STATE BEING CAPTURED, and the descendants named in
   * "forced" (the keys the ORIGINAL listed: a child whose design only appears on hover, like a reveal layer, is then measured on the preview too even
   * if the preview lost the rule that made it visible). Keys are relative to the target. "dropped" counts qualifying descendants beyond "maxDesc".
   */
  function subtree(root, key, maxDesc, forced) {
    const target = elementByKey(root, key);
    if (!target) return null;
    const s = { '': styleRecord(target) };
    const want = new Set(forced || []);
    // a member's ::before / ::after: recorded when generated in this state, or when the original listed it (a side that lost the rule must still say so); with the box its size resolves against in this state
    const refs = {};
    const addPseudo = (rel, el) => { for (const w of PSEUDOS) { const r = pseudoRecord(el, w); if (generated(r) || want.has(rel + w)) { s[rel + w] = r; refs[rel + w] = pseudoRefOf(root, el, w); } } };
    addPseudo('', target);
    let count = 0, dropped = 0;
    const visit = (el, rel) => {
      logicalKids(el).forEach((k, i) => {
        const relKey = rel ? rel + '/' + i : String(i);
        if (want.has(relKey)) { s[relKey] = styleRecord(k.el); addPseudo(relKey, k.el); }
        else if (hasOwnText(k.el) || designBearing(cssOf(k.el)) || pseudoDesign(k.el)) { if (count < maxDesc) { s[relKey] = styleRecord(k.el); addPseudo(relKey, k.el); count++; } else dropped++; }
        visit(k.el, relKey);
      });
    };
    visit(target, '');
    return { s, dropped, r: refs };
  }
  /** The longest transition (duration + delay) in the target's subtree AND its ancestors, in ms — how long to let a state settle (an inherited value animates with the ancestor's transition). */
  function maxTransitionMs(root, key, maxDesc) {
    const target = elementByKey(root, key); if (!target) return 0;
    const els = [target]; const q = [target]; while (q.length && els.length < maxDesc + 1) { const e = q.shift(); for (const k of logicalKids(e)) { els.push(k.el); q.push(k.el); } }
    for (let a = target.parentElement, n = 0; a && n < 24; a = a.parentElement, n++) { els.push(a); if (a === root) break; }
    let max = 0;
    for (const el of els) {
      const cs = cssOf(el); const d = cs.transitionDuration.split(','), l = cs.transitionDelay.split(',');
      d.forEach((v, i) => { const ms = (parseFloat(v) || 0) * (/ms/.test(v) ? 1 : 1000) + (parseFloat(l[i % l.length]) || 0) * (/ms/.test(l[i % l.length]) ? 1 : 1000); if (ms > max) max = ms; });
    }
    return Math.round(max);
  }
  /**
   * Transitions and animations still running on the target, EVERYTHING below it (a descendant's and any ::before / ::after: only a subtree query sees pseudo-element animations) and its
   * ancestors: how many, whether one never ends, and the longest time left (ms).
   */
  function animationState(root, key) {
    const target = elementByKey(root, key); if (!target) return { running: 0, infinite: false, remaining: 0 };
    const anims = target.getAnimations ? target.getAnimations({ subtree: true }) : [];
    for (let a = target.parentElement, n = 0; a && n < 24; a = a.parentElement, n++) { if (a.getAnimations) anims.push(...a.getAnimations()); if (a === root) break; }
    let running = 0, infinite = false, remaining = 0;
    for (const a of anims) {
      if (a.playState !== 'running' && a.playState !== 'pending') continue;
      running++;
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      if (t && (t.iterations === Infinity || t.endTime === Infinity)) { infinite = true; continue; }
      const left = (t ? t.endTime : 0) - (a.currentTime == null ? 0 : Number(a.currentTime));
      if (left > remaining) remaining = left;
    }
    return { running, infinite, remaining: Math.round(remaining) };
  }
  function focusInfo(root, key) { const el = elementByKey(root, key); if (!el) return null; return { focused: el === document.activeElement || (el.getRootNode && el.getRootNode().activeElement === el), visible: el.matches(':focus-visible') }; }
  function rectTop(root, key) { const el = elementByKey(root, key); return el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null; }
  window.__pvFidelity = { enumerate, subtree, freezeAnimations, thawAnimations, elementByKey, maxTransitionMs, animationState, focusInfo, rectTop, styleRecord, focusTrial, transitionMs, hoverBlocker, hoverThrough, norm };
  return 'installed';
})()`;
