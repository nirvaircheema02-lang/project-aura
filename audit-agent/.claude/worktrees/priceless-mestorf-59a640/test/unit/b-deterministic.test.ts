import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deterministicSections } from '../../src/agents/b1-page-analyzer/deterministic.ts';
import { classifyCandidate, selectCandidates } from '../../src/agents/b2-component-detector/deterministic.ts';
import { B1SectionsSchema } from '../../src/llm/schemas/b-nodes.ts';
import { COMPONENT_TYPES } from '../../src/skills/s3-component-taxonomy.ts';
import { parseAriaSnapshot } from '../../src/t-layer/element-registry.ts';
import type { DomFacts } from '../../src/agents/b2-component-detector/deterministic.ts';
import type { AriaElement } from '../../src/t-layer/element-registry.ts';

/**
 * No-API Module B on the REAL audit target: the live aria snapshot of the
 * market-entry page (page height 9516, viewport 1440), plus synthetic
 * snapshots / DomFacts for the rules the real page does not exercise.
 */

const REAL_TEXT = readFileSync(new URL('../fixtures/real/market-entry-aria.txt', import.meta.url), 'utf-8');
const REAL = parseAriaSnapshot(REAL_TEXT);
const PAGE = { pageHeight: 9516, viewportWidth: 1440 };

/** The real snapshot with one verbatim line replaced — fails loudly if the fixture line is not there. */
function realWith(anchor: string, replacement: string[]): AriaElement[] {
  if (!REAL_TEXT.includes(anchor)) throw new Error(`fixture line not found: ${anchor}`);
  return parseAriaSnapshot(REAL_TEXT.replace(anchor, replacement.join('\n')));
}

/** Mirrors B2's box-based `sectionElements`: the elements a section's candidates are chosen from. */
function elementsOfSection(elements: AriaElement[], rootRef: string): AriaElement[] {
  const box = elements.find((e) => e.ref === rootRef)?.box;
  if (!box) throw new Error(`no box for ${rootRef}`);
  return elements.filter((e) => e.box && e.box.y >= box.y - 4 && e.box.y + e.box.height <= box.y + box.height + 4);
}

/**
 * Mirrors B2's no-api claim loop (runB2 + detectDeterministically): sections
 * in order, personalized ones skipped, each offered its y-band, candidates
 * from `selectCandidates`, and the FIRST section to offer a candidate claims
 * it. Returns candidate ref → claiming section root.
 */
function claimsOf(elements: AriaElement[], sections: Array<{ rootRef: string; personalized: boolean }>): Map<string, string> {
  const owner = new Map<string, string>();
  for (const section of sections) {
    if (section.personalized) continue;
    const { candidates } = selectCandidates(elementsOfSection(elements, section.rootRef), { viewportWidth: 1440, allElements: elements });
    for (const c of candidates) if (!owner.has(c.ref)) owner.set(c.ref, section.rootRef);
  }
  return owner;
}

function isAncestorOrSelf(elements: AriaElement[], ancestorRef: string, ref: string): boolean {
  const byRef = new Map(elements.map((e) => [e.ref, e]));
  for (let r: string | null = ref; r !== null; r = byRef.get(r)?.parentRef ?? null) if (r === ancestorRef) return true;
  return false;
}

/** Every claim that went to a section the candidate is NOT a DOM descendant of — must be empty. */
function misattributed(elements: AriaElement[], sections: Array<{ rootRef: string; personalized: boolean }>): string[] {
  return [...claimsOf(elements, sections)].filter(([ref, root]) => !isAncestorOrSelf(elements, root, ref)).map(([ref, root]) => `${ref} claimed by ${root}`);
}

/** Candidates B2 would detect page-wide that no section ever offers — must be empty. */
function neverOffered(elements: AriaElement[], sections: Array<{ rootRef: string; personalized: boolean }>): string[] {
  const claimed = claimsOf(elements, sections);
  return selectCandidates(elements, { viewportWidth: 1440 }).candidates.filter((c) => !claimed.has(c.ref)).map((c) => c.ref);
}

/**
 * Playwright (1.63 coreBundle `visit(child, depth + 1, renderCursorPointer && !inCursorPointer)`)
 * never renders `[cursor=pointer]` under a ref'd element that already carries it. A synthetic
 * snapshot that does is a shape the real detector never sees.
 */
function expectPlaywrightShape(elements: AriaElement[]): void {
  const byRef = new Map(elements.map((e) => [e.ref, e]));
  for (const el of elements) {
    if (!el.line.includes('[cursor=pointer]')) continue;
    for (let r = el.parentRef; r !== null; r = byRef.get(r)?.parentRef ?? null) {
      expect(byRef.get(r)?.line.includes('[cursor=pointer]'), `${el.ref} is marked under marked ${r}`).toBe(false);
    }
  }
}

describe('B1 deterministicSections — the real market-entry page', () => {
  const sections = deterministicSections(REAL, PAGE);
  const byRoot = new Map(sections.map((s) => [s.rootRef, s]));

  it('finds the header, the 11 bands under the e65 wrapper and the footer, in document order', () => {
    expect(sections.map((s) => s.rootRef)).toEqual([
      'e2',
      'e66', 'e171', 'e285', 'e338', 'e398', 'e450', 'e494', 'e513', 'e541', 'e621', 'e670',
      'e712',
    ]);
  });

  it('never returns the page root or the wrapper that only holds the bands', () => {
    const roots = sections.map((s) => s.rootRef);
    expect(roots).not.toContain('e1');
    expect(roots).not.toContain('e65');
  });

  it('names sections by their first heading — "How We Can Help" names e171', () => {
    expect(byRoot.get('e171')?.name).toBe('How We Can Help');
    expect(byRoot.get('e670')?.name).toBe("FAQ's");
  });

  it('classifies kinds from structure only', () => {
    expect(byRoot.get('e712')?.kind).toBe('footer');
    expect(byRoot.get('e712')?.name).toBe('Footer');
    expect(byRoot.get('e2')?.kind).toBe('nav');
    // The h1 sits on an off-canvas carousel slide, but the section still contains it.
    expect(byRoot.get('e66')?.kind).toBe('hero');
    expect(byRoot.get('e450')?.kind).toBe('form');
    for (const ref of ['e171', 'e285', 'e338', 'e398', 'e494', 'e513', 'e541', 'e621', 'e670']) {
      expect(byRoot.get(ref)?.kind).toBe('content');
    }
  });

  it('falls back to "Section N" when nothing names a section', () => {
    expect(byRoot.get('e398')?.name).toBe('Section 6');
    expect(byRoot.get('e494')?.name).toBe('Section 8');
  });

  it('states why in every note, and nothing on this page is personalized or a listing', () => {
    for (const s of sections) {
      expect(s.note.startsWith('deterministic: ')).toBe(true);
      expect(s.personalized).toBe(false);
      expect(s.isListing).toBe(false);
    }
    expect(byRoot.get('e171')?.note).toContain('inside wrapper e65');
  });

  it('has exactly the B1SectionsSchema shape, so B1 resolves it unchanged', () => {
    expect(() => B1SectionsSchema.parse({ sections })).not.toThrow();
  });

  it('hands every candidate to the section it is a DOM descendant of, and offers every candidate somewhere', () => {
    expect(misattributed(REAL, sections)).toEqual([]);
    expect(neverOffered(REAL, sections)).toEqual([]);
  });

  it('B-1: an opened FAQ answer saying "based on your" does NOT exclude the FAQ section', () => {
    // Verbatim fixture text of the first answer, as it reads once the accordion is open.
    const opened = realWith('      - paragraph [box=200,7912,1040,0]: A market entry strategy', ['      - paragraph [ref=e9001] [box=200,7932,1040,44]: A market entry strategy']);
    const faq = deterministicSections(opened, PAGE).find((s) => s.rootRef === 'e670');
    expect(faq?.personalized).toBe(false);
    expect(faq?.note).toContain('"based on your" appears only in paragraph e9001');
  });
});

