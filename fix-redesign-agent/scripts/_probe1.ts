import { chromium } from 'playwright';
const SP = '/private/tmp/claude-502/-Users-sachin-Nirvair-promo-video/c1d32842-1d00-4bce-a50f-7a0f00ff171b/scratchpad/';
const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:4484/', { waitUntil: 'networkidle' });
const hero = page.locator('[data-pv-section="sustainable-product-consumer-perception-survey"]');
await hero.screenshot({ path: SP + 'surv-hero-before.png' });
const info = await page.evaluate(() => {
  const host = document.querySelector('[data-pv-section="sustainable-product-consumer-perception-survey"]')!;
  const h = host.querySelector('[data-pv-island="SectionHeading"] h1, [data-pv-island="SectionHeading"] h2, [data-pv-island="SectionHeading"] h3') as HTMLElement | null;
  const cs = h ? getComputedStyle(h) : null;
  const chain: string[] = [];
  for (let n: Element | null = h; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) { const c = getComputedStyle(n); chain.push(`${n.localName}.${String((n as HTMLElement).className).slice(0, 40)} bg=${c.backgroundColor} img=${c.backgroundImage.slice(0, 50)}`); if (chain.length > 14) break; }
  return { found: !!h, tag: h?.localName, color: cs?.color, fontSize: cs?.fontSize, cls: h?.className, parent: h?.parentElement?.className, chain, dataVariant: document.documentElement.getAttribute('data-variant'), htmlCls: document.documentElement.className };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
