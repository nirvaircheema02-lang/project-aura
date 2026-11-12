import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const html = readFileSync('/Users/sachin/Project-aura/fix-redesign-agent/projects/www.kenresearch.com-dealers-voice-survey/redesigns/dealers-voice-survey-page-audit-v3-redesign-20261012-104005/original.html','utf8');
const b = await chromium.launch(); const c = await b.newContext({ bypassCSP: true, viewport:{width:1440,height:900} }); const p = await c.newPage();
await p.route('**/*', r => r.request().url().startsWith('data:') ? r.continue() : r.abort());
await p.setContent(html, { waitUntil: 'domcontentloaded' });
console.log(await p.evaluate(() => Array.from(document.styleSheets).map(s => { let n=-1; try { n=s.cssRules.length } catch(e){ n='ERR' } return [s.ownerNode?.tagName, s.href?.slice(0,60), n, s.ownerNode?.textContent?.length]; })));
await b.close();
