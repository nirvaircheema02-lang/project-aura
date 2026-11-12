import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { ExtractionResult } from '../../src/preview/types.ts';
import { verifyPreview } from '../../src/preview/verify.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * "Text contrast was measured" is a required gate, but a selection with NO readable text (an image or logo strip) has nothing to measure:
 * that is a pass saying so, not a permanent INCOMPLETE with the untruthful reason "the contrast measurement could not run".
 */

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const section = (): ExtractionResult['sections'][number] => ({ id: 'logos', name: 'Logos', order: 0, unlabelled: false, tree: { t: 'el', tag: 'section', attrs: {}, children: [] }, ancestors: [], text: '', visibleText: '', height: 60, locator: { cssPath: 'section', textStart: '', textLength: 0 }, links: [], images: 0, headings: [], findingElements: [] });
const extraction = (): ExtractionResult => ({ sections: [section()], scopedCss: '', globalCss: '', htmlAttrs: {}, bodyAttrs: {}, orphanContent: [], outOfScopeText: [], remoteAssets: [], interactive: [], stats: { rules: 0, keptRules: 0, elements: 0 } });

describe('verifyPreview - contrast of a selection with no text', () => {
  it('passes "contrast.measured" saying there is no text to measure (not "could not run")', async () => {
    const srv = await startLocalServer({ '/': { body: '<!doctype html><html><head><meta charset="utf-8"><title>l</title><link rel="icon" href="data:,"></head><body style="margin:0"><div data-pv-section="logos" style="height:60px;background:#eee"></div></body></html>' } });
    try {
      const v = await verifyPreview({
        browser, url: `${srv.origin}/`, mode: 'selected-sections', expected: { mode: 'selected-sections', expectedSectionIds: ['logos'], forbiddenSectionIds: [], fixFindingsBySection: {}, globalSectionIds: [] },
        extraction: extraction(), fixFindings: [], routes: new Map(), decisions: null, islands: [], skippedIslands: [], originalBehavior: null, sectionNames: {}, simulated: [], generation: { assetsFailed: [], remoteLeft: [] },
      });
      const c = v.checks.find((x) => x.id === 'contrast.measured')!;
      expect(c.status).toBe('pass');
      expect(c.detail).toMatch(/no text/i);
      expect(v.status?.gaps.map((g) => g.family)).not.toContain('check:contrast.measured');
    } finally { await srv.close(); }
  }, 120_000);
});
