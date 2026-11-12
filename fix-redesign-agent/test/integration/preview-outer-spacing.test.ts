import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { extractSections } from '../../src/preview/extract.ts';

/**
 * REGRESSION (brand-perception run): FAQs and "What Our Clients Say" sat in `py-20` section containers; the preview mirrors ancestors as `display: contents`
 * (no box), so the 80px above and below each section vanished and sections ran into each other. A container that wraps ONE section gives its padding and
 * margin back to that section's host, at desktop and at phone width; a container shared by several sections gives none (it would be counted twice).
 */

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial}
.page{padding:10px 0}                       /* shared by every section: not any one section's spacing */
.own{padding-top:80px;padding-bottom:80px}   /* wraps only "faq" */
@media (max-width:767px){.own{padding-top:40px;padding-bottom:40px}}
.tight{margin-top:24px}                      /* a margin on a sole container counts too */
section{padding:0}
</style></head><body><div class="page">
<div class="own"><section data-fra-section="faq"><h2>FAQs</h2><p>Answer</p></section></div>
<div class="tight"><section data-fra-section="explore"><h2>Explore</h2></section></div>
<section data-fra-section="plain"><h2>Plain</h2></section>
</div></body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

describe('section-owned ancestor spacing', () => {
  it('re-applies a sole container\'s padding and margin, at desktop and phone width; shared containers and bare sections get none', async () => {
    const ctx = await browser.newContext();
    try {
      const r = await extractSections(ctx, HTML, { sectionIds: ['faq', 'explore', 'plain'], fullPage: false, names: {}, edits: [] });
      const by = Object.fromEntries(r.sections.map((s) => [s.id, s.outerSpacing]));
      expect(by['faq']).toEqual({ desktop: { top: 80, bottom: 80 }, mobile: { top: 40, bottom: 40 } });
      expect(by['explore']).toEqual({ desktop: { top: 24, bottom: 0 }, mobile: { top: 24, bottom: 0 } });
      expect(by['plain']).toBeUndefined();
    } finally { await ctx.close(); }
  });
});
