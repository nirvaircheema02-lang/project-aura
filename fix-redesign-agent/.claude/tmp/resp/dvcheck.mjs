import { chromium } from 'playwright';
const b = await chromium.launch();
for (const w of [375, 414, 768, 1024, 1440]) {
  const c = await b.newContext({ viewport: { width: w, height: 800 }, reducedMotion: 'reduce' }); const p = await c.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(String(e).slice(0, 120))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  await p.goto('http://127.0.0.1:4702/', { waitUntil: 'networkidle' }); await p.waitForTimeout(600);
  const H = await p.evaluate(() => document.documentElement.scrollHeight); for (let y = 0; y < H; y += 600) { await p.evaluate((yy) => scrollTo(0, yy), y); await p.waitForTimeout(100); }
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
  const d = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  console.log(w, 'docW', d[0], 'vw', d[1], 'errors', errs.length, errs[0] || '');
  if (w === 375) { for (const id of ['how-we-capture-dealer-needs', 'our-impact']) { const el = p.locator('[data-pv-section="' + id + '"]'); await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(500); await el.screenshot({ path: '.claude/tmp/resp/dvfix-' + id + '.png' }); } }
  await c.close();
}
await b.close();
