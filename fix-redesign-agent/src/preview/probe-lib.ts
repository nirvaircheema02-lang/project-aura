/**
 * The in-page probe library, as plain JavaScript source. It is evaluated as an expression
 * (never `new Function`/script tags) in BOTH the original production page and the generated
 * preview, so both sides are measured by exactly the same code. It never submits anything: it
 * only reads, hovers, scrolls, and (for non-submit controls) clicks and edits values.
 *
 * `window.__pvProbe.inventory(root)` lists interactive elements in document order;
 * the other functions measure one observable aspect of a section root.
 */
export const PROBE_LIB = String.raw`(() => {
  if (window.__pvProbe) return 'present';
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','LINK','META','TEMPLATE','TITLE']);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => norm(el.getAttribute('aria-label') || deepTextSafe(el) || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || '').slice(0, 80);
  const deepTextSafe = (el) => deepText(el);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // flattened-tree traversal: design-system "islands" are light-DOM nodes slotted into the section's shadow tree
  const flatChildren = (el) => { const out = []; for (const c of el.children) { if (c.tagName === 'SLOT') { for (const n of c.assignedNodes({ flatten: true })) if (n.nodeType === 1) out.push(n); } else out.push(c); } return out; };
  function flat(root) { const out = []; const visit = (n) => { out.push(n); for (const c of flatChildren(n)) visit(c); }; for (const c of flatChildren(root)) visit(c); return out; }
  function deepText(root) { let out = ''; const visit = (n) => { if (n.nodeType === 3) out += n.nodeValue + ' '; else if (n.nodeType === 1) { if (SKIP.has(n.tagName)) return; if (n.tagName === 'SLOT') { for (const a of n.assignedNodes({ flatten: true })) visit(a); return; } for (const c of n.childNodes) visit(c); } }; visit(root); return norm(out); }
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase(); const type = el.getAttribute('type');
    if (tag === 'a') return 'link'; if (tag === 'select') return 'select'; if (tag === 'textarea') return 'textarea'; if (tag === 'summary') return 'summary';
    if (tag === 'input') return type === 'range' ? 'range' : (type === 'checkbox' || type === 'radio') ? 'checkbox' : 'input';
    if (el.hasAttribute('aria-expanded')) return 'disclosure';
    return 'button';
  };
  function inventory(root) {
    const found = new Map();
    const add = (el, kind) => { if (!found.has(el)) found.set(el, kind); };
    const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=switch],[role=checkbox],[role=menuitem],[aria-expanded],[tabindex]:not([tabindex="-1"])';
    const all = flat(root);
    for (const el of all) if (el.matches(sel)) add(el, kindOf(el));
    const owned = (el) => { for (const f of found.keys()) if (f !== el && f.contains(el)) return true; return false; };
    for (const el of all) {
      if (SKIP.has(el.tagName) || found.has(el) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      if (getComputedStyle(el).cursor === 'pointer' && deepText(el).length > 0 && !owned(el)) add(el, 'pointer');
    }
    // repeated sibling groups (lists of cards, accordions, tabs): the first two are probed
    for (const parent of all) {
      const kids = flatChildren(parent).filter((k) => !SKIP.has(k.tagName) && k.namespaceURI === 'http://www.w3.org/1999/xhtml');
      if (kids.length < 3) continue;
      const cls = typeof kids[0].className === 'string' ? kids[0].className : '';
      if (!cls || !kids.every((k) => k.className === cls) || !kids.every((k) => deepText(k).length > 0 && k.getBoundingClientRect().height > 24)) continue;
      for (const k of kids.slice(0, 2)) if (!owned(k)) add(k, 'group-item');
    }
    const order = new Map(all.map((e, i) => [e, i]));
    const els = Array.from(found.keys()).sort((a, b) => order.get(a) - order.get(b));
    return els.map((el, index) => ({ el, index, kind: found.get(el), tag: el.tagName.toLowerCase(), label: labelOf(el), href: el.tagName === 'A' ? el.getAttribute('href') : null }));
  }
  const overlays = () => {
    let n = 0;
    for (const el of document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')) if (visible(el)) n++;
    for (const el of document.body.children) { const cs = getComputedStyle(el); if (cs.position === 'fixed' && visible(el) && el.getBoundingClientRect().width > innerWidth * 0.6 && el.getBoundingClientRect().height > innerHeight * 0.6 && !el.hasAttribute('data-pv-chrome')) n++; }
    return n;
  };
  function signature(root) {
    const all = flat(root);
    return { text: deepText(root), expanded: all.filter((e) => e.getAttribute('aria-expanded') === 'true').length, height: Math.round(root.getBoundingClientRect().height), overlay: overlays(), hidden: all.filter((e) => e.hasAttribute('hidden')).length, value: all.filter((e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)).map((e) => e.value).join('|') };
  }
  const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.,%$₹€£-]*/gu) || []);
  function textDelta(before, after) {
    const count = (arr) => { const m = new Map(); for (const w of arr) m.set(w, (m.get(w) || 0) + 1); return m; };
    const b = count(words(before)); const a = count(words(after));
    const added = []; const removed = [];
    for (const [w, n] of a) if ((b.get(w) || 0) < n) added.push(w);
    for (const [w, n] of b) if ((a.get(w) || 0) < n) removed.push(w);
    return { added: added.slice(0, 12), removed: removed.slice(0, 12) };
  }
  const HOVER_PROPS = ['color','backgroundColor','borderTopColor','boxShadow','transform','opacity','textDecorationLine','filter','outlineStyle','width','height'];
  function styleSnapshot(el) {
    const els = [el, ...Array.from(el.querySelectorAll('*')).slice(0, 14)];
    return els.map((e) => { const cs = getComputedStyle(e); return HOVER_PROPS.map((p) => cs[p]); });
  }
  function styleDiff(a, b) {
    const changed = new Set();
    for (let i = 0; i < Math.min(a.length, b.length); i++) for (let j = 0; j < HOVER_PROPS.length; j++) if (a[i][j] !== b[i][j]) changed.add(HOVER_PROPS[j]);
    return Array.from(changed);
  }
  function scrollFingerprint(root) {
    const out = [];
    for (const el of flat(root)) {
      if (SKIP.has(el.tagName)) continue;
      const svgAttrs = el.namespaceURI === 'http://www.w3.org/2000/svg' ? ['stroke-dashoffset','stroke-dasharray','opacity','transform','d','cx','cy','fill','stroke'].map((a) => el.getAttribute(a) || '').join(',') : '';
      out.push((typeof el.className === 'string' ? el.className : el.getAttribute('class') || '') + '|' + (el.getAttribute('style') || '') + '|' + svgAttrs + '|' + (el.getAttribute('aria-expanded') || '') + (el.hasAttribute('hidden') ? 'h' : ''));
    }
    return out;
  }
  function describe(el) { return el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : '') + ' "' + labelOf(el).slice(0, 30) + '"'; }
  function elementsForFingerprint(root) { return flat(root).filter((e) => !SKIP.has(e.tagName)); }
  function animations(root) {
    // document.getAnimations() does not report animations inside shadow trees, so ask every element of the flattened tree
    const out = [];
    const seen = new Set();
    for (const el of [root, ...flat(root)]) {
      for (const a of el.getAnimations()) {
        if (seen.has(a) || a.constructor.name !== 'CSSAnimation') continue;
        seen.add(a);
        const timing = a.effect.getTiming();
        out.push({ name: a.animationName, durationMs: Math.round(Number(timing.duration)), iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations, state: a.playState });
      }
    }
    return out;
  }
  function sticky(root) {
    const out = [];
    for (const el of flat(root)) if (!SKIP.has(el.tagName) && getComputedStyle(el).position === 'sticky') out.push(describe(el));
    return out;
  }
  window.__pvProbe = { flat, deepText, inventory, signature, textDelta, styleSnapshot, styleDiff, scrollFingerprint, elementsForFingerprint, describe, animations, sticky, overlays, norm };
  return 'installed';
})()`;