describe('B1 deterministicSections — y-bands B2 can claim from (B-2, B-4)', () => {
  it('B-2: keeps a sidebar + main row as ONE section instead of splitting main under the sidebar', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,6000]:',
        '  - banner [ref=e2] [box=0,0,1440,80]:',
        '    - link "Reports" [ref=e3] [cursor=pointer] [box=400,30,60,20]',
        '  - generic [ref=e10] [box=0,80,1440,5000]:',
        '    - complementary [ref=e11] [box=0,80,300,700]:',
        '      - heading "Table of contents" [level=2] [ref=e12] [box=20,100,260,30]',
        '      - link "1. Executive summary" [ref=e13] [cursor=pointer] [box=20,140,260,24]',
        '    - main [ref=e20] [box=300,80,1140,5000]:',
        '      - generic [ref=e21] [box=300,80,1140,900]:',
        '        - heading "India Logistics Market" [level=1] [ref=e22] [box=340,120,800,60]',
        '        - link "Buy report" [ref=e23] [cursor=pointer] [box=340,300,200,48]',
        '      - generic [ref=e30] [box=300,980,1140,2000]:',
        '        - heading "Executive summary" [level=2] [ref=e31] [box=340,1000,800,40]',
        '      - generic [ref=e40] [box=300,2980,1140,2100]:',
        '        - heading "Market size" [level=2] [ref=e41] [box=340,3000,800,40]',
        '  - contentinfo [ref=e50] [box=0,5080,1440,920]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, { pageHeight: 6000, viewportWidth: 1440 });
    expect(sections.map((s) => s.rootRef)).toEqual(['e2', 'e10', 'e50']);
    expect(sections[1]?.note).toContain('not split: its children e11 (y 80..780) and e20 (y 80..5080) overlap vertically');
    expect(misattributed(els, sections)).toEqual([]);
    expect(claimsOf(els, sections).get('e23')).toBe('e10');
  });

  it('B-2: a fixed overlay at the page root never claims the bands under it', () => {
    // Real page + a position:fixed cookie bar pinned to the bottom of the 900px viewport (scroll 0).
    const els = realWith('  - contentinfo [ref=e712]', [
      '  - region "Cookie consent" [ref=e9100] [box=0,780,1440,120]:',
      '    - paragraph [ref=e9101] [box=120,800,800,20]: We use cookies.',
      '    - button "Accept" [ref=e9102] [cursor=pointer] [box=1200,800,120,40]',
      '  - contentinfo [ref=e712]',
    ]);
    const sections = deterministicSections(els, PAGE);
    const roots = sections.map((s) => s.rootRef);
    // The 13 real sections unchanged, then the overlay — listed last, after every in-flow band.
    expect(roots).toEqual(['e2', 'e66', 'e171', 'e285', 'e338', 'e398', 'e450', 'e494', 'e513', 'e541', 'e621', 'e670', 'e712', 'e9100']);
    expect(sections.at(-1)?.note).toContain('out of flow — lies inside the y-range of e65; listed after the in-flow sections');
    const claims = claimsOf(els, sections);
    expect(claims.get('e172')).toBe('e171');
    expect(claims.get('e9102')).toBe('e9100');
    expect(misattributed(els, sections)).toEqual([]);
  });

  it('B-2: a fixed header over an unsplit main column is placed first, so it claims only its own controls', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,3000]:',
        '  - banner [ref=e2] [box=0,0,1440,80]:',
        '    - link "Reports" [ref=e3] [cursor=pointer] [box=400,30,60,20]',
        '  - main [ref=e4] [box=0,0,1440,2400]:',
        '    - heading "Article" [level=1] [ref=e5] [box=120,120,800,60]',
        '    - link "Read" [ref=e6] [cursor=pointer] [box=120,300,100,40]',
        '  - contentinfo [ref=e7] [box=0,2400,1440,600]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, { pageHeight: 3000, viewportWidth: 1440 });
    expect(sections.map((s) => [s.rootRef, s.kind])).toEqual([
      ['e2', 'nav'],
      ['e4', 'hero'],
      ['e7', 'footer'],
    ]);
    expect(sections[0]?.note).toContain('placed before e4');
    expect(misattributed(els, sections)).toEqual([]);
  });

  it('B-4: a sub-24px strip holding a control between two bands becomes its own section', () => {
    const els = realWith('    - generic [ref=e541] [box=144,6107,1152,632]:', [
      '    - generic [ref=e9200] [box=120,5990,1200,20]:',
      '      - link "Back to top" [ref=e9201] [cursor=pointer] [box=640,5990,160,20]',
      '    - generic [ref=e541] [box=144,6107,1152,632]:',
    ]);
    const sections = deterministicSections(els, PAGE);
    const roots = sections.map((s) => s.rootRef);
    expect(roots.slice(roots.indexOf('e513'), roots.indexOf('e541') + 1)).toEqual(['e513', 'e9200', 'e541']);
    expect(sections.find((s) => s.rootRef === 'e9200')?.note).toContain('kept as a section although shorter than 24px');
    expect(neverOffered(els, sections)).toEqual([]);
    expect(misattributed(els, sections)).toEqual([]);
  });

  it('B-2: a control rendered inside ANOTHER section\'s y-range is disclosed on the section that receives it', () => {
    // e4 is the header's child but position:fixed mid-page (a floating "Join meeting" button).
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,3000]:',
        '  - generic [ref=e2] [box=0,0,1440,100]:',
        '    - link "Reports" [ref=e3] [cursor=pointer] [box=400,30,60,20]',
        '    - link "Offer" [ref=e5] [cursor=pointer] [box=500,30,60,20]',
        '    - link "Shop" [ref=e6] [cursor=pointer] [box=600,30,60,20]',
        '    - button "Join Meeting Now" [ref=e4] [cursor=pointer] [box=1210,836,214,48]',
        '  - generic [ref=e7] [box=0,100,1440,2900]:',
        '    - generic [ref=e8] [box=0,100,1440,1400]:',
        '      - heading "Report" [level=1] [ref=e9] [box=120,200,800,60]',
        '    - generic [ref=e10] [box=0,1500,1440,1500]:',
        '      - heading "Summary" [level=2] [ref=e11] [box=120,1600,800,60]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, { pageHeight: 3000, viewportWidth: 1440 });
    expect(sections.map((s) => s.rootRef)).toEqual(['e2', 'e8', 'e10']);
    expect(claimsOf(els, sections).get('e4')).toBe('e8');
    expect(sections[1]?.note).toContain('controls of section e2 render in this y-range and are attributed to it by B2: e4 button "Join Meeting Now" (y 836..884)');
  });

  it('B-4: a control no section can offer is named in the nearest section note, never dropped silently', () => {
    // e6 hangs 200px below its band e3 into the gap before e7 — outside every y-range.
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,3000]:',
        '  - generic [ref=e2] [box=0,0,1440,3000]:',
        '    - generic [ref=e3] [box=0,0,1440,1000]:',
        '      - link "Hanging" [ref=e6] [cursor=pointer] [box=100,900,200,300]',
        '    - generic [ref=e7] [box=0,1300,1440,1700]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, { pageHeight: 3000, viewportWidth: 1440 });
    expect(sections.map((s) => s.rootRef)).toEqual(['e3', 'e7']);
    expect(sections[0]?.note).toContain('1 control(s) near this section lie outside every section\'s y-range and are never offered to B2: e6 link "Hanging"');
  });
});

