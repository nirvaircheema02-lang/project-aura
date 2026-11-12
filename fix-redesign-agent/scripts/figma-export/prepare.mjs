// Prepares a Figma export of a run's React Preview ("exact copy" of what the local preview renders).
//   node scripts/figma-export/prepare.mjs <redesignRunDir> [--page "Fix & redesign page"] [--wrapper "<name>"]
// Writes <run>/figma-export/: install.js (once per Figma file), chunks/NN.js (one use_figma call each), assets/ + assets.json, manifest.json, FIGMA_EXPORT.md.
// The pipeline cannot call Figma itself: the session runs the chunks through `use_figma` and uploads the images with `upload_assets` (see FIGMA_EXPORT.md).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { extractSections } from './extract.mjs';
import { buildTrees } from './tree.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.webp': 'image/webp' };
const CHUNK_LIMIT = 24000; // characters of DATA+TABLE per use_figma call: small enough for the session to read back in one piece (the tool limit is 50 KB)

function arg(name, fallback) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : fallback; }

function serve(dist) {
  const srv = createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = join(dist, p);
    if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404).end(); return; }
    const body = readFileSync(f); const type = MIME[extname(f)] ?? 'application/octet-stream';
    // video needs byte ranges: without them Chromium cannot seek, and every clip stays on its first (often blank) frame
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && (m[1] !== '' || m[2] !== '')) { const a = m[1] === '' ? Math.max(0, body.length - Number(m[2])) : Number(m[1]); const z = m[1] === '' || m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1); res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': 'bytes ' + a + '-' + z + '/' + body.length, 'content-length': z - a + 1 }).end(body.subarray(a, z + 1)); return; }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': body.length }).end(body);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

function walk(n, fn) { fn(n); (n.ch ?? []).forEach((c) => walk(c, fn)); }

async function rasterizeSvg(svgPath, outPng) {
  const svg = readFileSync(svgPath, 'utf8');
  const w = Number(/\swidth="([\d.]+)/.exec(svg)?.[1] ?? 100); const h = Number(/\sheight="([\d.]+)/.exec(svg)?.[1] ?? 100);
  const b = await chromium.launch();
  const pg = await b.newPage({ deviceScaleFactor: 3, viewport: { width: Math.ceil(w) + 8, height: Math.ceil(h) + 8 } });
  await pg.setContent('<body style="margin:0;background:transparent"><div id=s style="width:' + w + 'px;height:' + h + 'px">' + svg + '</div></body>');
  await pg.locator('#s').screenshot({ path: outPng, omitBackground: true });
  await b.close();
}

const runDir = resolve(process.argv[2] ?? '');
const dist = join(runDir, 'preview-app', 'dist');
if (!existsSync(join(dist, 'index.html'))) { console.error('no built preview at ' + dist + ' (run the preview build first)'); process.exit(1); }
const runName = basename(runDir);
// default names: the project folder without its domain ("www.kenresearch.com-dealers-voice-survey" -> "Dealers Voice Survey"), on the design-system file's pages section
const title = basename(dirname(dirname(runDir))).replace(/^www\.[a-z0-9]+\.[a-z]+-/, '').split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const pageName = arg('page', 'Fix & redesign page');
const wrapperName = arg('wrapper', title);
// the audit's Figma file: audit-agent stores it as figmaFileKey in its project.json (found through this project's auditProjectDir)
function auditFigma() {
  try {
    const proj = JSON.parse(readFileSync(join(dirname(dirname(runDir)), 'project.json'), 'utf8'));
    const a = JSON.parse(readFileSync(join(proj.auditProjectDir, 'project.json'), 'utf8'));
    if (a.figmaFileKey) return { key: a.figmaFileKey, url: a.figmaFileUrl ?? 'https://www.figma.com/design/' + a.figmaFileKey };
  } catch { /* no audit link: the session asks for the Figma link */ }
  return { key: arg('file-key', ''), url: '' };
}
const figmaFile = auditFigma();
const outDir = join(runDir, 'figma-export');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'chunks'), { recursive: true }); mkdirSync(join(outDir, 'assets'), { recursive: true });

const srv = await serve(dist);
const url = 'http://127.0.0.1:' + srv.address().port + '/';
let extracted;
try { extracted = await extractSections(url); } finally { srv.close(); }
const trees = buildTrees(extracted.sections);
const order = extracted.order.filter((id) => trees[id]);
const names = Object.fromEntries(order.map((id, i) => [id, (i + 1) + ' ' + extracted.names[id]]));

// images: the preview's own files, SVG pictures rasterised (Figma image fills take raster only)
const assets = {};
// pictures drawn from the page itself (video frames, dot patterns): data URLs from the extractor
for (const [src, url] of Object.entries(extracted.synth ?? {})) { const m = /^data:([^;]+);base64,(.*)$/.exec(url); if (m) assets[src] = { file: src, type: m[1], data: Buffer.from(m[2], 'base64') }; }
for (const id of order) walk(trees[id], (n) => {
  if (n.k !== 'i' || !n.src || assets[n.src]) return;
  const from = [join(dist, 'assets', n.src), join(dist, n.src)].find((f) => existsSync(f));
  if (!from) { console.warn('image not found in dist: ' + n.src); return; }
  const ext = extname(n.src).toLowerCase();
  if (ext === '.svg') assets[n.src] = { file: n.src.replace(/\.svg$/i, '.png'), type: 'image/png', from, raster: true };
  else assets[n.src] = { file: n.src, type: MIME[ext] ?? 'image/png', from };
});
for (const [src, a] of Object.entries(assets)) {
  const to = join(outDir, 'assets', a.file);
  if (a.data) writeFileSync(to, a.data); else if (a.raster) await rasterizeSvg(a.from, to); else copyFileSync(a.from, to);
  delete a.from; delete a.data; a.bytes = statSync(to).size;
}
writeFileSync(join(outDir, 'assets.json'), JSON.stringify(assets, null, 1));

