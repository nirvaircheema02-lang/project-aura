import { chromium } from 'playwright';
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }); const p = await c.newPage();
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}' }); await p.waitForTimeout(1200);
const ids = {10:'our-resources',11:'explore-other-surveys',8:'what-our-clients-say'};
for (const [i,id] of Object.entries(ids)) { const el = p.locator('[data-pv-section="'+id+'"]'); await el.evaluate(e=>e.scrollIntoView({block:'center'})); await p.waitForTimeout(1200); await el.screenshot({ path: '.claude/tmp/live_'+i+'.png' }); }
await b.close();