describe('B1 deterministicSections — spine rules (synthetic snapshots)', () => {
  const page = { pageHeight: 3000, viewportWidth: 1440 };

  it('skips zero-size, off-canvas and sub-24px children, but keeps a short landmark', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,3000]:',
        '  - navigation "Skip" [ref=e2] [box=0,0,1440,10]',
        '  - generic [ref=e3] [box=0,10,1440,0]',
        '  - generic [ref=e4] [box=-1440,10,1440,900]',
        '  - generic [ref=e5] [box=1440,10,1440,900]',
        '  - generic [ref=e6] [box=0,12,1440,20]',
        '  - generic [ref=e7] [box=0,40,1440,900]:',
        '    - heading "Band" [level=2] [ref=e8] [box=100,60,300,40]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, page);
    expect(sections.map((s) => s.rootRef)).toEqual(['e2', 'e7']);
    expect(sections[0]).toMatchObject({ kind: 'nav', name: 'Skip' });
    expect(sections[1]?.name).toBe('Band');
  });

  it('descends a pass-through container whose only band is itself page-tall', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,3000]:',
        '  - main [ref=e2] [box=0,0,1440,3000]:',
        '    - generic [ref=e3] [box=0,0,1440,3000]:',
        '      - generic [ref=e4] [box=0,0,1440,1000]',
        '      - generic [ref=e5] [box=0,1000,1440,1000]',
        '      - generic [ref=e6] [box=0,2000,1440,1000]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, page);
    expect(sections.map((s) => s.rootRef)).toEqual(['e4', 'e5', 'e6']);
    expect(sections[0]?.note).toContain('inside wrapper e2 > e3');
  });

  it('keeps a tall node with a single short band as one section (not a wrapper)', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,3000]:',
        '  - generic [ref=e2] [box=0,0,1440,2800]:',
        '    - heading "Article" [level=2] [ref=e3] [box=100,20,600,40]',
      ].join('\n'),
    );
    expect(deterministicSections(els, page).map((s) => s.rootRef)).toEqual(['e2']);
  });

  it('returns sections by y even when the DOM order differs, and only the FIRST h1 section is the hero', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,3000]:',
        '  - generic [ref=e2] [box=0,2000,1440,900]:',
        '    - heading "Second title" [level=1] [ref=e3] [box=100,2020,600,40]',
        '  - generic [ref=e4] [box=0,1000,1440,900]:',
        '    - heading "First title" [level=1] [ref=e5] [box=100,1020,600,40]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, page);
    expect(sections.map((s) => [s.rootRef, s.kind])).toEqual([
      ['e4', 'hero'],
      ['e2', 'content'],
    ]);
  });

  it('prefers the aria name, labels a banner "Header", and flags personalized content', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,3000]:',
        '  - banner [ref=e2] [box=0,0,1440,80]:',
        '    - heading "Brand" [level=2] [ref=e3] [box=10,10,100,20]',
        '  - region "Promotions" [ref=e4] [box=0,100,1440,800]:',
        '    - heading "Deals" [level=2] [ref=e5] [box=10,110,100,20]',
        '  - generic [ref=e6] [box=0,1000,1440,800]:',
        '    - heading "Recommended for you" [level=2] [ref=e7] [box=10,1010,300,20]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, page);
    expect(sections.map((s) => [s.rootRef, s.name, s.kind])).toEqual([
      ['e2', 'Header', 'nav'],
      ['e4', 'Promotions', 'content'],
      ['e6', 'Recommended for you', 'content'],
    ]);
    expect(sections[2]?.personalized).toBe(true);
    expect(sections[2]?.note).toContain('personalized: "Recommended for you"');
    expect(sections[1]?.personalized).toBe(false);
  });

  it('marks a listing only for ≥ 12 sibling links/cards sharing one role pattern', () => {
    // One 1400px section (under half the 3000px page, so never a wrapper) holding the list(s).
    const grid = (count: number, perList: number) => {
      const lines = ['- generic [ref=e1] [box=0,0,1440,3000]:', '  - generic [ref=e2] [box=0,0,1440,1400]:'];
      let ref = 3;
      for (let list = 0; list * perList < count; list++) {
        lines.push(`    - list [ref=e${ref++}] [box=0,${list * 700},1440,680]:`);
        for (let i = 0; i < Math.min(perList, count - list * perList); i++) {
          lines.push(`      - listitem [ref=e${ref++}] [box=0,${list * 700 + i * 50},1440,45]:`);
          lines.push(`        - link "Report ${list}-${i}" [ref=e${ref++}] [cursor=pointer] [box=0,${list * 700 + i * 50},400,40]`);
        }
      }
      const sections = deterministicSections(parseAriaSnapshot(lines.join('\n')), page);
      expect(sections.map((s) => s.rootRef)).toEqual(['e2']);
      return sections[0];
    };
    expect(grid(12, 12)?.isListing).toBe(true);
    expect(grid(12, 12)?.note).toContain('listing: 12 × listitem>link under e3');
    expect(grid(11, 11)?.isListing).toBe(false);
    // The same 12 links split over two sibling lists of 6 (like footer link columns) is not a result grid.
    expect(grid(12, 6)?.isListing).toBe(false);
  });

  it('still sections a snapshot whose root line carries no ref', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [box=0,0,1440,3000]:',
        '  - generic [ref=e2] [box=0,0,1440,900]',
        '  - contentinfo [ref=e3] [box=0,2000,1440,900]',
      ].join('\n'),
    );
    expect(deterministicSections(els, page).map((s) => [s.rootRef, s.kind])).toEqual([
      ['e2', 'content'],
      ['e3', 'footer'],
    ]);
  });

  it('B-5: on a short page the hero stays one section — an h1, its paragraph and its form are not bands', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,1500]:',
        '  - banner [ref=e2] [box=0,0,1440,100]:',
        '    - navigation [ref=e3] [box=0,0,1440,100]:',
        '      - link "Reports" [ref=e4] [cursor=pointer] [box=400,40,60,20]',
        '  - generic [ref=e10] [box=0,100,1440,800]:',
        '    - generic [ref=e16] [box=120,140,600,20]:',
        '      - link "Home" [ref=e17] [cursor=pointer] [box=120,140,40,20]',
        '    - heading "Book a discovery call" [level=1] [ref=e11] [box=120,200,800,80]',
        '    - paragraph [ref=e12] [box=120,300,800,60]: Tell us about your project.',
        '    - generic [ref=e13] [box=120,400,800,400]:',
        '      - textbox "Name" [ref=e14] [box=120,420,400,40]',
        '      - button "Submit" [ref=e15] [cursor=pointer] [box=120,500,160,48]',
        '  - contentinfo [ref=e20] [box=0,900,1440,600]:',
        '    - link "Privacy" [ref=e21] [cursor=pointer] [box=120,950,60,20]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, { pageHeight: 1500, viewportWidth: 1440 });
    expect(sections.map((s) => [s.rootRef, s.kind, s.name])).toEqual([
      ['e2', 'nav', 'Header'],
      ['e10', 'hero', 'Book a discovery call'],
      ['e20', 'footer', 'Footer'],
    ]);
    // The breadcrumb strip inside the hero is offered with it.
    expect(neverOffered(els, sections)).toEqual([]);
  });

  it('B-6: a title band under the header (breadcrumb + h1) is the hero, not a second nav', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,5000]:',
        '  - banner [ref=e2] [box=0,0,1440,80]:',
        '    - link "Reports" [ref=e3] [cursor=pointer] [box=400,30,60,20]',
        '  - generic [ref=e10] [box=0,80,1440,160]:',
        '    - navigation [ref=e11] [box=120,100,400,20]:',
        '      - link "Home" [ref=e12] [cursor=pointer] [box=120,100,40,20]',
        '      - link "Reports" [ref=e14] [cursor=pointer] [box=180,100,60,20]',
        '      - link "Logistics" [ref=e15] [cursor=pointer] [box=260,100,80,20]',
        '    - heading "India Logistics Market Outlook to 2030" [level=1] [ref=e13] [box=120,140,900,60]',
        '  - generic [ref=e20] [box=0,240,1440,1800]:',
        '    - heading "Report summary" [level=2] [ref=e21] [box=120,260,600,40]',
        '  - contentinfo [ref=e30] [box=0,4000,1440,1000]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, { pageHeight: 5000, viewportWidth: 1440 });
    expect(sections.map((s) => [s.rootRef, s.kind])).toEqual([
      ['e2', 'nav'],
      ['e10', 'hero'],
      ['e20', 'content'],
      ['e30', 'footer'],
    ]);
    expect(sections[1]?.note).toContain('its navigation row above the h1 (a title band) → hero');
  });

  it('B-6: a header whose logo is the h1 stays nav; only the first unnamed nav band is called "Header"', () => {
    const logoHeader = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,5000]:',
        '  - generic [ref=e2] [box=0,0,1440,40]:',
        '    - link "Offer" [ref=e3] [cursor=pointer] [box=100,10,60,20]',
        '    - link "Terms" [ref=e4] [cursor=pointer] [box=200,10,60,20]',
        '    - link "Shop" [ref=e5] [cursor=pointer] [box=300,10,60,20]',
        '  - generic [ref=e6] [box=0,40,1440,80]:',
        '    - heading "Ken Research" [level=1] [ref=e8] [box=16,60,152,30]',
        '    - navigation [ref=e7] [box=400,40,800,80]:',
        '      - link "Reports" [ref=e9] [cursor=pointer] [box=400,70,60,20]',
        '  - generic [ref=e10] [box=0,120,1440,2000]:',
        '    - heading "Title" [level=2] [ref=e11] [box=120,140,600,60]',
      ].join('\n'),
    );
    // Even under an announcement strip, the logo h1 sits BESIDE the navigation, not below a
    // breadcrumb row: the band is the header, not a title band.
    const sections = deterministicSections(logoHeader, { pageHeight: 5000, viewportWidth: 1440 });
    expect(sections.map((s) => [s.rootRef, s.kind, s.name])).toEqual([
      ['e2', 'nav', 'Header'],
      ['e6', 'nav', 'Ken Research'],
      ['e10', 'content', 'Title'],
    ]);

    const stripThenHeader = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,5000]:',
        '  - generic [ref=e2] [box=0,0,1440,40]:',
        '    - link "Offer" [ref=e3] [cursor=pointer] [box=100,10,60,20]',
        '    - link "Terms" [ref=e4] [cursor=pointer] [box=200,10,60,20]',
        '    - link "Shop" [ref=e5] [cursor=pointer] [box=300,10,60,20]',
        '  - generic [ref=e6] [box=0,40,1440,80]:',
        '    - navigation [ref=e7] [box=0,40,1440,80]:',
        '      - link "Reports" [ref=e8] [cursor=pointer] [box=400,70,60,20]',
        '  - generic [ref=e9] [box=0,120,1440,2000]:',
        '    - heading "Title" [level=1] [ref=e10] [box=120,140,600,60]',
      ].join('\n'),
    );
    expect(deterministicSections(stripThenHeader, { pageHeight: 5000, viewportWidth: 1440 }).map((s) => [s.rootRef, s.kind, s.name])).toEqual([
      ['e2', 'nav', 'Header'],
      ['e6', 'nav', 'Navigation'],
      ['e9', 'hero', 'Title'],
    ]);

    const soleLogoHeader = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,5000]:',
        '  - generic [ref=e6] [box=0,0,1440,80]:',
        '    - heading "Ken Research" [level=1] [ref=e8] [box=16,20,152,30]',
        '    - navigation [ref=e7] [box=400,0,800,80]:',
        '      - link "Reports" [ref=e9] [cursor=pointer] [box=400,30,60,20]',
        '  - generic [ref=e10] [box=0,80,1440,2000]:',
        '    - heading "Title" [level=2] [ref=e11] [box=120,100,600,60]',
      ].join('\n'),
    );
    expect(deterministicSections(soleLogoHeader, { pageHeight: 5000, viewportWidth: 1440 }).map((s) => [s.rootRef, s.kind])).toEqual([
      ['e6', 'nav'],
      ['e10', 'content'],
    ]);
  });

  it('B-1: only a TITLE announces personalization — body copy and menu links do not', () => {
    const els = parseAriaSnapshot(
      [
        '- generic [ref=e1] [box=0,0,1440,5000]:',
        '  - generic [ref=e2] [box=0,0,1440,900]:',
        '    - heading "Custom research" [level=2] [ref=e3] [box=120,40,600,40]',
        '    - paragraph [ref=e4] [box=120,100,600,40]: Reports tailored based on your requirements.',
        '    - link "Recently viewed" [ref=e5] [cursor=pointer] [box=120,160,200,48]',
        '  - region "Recently viewed" [ref=e6] [box=0,1000,1440,900]:',
        '    - link "Report A" [ref=e7] [cursor=pointer] [box=120,1100,200,48]',
        '  - generic [ref=e8] [box=0,2000,1440,900]:',
        '    - list "Picked for you" [ref=e9] [box=120,2100,1200,400]:',
        '      - listitem [ref=e10] [box=120,2100,400,48]',
      ].join('\n'),
    );
    const sections = deterministicSections(els, { pageHeight: 5000, viewportWidth: 1440 });
    expect(sections.map((s) => [s.rootRef, s.personalized])).toEqual([
      ['e2', false],
      ['e6', true],
      ['e8', true],
    ]);
    expect(sections[0]?.note).toContain('"based on your" appears only in paragraph e4');
    expect(sections[1]?.note).toContain('personalized: "Recently viewed" (its own name)');
    expect(sections[2]?.note).toContain('personalized: "Picked for you" (list e9)');
  });
});

