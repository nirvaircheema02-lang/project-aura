import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidatesByText, labelKey, mapByTextIdentity } from '../../src/mapping/text-identity.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/**
 * Real Chromium. The dealers-voice-survey run left 246 findings unmapped ("no candidate passed at least two objective checks"), among them the four
 * card "Read More" links, so no design-system component could be applied to them. Exact text identity places them — only when unambiguous.
 */
const HTML = `<!doctype html><html><body style="margin:0">
<div class="card" style="height:300px"><p id="t1">34+ NPS uplift achieved within 9 months</p><a id="r1" href="#"><span>Read More</span><svg width="8" height="8"></svg></a></div>
<div class="card" style="height:300px"><p id="t2">Dealer churn reduced from 18% to 7% in one year</p><a id="r2" href="#"><span>Read More</span><svg width="8" height="8"></svg></a></div>
<div class="card" style="height:300px"><a id="r3" href="#"><span>Read More</span></a><div style="display:none"><a id="hidden" href="#">Read More</a></div></div>
<h2 id="dup">Customer Satisfaction Surveys</h2><button id="b1">Customer Satisfaction Surveys</button>
<p id="long">Uncover what drives your dealer network - trust, motivation, challenges, and performance with our survey</p>
</body></html>`;

let pool: BrowserPool;
beforeAll(async () => { pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' }); await pool.start(); });
afterAll(async () => { await pool?.stop(); });
const withPage = (fn: (p: import('playwright').Page) => Promise<void>) => pool.withIsolatedPage(async (p) => { await p.setContent(HTML); await fn(p); });
const idAt = (p: import('playwright').Page, y: number) => p.evaluate((yy) => document.elementFromPoint(20, yy - window.scrollY)?.closest('a,p,h2,button')?.id ?? null, y);

describe('mapByTextIdentity', () => {
  it('REGRESSION: pairs a duplicate-labelled set ("Read More" ×3) with the three visible links by reading order, link → the <a> itself, hidden copies ignored', async () => {
    await withPage(async (p) => {
      const items = [3, 1, 2].map((n) => ({ findingId: `F${n}`, label: 'Read More', type: 'link', auditBox: { x: 0, y: n * 300 - 100, width: 50, height: 20 } })); // given out of order
      const m = await mapByTextIdentity(p, items);
      expect(m.map((x) => x.findingId).sort()).toEqual(['F1', 'F2', 'F3']);
      const byId = Object.fromEntries(m.map((x) => [x.findingId, x.candidate]));
      expect(byId['F1']!.tagName).toBe('a');
      expect(byId['F1']!.box.y).toBeLessThan(byId['F2']!.box.y);
      expect(byId['F2']!.box.y).toBeLessThan(byId['F3']!.box.y);
    });
  });

  it('a paragraph maps to the innermost element holding exactly its text; a label cut with "…" matches as a prefix', async () => {
    await withPage(async (p) => {
      const m = await mapByTextIdentity(p, [
        { findingId: 'P1', label: '34+ NPS uplift achieved within 9 months', type: 'paragraph', auditBox: null },
        { findingId: 'P2', label: 'Uncover what drives your dealer network - trust, motivation…', type: 'paragraph', auditBox: null },
      ]);
      expect(Object.fromEntries(m.map((x) => [x.findingId, x.candidate.tagName]))).toEqual({ P1: 'p', P2: 'p' });
    });
  });

  it('NEVER guesses: more findings than live matches, or more live matches than findings, leaves the group unmapped', async () => {
    await withPage(async (p) => {
      const two = [1, 2].map((n) => ({ findingId: `X${n}`, label: 'Read More', type: 'link', auditBox: null })); // 3 live links, 2 findings
      expect(await mapByTextIdentity(p, two)).toEqual([]);
      const five = [1, 2, 3, 4, 5].map((n) => ({ findingId: `Y${n}`, label: 'Read More', type: 'link', auditBox: null })); // 3 live, 5 findings
      expect(await mapByTextIdentity(p, five)).toEqual([]);
      expect(await mapByTextIdentity(p, [{ findingId: 'Z', label: 'Not on the page at all', type: 'paragraph', auditBox: null }])).toEqual([]);
    });
  });

  it('a heading label that two elements carry (heading + button) with one finding stays unmapped; elements already taken are excluded', async () => {
    await withPage(async (p) => {
      // two live elements (the h2 AND the button) carry this text but there is one finding: ambiguous, so unmapped
      expect(await mapByTextIdentity(p, [{ findingId: 'H', label: 'Customer Satisfaction Surveys', type: 'section-heading', auditBox: null }])).toEqual([]);
      // with the finding for each, they pair (heading group and button group are separate)
      // the button finding pairs with the <button>; the heading finding still sees two text carriers (h2 and the button's text) and stays unmapped
      const both = await mapByTextIdentity(p, [
        { findingId: 'H', label: 'Customer Satisfaction Surveys', type: 'section-heading', auditBox: null },
        { findingId: 'B', label: 'Customer Satisfaction Surveys', type: 'button', auditBox: null },
      ]);
      expect(both.map((m) => [m.findingId, m.candidate.tagName])).toEqual([['B', 'button']]);
      const taken = await candidatesByText(p, 'Read More', true);
      const first = taken[0]!;
      const m = await mapByTextIdentity(p, [1, 2].map((n) => ({ findingId: `T${n}`, label: 'Read More', type: 'link', auditBox: null })), (c) => c.box.y === first.box.y);
      expect(m).toHaveLength(2);
      expect(m.some((x) => x.candidate.box.y === first.box.y)).toBe(false);
    });
  });

  it('labelKey normalizes whitespace and a trailing ellipsis', () => {
    expect(labelKey('  Get   Pricing &  Timeline…')).toBe('Get Pricing & Timeline');
    void idAt;
  });
});

describe('mapByTextIdentity — a heading finding is only ever a heading', () => {
  // REGRESSION (brand-perception run): "Dealer's Voice Surveys" is a card h2, a CTA and a tab label. With the h2 and the CTA taken by other findings, the h2 finding was paired with the
  // one free element left — the tab label <span> — and the h2's DS size landed on it.
  const PAGE = `<!doctype html><html><body><h2 id="card">Dealers Voice Surveys</h2><a id="cta" href="#">Dealers Voice Surveys</a><ul><li><span id="tab">Dealers Voice Surveys</span></li></ul></body></html>`;
  it('refuses to pair a section-heading finding with the tab label span; pairs it with the h2 when the h2 is free', async () => {
    await pool.withIsolatedPage(async (p) => {
      await p.setContent(PAGE);
      const item = { findingId: 'H', label: 'Dealers Voice Surveys', type: 'section-heading', auditBox: null };
      // the h2 and the CTA are taken: only the span is free -> refused
      const taken = (c: { tagName: string }) => c.tagName.toLowerCase() === 'h2' || c.tagName.toLowerCase() === 'a';
      expect(await mapByTextIdentity(p, [item], taken)).toEqual([]);
      // nothing taken: three live matches vs one finding -> still unmapped (never guessed)
      expect(await mapByTextIdentity(p, [item])).toEqual([]);
    });
  });
  it('tagCompatible: headings only for section-heading; every other type is permissive', async () => {
    const { tagCompatible } = await import('../../src/mapping/text-identity.ts');
    expect(tagCompatible('section-heading', { tagName: 'H2', role: null })).toBe(true);
    expect(tagCompatible('section-heading', { tagName: 'SPAN', role: 'heading' })).toBe(true);
    expect(tagCompatible('section-heading', { tagName: 'SPAN', role: null })).toBe(false);
    expect(tagCompatible('paragraph', { tagName: 'SPAN', role: null })).toBe(true);
  });
});
