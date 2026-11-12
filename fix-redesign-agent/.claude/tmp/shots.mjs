import { chromium } from 'playwright';
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }); const p = await c.newPage();
await p.goto('http://127.0.0.1:4585/', { waitUntil: 'networkidle' });
await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
await p.waitForTimeout(1500);
const ids = ['your-dealers-know-what-your-data-doesn-t','dealer-insights-dashboard','our-clients','what-s-impacting-your-dealers','how-we-capture-dealer-needs'];
let i=1;
for (const id of ids) { const el = p.locator('[data-pv-section="'+id+'"]'); await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(800); await el.screenshot({ path: '.claude/tmp/live_'+i+'.png' }); i++; }
const info = await p.evaluate(() => { const o={}; document.querySelectorAll('[data-pv-section]').forEach(s=>{ const walk=(r)=>{ let c={img:0,canvas:0,video:0,bgurl:0,picture:0,svgBig:0,iframe:0}; const all=[...r.querySelectorAll('*')]; for(const e of all){ const t=e.tagName.toLowerCase(); if(t==='img')c.img++; if(t==='canvas')c.canvas++; if(t==='video')c.video++; if(t==='picture')c.picture++; if(t==='iframe')c.iframe++; if(t==='svg'&&e.outerHTML.length>=5000)c.svgBig++; if(/url\(/.test(getComputedStyle(e).backgroundImage))c.bgurl++; if(e.shadowRoot){const d=walk(e.shadowRoot); for(const k in c)c[k]+=d[k];} } return c;}; o[s.getAttribute('data-pv-section')]=walk(s); }); return o; });
console.log(JSON.stringify(info,null,1));
await b.close();