describe('B2 selectCandidates — the real market-entry page', () => {
  it('the header offers "Book discovery call" and the role-less Sign in / Sign up controls', () => {
    const { candidates } = selectCandidates(elementsOfSection(REAL, 'e2'), { viewportWidth: 1440 });
    const refs = candidates.map((c) => c.ref);
    expect(candidates.find((c) => c.name === 'Book discovery call')?.ref).toBe('e63');
    expect(refs).toEqual(expect.arrayContaining(['e14', 'e17', 'e52']));
    // "Company" is a plain generic with no pointer cursor: not a candidate.
    expect(refs).not.toContain('e9');
  });

  it('carousel slides at x<0 or x≥1440 go to offCanvas, never to candidates', () => {
    const { candidates, offCanvas } = selectCandidates(elementsOfSection(REAL, 'e66'), { viewportWidth: 1440 });
    const off = offCanvas.map((c) => c.ref);
    expect(off).toEqual(expect.arrayContaining(['e93', 'e119', 'e132', 'e145']));
    expect(off).toEqual(expect.arrayContaining(['e90', 'e91', 'e92']));
    for (const el of offCanvas) {
      const box = el.box!;
      expect(box.x + box.width <= 0 || box.x >= 1440).toBe(true);
    }
    const refs = candidates.map((c) => c.ref);
    expect(refs).toContain('e106'); // the visible slide's link
    for (const ref of off) expect(refs).not.toContain(ref);
  });

  it('B-3: each case-study card is ONE candidate — its empty overlay link is merged into it, not a second card', () => {
    const { candidates, merged } = selectCandidates(elementsOfSection(REAL, 'e338'), { viewportWidth: 1440, allElements: REAL });
    const refs = candidates.map((c) => c.ref);
    expect(refs).toEqual(expect.arrayContaining(['e343', 'e351', 'e359', 'e372']));
    for (const overlay of ['e350', 'e358', 'e366', 'e379']) expect(refs).not.toContain(overlay);
    expect(merged.map((m) => [m.ref, m.keptRef])).toEqual([
      ['e350', 'e343'],
      ['e358', 'e351'],
      ['e366', 'e359'],
      ['e379', 'e372'],
    ]);
    expect(merged[0]?.reason).toContain('empty link (no name, no child elements) inside clickable e343');

    // …and the kept element is typed as the one card it is.
    const card = candidates.find((c) => c.ref === 'e343')!;
    const typed = classifyCandidate(card, facts({ tag: 'div', text: 'Market Expansion Logistics Aramex unlocked 20+ clients', hasImg: true, childElementCount: 2, box: card.box! }));
    expect(typed?.componentType).toBe('card');
  });
});

