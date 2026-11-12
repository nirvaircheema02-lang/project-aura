import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const b = await chromium.launch();
const measure = (root) => { const sec = root.querySelector('[data-fra-section="our-impact"]') || root.querySelector('div'); const as = [...root.querySelectorAll('a')].filter(a => /^Read More/.test(a.textContent.trim())); return as.map(a => { const r = a.getBoundingClientRect(); const card = a.closest('[class*="group"]'); const c = card && card.getBoundingClientRect(); return { a: [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)], card: c && [Math.round(c.x), Math.round(c.y + scrollY), Math.round(c.width), Math.round(c.height)], offsetInCard: c && [Math.round(r.x - c.x), Math.round(r.bottom - c.bottom)] }; }); };
// live (frozen capture)
let c = await b.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } }); let p = await c.newPage();
await p.route('**/*', r => r.request().url().startsWith('data:') ? r.continue() : r.abort());
await p.setContent(readFileSync('/Users/sachin/Project-aura/fix-redesign-agent/projects/www.kenresearch.com-dealers-voice-survey/redesigns/dealers-voice-survey-page-audit-v3-redesign-20261012-104005/context/capture-snapshot.html', 'utf8'), { waitUntil: 'domcontentloaded' }); await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}' }); await p.waitForTimeout(500);
console.log('LIVE', JSON.stringify(await p.evaluate(`(${measure.toString()})(document)`)));
// preview
p = await b.newPage({ viewport: { width: 1440, height: 900 } }); await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
console.log('PREVIEW', JSON.stringify(await p.evaluate(`(()=>{const h=document.querySelector('[data-pv-section="our-impact"]'); return (${measure.toString()})(h.shadowRoot)})()`)));
await b.close();
