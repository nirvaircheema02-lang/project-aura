import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const ports = JSON.parse(readFileSync('.claude/tmp/resp/ports.json', 'utf8'));
const WIDTHS = [375, 768, 1024];
const b = await chromium.launch();
const out = {};
for (const [k, port] of Object.entries(ports)) {
  out[k] = {};
  for (const w of WIDTHS) {
    const c = await b.newContext({ viewport: { width: w, height: 800 }, reducedMotion: 'reduce' }); const p = await c.newPage();
    await p.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
    // scroll through to trigger lazy/scroll effects
    const H = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < H; y += 600) { await p.evaluate((yy) => scrollTo(0, yy), y); await p.waitForTimeout(120); }
    await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
    const r = await p.evaluate((W) => {
      const res = { docW: document.documentElement.scrollWidth, over: [], tiny: [], small: [], secs: [] };
      const seen = new Set();
      const walk = (root, sec) => {
        for (const e of root.querySelectorAll('*')) {
          const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') { if (e.shadowRoot) walk(e.shadowRoot, sec); continue; }
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (r.right > W + 2 || r.left < -2)) {
            // ignore elements clipped by an overflow-hidden ancestor
            let clipped = false; for (let a = e.parentElement || (e.getRootNode() && e.getRootNode().host); a; a = a.parentElement || (a.getRootNode() && a.getRootNode().host)) { const s = getComputedStyle(a); if (s.overflowX !== 'visible') { const ar = a.getBoundingClientRect(); if (ar.right <= W + 2 && ar.left >= -2) { clipped = true; break; } } }
            if (!clipped) { const key = sec + '|' + e.tagName + '|' + Math.round(r.left) + '|' + Math.round(r.right); if (!seen.has(key) && res.over.length < 12) { seen.add(key); res.over.push({ sec, tag: e.tagName, cls: (e.getAttribute('class') || '').toString().slice(0, 50), l: Math.round(r.left), r: Math.round(r.right), t: (e.textContent || '').trim().slice(0, 30) }); } }
          }
          if (e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
            const fs = parseFloat(cs.fontSize); if (fs < 11 && res.tiny.length < 6) res.tiny.push({ sec, fs, t: (e.textContent || '').trim().slice(0, 30) });
          }
          if ((e.tagName === 'A' || e.tagName === 'BUTTON') && r.width > 0 && (r.height < 30 || r.width < 30) && r.width * r.height > 0 && res.small.length < 6) res.small.push({ sec, w: Math.round(r.width), h: Math.round(r.height), t: (e.textContent || '').trim().slice(0, 25) });
          if (e.shadowRoot) walk(e.shadowRoot, sec);
        }
      };
      document.querySelectorAll('[data-pv-section]').forEach((s) => { const id = s.getAttribute('data-pv-section'); const rc = s.getBoundingClientRect(); res.secs.push([id, Math.round(rc.height)]); walk(s, id); if (s.shadowRoot) walk(s.shadowRoot, id); });
      return res;
    }, w);
    out[k][w] = r;
    await p.screenshot({ path: '.claude/tmp/resp/' + k + '-' + w + '.png', fullPage: true });
    await c.close();
  }
}
await b.close();
writeFileSync('.claude/tmp/resp/audit.json', JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) for (const [w, r] of Object.entries(v)) console.log(k, w, 'docW', r.docW, 'overflow', r.over.length, 'tiny', r.tiny.length, 'smallTap', r.small.length);
