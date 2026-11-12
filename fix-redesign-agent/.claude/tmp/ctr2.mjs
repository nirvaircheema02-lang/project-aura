import { chromium } from 'playwright';
for (const reduced of [false, true]) {
  const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: reduced ? 'reduce' : 'no-preference' }); const p = await c.newPage();
  await p.goto('http://127.0.0.1:4585/?motion=full', { waitUntil: 'networkidle' });
  const get = () => p.locator('[data-fra-element="e17"]').first().textContent();
  const seen = [await get()];
  for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, 150); await p.waitForTimeout(120); const t = await get(); if (seen[seen.length - 1] !== t) seen.push(t); }
  await p.waitForTimeout(2000); seen.push(await get());
  console.log('reducedMotion', reduced, JSON.stringify(seen.slice(0, 8)), seen.length);
  await b.close();
}