describe('B2 selectCandidates — selection rules (Playwright-shaped synthetic snapshots)', () => {
  const els = parseAriaSnapshot(
    [
      '- generic [ref=e1] [box=0,0,1440,900]:',
      '  - generic [ref=e2] [cursor=pointer] [box=100,100,200,48]:',
      '    - link "Download brochure" [ref=e3] [box=100,100,200,48]:',
      '      - /url: /brochure.pdf',
      '  - generic [ref=e4] [cursor=pointer] [box=400,100,300,300]:',
      '    - button "Save" [ref=e5] [box=640,110,40,40]',
      '    - generic [ref=e6] [box=600,110,40,40]',
      '    - link [ref=e7] [box=400,160,300,240]:',
      '      - /url: /case-study',
      '  - link "Reports" [ref=e8] [box=800,100,200,48]:',
      '    - generic [ref=e9] [cursor=pointer] [box=800,100,200,48]',
      '  - paragraph [ref=e10] [box=100,500,400,20]: Just text',
      '  - link "Nothing" [ref=e11] [cursor=pointer] [box=100,600,0,20]',
      '  - link "Skip to content" [ref=e12] [cursor=pointer] [box=0,0,1,1]',
      '  - spinbutton "Phone" [ref=e13] [box=100,700,300,40]',
      '  - link [ref=e14] [cursor=pointer] [box=1000,700,160,40]:',
      '    - /url: /somewhere',
    ].join('\n'),
  );
  const { candidates, offCanvas, visuallyHidden, merged } = selectCandidates(els, { viewportWidth: 1440 });

  it('uses only shapes Playwright emits (no [cursor=pointer] under a [cursor=pointer] ancestor)', () => {
    expectPlaywrightShape(els);
  });

  it('B-3: one control, one candidate — the semantic element wins over a same-box pointer wrapper', () => {
    expect(candidates.map((c) => c.ref)).toEqual(['e3', 'e4', 'e5', 'e8', 'e13', 'e14']);
    expect(merged.map((m) => [m.ref, m.keptRef])).toEqual([
      ['e2', 'e3'], // pointer wrapper around the same-box link: the link is kept
      ['e7', 'e4'], // empty overlay link inside the clickable card
      ['e9', 'e8'], // marked child coinciding with an (unmarked) link
    ]);
    expect(merged[0]?.reason).toContain('pointer wrapper around the same-box link e3');
    // An unmarked role-less icon inside a pointer card (e6) is indistinguishable from decoration:
    // never guessed into a control. A role-bearing one (e5) is kept.
    expect(candidates.map((c) => c.ref)).not.toContain('e6');
    expect(offCanvas).toEqual([]);
  });

  it('B-9: an sr-only (≤ 2px) control is a stated visually-hidden boundary, not a candidate', () => {
    expect(visuallyHidden.map((e) => e.ref)).toEqual(['e12']);
    expect(candidates.map((c) => c.ref)).not.toContain('e12');
  });

  it('carries each candidate\'s hierarchy context for classification', () => {
    expect(candidates.find((c) => c.ref === 'e5')?.selection).toEqual({ inNavigation: false, inFooter: false, clickableAncestor: 'e4', repeatedUnit: null });
  });
});

