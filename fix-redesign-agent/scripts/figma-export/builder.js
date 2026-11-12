// Runs inside Figma (use_figma): globals DATA (section trees), TABLE (shared SVG strings) and CFG ({ page, wrapper, order, names }).
// Installed once per Figma file in plugin data (fra/builder) so each page export only sends its data.
let page = figma.root.children.find((p) => p.name === CFG.page);
if (!page) { page = figma.createPage(); page.name = CFG.page; }
await figma.setCurrentPageAsync(page);
for (const pg of figma.root.children) await pg.loadAsync();
const NAMES = CFG.names;
const ORDER = CFG.order.filter((id) => DATA[id]);
const DARK = new Set(CFG.dark || []);
const MKBG = CFG.maskBg || {};
let wrapper = page.children.find((n) => n.name === CFG.wrapper);
if (!wrapper) {
  wrapper = figma.createFrame(); wrapper.name = CFG.wrapper; wrapper.layoutMode = 'VERTICAL'; wrapper.itemSpacing = 0;
  wrapper.primaryAxisSizingMode = 'AUTO'; wrapper.counterAxisSizingMode = 'FIXED'; wrapper.resize(1440, 100); wrapper.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  let right = 0; for (const c of page.children) if (c !== wrapper) right = Math.max(right, c.x + c.width);
  page.appendChild(wrapper); wrapper.x = right ? right + 200 : 0; wrapper.y = 0;
}
figma.root.setSharedPluginData('fra', 'cfg', JSON.stringify({ page: CFG.page, wrapper: CFG.wrapper }));
const FAM = { s: 'DM Sans', n: 'Noto Serif', m: 'DM Mono' };
const STY = (f, k) => f === 'm' ? (k <= 300 ? 'Light' : k >= 500 ? 'Medium' : 'Regular') : (k <= 300 ? 'Light' : k === 400 ? 'Regular' : k === 500 ? 'Medium' : k === 600 ? 'SemiBold' : k >= 800 ? 'ExtraBold' : 'Bold');
const need = new Set(); const scan = (n) => { if (n.k === 't') need.add(n.f + '|' + STY(n.f, n.wt)); (n.ch || []).forEach(scan); }; Object.values(DATA).forEach(scan);
await Promise.all([...need].map(x => { const [f, st] = x.split('|'); return figma.loadFontAsync({ family: FAM[f], style: st }); }));
await figma.loadFontAsync({ family: 'DM Sans', style: 'Medium' });
const TK = CFG.tokens || {};
const colls = await figma.variables.getLocalVariableCollectionsAsync();
const collOf = (name) => colls.find((c) => c.name === name);
const PRIM = /^(?:red|black|white|warm|purple|periwinkle|coral|perano|green|amber|rose)(?:-\d+)?$/;
const palette = new Map(); const TOKS = [];
const cc = collOf(TK.colors || 'Ken / Colors') || collOf('Ken DS (core-v2)');
for (const id of (cc ? cc.variableIds : [])) {
  const v = await figma.variables.getVariableByIdAsync(id); if (v.resolvedType !== 'COLOR') continue;
  const c = v.valuesByMode[cc.modes[0].modeId]; if (!c || c.r === undefined) continue;
  const key = ([c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0'))).join('') + '@' + Math.round((c.a === undefined ? 1 : c.a) * 100);
  const prev = palette.get(key);
  if (!prev || (!PRIM.test(prev.name) && PRIM.test(v.name))) palette.set(key, v);
  TOKS.push({ v, r: c.r * 255, g: c.g * 255, b: c.b * 255, a: c.a === undefined ? 1 : c.a });
}
const floatMap = async (name, only) => { const m = new Map(); const c = collOf(name); for (const id of (c ? c.variableIds : [])) { const v = await figma.variables.getVariableByIdAsync(id); if (v.resolvedType !== 'FLOAT' || (only && !only.test(v.name))) continue; const x = v.valuesByMode[c.modes[0].modeId]; if (typeof x === 'number' && !m.has(x)) m.set(x, v); } return m; };
const spaceVars = await floatMap(TK.spacing || 'Ken / Spacing', /^space\//);
const radiusVars = await floatMap(TK.radius || 'Ken / Border Radius / Scale', /^radius-/);
const sizeVars = await floatMap(TK.typography || 'Ken / Typography', /^(?:text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|compact|nav|card-micro)|button-font-lg)$/); // 18px is the DS button-font-lg (user, 2026-10-30)
for (const [k, v] of await floatMap('Ken / Badge', /^badge-sm-font$/)) if (!sizeVars.has(k)) sizeVars.set(k, v); // the 11px micro label ("Step 01") is the DS badge-sm-font
const bindNum = (node, field, value, map) => { const v = map.get(Math.round(value * 100) / 100); if (v) { try { node.setBoundVariable(field, v); } catch (e) { /* field not bindable on this node */ } } };
const okHex = (s) => {
  const m = /^oklab\(\s*([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(s); if (!m) return s;
  const L = +m[1], a = +m[2], b = +m[3], al = m[4] === undefined ? 1 : +m[4];
  const l_ = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3), m_ = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3), s_ = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_];
  const g = (x) => { x = Math.min(1, Math.max(0, x)); return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; };
  const h2 = (x) => Math.round(g(x) * 255).toString(16).padStart(2, '0');
  return h2(lin[0]) + h2(lin[1]) + h2(lin[2]) + Math.round(al * 255).toString(16).padStart(2, '0');
};
const rgb = (h) => ({ r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 });
const alpha = (h) => h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
// No exact token: the NEAREST suitable one (user rule, 2026-10-30): same alpha (within 0.02), colour distance dE76 <= 2 in CIE Lab, and a token of the same role (text/icon ink, fill or stroke), so the look does not change
const labOf = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; const R = f(r), G = f(g), B = f(b); const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883; const h = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; return [116 * h(Y) - 16, 500 * (h(X) - h(Y)), 200 * (h(Y) - h(Z))]; };
const POOL = { text: /^(text-|black|white|label-|semantic-ink|color-text|foundation)/, icon: /^(text-|black|white|label-|semantic-ink|color-text|foundation)/, fill: /^(?!text-|label-|border-)/, stroke: /^(?!text-|label-)/ };
// second tier (user, 2026-10-30): no token within dE 2 -> the CLOSEST token of the same alpha within dE 15 (text may also take the neutral ramps), so nothing stays untokenized where a close DS colour exists
const POOL_NEAR_TEXT = /^(text-|black|white|warm|label-|semantic-ink|color-text|foundation)/;
const NEAR = {};
const nearestToken = (base, a, role, maxD = 2, pool = (POOL[role] || POOL.fill)) => {
  const c = rgb(base); const L = labOf(c.r * 255, c.g * 255, c.b * 255); let best = null;
  for (const t of TOKS) { if (Math.abs(t.a - a) > 0.02 || !pool.test(t.v.name)) continue; const T = labOf(t.r, t.g, t.b); const d = Math.sqrt((L[0] - T[0]) ** 2 + (L[1] - T[1]) ** 2 + (L[2] - T[2]) ** 2); if (d <= maxD && (!best || d < best.d || (d === best.d && PRIM.test(t.v.name) && !PRIM.test(best.t.v.name)))) best = { t, d }; }
  return best;
};
let LASTOV = null; // set when a text colour is a full-alpha token shown at partial opacity: the caller then sets the node's opacity (a bound paint always takes its variable's alpha)
const solidFill = (h0, op = 1, role = 'fill') => { LASTOV = null; const h = okHex(h0); const base = h.slice(0, 6).toLowerCase(), a = alpha(h) * op; const v = palette.get(base + '@' + Math.round(a * 100)); if (v) return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: rgb(base) }, 'color', v);
  const ov = a < 0.999 && role === 'text' ? palette.get(base + '@100') : null; if (ov) { LASTOV = a; return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: rgb(base) }, 'color', ov); } // exact RGB token, shown at partial opacity: bind it and keep the paint opacity
  const nb = nearestToken(base, a, role) || nearestToken(base, a, role, 15, role === 'text' ? POOL_NEAR_TEXT : (POOL[role] || POOL.fill)); if (nb) { const k = base + '@' + Math.round(a * 100) + ' -> ' + nb.t.v.name + ' (dE ' + nb.d.toFixed(1) + ')'; NEAR[k] = (NEAR[k] || 0) + 1; return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: nb.t.r / 255, g: nb.t.g / 255, b: nb.t.b / 255 } }, 'color', nb.t.v); }
  return { type: 'SOLID', color: rgb(base), opacity: a }; };
