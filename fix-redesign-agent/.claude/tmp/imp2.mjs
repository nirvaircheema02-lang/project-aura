import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const b = await chromium.launch();
// live capture with its transitions enabled
let c = await b.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } }); let p = await c.newPage();
await p.route('**/*', r => r.request().url().startsWith('data:') ? r.continue() : r.abort());
await p.setContent(readFileSync('/Users/sachin/Project-aura/fix-redesign-agent/projects/www.kenresearch.com-dealers-voice-survey/redesigns/dealers-voice-survey-page-audit-v3-redesign-20261012-104005/context/capture-snapshot.html', 'utf8'), { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(600);
const sec = p.locator('[data-fra-section="our-impact"]'); await sec.scrollIntoViewIfNeeded();
const card = p.locator('[data-fra-section="our-impact"] [class*="group"]').nth(1); const bb = await card.boundingBox(); await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.waitForTimeout(1500);
await sec.screenshot({ path: '.claude/tmp/impact-live-hover.png' });
const livePos = await p.evaluate(() => [...document.querySelectorAll('[data-fra-section="our-impact"] a')].filter(a => /Read More/.test(a.textContent)).map(a => { const r = a.getBoundingClientRect(); const g = a.closest('[class*="group"]').getBoundingClientRect(); return [Math.round(r.x - g.x), Math.round(r.y - g.y), Math.round(g.height)]; }));
p = await b.newPage({ viewport: { width: 1440, height: 900 } }); await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const s2 = p.locator('[data-pv-section="our-impact"]'); await s2.scrollIntoViewIfNeeded(); await p.waitForTimeout(500);
const card2 = p.locator('[data-pv-section="our-impact"] >> [class*="group"]').nth(1); const bb2 = await card2.boundingBox(); await p.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2); await p.waitForTimeout(1500);
await s2.screenshot({ path: '.claude/tmp/impact-prev-hover.png' });
console.log(JSON.stringify({ livePos })); await b.close();
