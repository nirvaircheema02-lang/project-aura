// Turns the raw extraction (absolute boxes + computed style) into the compact tree the Figma builder consumes: named frames, auto-layout inferred from the
// measured geometry (only where it reproduces it), colours as hex, SVG icons inlined, images as slots (`src`), masks/blur/opacity carried over.
const FF = { 'DM Sans': 's', 'Noto Serif': 'n', 'DM Mono': 'm' };
/** The page's own text can name the font by its CSS variable (`notoSerif`, `dmMono`) rather than the family: map those to the same builder family. */
const fam = (ff) => FF[ff] ?? (/noto/i.test(ff ?? '') ? 'n' : /mono/i.test(ff ?? '') ? 'm' : 's');
const r0 = (v) => Math.round(v);

export function col(c) {
  if (c == null) return null;
  const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
  if (!m) return c;
  const hx = (v) => Math.trunc(Number(v)).toString(16).padStart(2, '0');
  const a = m[4] ? Number(m[4]) : 1;
  const h = hx(m[1]) + hx(m[2]) + hx(m[3]);
  return a >= 0.995 ? h : h + Math.round(a * 255).toString(16).padStart(2, '0');
}
const cssColours = (s) => (s ? s.replace(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/g, (m) => '#' + col(m)) : s);

/** kids carry absolute ax/ay/w/h. Returns { L, ks } (an auto-layout description + the kids in flow order) or null. */
function infer(f, kids) {
  const n = kids.length;
  if (n === 0) return null;
  const { ax: fx, ay: fy, w: fw, h: fh } = f;
  const tryDir = (d) => {
    const ks = [...kids].sort((a, b) => (d === 'V' ? a.ay - b.ay || a.ax - b.ax : a.ax - b.ax || a.ay - b.ay));
    const mains = [];
    for (let i = 1; i < ks.length; i++) {
      const p = ks[i - 1];
      const k = ks[i];
      const gap = d === 'V' ? k.ay - (p.ay + p.h) : k.ax - (p.ax + p.w);
      if (gap < -1.5) return null;
      mains.push(gap);
    }
    if (mains.length && Math.max(...mains) - Math.min(...mains) > 2.5) return null;
    const gap = mains.length ? r0(mains.reduce((a, b) => a + b, 0) / mains.length) : 0;
    let lo; let ce; let hi;
    if (d === 'V') {
      lo = ks.map((k) => k.ax - fx); ce = ks.map((k) => k.ax + k.w / 2 - (fx + fw / 2)); hi = ks.map((k) => fx + fw - (k.ax + k.w));
    } else {
      lo = ks.map((k) => k.ay - fy); ce = ks.map((k) => k.ay + k.h / 2 - (fy + fh / 2)); hi = ks.map((k) => fy + fh - (k.ay + k.h));
    }
    const spread = (a) => Math.max(...a) - Math.min(...a);
    let ca; let c0;
    if (spread(lo) <= 1.6) { ca = 'MIN'; c0 = r0(lo[0]); } else if (spread(ce) <= 2.2) { ca = 'CENTER'; c0 = 0; } else if (spread(hi) <= 1.6) { ca = 'MAX'; c0 = r0(hi[0]); } else return null;
    // a child hanging outside the frame on the cross axis (a marquee strip shifted left) cannot be an auto-layout child: the padding would clamp the offset to 0 and move it
    if ((ca === 'MIN' || ca === 'MAX') && c0 < -1.5) return null;
    const first = ks[0]; const last = ks[ks.length - 1];
    const p1 = d === 'V' ? first.ay - fy : first.ax - fx;
    const p2 = d === 'V' ? fy + fh - (last.ay + last.h) : fx + fw - (last.ax + last.w);
    if (p1 < -1.5 || p2 < -1.5) return null;
    const L = { d, g: gap, pa: 'MIN', ca };
    if (d === 'V') Object.assign(L, { pt: Math.max(0, r0(p1)), pb: Math.max(0, r0(p2)), pl: ca === 'MIN' ? Math.max(0, c0) : 0, pr: ca === 'MAX' ? Math.max(0, c0) : 0 });
    else Object.assign(L, { pl: Math.max(0, r0(p1)), pr: Math.max(0, r0(p2)), pt: ca === 'MIN' ? Math.max(0, c0) : 0, pb: ca === 'MAX' ? Math.max(0, c0) : 0 });
    return { L, ks };
  };
  if (n === 1) return tryDir('V');
  const r1 = tryDir('V'); const r2 = tryDir('H');
  if (r1 && r2) return new Set(kids.map((k) => r0(k.ax))).size === 1 ? r1 : r2;
  return r1 || r2;
}

