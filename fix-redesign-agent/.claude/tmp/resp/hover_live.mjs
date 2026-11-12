import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c.newPage();
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await p.waitForTimeout(6000);
const cards = p.locator('div[class*="border-[#EDECFB]"][class*="h-[140px]"]');
const n = await cards.count(); console.log('cards', n);
if (n) {
  await cards.nth(1).scrollIntoViewIfNeeded(); await p.waitForTimeout(500);
  const ops = async () => cards.evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity));
  console.log('rest', JSON.stringify(await ops()));
  await cards.nth(1).hover(); await p.waitForTimeout(700); console.log('hover card2', JSON.stringify(await ops()));
  await p.mouse.move(5, 5); await p.waitForTimeout(700); console.log('outside', JSON.stringify(await ops()));
}
await b.close();
