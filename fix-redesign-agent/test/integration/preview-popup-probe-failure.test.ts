import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { ExtractionResult } from '../../src/preview/types.ts';
import { verifyPreview } from '../../src/preview/verify.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * A required measurement that CRASHES is missing evidence, not a pass: when the popup-control probe throws (page closed, navigation timeout), the
 * select / combobox checks must read "not checked" and the overall status must list them as an unverified required gap.
 */

vi.mock('../../src/preview/popup-check.ts', async (orig) => {
  const real = await orig<typeof import('../../src/preview/popup-check.ts')>();
  return { ...real, checkPopupControls: vi.fn(async () => { throw new Error('Target page, context or browser has been closed'); }) };
});

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const section = (): ExtractionResult['sections'][number] => ({ id: 'calc', name: 'Calc', order: 0, unlabelled: false, tree: { t: 'el', tag: 'section', attrs: {}, children: [] }, ancestors: [], text: 'Pick one', visibleText: 'Pick one', height: 40, locator: { cssPath: 'section', textStart: '', textLength: 0 }, links: [], images: 0, headings: [], findingElements: [] });
const extraction = (): ExtractionResult => ({ sections: [section()], scopedCss: '', globalCss: '', htmlAttrs: {}, bodyAttrs: {}, orphanContent: [], outOfScopeText: [], remoteAssets: [], interactive: [], stats: { rules: 0, keptRules: 0, elements: 0 } });

describe('verifyPreview - a popup-control probe that throws', () => {
  it('is NOT-CHECKED (an unverified required gap), never the passing "no select or combobox control" check', async () => {
    const srv = await startLocalServer({ '/': { body: '<!doctype html><html><head><meta charset="utf-8"><title>s</title><link rel="icon" href="data:,"></head><body style="margin:0"><div data-pv-section="calc"><select aria-label="Length"><option>0-15</option></select></div></body></html>' } });
    try {
      const v = await verifyPreview({
        browser, url: `${srv.origin}/`, mode: 'selected-sections', expected: { mode: 'selected-sections', expectedSectionIds: ['calc'], forbiddenSectionIds: [], fixFindingsBySection: {}, globalSectionIds: [] },
        extraction: extraction(), fixFindings: [], routes: new Map(), decisions: null, islands: [], skippedIslands: [], originalBehavior: null, sectionNames: {}, simulated: [], generation: { assetsFailed: [], remoteLeft: [] },
      });
      const popup = v.checks.find((c) => c.id === 'interaction.popup-controls');
      expect(popup?.status).toBe('not-checked');
      expect(popup?.detail).toMatch(/probe failed.*browser has been closed/);
      expect(popup?.detail).not.toMatch(/no select or combobox control/);
      expect(v.checks.some((c) => c.id === 'interaction.popup-controls-keyboard' && c.status === 'pass')).toBe(false);
      expect(v.status?.gaps.map((g) => g.family)).toContain('check:interaction.popup-controls');
      expect(v.status?.verdict).not.toBe('pass');
    } finally { await srv.close(); }
  }, 120_000);
});