const shadowOf = (s) => {
  if (!s) return null;
  const sh = cssColours(s).replace(/#00000000 0px 0px 0px 0px,?\s*/g, '').replace(/^[,\s]+|[,\s]+$/g, '');
  return sh || null;
};

function enc(n, parent) {
  const rel = () => ({ x: r0(n.ax - parent.ax), y: r0(n.ay - parent.ay) });
  if (n.k === 't') {
    const o = { k: 't', ...rel(), w: r0(n.w), h: r0(n.h), s: n.s, f: fam(n.ff), z: Math.round(n.z * 10) / 10, wt: n.fw, c: col(n.c) };
    if (n.op != null && n.op < 0.99) o.op = n.op;
    if (n.lc) o.lc = n.lc;
    if (n.ls) o.l = Math.round(n.ls * 100) / 100;
    if (n.lh) o.L = Math.round(n.lh * 10) / 10;
    if (!['start', 'left'].includes(n.ta)) o.a = n.ta[0];
    if (n.tt === 'uppercase') o.u = 1;
    if ((n.td || '').includes('underline')) o.d = 1;
    return o;
  }
  if (n.k === 'i') {
    const o = { k: 'i', ...rel(), w: r0(n.w), h: r0(n.h) };
    if (n.r) o.r = n.r;
    if (n.src) o.src = n.src;
    if (n.abs) o.abs = 1;
    if (n.fit && n.fit !== 'fill') o.fit = n.fit;
    if (n.op != null && n.op < 0.99) o.op = n.op;
    if (n.mb) o.mb = n.mb;
    if (n.gs) o.gs = n.gs;
    if (n.pos && n.pos !== '50% 50%') o.pos = n.pos;
    if (n.ib || n.ibw) {
      // an <img> with its own background/border/padding is a tile with the picture inset inside it
      const inset = (n.ibw || 0) + (n.ipad || 0);
      const tile = { k: 'f', n: 'Image tile', x: o.x, y: o.y, w: o.w, h: o.h };
      if (n.ib) tile.b = col(n.ib);
      if (n.ibw) { tile.bw = n.ibw; tile.bc = col(n.ibc); }
      if (n.r) tile.r = n.r;
      if (n.ibb) tile.bb = Number(n.ibb);
      const sh = shadowOf(n.ish);
      if (sh) tile.sh = sh;
      o.x = inset; o.y = inset; o.w = Math.max(1, o.w - 2 * inset); o.h = Math.max(1, o.h - 2 * inset);
      o.r = (n.r || 0) >= 999 ? 9999 : Math.max(0, (n.r || 0) - inset);
      if (!o.r) delete o.r;
      if (o.op != null) { tile.op = o.op; delete o.op; }
      tile.ch = [o];
      return tile;
    }
    return o;
  }
  if (n.k === 'v') {
    if (!n.v) return null;
    // scroll-driven "draw" animations leave a partial dash state: export the fully drawn path
    let s = n.v.replace(/\s(pathLength|stroke-dasharray|stroke-dashoffset)="[^"]*"/g, '');
    for (const a of ['width', 'height']) {
      const hd = s.slice(0, s.indexOf('>'));
      const ms = [...hd.matchAll(new RegExp('\\s' + a + '="[^"]*"', 'g'))];
      if (ms.length > 1) s = s.slice(0, ms[1].index) + s.slice(ms[1].index + ms[1][0].length);
    }
    const o = { k: 'v', ...rel(), w: r0(n.w), h: r0(n.h), v: s };
    if (n.op != null && n.op < 0.99) o.op = n.op;
    if (n.w >= 400 && n.h >= 100) o.bel = 1;
    return o;
  }
  // frame
  let kids = n.kids;
  const o = { k: 'f', n: n.n, w: r0(n.w), h: r0(n.h) };
  if (parent) Object.assign(o, rel());
  if (n.b) o.b = col(n.b);
  if (n.g) o.g = cssColours(n.g);
  if (n.bw) { o.bw = n.bw; o.bc = col(n.bc); }
  if (n.r) o.r = n.r;
  const sh = shadowOf(n.sh);
  if (sh) o.sh = sh;
  if (n.cl) o.cl = 1;
  if (n.bel) o.bel = 1;
  if (n.op) o.op = n.op;
  if (n.fl) o.fl = n.fl;
  if (n.bb) o.bb = n.bb;
  const big = kids.filter((x) => x.k === 'i' && x.w >= 1400).sort((a, b) => (a.zi || 0) - (b.zi || 0)); // full-bleed backgrounds are absolutely positioned, outside the flow; a negative z-index sits BEHIND the others (the hero video over its background picture), not in DOM order
  kids = kids.filter((x) => !(x.k === 'i' && x.w >= 1400));
  let res = kids.length >= 1 ? infer(n, kids) : null;
  if (!res && kids.length >= 4) {
    const ks = [...kids].sort((a, b) => a.ay - b.ay || a.ax - b.ax);
    const rows = [];
    for (const k of ks) {
      if (rows.length && Math.abs(rows[rows.length - 1][0].ay - k.ay) <= 3) rows[rows.length - 1].push(k);
      else rows.push([k]);
    }
    if (rows.length >= 2 && rows.length < kids.length) {
      const synth = rows.map((r, i) => {
        const x0 = Math.min(...r.map((k) => k.ax)); const y0 = Math.min(...r.map((k) => k.ay));
        const x1 = Math.max(...r.map((k) => k.ax + k.w)); const y1 = Math.max(...r.map((k) => k.ay + k.h));
        return { k: 'f', ax: x0, ay: y0, w: x1 - x0, h: y1 - y0, n: 'Row ' + (i + 1), kids: r };
      });
      const res2 = infer(n, synth);
      if (res2) { kids = synth; res = res2; }
    }
  }
  if (res) { o.al = res.L; kids = res.ks; }
  // the builder puts an absolute picture of an auto-layout frame at the bottom of the stack as it is built, so those are listed top-first; elsewhere they stack in build order
  o.ch = [...(o.al ? [...big].reverse() : big), ...kids].map((k) => enc(k, n)).filter(Boolean);
  o.ch.slice(0, big.length).forEach((e) => { e.abs = 1; });
  return o;
}

function parseMask(m, section) {
  const g = m.m;
  const horiz = /^linear-gradient\((90deg|270deg)/.test(g);
  const st = [...g.matchAll(/rgba?\(([^)]*)\)\s*([\d.]+)?%?/g)].map((mm) => {
    const parts = mm[1].split(',').map(Number);
    return [parts.length > 3 ? parts[3] : 1, mm[2] === undefined ? null : Number(mm[2])];
  });
  if (st.length) { if (st[0][1] === null) st[0][1] = 0; if (st[st.length - 1][1] === null) st[st.length - 1][1] = 100; }
  return { x: r0(m.ax - section.ax), y: r0(m.ay - section.ay), w: r0(m.w), h: r0(m.h), d: horiz ? 'h' : 'v', st };
}

/** raw = { [sectionId]: { w, h, ax, ay, root, masks } } -> { [sectionId]: tree } */
export function buildTrees(raw) {
  const out = {};
  for (const [sid, v] of Object.entries(raw)) {
    const root = v.root;
    root.ax = v.ax; root.ay = v.ay;
    const t = enc(root, null);
    Object.assign(t, { x: 0, y: 0, w: v.w, h: v.h });
    t.mk = (v.masks ?? []).map((m) => parseMask(m, v)).filter((m) => m.st.length);
    out[sid] = t;
  }
  return out;
}
