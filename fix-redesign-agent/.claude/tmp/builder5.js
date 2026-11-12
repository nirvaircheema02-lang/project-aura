const page = figma.root.children.find(p => p.name === '06 Fix Redesign');
await figma.setCurrentPageAsync(page);
const NAMES = { 'your-dealers-know-what-your-data-doesn-t': '1 Your Dealers Know What Your Data Doesn’t', 'dealer-insights-dashboard': '2 Dealer Insights Dashboard', 'our-clients': '3 Our Clients', 'what-s-impacting-your-dealers': '4 What’s Impacting Your Dealers', 'how-we-capture-dealer-needs': '5 How We Capture Dealer Needs', 'what-makes-our-way-different': '6 What Makes Our Way Different', 'our-impact': '7 Our Impact', 'what-our-clients-say': '8 What Our Clients Say', 'faqs': '9 FAQs', 'our-resources': '10 Our Resources', 'explore-other-surveys': '11 Explore Other Surveys' };
const ORDER = Object.keys(NAMES);
const DARK = new Set(['our-resources', 'explore-other-surveys']);
const MKBG = { 'your-dealers-know-what-your-data-doesn-t': 'fffefe' };
const WN = 'Dealers Voice Survey — Local Preview (exact copy)';
const wrapper = page.children.find(n => n.name === WN);
const FAM = { s: 'DM Sans', n: 'Noto Serif', m: 'DM Mono' };
const STY = (f, k) => f === 'm' ? (k <= 300 ? 'Light' : k >= 500 ? 'Medium' : 'Regular') : (k <= 300 ? 'Light' : k === 400 ? 'Regular' : k === 500 ? 'Medium' : k === 600 ? 'SemiBold' : k >= 800 ? 'ExtraBold' : 'Bold');
const need = new Set(); const scan = (n) => { if (n.k === 't') need.add(n.f + '|' + STY(n.f, n.wt)); (n.ch || []).forEach(scan); }; Object.values(DATA).forEach(scan);
await Promise.all([...need].map(x => { const [f, st] = x.split('|'); return figma.loadFontAsync({ family: FAM[f], style: st }); }));
await figma.loadFontAsync({ family: 'DM Sans', style: 'Medium' });
const coll = (await figma.variables.getLocalVariableCollectionsAsync()).find(c => c.name === 'Ken DS (core-v2)');
const palette = new Map();
for (const id of coll.variableIds) { const v = await figma.variables.getVariableByIdAsync(id); if (v.resolvedType === 'COLOR') { const c = v.valuesByMode[coll.modes[0].modeId]; palette.set(([c.r, c.g, c.b].map(x => Math.round(x * 255).toString(16).padStart(2, '0'))).join(''), v); } }
const styleMap = new Map(); for (const s of await figma.getLocalTextStylesAsync()) styleMap.set(s.name, s);
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
const solidFill = (h0, op = 1) => { const h = okHex(h0); const base = h.slice(0, 6).toLowerCase(), a = alpha(h) * op; if (a >= 0.995 && palette.has(base)) return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: rgb(base) }, 'color', palette.get(base)); return { type: 'SOLID', color: rgb(base), opacity: a }; };
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
const BUTTONS = { 'Get Pricing & Timeline': 'Brand', 'View Sample Dashboard': 'Brand', 'Discuss Scope': 'Brand', 'Get Survey Roadmap': 'Brand', 'Employee Engagement Surveys': 'Brand', 'Customer Satisfaction Surveys': 'Brand', 'Customer Demand, Needs & Pain Point Surveys': 'Brand', 'Brand Perception Surveys': 'Brand', 'View More': 'Secondary' };
const btnSet = await figma.getNodeByIdAsync('10:76'), stComp = await figma.getNodeByIdAsync('10:79');
const firstText = (n) => { if (n.k === 't') return n; for (const c of n.ch || []) { const t = firstText(c); if (t) return t; } return null; };
const stats = { frames: 0, auto: 0, texts: 0, icons: 0, images: 0, ds: 0 }; const errors = {};
const AL = { MIN: 'MIN', CENTER: 'CENTER', MAX: 'MAX' };
async function build(n, parent, parentAL, dark) {
  if (n.k === 'f') {
    const mb = /^(Button|Link) · (.+)$/.exec(n.n || ''); const ft = firstText(n);
    if (mb && BUTTONS[mb[2]] && ft && (BUTTONS[mb[2]] !== 'Brand' || /^ffffff/.test(ft.c))) {
      const inst = btnSet.findOne(c => c.type === 'COMPONENT' && c.name === 'Variant=' + BUTTONS[mb[2]] + ', State=Default').createInstance(); inst.findOne(x => x.type === 'TEXT').characters = mb[2]; inst.name = 'Button · ' + mb[2]; parent.appendChild(inst);
      if (!parentAL) { inst.x = n.x + (n.w - inst.width) / 2; inst.y = n.y + (n.h - inst.height) / 2; } stats.ds++; return inst; }
    if (/^Badge · Step \d+$/.test(n.n || '')) { const inst = stComp.createInstance(); inst.findOne(x => x.type === 'TEXT').characters = n.n.slice(8); inst.name = n.n; parent.appendChild(inst); if (!parentAL) { inst.x = n.x; inst.y = n.y; } stats.ds++; return inst; }
    const op = n.op === undefined ? 1 : n.op;
    const f = figma.createFrame(); f.name = n.n || 'Group'; f.resize(Math.max(1, n.w), Math.max(1, n.h)); const fl = [];
    if (n.b) fl.push(solidFill(n.b, op)); if (n.g && !/109\.59deg/.test(n.g)) { const g = gradFill(n.g, op); if (g) fl.push(g); } f.fills = fl;
    if (n.bw) { f.strokes = [solidFill(n.bc, op)]; f.strokeWeight = n.bw; f.strokeAlign = 'INSIDE'; } if (n.r) f.cornerRadius = Math.min(n.r, Math.min(n.w, n.h) / 2);
    const ef = n.sh ? shadowOf(n.sh) : []; if (n.fl) ef.push({ type: 'LAYER_BLUR', radius: n.fl * 2, visible: true }); if (n.bb) ef.push({ type: 'BACKGROUND_BLUR', radius: n.bb * 2, visible: true }); if (ef.length) f.effects = ef;
    f.clipsContent = !!n.cl && !(n.ch || []).some(k => k.k !== 'i' && (k.y + k.h > n.h + 2 || k.x + k.w > n.w + 2 || k.y < -2));
    if (n.al) { const a = n.al; f.layoutMode = a.d === 'V' ? 'VERTICAL' : 'HORIZONTAL'; f.itemSpacing = a.g; f.paddingTop = a.pt; f.paddingBottom = a.pb; f.paddingLeft = a.pl; f.paddingRight = a.pr; f.primaryAxisAlignItems = 'MIN'; f.counterAxisAlignItems = AL[a.ca]; f.primaryAxisSizingMode = 'FIXED'; f.counterAxisSizingMode = 'FIXED'; stats.auto++; }
    stats.frames++; parent.appendChild(f); if (!parentAL) { f.x = n.x; f.y = n.y; }
    const imgOnly = (k) => k.k === 'i' || (k.k === 'f' && (k.ch || []).length > 0 && k.ch.every(imgOnly)); const bgOnly = (k) => k.k === 'f' && !!k.b && !(k.ch || []).length; let kids = n.ch || []; if (!n.al) kids = [...kids.filter(k => imgOnly(k) || bgOnly(k)), ...kids.filter(k => !(imgOnly(k) || bgOnly(k)))];
    for (const k of kids) await build(k, f, !!n.al, dark);
    return f;
  }
  if (n.k === 't') {
    const t = figma.createText(); const sty = STY(n.f, n.wt); t.fontName = { family: FAM[n.f], style: sty }; t.characters = n.s; t.fontSize = n.z;
    const sname = 'Ken DS/' + FAM[n.f] + ' ' + sty + ' ' + n.z; let st = styleMap.get(sname); if (!st) { st = figma.createTextStyle(); st.name = sname; st.fontName = { family: FAM[n.f], style: sty }; st.fontSize = n.z; styleMap.set(sname, st); }
    try { await t.setTextStyleIdAsync(st.id); } catch (e) { errors.style = String(e).slice(0, 60); }
    t.fills = [solidFill(/^[0-9a-f]{6}00$/.test(n.c) ? 'b01f24' : n.c, n.op === undefined ? 1 : n.op)];
    t.letterSpacing = { unit: 'PIXELS', value: n.l || 0 }; if (n.L) t.lineHeight = { unit: 'PIXELS', value: n.L }; if (n.u) t.textCase = 'UPPER'; if (n.d) t.textDecoration = 'UNDERLINE';
    const al = n.a === 'c' ? 'CENTER' : (n.a === 'r' || n.a === 'e') ? 'RIGHT' : 'LEFT'; t.textAlignHorizontal = al; parent.appendChild(t);
    const single = !/\s/.test(n.s.trim()) || n.h <= (n.L || n.z * 1.4) * 1.3;
    if (single) t.textAutoResize = 'WIDTH_AND_HEIGHT'; else { t.resize(n.w * 1.06 + 4, 20); t.textAutoResize = 'HEIGHT'; }
    if (!parentAL) { t.x = n.x + (al === 'CENTER' ? n.w / 2 - t.width / 2 : al === 'RIGHT' ? n.w - t.width : 0); t.y = n.y + n.h / 2 - t.height / 2; }
    t.name = n.s.slice(0, 40); stats.texts++; return t;
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
  const root = DATA[sid]; if (!root) continue;
  const olds = wrapper.children.filter(c => c.name === NAMES[sid]); let pos = olds.length ? wrapper.children.indexOf(olds[0]) : -1; olds.forEach(o => o.remove());
  const before = { ...stats }; const dark = DARK.has(sid);
  const fr = await build({ ...root, n: NAMES[sid], b: root.b || (dark ? '141016' : 'ffffff'), cl: 1 }, wrapper, true, dark);
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
const firstBySrc = {}; for (const sid of ORDER) { const w = wrapper.children.find(c => c.name === NAMES[sid]); if (!w || !DATA[sid]) continue; for (const x of w.findAll(x => x.name.startsWith('IMG|'))) { if (!firstBySrc[x.name]) firstBySrc[x.name] = x.id; } }
return { report, stats, errors, wrapperHeight: wrapper.height, firstBySrc };
