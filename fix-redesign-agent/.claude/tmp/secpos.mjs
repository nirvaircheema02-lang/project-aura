import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const html = readFileSync('/Users/sachin/Project-aura/fix-redesign-agent/projects/www.kenresearch.com-dealers-voice-survey/redesigns/dealers-voice-survey-page-audit-v3-redesign-20261012-104005/context/capture-snapshot.html','utf8');
const b = await chromium.launch(); const c = await b.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } }); const p = await c.newPage();
await p.route('**/*', r => r.request().url().startsWith('data:') ? r.continue() : r.abort());
await p.setContent(html,{waitUntil:'domcontentloaded'});
console.log(JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('[data-fra-section]')].map(e=>[e.getAttribute('data-fra-section'),Math.round(e.getBoundingClientRect().y+scrollY),Math.round(e.getBoundingClientRect().height)]))));
await b.close();