const gradFill = (s, op = 1) => {
  const m = /(linear|radial)-gradient\(/.exec(s); if (!m) return null;
  let i = m.index + m[0].length, d = 1; const st = i; while (i < s.length && d > 0) { if (s[i] === '(') d++; if (s[i] === ')') d--; i++; }
  const body = s.slice(st, i - 1); const stops = [...body.matchAll(/#([0-9a-fA-F]{6,8})(?:\s+(-?[\d.]+)%)?/g)];
  if (stops.length < 2) return null;
  const gs = stops.map((x, k) => ({ position: Math.min(1, Math.max(0, x[2] !== undefined ? parseFloat(x[2]) / 100 : k / (stops.length - 1))), color: { ...rgb(x[1]), a: alpha(x[1]) * op } }));
  if (m[1] === 'radial') return { type: 'GRADIENT_RADIAL', gradientStops: gs, gradientTransform: [[1, 0, 0], [0, 1, 0]] };
  const am = /(-?[\d.]+)deg/.exec(body.split('#')[0]); const th = ((am ? parseFloat(am[1]) : /to right/.test(body) ? 90 : 180) * Math.PI) / 180; const dx = Math.sin(th), dy = -Math.cos(th);
  return { type: 'GRADIENT_LINEAR', gradientStops: gs, gradientTransform: [[dx, dy, 0.5 - 0.5 * dx - 0.5 * dy], [-dy, dx, 0.5 + 0.5 * dy - 0.5 * dx]] };
};
const shadowOf = (s) => { const m = /#([0-9a-fA-F]{6,8})\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?/.exec(s); if (!m || /inset/.test(s)) return []; return [{ type: 'DROP_SHADOW', color: { ...rgb(m[1]), a: alpha(m[1]) }, offset: { x: +m[2], y: +m[3] }, radius: +m[4], spread: +(m[5] || 0), visible: true, blendMode: 'NORMAL' }]; };
const btnSet = figma.root.findOne((n) => n.type === 'COMPONENT_SET' && n.name === (CFG.dsButton || 'Button / Brand')) || figma.root.findOne((n) => n.type === 'COMPONENT_SET' && n.name === 'Button');
const stComp = figma.root.findOne((n) => n.type === 'COMPONENT' && n.name === 'StepLabel') || figma.root.findOne((n) => n.type === 'COMPONENT_SET' && n.name === 'StepLabel');
const brandVariant = btnSet ? (btnSet.findOne((c) => c.type === 'COMPONENT' && c.name === 'Size=md, State=Rest') || btnSet.findOne((c) => c.type === 'COMPONENT' && c.name === 'Variant=Brand, State=Default')) : null;
const firstText = (n) => { if (n.k === 't') return n; for (const c of n.ch || []) { const t = firstText(c); if (t) return t; } return null; };
const stats = { frames: 0, auto: 0, texts: 0, icons: 0, images: 0, ds: 0 }; const errors = {};
const AL = { MIN: 'MIN', CENTER: 'CENTER', MAX: 'MAX' };
const MINW = new Map(); // text id -> width of its longest word
const wordMin = (t, s) => { const word = s.split(/\s+/).sort((a, b) => b.length - a.length)[0]; if (!word) return 0; const p = figma.createText(); p.fontName = t.fontName; p.fontSize = t.fontSize; p.letterSpacing = t.letterSpacing; p.characters = word; const x = Math.ceil(p.width) + 1; p.remove(); return x; };
async function build(n, parent, parentAL, dark) {
  if (n.k === 'f') {
    const mb = /^(Button|Link) · (.+)$/.exec(n.n || ''); const ft = firstText(n);
    // a brand-gradient CTA with white text is the DS Button (Brand); everything else is rebuilt from its measured style
    if (mb && brandVariant && ft && /^ffffff/.test(ft.c) && n.g && /linear-gradient\(90deg/.test(n.g)) {
      const label = ft.s.trim() || mb[2]; // the frame name is cut at 40 characters with an ellipsis: the label is the CTA's own text
      const inst = brandVariant.createInstance(); parent.appendChild(inst);
      const props = Object.keys(inst.componentProperties); const lab = props.find((k) => k.startsWith('Label')); const arr = props.find((k) => k.startsWith('Arrow'));
      if (lab || arr) { const set = {}; if (lab) set[lab] = label; if (arr) set[arr] = (n.ch || []).some((c) => c.k === 'v'); inst.setProperties(set); } else { const tx = inst.findOne((x) => x.type === 'TEXT'); if (tx) tx.characters = label; }
      inst.name = 'Button · ' + label; inst.primaryAxisSizingMode = 'AUTO'; // hug the label (an instance of an older Button / Brand may be fixed-width)
      const shm = inst.findOne((x) => x.name === 'Shimmer'); if (shm) shm.resize(inst.width, inst.height); // the brand fill covers the arrow too, whatever width the label gave the button
      if (!parentAL) { inst.x = n.x + (n.w - inst.width) / 2; inst.y = n.y + (n.h - inst.height) / 2; } stats.ds++; return inst; }
    if (stComp && /^Badge · Step \d+$/.test(n.n || '')) { const inst = stComp.createInstance(); inst.findOne(x => x.type === 'TEXT').characters = n.n.slice(8); inst.name = n.n; parent.appendChild(inst); if (!parentAL) { inst.x = n.x; inst.y = n.y; } stats.ds++; return inst; }
    const op = n.op === undefined ? 1 : n.op;
    const f = figma.createFrame(); f.name = n.n || 'Group'; f.resize(Math.max(1, n.w), Math.max(1, n.h)); const fl = [];
    if (n.b) fl.push(solidFill(n.b, op)); if (n.g && !/109\.59deg/.test(n.g)) { const g = gradFill(n.g, op); if (g) fl.push(g); } f.fills = fl;
    if (n.bw) { f.strokes = [solidFill(n.bc, op, 'stroke')]; f.strokeWeight = n.bw; f.strokeAlign = 'INSIDE'; } if (n.r) { f.cornerRadius = Math.min(n.r, Math.min(n.w, n.h) / 2); if (n.r === Math.min(n.r, Math.min(n.w, n.h) / 2)) for (const k of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) bindNum(f, k, n.r, radiusVars); }
    const ef = n.sh ? shadowOf(n.sh) : []; if (n.fl) ef.push({ type: 'LAYER_BLUR', radius: n.fl * 2, visible: true }); if (n.bb) ef.push({ type: 'BACKGROUND_BLUR', radius: n.bb * 2, visible: true }); if (ef.length) f.effects = ef;
    f.clipsContent = !!n.cl;
    if (n.al) { const a = n.al; f.layoutMode = a.d === 'V' ? 'VERTICAL' : 'HORIZONTAL'; f.itemSpacing = a.g; f.paddingTop = a.pt; f.paddingBottom = a.pb; f.paddingLeft = a.pl; f.paddingRight = a.pr; for (const [fld, val] of [['itemSpacing', a.g], ['paddingTop', a.pt], ['paddingBottom', a.pb], ['paddingLeft', a.pl], ['paddingRight', a.pr]]) bindNum(f, fld, val, spaceVars); f.primaryAxisAlignItems = 'MIN'; f.counterAxisAlignItems = AL[a.ca]; f.primaryAxisSizingMode = 'FIXED'; f.counterAxisSizingMode = 'FIXED'; stats.auto++; }
    stats.frames++; parent.appendChild(f); if (!parentAL) { f.x = n.x; f.y = n.y; }
    const imgOnly = (k) => k.k === 'i' || (k.k === 'f' && (k.ch || []).length > 0 && k.ch.every(imgOnly)); const bgOnly = (k) => k.k === 'f' && !!k.b && !(k.ch || []).length; let kids = n.ch || []; if (!n.al) kids = [...kids.filter(k => k.bel), ...kids.filter(k => !k.bel && (imgOnly(k) || bgOnly(k))), ...kids.filter(k => !k.bel && !(imgOnly(k) || bgOnly(k)))];
    for (const k of kids) await build(k, f, !!n.al, dark);
    if (n.al && n.al.d === 'H') { // wrapped text is built 6% wider than measured: take that back when the row overflows, so the trailing icon stays inside it
      const vis = f.children.filter((c) => c.layoutPositioning !== 'ABSOLUTE'); let over = n.al.pl + n.al.pr + n.al.g * Math.max(0, vis.length - 1) + vis.reduce((s, c) => s + c.width, 0) - f.width;
      for (const c of vis) if (over > 0.5 && c.type === 'TEXT' && c.textAutoResize === 'HEIGHT') { const w = Math.max(MINW.get(c.id) || 20, c.width - over); over -= c.width - w; c.resize(w, c.height); }
    }
    return f;
  }
  if (n.k === 't') {
    const t = figma.createText(); const sty = STY(n.f, n.wt); t.fontName = { family: FAM[n.f], style: sty }; t.characters = n.s; t.fontSize = n.z;
    bindNum(t, 'fontSize', n.z, sizeVars); // text styles are linked afterwards (post step), where they match exactly
    t.fills = [solidFill(/^[0-9a-f]{6}00$/.test(n.c) ? 'b01f24' : n.c, n.op === undefined ? 1 : n.op, 'text')]; if (LASTOV !== null) t.opacity = LASTOV;
    t.letterSpacing = { unit: 'PIXELS', value: n.l || 0 }; if (n.L) t.lineHeight = { unit: 'PIXELS', value: n.L }; if (n.u) t.textCase = 'UPPER'; if (n.d) t.textDecoration = 'UNDERLINE';
    const al = n.a === 'c' ? 'CENTER' : (n.a === 'r' || n.a === 'e') ? 'RIGHT' : 'LEFT'; t.textAlignHorizontal = al; parent.appendChild(t);
    const single = !/\s/.test(n.s.trim()) || n.h <= (n.L || n.z * 1.4) * 1.3;
    if (single) t.textAutoResize = 'WIDTH_AND_HEIGHT';
    else {
      // wrapped text: the browser's measured width is the width the lines wrap at. A line-clamped text keeps exactly that width (6% more lets a clamped second line show extra words); every wrapped text stays at least as wide as its longest word in Figma's own metrics, so a word is never broken and cut off ("Benchmarkin…")
      const wm = wordMin(t, n.s); const w = Math.max(n.lc ? n.w : n.w * 1.06 + 4, wm);
      t.resize(w, 20); t.textAutoResize = 'HEIGHT'; MINW.set(t.id, wm);
    }
    if (!parentAL) { t.x = n.x + (al === 'CENTER' ? n.w / 2 - t.width / 2 : al === 'RIGHT' ? n.w - t.width : 0); t.y = n.lc ? n.y : n.y + n.h / 2 - t.height / 2; }
    t.name = n.s.slice(0, 40); if (n.lc) { t.textTruncation = 'ENDING'; t.maxLines = n.lc; } stats.texts++; return t;
  }
  if (n.k === 'i') {
    const r = figma.createRectangle(); r.name = 'IMG|' + (n.src || 'none'); r.resize(Math.max(1, n.w), Math.max(1, n.h)); if (n.r) r.cornerRadius = Math.min(n.r, Math.min(n.w, n.h) / 2);
    r.fills = [solidFill(dark ? '404040' : 'e5e5e5')]; r.setSharedPluginData('fra', 'm', JSON.stringify({ fit: n.fit || 'fill', op: n.op, mb: n.mb, gs: n.gs, pos: n.pos, w: n.w, h: n.h }));
    parent.appendChild(r);
    if (n.abs && parentAL) { r.layoutPositioning = 'ABSOLUTE'; r.x = n.x; r.y = n.y; parent.insertChild(0, r); } else if (!parentAL) { r.x = n.x; r.y = n.y; }
    stats.images++; return r;
  }
  if (n.k === 'v') { try { const sv = n.v.startsWith('@') ? TABLE[n.v.slice(1)] : n.v; const v = figma.createNodeFromSvg(sv); v.name = 'Icon'; v.resize(Math.max(1, n.w), Math.max(1, n.h)); if (n.op !== undefined) v.opacity = n.op; parent.appendChild(v); if (!parentAL) { v.x = n.x; v.y = n.y; } stats.icons++; return v; } catch (e) { errors['svg' + stats.icons] = String(e).slice(0, 60); } }
}
const report = {};
for (const sid of ORDER) {
  let root = DATA[sid]; if (!root) continue;
  // scroll runway (a pinned/sticky block with thousands of px of padding above and below): show the pinned block as ONE viewport, without the blank scroll distance (user, 2026-10-30)
  if (root.al && root.ch && root.ch.length === 1 && root.al.pt >= 900 && root.al.pb >= 900) { const c = root.ch[0]; root = { ...root, h: c.h, al: { ...root.al, pt: 0, pb: 0 } }; }
  const olds = wrapper.children.filter(c => c.name === NAMES[sid]); let pos = olds.length ? wrapper.children.indexOf(olds[0]) : -1; olds.forEach(o => o.remove());
  const before = { ...stats }; const dark = DARK.has(sid);
  const fr = await build({ ...root, n: NAMES[sid], b: root.b || 'ffffff', cl: 1 }, wrapper, true, dark);
  fr.layoutSizingHorizontal = 'FIXED'; fr.layoutSizingVertical = 'FIXED';
  if (pos >= 0) wrapper.insertChild(pos, fr);
  for (const m of root.mk || []) {
    const bg = MKBG[sid] || 'ffffff'; const o = figma.createRectangle(); o.name = 'Fade mask'; o.resize(m.w, m.h);
    const stops = m.st.map(s => ({ position: Math.min(1, Math.max(0, s[1] / 100)), color: { ...rgb(bg), a: 1 - s[0] } }));
    o.fills = [{ type: 'GRADIENT_LINEAR', gradientStops: stops, gradientTransform: m.d === 'h' ? [[1, 0, 0], [0, 1, 0]] : [[0, 1, 0], [-1, 0, 1]] }];
    fr.appendChild(o); if (fr.layoutMode !== 'NONE') o.layoutPositioning = 'ABSOLUTE'; o.x = m.x; o.y = m.y;
  }
  const imgs = fr.findAll(x => x.name.startsWith('IMG|'));
  report[sid] = { id: fr.id, frames: stats.frames - before.frames, texts: stats.texts - before.texts, imgs: imgs.length };
}
const H = JSON.parse(figma.root.getSharedPluginData('fra', 'hashes') || '{}');
const firstBySrc = {};
for (const sid of ORDER) { const w = wrapper.children.find((c) => c.name === NAMES[sid]); if (!w) continue; for (const x of w.findAll((x) => x.name.startsWith('IMG|'))) { if (!H[x.name] && !firstBySrc[x.name]) firstBySrc[x.name] = x.id; } }
return { report, stats, errors, wrapperHeight: wrapper.height, firstBySrc, nearestBound: NEAR };