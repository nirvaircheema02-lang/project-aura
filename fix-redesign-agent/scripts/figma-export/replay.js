// Rebuilds the page from the chunks stored in the Figma file by an earlier export (after a builder upgrade or a fix), then applies the stored pictures. WRAPPER is prepended.
const AF = Object.getPrototypeOf(async function () {}).constructor;
const B = figma.root.getSharedPluginData('fra', 'builder');
const keys = figma.root.getSharedPluginDataKeys('fra').filter((k) => k.startsWith('chunk:' + WRAPPER + ':')).sort();
const out = { chunks: keys.length, reports: [], firstBySrc: {} };
for (const k of keys) {
  const { CFG, DATA, TABLE } = JSON.parse(figma.root.getSharedPluginData('fra', k));
  const r = await new AF('DATA', 'TABLE', 'CFG', B)(DATA, TABLE, CFG);
  out.reports.push({ k, sections: Object.keys(r.report).length, errors: r.errors }); Object.assign(out.firstBySrc, r.firstBySrc);
}
out.posted = await new AF(figma.root.getSharedPluginData('fra', 'post'))();
return out;
