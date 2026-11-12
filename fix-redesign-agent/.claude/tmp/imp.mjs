import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const b = await chromium.launch();
let c = await b.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } }); let p = await c.newPage();
await p.route('**/*', r => r.request().url().startsWith('data:') ? r.continue() : r.abort());
await p.setContent(readFileSync('/Users/sachin/Project-aura/fix-redesign-agent/projects/www.kenresearch.com-dealers-voice-survey/redesigns/dealers-voice-survey-page-audit-v3-redesign-20261012-104005/context/capture-snapshot.html', 'utf8'), { waitUntil: 'domcontentloaded' }); await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}' }); await p.waitForTimeout(600);
await p.locator('[data-fra-section="our-impact"]').screenshot({ path: '.claude/tmp/impact-live.png' });
p = await b.newPage({ viewport: { width: 1440, height: 900 } }); await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
const sec = p.locator('[data-pv-section="our-impact"]'); await sec.scrollIntoViewIfNeeded(); await p.waitForTimeout(800); await sec.screenshot({ path: '.claude/tmp/impact-prev.png' });
await b.close();