/** A plain, unfilled inline link unless overridden. */
function facts(over: Partial<Omit<DomFacts, 'style' | 'box'>> & { style?: Partial<DomFacts['style']>; box?: Partial<DomFacts['box']> } = {}): DomFacts {
  const { style, box, ...rest } = over;
  return {
    tag: 'a',
    classes: [],
    roleAttr: null,
    cursor: 'pointer',
    text: 'Read more',
    hasSvg: false,
    hasImg: false,
    ownText: true,
    childElementCount: 0,
    ...rest,
    style: {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      backgroundImage: 'none',
      borderTopWidth: '0px',
      borderTopStyle: 'none',
      paddingLeft: '0px',
      paddingTop: '0px',
      color: 'rgb(0, 0, 0)',
      fontSize: '16px',
      fontWeight: '400',
      display: 'inline',
      opacity: '1',
      visibility: 'visible',
      textTransform: 'none',
      letterSpacing: 'normal',
      ...style,
    },
    box: { x: 100, y: 100, width: 120, height: 24, ...box },
  };
}

function aria(role: string, name = '', extra = ''): AriaElement {
  return {
    ref: 'e1',
    role,
    name,
    line: `- ${role}${name ? ` "${name}"` : ''}${extra ? ` ${extra}` : ''} [ref=e1] [box=100,100,120,24]`,
    depth: 1,
    parentRef: null,
    box: { x: 100, y: 100, width: 120, height: 24 },
  };
}

