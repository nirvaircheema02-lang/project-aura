// Runs inside Figma after the images were uploaded onto the first IMG| slot of each new picture. Copies each picture to every slot that shows it, with its
// fit/crop, opacity, blend mode and grayscale, and remembers the image hashes in the file so later pages reuse them without uploading again.
const page = figma.root.children.find((p) => p.name === JSON.parse(figma.root.getSharedPluginData('fra', 'cfg') || '{}').page);
await figma.setCurrentPageAsync(page);
const cfg = JSON.parse(figma.root.getSharedPluginData('fra', 'cfg'));
const w = page.children.find((n) => n.name === cfg.wrapper);
const H = JSON.parse(figma.root.getSharedPluginData('fra', 'hashes') || '{}');
const slots = w.findAll((n) => n.name.startsWith('IMG|'));
for (const n of slots) { const f = n.fills; if (f && f[0] && f[0].type === 'IMAGE' && !H[n.name]) H[n.name] = f[0].imageHash; }
// An image that no layer shows any more is dropped by Figma, so a stored hash can go stale (a page rebuilt in place removes the old slots): forget those, and report the slots that
// need their picture uploaded again (needUpload: picture name -> first slot id, the same shape as first-by-src.json).
for (const k of Object.keys(H)) if (!figma.getImageByHash(H[k])) delete H[k];
figma.root.setSharedPluginData('fra', 'hashes', JSON.stringify(H));
const rep = { total: slots.length, missing: [], needUpload: {} };
for (const n of slots) if (!H[n.name] && !rep.needUpload[n.name]) rep.needUpload[n.name] = n.id;
for (const n of slots) {
  const hash = H[n.name]; if (!hash) { rep.missing.push(n.name); continue; }
  const m = JSON.parse(n.getSharedPluginData('fra', 'm') || '{}'); const sz = await figma.getImageByHash(hash).getSizeAsync(); const W = n.width, Hh = n.height; let paint;
  // contain, and cover with an object-position other than the centre, are placed by hand (a fill always crops from the middle)
  if (m.fit === 'contain' || (m.fit === 'cover' && m.pos && m.pos !== '50% 50%')) { const s = (m.fit === 'cover' ? Math.max : Math.min)(W / sz.width, Hh / sz.height), dw = sz.width * s, dh = sz.height * s; const pp = (m.pos || '50% 50%').split(' ').map((x) => parseFloat(x) / 100); const ox = (W - dw) * pp[0], oy = (Hh - dh) * pp[1]; paint = { type: 'IMAGE', imageHash: hash, scaleMode: 'CROP', imageTransform: [[W / dw, 0, -ox / dw], [0, Hh / dh, -oy / dh]] }; }
  else paint = { type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' };
  if (m.gs) paint.filters = { saturation: -m.gs }; n.fills = [paint]; if (m.op !== undefined && m.op < 0.99) n.opacity = m.op; if (m.mb === 'multiply') n.blendMode = 'MULTIPLY';
}
w.children.forEach((c) => { c.clipsContent = true; });
// Tokens for what the builder cannot bind at creation: icon strokes/fills (they come from SVG) and font sizes that are the design system's size within rounding (39.1 -> 39).
const colls = await figma.variables.getLocalVariableCollectionsAsync();
const collOf = (nm) => colls.find((c) => c.name === nm);
const PRIM = /^(?:red|black|white|warm|purple|periwinkle|coral|perano|green|amber|rose)(?:-\d+)?$/;
const pal = new Map(); const TOKS = []; const cc = collOf('Ken / Colors');
for (const id of (cc ? cc.variableIds : [])) { const v = await figma.variables.getVariableByIdAsync(id); if (v.resolvedType !== 'COLOR') continue; const c = v.valuesByMode[cc.modes[0].modeId]; if (!c || c.r === undefined) continue; const k = [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('') + '@' + Math.round((c.a === undefined ? 1 : c.a) * 100); const prev = pal.get(k); if (!prev || (!PRIM.test(prev.name) && PRIM.test(v.name))) pal.set(k, v); TOKS.push({ v, r: c.r * 255, g: c.g * 255, b: c.b * 255, a: c.a === undefined ? 1 : c.a }); }
const sizes = []; const tc = collOf('Ken / Typography');
for (const id of (tc ? tc.variableIds : [])) { const v = await figma.variables.getVariableByIdAsync(id); if (v.resolvedType === 'FLOAT' && /^(?:text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|compact|nav|card-micro)|button-font-lg)$/.test(v.name)) sizes.push([v.valuesByMode[tc.modes[0].modeId], v]); }
const bdc = collOf('Ken / Badge'); for (const id of (bdc ? bdc.variableIds : [])) { const v = await figma.variables.getVariableByIdAsync(id); if (v.resolvedType === 'FLOAT' && v.name === 'badge-sm-font') sizes.push([v.valuesByMode[bdc.modes[0].modeId], v]); }
// Keep every uploaded picture alive: a frame next to the page holds one small layer per picture, so a later in-place rebuild never loses them (do not delete it).
const keepName = 'fra pictures (' + cfg.wrapper + ')';
page.children.filter((n) => n.name === keepName).forEach((n) => n.remove());
const keep = figma.createFrame(); keep.name = keepName; keep.fills = []; keep.clipsContent = false; let kx = 0;
for (const [nm, hash] of Object.entries(H)) { const r = figma.createRectangle(); r.name = nm; r.resize(32, 32); r.fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FIT' }]; keep.appendChild(r); r.x = kx; r.y = 0; kx += 40; }
keep.resize(Math.max(40, kx), 40); page.appendChild(keep); keep.x = w.x + w.width + 200; keep.y = w.y;
rep.keptPictures = Object.keys(H).length;
rep.iconPaintsBound = 0; rep.sizesBound = 0; rep.iconNearest = {};
// icon colours with no exact token: the nearest ink token (dE76 <= 2 in CIE Lab, same alpha within 0.02), as the builder does for fills, strokes and text
const labOf = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; const R = f(r), G = f(g), B = f(b); const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883; const h = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; return [116 * h(Y) - 16, 500 * (h(X) - h(Y)), 200 * (h(Y) - h(Z))]; };
const INK = /^(text-|black|white|label-|semantic-ink|color-text|foundation)/;
const nearestInk = (f) => { const L = labOf(f.color.r * 255, f.color.g * 255, f.color.b * 255); const a = f.opacity === undefined ? 1 : f.opacity; let best = null; for (const t of TOKS) { if (Math.abs(t.a - a) > 0.02 || !INK.test(t.v.name)) continue; const T = labOf(t.r, t.g, t.b); const d = Math.sqrt((L[0] - T[0]) ** 2 + (L[1] - T[1]) ** 2 + (L[2] - T[2]) ** 2); if (d <= 2 && (!best || d < best.d)) best = { t, d }; } return best; };
const nearestAny = (f) => { const L = labOf(f.color.r * 255, f.color.g * 255, f.color.b * 255); const a = f.opacity === undefined ? 1 : f.opacity; let best = null; for (const t of TOKS) { if (Math.abs(t.a - a) > 0.02 || !/^(?!text-|label-|border-)/.test(t.v.name)) continue; const T = labOf(t.r, t.g, t.b); const d = Math.sqrt((L[0] - T[0]) ** 2 + (L[1] - T[1]) ** 2 + (L[2] - T[2]) ** 2); if (d <= 15 && (!best || d < best.d)) best = { t, d }; } return best; }; // second tier: the closest token of the same alpha within dE 15 (user, 2026-10-30)
const paintKey = (f) => [f.color.r, f.color.g, f.color.b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('') + '@' + Math.round((f.opacity === undefined ? 1 : f.opacity) * 100);
for (const n of w.findAll((x) => /^(VECTOR|BOOLEAN_OPERATION|STAR|ELLIPSE|LINE|POLYGON)$/.test(x.type))) {
  for (const k of ['fills', 'strokes']) {
    const arr = n[k]; if (!Array.isArray(arr) || !arr.some((f) => f.type === 'SOLID')) continue;
    n[k] = arr.map((f) => { if (f.type !== 'SOLID' || (f.boundVariables && f.boundVariables.color)) return f; const v = pal.get(paintKey(f)); if (!v) { const nb = nearestInk(f) || nearestAny(f); if (!nb) return f; const kk = paintKey(f) + ' -> ' + nb.t.v.name + ' (dE ' + nb.d.toFixed(1) + ')'; rep.iconNearest[kk] = (rep.iconNearest[kk] || 0) + 1; rep.iconPaintsBound++; return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: nb.t.r / 255, g: nb.t.g / 255, b: nb.t.b / 255 } }, 'color', nb.t.v); } rep.iconPaintsBound++; return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: f.color.r, g: f.color.g, b: f.color.b } }, 'color', v); });
  }
}
// Last tier (user, 2026-10-30): a paint still raw because no token carries its alpha gets the CLOSEST full-alpha token (dE76 <= 15; an exact RGB match is dE 0) and keeps its OWN opacity:
// a bound paint takes its variable's alpha at the first assignment, but keeps an opacity that is set in a second one.
rep.partialNearest = {};
for (const n of w.findAll(() => true)) {
  for (const k of ['fills', 'strokes']) {
    const arr = n[k]; if (!Array.isArray(arr)) continue; const pend = []; let ch = false;
    const next = arr.map((f, i) => {
      if (f.type !== 'SOLID' || f.visible === false || (f.boundVariables && f.boundVariables.color)) return f;
      const a = f.opacity === undefined ? 1 : f.opacity; const L = labOf(f.color.r * 255, f.color.g * 255, f.color.b * 255); let best = null;
      for (const t of TOKS) { if (t.a < 0.98 || !(n.type === 'TEXT' ? /^(text-|black|white|warm|label-|semantic-ink|color-text|foundation)/ : /^(?!text-|label-|border-)/).test(t.v.name)) continue; const T = labOf(t.r, t.g, t.b); const d = Math.sqrt((L[0] - T[0]) ** 2 + (L[1] - T[1]) ** 2 + (L[2] - T[2]) ** 2); if (d <= 15 && (!best || d < best.d)) best = { t, d }; }
      if (!best) return f;
      const kk = paintKey(f) + ' -> ' + best.t.v.name + ' (dE ' + best.d.toFixed(1) + ')'; rep.partialNearest[kk] = (rep.partialNearest[kk] || 0) + 1; ch = true; if (a < 0.999) pend.push([i, a]);
      return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: best.t.r / 255, g: best.t.g / 255, b: best.t.b / 255 } }, 'color', best.t.v);
    });
    if (!ch) continue;
    n[k] = next;
    if (pend.length) { const again = n[k].map((f) => JSON.parse(JSON.stringify(f))); for (const [i, a] of pend) again[i].opacity = a; n[k] = again; }
  }
}
for (const t of w.findAll((x) => x.type === 'TEXT')) {
  if (t.textStyleId || t.fontSize === figma.mixed || (t.boundVariables && t.boundVariables.fontSize)) continue;
  const hit = sizes.find(([val]) => Math.abs(val - t.fontSize) < 0.16);
  if (hit) { t.setBoundVariable('fontSize', hit[1]); rep.sizesBound++; }
}
// Link text to the file's own text styles where the style IS the measured text (same font, size, line height and tracking), so the look never changes.
const lhPx = (st) => st.lineHeight.unit === 'PIXELS' ? st.lineHeight.value : st.lineHeight.unit === 'PERCENT' ? st.lineHeight.value * st.fontSize / 100 : null;
const lsPx = (st) => st.letterSpacing.unit === 'PIXELS' ? st.letterSpacing.value : st.letterSpacing.value * st.fontSize / 100;
const styles = (await figma.getLocalTextStylesAsync()).filter((st) => lhPx(st) !== null);
rep.textStyled = 0;
for (const t of w.findAll((n) => n.type === 'TEXT')) {
  if (t.textStyleId || t.fontName === figma.mixed || t.fontSize === figma.mixed || t.lineHeight === figma.mixed || t.lineHeight.unit !== 'PIXELS' || t.letterSpacing === figma.mixed) continue;
  const lsv = t.letterSpacing.unit === 'PIXELS' ? t.letterSpacing.value : t.letterSpacing.value * t.fontSize / 100;
  const st = styles.find((x) => x.fontName.family === t.fontName.family && x.fontName.style === t.fontName.style && Math.abs(x.fontSize - t.fontSize) < 0.16 && Math.abs(lhPx(x) - t.lineHeight.value) < 0.6 && Math.abs(lsPx(x) - lsv) < 0.15);
  if (st) { await t.setTextStyleIdAsync(st.id); rep.textStyled++; }
}
return rep;