// chunks: shared SVG strings go in a TABLE so repeated icons are sent once
const chunks = [];
let cur = null;
const flush = () => { if (cur) chunks.push(cur); cur = null; };
for (const id of order) {
  const t = JSON.parse(JSON.stringify(trees[id]));
  const table = {};
  walk(t, (n) => { if (n.k === 'v' && n.v && n.v.length > 400) { let key = Object.keys(table).find((k) => table[k] === n.v); if (!key) { key = 's' + Object.keys(table).length; table[key] = n.v; } n.v = '@' + key; } });
  const size = JSON.stringify(t).length + JSON.stringify(table).length;
  if (!cur || cur.size + size > CHUNK_LIMIT) { flush(); cur = { ids: [], data: {}, table: {}, size: 0 }; }
  // tables are per chunk: remap keys
  const remap = {};
  for (const [k, v] of Object.entries(table)) { let nk = Object.keys(cur.table).find((x) => cur.table[x] === v); if (!nk) { nk = 's' + Object.keys(cur.table).length; cur.table[nk] = v; } remap[k] = nk; }
  walk(t, (n) => { if (n.k === 'v' && typeof n.v === 'string' && n.v.startsWith('@')) n.v = '@' + remap[n.v.slice(1)]; });
  cur.ids.push(id); cur.data[id] = t; cur.size += size;
}
flush();
// The runner keeps each chunk in the Figma file (plugin data), so a later builder upgrade can rebuild the page from replay.js without sending the data again.
const RUNNER = "const AF = Object.getPrototypeOf(async function () {}).constructor;\nconst B = figma.root.getSharedPluginData('fra', 'builder');\nif (!B) return { error: 'builder not installed: run install.js first' };\nfigma.root.setSharedPluginData('fra', 'chunk:' + CFG.wrapper + ':' + String(CFG.idx).padStart(2, '0'), JSON.stringify({ CFG, DATA, TABLE }));\nreturn await new AF('DATA', 'TABLE', 'CFG', B)(DATA, TABLE, CFG);\n";
const chunkFiles = chunks.map((c, i) => {
  const cfg = { page: pageName, wrapper: wrapperName, idx: i + 1, order: c.ids, names: Object.fromEntries(c.ids.map((id) => [id, names[id]])) };
  const file = 'chunks/' + String(i + 1).padStart(2, '0') + '.js';
  const code = 'const CFG = ' + JSON.stringify(cfg) + ';\nconst DATA = ' + JSON.stringify(c.data) + ';\nconst TABLE = ' + JSON.stringify(c.table) + ';\n' + RUNNER;
  writeFileSync(join(outDir, file), code);
  return { file, sections: c.ids, chars: code.length };
});

// install.js: stores the builder + post-step in the Figma file (plugin data), so each export only sends its data
const builder = readFileSync(join(HERE, 'builder.js'), 'utf8'); const post = readFileSync(join(HERE, 'post.js'), 'utf8');
const VERSION = '2026-10-30.16';
if (/`|\$\{/.test(builder + post)) throw new Error('builder/post must not contain backticks or template placeholders (they are embedded via String.raw)');
writeFileSync(join(outDir, 'install.js'),
  "if (figma.root.getSharedPluginData('fra', 'version') === '" + VERSION + "') return { installed: true, version: '" + VERSION + "' };\n" +
  'figma.root.setSharedPluginData(\'fra\', \'builder\', String.raw`' + builder + '`);\n' +
  'figma.root.setSharedPluginData(\'fra\', \'post\', String.raw`' + post + '`);\n' +
  "figma.root.setSharedPluginData('fra', 'version', '" + VERSION + "');\nreturn { installed: true, version: '" + VERSION + "' };\n");
writeFileSync(join(outDir, 'tokens.js'), 'const TOKENS = ' + JSON.stringify(JSON.parse(readFileSync(join(HERE, 'ds-tokens.json'), 'utf8'))) + ';\n' + readFileSync(join(HERE, 'tokens.js'), 'utf8'));
writeFileSync(join(outDir, 'replay.js'), "const WRAPPER = " + JSON.stringify(wrapperName) + ";\n" + readFileSync(join(HERE, 'replay.js'), 'utf8'));
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ run: runName, figmaFileKey: figmaFile.key, figmaFileUrl: figmaFile.url, page: pageName, wrapper: wrapperName, version: VERSION, sections: order.map((id) => ({ id, name: names[id] })), chunks: chunkFiles, assets: Object.keys(assets).length }, null, 1));
writeFileSync(join(outDir, 'FIGMA_EXPORT.md'), readFileSync(join(HERE, 'FIGMA_EXPORT.template.md'), 'utf8').replaceAll('{{RUN}}', runDir).replaceAll('{{WRAPPER}}', wrapperName).replaceAll('{{PAGE}}', pageName).replaceAll('{{CHUNKS}}', String(chunkFiles.length)).replaceAll('{{FILE_KEY}}', figmaFile.key || '(not found: ask the user for the audit Figma link)').replaceAll('{{FILE_URL}}', figmaFile.url || '-'));
console.log(JSON.stringify({ outDir, sections: order.length, chunks: chunkFiles, images: Object.keys(assets).length }, null, 1));
