// Image upload helper for a Figma export.
//   node scripts/figma-export/upload.mjs plan <runDir>              -> prints { count, nodeIds } for `upload_assets` (from figma-export/first-by-src.json)
//   node scripts/figma-export/upload.mjs send <runDir> <uploads.json> -> POSTs every image to the submitUrl `upload_assets` returned (same order as plan)
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';

const [cmd, runArg, uploadsFile] = process.argv.slice(2);
const dir = join(resolve(runArg ?? ''), 'figma-export');
const first = JSON.parse(readFileSync(join(dir, 'first-by-src.json'), 'utf8')); // { "IMG|<src>": "<figma node id>" }
const assets = JSON.parse(readFileSync(join(dir, 'assets.json'), 'utf8'));
const entries = Object.entries(first).map(([name, nodeId]) => ({ src: name.slice(4), nodeId })).filter((e) => assets[e.src]);

// The Figma plugin API cannot read the size of a WebP picture (`getImageByHash(...).getSizeAsync()` throws "Could not read image size from image metadata"), and the post step
// needs it to place every slot. WebP pictures are therefore sent as PNG (alpha kept) — converted with macOS `sips`; other types go as they are.
function forFigma(file, type) {
  if (type !== 'image/webp') return { body: readFileSync(file), type };
  const out = join(mkdtempSync(join(tmpdir(), 'fra-img-')), 'img.png');
  execFileSync('sips', ['-s', 'format', 'png', file, '--out', out], { stdio: 'ignore' });
  return { body: readFileSync(out), type: 'image/png' };
}

if (cmd === 'plan') {
  console.log(JSON.stringify({ count: entries.length, nodeIds: entries.map((e) => e.nodeId) }));
} else if (cmd === 'send') {
  const raw = JSON.parse(readFileSync(resolve(uploadsFile), 'utf8'));
  const uploads = Array.isArray(raw) ? raw : raw.uploads;
  if (uploads.length !== entries.length) throw new Error('upload count ' + uploads.length + ' != planned ' + entries.length);
  const results = await Promise.all(entries.map(async (e, i) => {
    const a = assets[e.src];
    const { body, type } = forFigma(join(dir, 'assets', a.file), a.type);
    const r = await fetch(uploads[i].submitUrl, { method: 'POST', headers: { 'content-type': type }, body });
    const j = await r.json().catch(() => ({}));
    return { src: e.src, ok: r.ok && j.success !== false };
  }));
  console.log(JSON.stringify({ sent: results.length, failed: results.filter((r) => !r.ok).map((r) => r.src) }));
} else { console.error('usage: upload.mjs plan|send <runDir> [uploads.json]'); process.exit(1); }
