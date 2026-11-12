const page = figma.root.children.find(p => p.name === '06 Fix Redesign');
await figma.setCurrentPageAsync(page);
const NAMES = { 'your-dealers-know-what-your-data-doesn-t': '1 Your Dealers Know What Your Data Doesn’t', 'dealer-insights-dashboard': '2 Dealer Insights Dashboard', 'our-clients': '3 Our Clients', 'what-s-impacting-your-dealers': '4 What’s Impacting Your Dealers', 'how-we-capture-dealer-needs': '5 How We Capture Dealer Needs', 'what-makes-our-way-different': '6 What Makes Our Way Different', 'our-impact': '7 Our Impact', 'what-our-clients-say': '8 What Our Clients Say', 'faqs': '9 FAQs', 'our-resources': '10 Our Resources', 'explore-other-surveys': '11 Explore Other Surveys' };
const WN = 'Dealers Voice Survey — Fix Redesign v3';
let wrapper = page.children.find(n => n.name === WN);
if (!wrapper) { wrapper = figma.createAutoLayout('VERTICAL'); wrapper.name = WN; wrapper.itemSpacing = 0; wrapper.resize(1440, 100); wrapper.layoutSizingHorizontal = 'FIXED'; wrapper.fills = []; wrapper.x = 3000; wrapper.y = 0; }
const FAM = { s: 'DM Sans', n: 'Noto Serif', m: 'DM Mono' };
const STY = (f, k) => f === 'm' ? (k <= 300 ? 'Light' : k >= 500 ? 'Medium' : 'Regular') : (k <= 300 ? 'Light' : k === 400 ? 'Regular' : k === 500 ? 'Medium' : k === 600 ? 'SemiBold' : k >= 800 ? 'ExtraBold' : 'Bold');
const need = new Set(); for (const s of Object.values(DATA)) for (const l of s.L) if (l.t === 't') need.add(l.f + '|' + STY(l.f, l.k));
await Promise.all([...need].map(n => { const [f, st] = n.split('|'); return figma.loadFontAsync({ family: FAM[f], style: st }); }));
await figma.loadFontAsync({ family: 'DM Sans', style: 'Medium' });
const coll = (await figma.variables.getLocalVariableCollectionsAsync()).find(c => c.name === 'Ken DS (core-v2)');
const palette = new Map();
for (const id of coll.variableIds) { const v = await figma.variables.getVariableByIdAsync(id); if (v.resolvedType === 'COLOR') { const c = v.valuesByMode[coll.modes[0].modeId]; palette.set(([c.r, c.g, c.b].map(x => Math.round(x * 255).toString(16).padStart(2, '0'))).join(''), v); } }
const rgb = (h) => ({ r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 });
const alpha = (h) => h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
const solidFill = (h) => { const base = h.slice(0, 6).toLowerCase(), a = alpha(h); if (a >= 0.995 && palette.has(base)) return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: rgb(base) }, 'color', palette.get(base)); return { type: 'SOLID', color: rgb(base), opacity: a }; };
const gradFill = (s) => {
  const m = /(linear|radial)-gradient\(/.exec(s); if (!m) return null;
  let i = m.index + m[0].length, d = 1; const st = i; while (i < s.length && d > 0) { if (s[i] === '(') d++; if (s[i] === ')') d--; i++; }
  const body = s.slice(st, i - 1); const stops = [...body.matchAll(/#([0-9a-fA-F]{6,8})(?:\s+(-?[\d.]+)%)?/g)];
  if (stops.length < 2) return null;
  const gs = stops.map((x, k) => ({ position: Math.min(1, Math.max(0, x[2] !== undefined ? parseFloat(x[2]) / 100 : k / (stops.length - 1))), color: { ...rgb(x[1]), a: alpha(x[1]) } }));
  if (m[1] === 'radial') return { type: 'GRADIENT_RADIAL', gradientStops: gs, gradientTransform: [[1, 0, 0], [0, 1, 0]] };
  const am = /(-?[\d.]+)deg/.exec(body.split('#')[0]); const th = ((am ? parseFloat(am[1]) : 180) * Math.PI) / 180; const dx = Math.sin(th), dy = -Math.cos(th);
  return { type: 'GRADIENT_LINEAR', gradientStops: gs, gradientTransform: [[dx, dy, 0.5 - 0.5 * dx - 0.5 * dy], [-dy, dx, 0.5 + 0.5 * dy - 0.5 * dx]] };
};
const shadowOf = (s) => { const m = /#([0-9a-fA-F]{6,8})\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?/.exec(s); if (!m || /inset/.test(s)) return []; return [{ type: 'DROP_SHADOW', color: { ...rgb(m[1]), a: alpha(m[1]) }, offset: { x: +m[2], y: +m[3] }, radius: +m[4], spread: +(m[5] || 0), visible: true, blendMode: 'NORMAL' }]; };
const BUTTONS = { 'Get Pricing & Timeline': 'Brand', 'View Sample Dashboard': 'Brand', 'Discuss Scope': 'Brand', 'Get Survey Roadmap': 'Brand', 'Employee Engagement Surveys': 'Brand', 'View More': 'Ghost' };
const btnSet = await figma.getNodeByIdAsync('10:76');
const report = {};
for (const [sid, S] of Object.entries(DATA)) {
  const old = wrapper.children.find(n => n.name === NAMES[sid]); if (old) old.remove();
  const fr = figma.createFrame(); fr.name = NAMES[sid]; fr.resize(S.w, S.h); fr.clipsContent = true; fr.fills = [solidFill('ffffff')]; wrapper.appendChild(fr); fr.layoutSizingHorizontal = 'FIXED'; fr.layoutSizingVertical = 'FIXED';
  const L = S.L, skip = new Set(), btnAt = new Map();
  L.forEach((l, i) => { if (l.t !== 't' || !BUTTONS[l.s]) return; let best = -1, area = 1e9;
    L.forEach((b, j) => { if (b.t !== 'b' || !(b.b || b.g)) return; if (b.x <= l.x + 2 && b.y <= l.y + 2 && b.x + b.w >= l.x + l.w - 2 && b.y + b.h >= l.y + l.h - 2 && b.w <= 460 && b.h <= 90 && b.w * b.h < area) { best = j; area = b.w * b.h; } });
    if (best < 0) return; const bb = L[best]; skip.add(best); skip.add(i); btnAt.set(i, bb);
    L.forEach((o, k) => { if (o.t === 'b' && Math.abs(o.y - bb.y) <= 3 && Math.abs(o.h - bb.h) <= 4 && o.x >= bb.x - 2 && o.x <= bb.x + bb.w) skip.add(k); });
    L.forEach((o, k) => { if (o.t === 'v' && o.x >= bb.x - 2 && o.y >= bb.y - 2 && o.x + o.w <= bb.x + bb.w + 2 && o.y + o.h <= bb.y + bb.h + 2) skip.add(k); }); });
  let n = 0, nb = 0;
  L.forEach((l, i) => {
    if (btnAt.has(i)) { const bb = btnAt.get(i); const comp = btnSet.findOne(c => c.type === 'COMPONENT' && c.name === `Variant=${BUTTONS[l.s]}, State=Default`); const inst = comp.createInstance(); const tx = inst.findOne(x => x.type === 'TEXT'); tx.characters = l.s;
      if (BUTTONS[l.s] === 'Ghost') { tx.fills = [solidFill('ffffff')]; inst.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 0.6 }]; for (const v of inst.findAll(x => x.type === 'VECTOR')) v.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; }
      fr.appendChild(inst); inst.x = bb.x + bb.w / 2 - inst.width / 2; inst.y = bb.y + bb.h / 2 - inst.height / 2; inst.name = 'Button · ' + l.s; nb++; return; }
    if (skip.has(i)) return;
    if (l.t === 'b' && l.g && /109\.59deg/.test(l.g) && l.h <= 48) return;
    if (l.t === 'b') { const r = figma.createRectangle(); r.name = 'Box'; r.x = l.x; r.y = l.y; r.resize(Math.max(1, l.w), Math.max(1, l.h)); const f = []; if (l.b) f.push(solidFill(l.b)); if (l.g) { const g = gradFill(l.g); if (g) f.push(g); } r.fills = f.length ? f : [];
      if (l.bw) { r.strokes = [solidFill(l.bc)]; r.strokeWeight = l.bw; r.strokeAlign = 'INSIDE'; } if (l.r) r.cornerRadius = Math.min(l.r, Math.min(l.w, l.h) / 2); if (l.sh) r.effects = shadowOf(l.sh); fr.appendChild(r); n++; }
    else if (l.t === 'i') { const r = figma.createRectangle(); r.name = 'Image'; r.x = l.x; r.y = l.y; r.resize(Math.max(1, l.w), Math.max(1, l.h)); if (l.r) r.cornerRadius = Math.min(l.r, Math.min(l.w, l.h) / 2); r.fills = [solidFill('e5e5e5')]; fr.appendChild(r); n++; }
    else if (l.t === 'v') { try { const v = figma.createNodeFromSvg(l.v); v.name = 'Vector'; v.x = l.x; v.y = l.y; v.resize(Math.max(1, l.w), Math.max(1, l.h)); fr.appendChild(v); n++; } catch (e) { report[sid + ':svg' + i] = String(e).slice(0, 80); } }
    else if (l.t === 't') { const t = figma.createText(); t.fontName = { family: FAM[l.f], style: STY(l.f, l.k) }; t.characters = l.s; t.fontSize = l.z; t.fills = [solidFill(l.c.length >= 8 && /00$/.test(l.c) && alpha(l.c) === 0 ? 'b01f24' : l.c)];
      if (l.l) t.letterSpacing = { unit: 'PIXELS', value: l.l }; if (l.L) t.lineHeight = { unit: 'PIXELS', value: l.L }; if (l.u) t.textCase = 'UPPER'; if (l.d) t.textDecoration = 'UNDERLINE';
      const al = l.a === 'c' ? 'CENTER' : (l.a === 'r' || l.a === 'e') ? 'RIGHT' : 'LEFT'; t.textAlignHorizontal = al; t.resize(l.w + 8, 20); t.textAutoResize = 'HEIGHT'; fr.appendChild(t);
      t.x = l.x - (al === 'CENTER' ? 4 : al === 'RIGHT' ? 8 : 0); t.y = l.y + l.h / 2 - t.height / 2; t.name = l.s.slice(0, 40); n++; }
  });
  report[sid] = { layers: n, buttons: nb, id: fr.id };
}
return { report, wrapperId: wrapper.id, wrapperHeight: wrapper.height };
