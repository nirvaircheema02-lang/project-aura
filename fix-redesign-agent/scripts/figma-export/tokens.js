// Runs inside Figma (use_figma) in the page's audit file; TOKENS (ds-tokens.json) is prepended by prepare.mjs. Recreates the Ken Design System tokens locally (the DS is not a
// library in the audit files) so the export can bind to them. Idempotent: existing collections/variables/styles/components are kept. Never run this in the DS file itself.
const made = { colors: 0, numbers: 0, strings: 0, styles: 0, button: false };
const cols = await figma.variables.getLocalVariableCollectionsAsync();
const colls = {};
const col = (n) => colls[n] || (colls[n] = cols.find((c) => c.name === n) || figma.variables.createVariableCollection(n));
const have = async (c) => { const s = new Set(); for (const id of c.variableIds) s.add((await figma.variables.getVariableByIdAsync(id)).name); return s; };
const cc = col('Ken / Colors'); let h = await have(cc);
for (const [k, [r, g, b, a]] of Object.entries(TOKENS.colors)) { if (h.has(k)) continue; const v = figma.variables.createVariable(k, cc, 'COLOR'); v.setValueForMode(cc.modes[0].modeId, { r, g, b, a }); made.colors++; }
for (const [cn, rows] of Object.entries(TOKENS.numbers)) { const c = col(cn); h = await have(c); for (const [k, val] of Object.entries(rows)) { if (h.has(k)) continue; const v = figma.variables.createVariable(k, c, 'FLOAT'); v.setValueForMode(c.modes[0].modeId, val); made.numbers++; } }
for (const [cn, rows] of Object.entries(TOKENS.strings)) { const c = col(cn); h = await have(c); for (const [k, val] of Object.entries(rows)) { if (h.has(k)) continue; const v = figma.variables.createVariable(k, c, 'STRING'); v.setValueForMode(c.modes[0].modeId, val); made.strings++; } }
const hs = new Set((await figma.getLocalTextStylesAsync()).map((s) => s.name));
for (const [name, fam, style, size, lh, ls] of TOKENS.textStyles) {
  if (hs.has(name)) continue; await figma.loadFontAsync({ family: fam, style });
  const s = figma.createTextStyle(); s.name = name; s.fontName = { family: fam, style }; s.fontSize = size; s.lineHeight = lh === null ? { unit: 'AUTO' } : { unit: 'PIXELS', value: lh }; s.letterSpacing = ls ? { unit: 'PIXELS', value: ls } : { unit: 'PERCENT', value: 0 }; made.styles++;
}
for (const p of figma.root.children) await p.loadAsync();
if (!figma.root.findOne((n) => n.type === 'COMPONENT_SET' && n.name === 'Button / Brand')) {
  const PN = '3.1 — Components/ Buttons, Links & CTA';
  let pg = figma.root.children.find((p) => p.name === PN); if (!pg) { pg = figma.createPage(); pg.name = PN; }
  const keep = figma.currentPage; await figma.setCurrentPageAsync(pg);
  await figma.loadFontAsync({ family: 'DM Sans', style: 'Regular' });
  const cv = await figma.variables.getLocalVariablesAsync('COLOR'); const fv = await figma.variables.getLocalVariablesAsync('FLOAT');
  const cvar = (n) => cv.find((v) => v.name === n); const fvar = (n) => fv.find((v) => v.name === n);
  const paint = (name) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }, 'color', cvar(name));
  const c = figma.createComponent(); c.name = 'Size=md, State=Rest';
  c.layoutMode = 'HORIZONTAL'; c.resize(112, 48); c.primaryAxisSizingMode = 'AUTO'; c.counterAxisSizingMode = 'FIXED';
  c.primaryAxisAlignItems = 'CENTER'; c.counterAxisAlignItems = 'CENTER'; c.itemSpacing = 8; c.paddingLeft = 28; c.paddingRight = 28; c.paddingTop = 0; c.paddingBottom = 0;
  c.setBoundVariable('itemSpacing', fvar('space/xs').id); c.setBoundVariable('cornerRadius', fvar('radius-xs').id); c.cornerRadius = 5; c.fills = []; c.clipsContent = true;
  c.effects = [{ type: 'DROP_SHADOW', visible: true, radius: 16, color: { r: 0.6902, g: 0.1216, b: 0.1412, a: 0.15 }, offset: { x: 0, y: 4 }, spread: 0, blendMode: 'NORMAL', showShadowBehindNode: true }];
  const sh = figma.createRectangle(); sh.name = 'Shimmer'; c.appendChild(sh); sh.layoutPositioning = 'ABSOLUTE'; sh.resize(112, 48); sh.x = 0; sh.y = 0; sh.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
  sh.fills = [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 0.6902, g: 0.1216, b: 0.1412, a: 1 } }, { position: 1, color: { r: 0.9216, g: 0.2824, b: 0.3059, a: 1 } }] }];
  const lab = figma.createText(); lab.name = 'Label'; c.appendChild(lab); lab.fontName = { family: 'DM Sans', style: 'Regular' }; lab.fontSize = 16; lab.characters = 'Button'; lab.fills = [paint('white')];
  const lst = (await figma.getLocalTextStylesAsync()).find((s) => s.name === 'Ken / Components / DM Sans Regular 16/24'); if (lst) await lab.setTextStyleIdAsync(lst.id);
  const arrow = figma.createFrame(); arrow.name = 'Arrow'; arrow.fills = []; arrow.resize(18, 18); arrow.clipsContent = false; c.appendChild(arrow); arrow.layoutSizingHorizontal = 'FIXED'; arrow.layoutSizingVertical = 'FIXED';
  for (const d of ['M 0 0 L 7.5 0 L 7.5 7.5', 'M 0 7.5 L 7.5 0']) { const v = figma.createVector(); v.vectorPaths = [{ windingRule: 'NONE', data: d }]; v.fills = []; v.strokeWeight = 1.5; v.strokeCap = 'ROUND'; v.strokeJoin = 'ROUND'; v.strokes = [paint('white')]; arrow.appendChild(v); v.x = 5.25; v.y = 5.25; }
  sh.resize(c.width, c.height); sh.x = 0; sh.y = 0; // the shimmer spans the hugged component, so an instance's brand fill stretches over its whole width
  const set = figma.combineAsVariants([c], pg); set.name = 'Button / Brand';
  const kl = set.addComponentProperty('Label', 'TEXT', 'Button'); const ka = set.addComponentProperty('Arrow', 'BOOLEAN', false);
  lab.componentPropertyReferences = { characters: kl }; arrow.componentPropertyReferences = { visible: ka }; arrow.visible = false; set.x = 100; set.y = 100; made.button = true;
  await figma.setCurrentPageAsync(keep);
}
return made;