describe('B2 classifyCandidate (synthetic DomFacts)', () => {
  it('headings are section headings — or eyebrows when small and uppercase/tracked', () => {
    const h2 = classifyCandidate(aria('heading', 'Our Client Results', '[level=2]'), facts({ tag: 'h2', cursor: 'auto', text: 'Our Client Results', style: { fontSize: '40px' } }));
    expect(h2).toMatchObject({ componentType: 'section-heading', confidence: 0.9, label: 'Our Client Results' });
    expect(h2?.domSignals).toContain('level=2');

    const upper = classifyCandidate(aria('heading', 'Market Entry', '[level=5]'), facts({ tag: 'h5', text: 'Market Entry', style: { fontSize: '12px', textTransform: 'uppercase' } }));
    expect(upper?.componentType).toBe('eyebrow');
    const tracked = classifyCandidate(aria('heading', 'Insights', '[level=6]'), facts({ tag: 'h6', text: 'Insights', style: { fontSize: '14px', letterSpacing: '1.4px' } }));
    expect(tracked?.componentType).toBe('eyebrow');
    const bigUpper = classifyCandidate(aria('heading', 'FAQ', '[level=2]'), facts({ tag: 'h2', text: 'FAQ', style: { fontSize: '16px', textTransform: 'uppercase' } }));
    expect(bigUpper?.componentType).toBe('section-heading');
  });

  it('a link that RENDERS as a button is a button (fill, gradient, or solid border with padding)', () => {
    const cta = REAL.find((e) => e.ref === 'e63')!;
    const filled = classifyCandidate(
      cta,
      facts({ text: 'Book discovery call', box: { width: 166, height: 40 }, style: { backgroundColor: 'rgb(176, 31, 36)', paddingLeft: '24px', display: 'inline-flex' } }),
      { inNavigation: true },
    );
    expect(filled).toMatchObject({ componentType: 'button', confidence: 0.9, label: 'Book discovery call' });
    expect(filled?.domSignals.some((s) => s.startsWith('renders as a button: filled background'))).toBe(true);
    expect(filled?.visualSignals).toMatch(/^deterministic: 166×40px; display inline-flex; bg rgb\(176, 31, 36\)/);

    const gradient = classifyCandidate(aria('link', 'Talk to us'), facts({ box: { height: 56 }, style: { backgroundImage: 'linear-gradient(90deg, rgb(176, 31, 36), rgb(120, 10, 20))' } }));
    expect(gradient?.componentType).toBe('button');

    const outlined = classifyCandidate(aria('link', 'Consult Today'), facts({ box: { height: 45 }, style: { borderTopWidth: '1px', borderTopStyle: 'solid', paddingLeft: '16px' } }));
    expect(outlined?.componentType).toBe('button');
    const borderedNoPadding = classifyCandidate(aria('link', 'Consult Today'), facts({ box: { height: 45 }, style: { borderTopWidth: '1px', borderTopStyle: 'solid', paddingLeft: '0px' } }));
    expect(borderedNoPadding?.componentType).toBe('link');
    // A fill on a 100px-tall panel is not a button.
    const panel = classifyCandidate(aria('link', 'Panel'), facts({ box: { width: 100, height: 100 }, style: { backgroundColor: 'rgb(255, 255, 255)' } }));
    expect(panel?.componentType).not.toBe('button');
  });

  it('plain links are links, or nav-links inside a navigation', () => {
    expect(classifyCandidate(aria('link', 'Reports'), facts({ text: 'Reports' }))?.componentType).toBe('link');
    expect(classifyCandidate(aria('link', 'Reports'), facts({ text: 'Reports' }), { inNavigation: true })?.componentType).toBe('nav-link');
    // A wide 56px band link is still a link, not a card.
    expect(classifyCandidate(aria('link', 'Read More'), facts({ text: 'Read More', box: { width: 1016, height: 56 } }))?.componentType).toBe('link');
  });

  it('small square clickables with no text are icon buttons; large ones are cards', () => {
    const arrow = classifyCandidate(aria('generic', '', '[cursor=pointer]'), facts({ tag: 'div', text: '', hasSvg: true, box: { width: 40, height: 40 } }));
    expect(arrow).toMatchObject({ componentType: 'icon-button', confidence: 0.45, label: '(unlabelled icon-button generic)' });

    const card = classifyCandidate(
      aria('generic', '', '[cursor=pointer]'),
      facts({ tag: 'div', text: 'Aramex unlocked 20+ clients across 6 countries', hasImg: true, box: { width: 301, height: 344 } }),
    );
    expect(card).toMatchObject({ componentType: 'card', confidence: 0.6 });

    const imageCard = classifyCandidate(aria('link', 'Case study'), facts({ text: 'Case study', hasImg: true, box: { width: 128, height: 120 } }));
    expect(imageCard?.componentType).toBe('card');
  });

  it('an unknown clickable generic is a LOW-confidence button, and says the type was inferred', () => {
    const signIn = classifyCandidate(aria('generic', '', '[cursor=pointer]'), facts({ tag: 'div', text: 'Sign in', box: { width: 57, height: 20 } }));
    expect(signIn).toMatchObject({ componentType: 'button', confidence: 0.45, label: 'Sign in' });
    expect(signIn?.domSignals).toContain('clickable generic — type inferred');
  });

  it('native buttons stay buttons without a fill; role-attributed controls score 0.8', () => {
    expect(classifyCandidate(aria('button', 'Market Entry'), facts({ tag: 'button', text: 'Market Entry' }))).toMatchObject({ componentType: 'button', confidence: 0.9 });
    expect(classifyCandidate(aria('button', 'Menu'), facts({ tag: 'div', roleAttr: 'button', text: 'Menu' }))).toMatchObject({ componentType: 'button', confidence: 0.8 });
    expect(classifyCandidate(aria('tab', 'Agentic AI'), facts({ tag: 'button', roleAttr: 'tab', text: 'Agentic AI' }))).toMatchObject({ componentType: 'tabs', confidence: 0.8 });
  });

  it('form fields map by role (and tag) to the input taxonomy', () => {
    const field = (role: string, tag: string, over: Partial<Omit<DomFacts, 'style' | 'box'>> = {}) =>
      classifyCandidate(aria(role, 'Field'), facts({ tag, text: '', cursor: 'text', ...over }))?.componentType;
    expect(field('textbox', 'input')).toBe('input');
    expect(field('textbox', 'textarea')).toBe('textarea');
    expect(field('searchbox', 'input')).toBe('search');
    expect(field('combobox', 'select')).toBe('select');
    expect(field('checkbox', 'input')).toBe('checkbox');
    expect(field('radio', 'input')).toBe('radio');
    expect(field('spinbutton', 'input')).toBe('input');
    expect(classifyCandidate(aria('textbox', 'Full Name'), facts({ tag: 'input', text: '', cursor: 'text' }))?.confidence).toBe(0.9);

    // "Select Industry": a text field with a pointer cursor — the dropdown reading is stated, not acted on.
    const industry = classifyCandidate(aria('textbox', 'Select Industry', '[cursor=pointer]'), facts({ tag: 'input', text: '' }));
    expect(industry?.componentType).toBe('input');
    expect(industry?.domSignals).toContain('cursor:pointer on a text field — may be a dropdown trigger');
  });

  it('returns null for what is not a rendered component', () => {
    const link = aria('link', 'Hidden');
    expect(classifyCandidate(link, facts({ style: { display: 'none' } }))).toBeNull();
    expect(classifyCandidate(link, facts({ style: { visibility: 'hidden' } }))).toBeNull();
    expect(classifyCandidate(link, facts({ style: { opacity: '0' } }))).toBeNull();
    expect(classifyCandidate(link, facts({ box: { width: 0 } }))).toBeNull();
    expect(classifyCandidate(aria('paragraph', ''), facts({ tag: 'p', cursor: 'auto', text: 'Prose' }))).toBeNull();
    // An inherited pointer cursor (text inside a link) does not make an element a control of its own.
    expect(classifyCandidate(aria('paragraph', ''), facts({ tag: 'p', cursor: 'pointer', text: 'Inside a link' }))).toBeNull();
    expect(classifyCandidate(aria('heading', '', '[level=2]'), facts({ tag: 'h2', text: '' }))).toBeNull();
  });

  it('instanceGroupKey is type:tag:sha1(sorted classes) — identical instances share it', () => {
    const a = classifyCandidate(aria('link', 'One'), facts({ classes: ['btn', 'btn-primary', 'px-4'] }));
    const b = classifyCandidate(aria('link', 'Two'), facts({ classes: ['px-4', 'btn', 'btn-primary'] }));
    const c = classifyCandidate(aria('link', 'Three'), facts({ classes: ['btn', 'btn-secondary', 'px-4'] }));
    expect(a?.instanceGroupKey).toMatch(/^link:a:[0-9a-f]{10}$/);
    expect(a?.instanceGroupKey).toBe(b?.instanceGroupKey);
    expect(a?.instanceGroupKey).not.toBe(c?.instanceGroupKey);
  });

  it('labels from the aria name, else the text capped at 60 chars; at most 6 class signals', () => {
    const long = 'x'.repeat(80);
    const fromText = classifyCandidate(aria('link', ''), facts({ text: long }));
    expect(fromText?.label.length).toBe(60);
    const many = classifyCandidate(aria('link', 'Many'), facts({ classes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }));
    expect(many?.domSignals.filter((s) => s.startsWith('class='))).toHaveLength(6);
    expect(many?.domSignals.slice(0, 3)).toEqual(['role=link', 'tag=a', 'cursor=pointer']);
  });

  it('B-7: a combobox is a select only on <select>/<button>; on an <input> it is an autocomplete input', () => {
    const combo = (tag: string, over: Partial<Omit<DomFacts, 'style' | 'box'>> = {}) =>
      classifyCandidate(aria('combobox', 'Search reports'), facts({ tag, text: '', cursor: 'text', box: { width: 480, height: 44 }, ...over }));
    const input = combo('input');
    expect(input).toMatchObject({ componentType: 'input', confidence: 0.9 });
    expect(input?.domSignals).toContain('combobox on <input> — an autocomplete text field, not a native select');
    expect(combo('select')?.componentType).toBe('select');
    expect(combo('button', { roleAttr: 'combobox' })).toMatchObject({ componentType: 'select', confidence: 0.8 });
    expect(combo('div', { roleAttr: 'combobox' })).toMatchObject({ componentType: 'select', confidence: 0.45 });
  });

  it('B-8: headings doing another job are section headings only at LOW confidence, with the reason', () => {
    const real = (ref: string) => REAL.find((e) => e.ref === ref)!;
    const headingFacts = (el: AriaElement, cursor = 'auto') => facts({ tag: 'h2', cursor, text: el.name, box: el.box!, style: { fontSize: '16px' } });

    // A clickable FAQ question: the snapshot marks the h2 itself [cursor=pointer].
    const faq = classifyCandidate(real('e681'), headingFacts(real('e681'), 'pointer'));
    expect(faq).toMatchObject({ componentType: 'section-heading', confidence: 0.45 });
    expect(faq?.domSignals.some((s) => s.startsWith('clickable heading ([cursor=pointer])'))).toBe(true);

    // Footer office label and repeated resource-card title: the context comes from selection.
    const footer = selectCandidates(elementsOfSection(REAL, 'e712'), { viewportWidth: 1440, allElements: REAL }).candidates.find((c) => c.ref === 'e828')!;
    expect(classifyCandidate(footer, headingFacts(footer))).toMatchObject({ confidence: 0.45 });
    const resources = selectCandidates(elementsOfSection(REAL, 'e621'), { viewportWidth: 1440, allElements: REAL }).candidates;
    const cardTitle = resources.find((c) => c.ref === 'e651')!;
    const typedTitle = classifyCandidate(cardTitle, headingFacts(cardTitle));
    expect(typedTitle).toMatchObject({ componentType: 'section-heading', confidence: 0.45 });
    // Three identical blocks: e639's title (e640) is a YAML-quoted snapshot line, read since the parser fix.
    expect(typedTitle?.domSignals.some((s) => s.startsWith('titles e650, one of 3 identical sibling blocks (e639, e661)'))).toBe(true);

    // A heading inheriting cursor:pointer (no marker of its own) sits inside a clickable.
    const inherited = classifyCandidate(aria('heading', 'Aramex', '[level=3]'), facts({ tag: 'h3', cursor: 'pointer', text: 'Aramex' }));
    expect(inherited?.confidence).toBe(0.45);

    // An unambiguous section heading keeps 0.9 — through selection too.
    const band = resources.find((c) => c.ref === 'e622')!;
    expect(classifyCandidate(band, headingFacts(band))).toMatchObject({ componentType: 'section-heading', confidence: 0.9 });
    const howWeHelp = selectCandidates(elementsOfSection(REAL, 'e171'), { viewportWidth: 1440, allElements: REAL }).candidates.find((c) => c.ref === 'e172')!;
    expect(classifyCandidate(howWeHelp, headingFacts(howWeHelp))?.confidence).toBe(0.9);
  });

  it('B-9: a visually hidden (sr-only, ≤ 2px) control is not a rendered component', () => {
    expect(classifyCandidate(aria('link', 'Skip to content'), facts({ text: 'Skip to content', box: { width: 1, height: 1 }, style: { display: 'block' } }))).toBeNull();
    expect(classifyCandidate(aria('link', 'Tiny'), facts({ text: 'Tiny', box: { width: 120, height: 2 } }))).toBeNull();
  });

  it('an empty clickable (no text, no children) is typed only at LOW confidence — it is a transparent overlay', () => {
    const overlay = classifyCandidate(aria('link', ''), facts({ text: '', childElementCount: 0, box: { width: 301, height: 280 } }));
    expect(overlay).toMatchObject({ componentType: 'card', confidence: 0.45 });
    expect(overlay?.domSignals.some((s) => s.startsWith('empty clickable (no text, no child elements)'))).toBe(true);
  });

  it('only ever emits taxonomy values', () => {
    const outputs = [
      classifyCandidate(aria('heading', 'H', '[level=2]'), facts({ tag: 'h2', text: 'H' })),
      classifyCandidate(aria('tab', 'T'), facts({ tag: 'button', roleAttr: 'tab' })),
      classifyCandidate(aria('switch', 'S'), facts({ tag: 'button', roleAttr: 'switch' })),
      classifyCandidate(aria('slider', 'S'), facts({ tag: 'input' })),
      classifyCandidate(aria('generic', '', '[cursor=pointer]'), facts({ tag: 'span', text: 'x' })),
    ];
    for (const out of outputs) expect(COMPONENT_TYPES as readonly string[]).toContain(out?.componentType);
  });
});
