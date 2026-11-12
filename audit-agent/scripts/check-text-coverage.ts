// Text coverage gate: lists visible body-text / stat leaves on the audited page that no finding accounts for.
// Usage: node --experimental-strip-types scripts/check-text-coverage.ts <runDir>   (exit 1 when any are unaccounted)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: check-text-coverage.ts <runDir>');
  process.exit(2);
}

const data = JSON.parse(readFileSync(join(runDir, 'data.json'), 'utf8'));
const url: string = data.findings[0].location.url;
const norm = (s: string) => s.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const audited = data.findings.map((f: any) => norm(String(f.component?.productionLabel ?? '')));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
const height = await page.evaluate(() => document.documentElement.scrollHeight);
for (let y = 0; y < height; y += 500) {
  await page.evaluate((v) => scrollTo(0, v), y);
  await page.waitForTimeout(150);
}
await page.waitForTimeout(3000); // let count-up stats settle

const leaves = await page.evaluate(() => {
  const owner = 'a,button,h1,h2,h3,h4,h5,h6,label,[role=button],[role=link],[role=tab]';
  const out: any[] = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (el.children.length || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH'].includes(el.tagName)) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.closest(owner)) continue; // controls and headings are B2's own path
    let faded = false;
    for (let n: Element | null = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) === 0) faded = true;
    const section = el.closest('section');
    const heading = section?.querySelector('h1,h2,h3');
    out.push({
      text: text.slice(0, 70),
      tag: el.tagName.toLowerCase(),
      color: cs.color,
      faded,
      gradientText: cs.backgroundClip === 'text' || (cs as any).webkitBackgroundClip === 'text',
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      section: (heading?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50),
    });
  }
  return out;
});
await browser.close();

const missing = leaves.filter((l) => {
  const t = norm(l.text);
  return !audited.some((a: string) => a && (a.startsWith(t) || t.startsWith(a)));
});

const fadedCount = missing.filter((m) => m.faded).length;
console.log(`text leaves outside controls/headings: ${leaves.length} · unaccounted: ${missing.length} (${fadedCount} inside an opacity-0 layer — revealed only on hover/scroll, ${missing.length - fadedCount} visible)`);
for (const m of missing) {
  console.log(`  [${m.section || '—'}]${m.faded ? ' (opacity-0 layer)' : ''} <${m.tag}> "${m.text}" ${m.fontSize}/${m.fontWeight} ${m.gradientText ? 'gradient-text' : m.color}`);
}
process.exit(missing.length ? 1 : 0);
