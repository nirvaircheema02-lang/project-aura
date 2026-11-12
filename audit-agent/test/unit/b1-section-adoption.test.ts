import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deterministicSections, type DeterministicSection } from '../../src/agents/b1-page-analyzer/deterministic.ts';
import { selectCandidates } from '../../src/agents/b2-component-detector/deterministic.ts';
import { sectionElements } from '../../src/agents/b2-component-detector/index.ts';
import { parseAriaSnapshot } from '../../src/t-layer/element-registry.ts';
import type { SectionInfo } from '../../src/agents/types.ts';
import type { AriaElement } from '../../src/t-layer/element-registry.ts';

/**
 * B1 section bounds. A section's band is its root element's own box. A `position: sticky` scroll
 * stage is a viewport-sized pinned WINDOW (here 900px) over an `overflow: hidden` list that is
 * taller than the window (1184px): the list's later rows lie beyond the stage's box — in the real
 * audit of a "Our Differentiators" block, "Multi-Channel Data Collection" and "Ongoing Support &
 * Consultation" (y 4590 and 4726, below the stage's 4498 bottom) were "outside every section's
 * y-range … never offered to B2" and so never audited. B1 owns section MEMBERSHIP, so B1 now
 * assigns such content to the section whose DOM subtree holds it (`adoptedRefs`); B2 only honours
 * that list. The snapshot below is that real layout (refs and boxes from the live capture).
 */

const STICKY_STAGE = [
  '- generic [ref=e1] [box=0,0,1440,16596]:',
  '  - banner [ref=e2] [box=0,0,1440,100]:',
  '    - link "Home" [ref=e3] [cursor=pointer] [box=20,30,80,30]',
  '  - generic [ref=e65] [box=0,100,1440,15460]:',
  '    - generic [ref=e66] [box=0,100,1440,3498]:',
  '      - heading "Reach anyone. Anywhere." [level=1] [ref=e67] [box=160,200,800,60]',
  '      - link "Start" [ref=e68] [cursor=pointer] [box=160,600,200,48]',
  '    - generic [ref=e260] [box=120,3598,1200,900]:',
  '      - heading "Our Differentiators" [level=2] [ref=e261] [box=160,3640,528,48]',
  '      - link "Discuss Scope" [ref=e262] [cursor=pointer] [box=160,4400,180,46]',
  '      - generic [ref=e274] [box=752,3598,528,1184]:',
  '        - generic [ref=e275] [box=792,3710,448,120]:',
  '          - heading "Industry-Specific Insights" [level=3] [ref=e277] [box=792,3754,448,28]',
  '        - generic [ref=e287] [box=792,4118,448,120]:',
  '          - heading "Customizable Surveys" [level=3] [ref=e289] [box=792,4162,448,28]',
  '        - generic [ref=e299] [box=792,4526,448,120]:',
  '          - heading "Multi-Channel Data Collection" [level=3] [ref=e301] [box=792,4570,448,28]',
  '        - generic [ref=e303] [box=792,4662,448,120]:',
  '          - heading "Ongoing Support & Consultation" [level=3] [ref=e305] [box=792,4706,448,28]',
  '    - generic [ref=e400] [box=0,11698,1440,900]:',
  '      - heading "What Our Clients Say" [level=2] [ref=e401] [box=136,11700,320,48]',
  '      - link "More" [ref=e402] [cursor=pointer] [box=136,12000,100,40]',
  '  - contentinfo [ref=e500] [box=0,15560,1440,1036]',
].join('\n');

const PAGE = { pageHeight: 16596, viewportWidth: 1440 };

/** B1's output → the SectionInfo B2 receives (what B1's index builds), so B2's own `sectionElements` can be exercised. */
function infoOf(section: DeterministicSection, elements: AriaElement[], i: number): SectionInfo {
  return {
    id: `s${i}`,
    name: section.name,
    kind: section.kind,
    rootRef: section.rootRef,
    personalized: section.personalized,
    isListing: section.isListing,
    note: section.note,
    box: elements.find((e) => e.ref === section.rootRef)?.box,
    ...(section.adoptedRefs ? { adoptedRefs: section.adoptedRefs } : {}),
  };
}

describe('B1 adopts content its section owns but renders outside the section\'s own y-range', () => {
  const els = parseAriaSnapshot(STICKY_STAGE);
  const sections = deterministicSections(els, PAGE);
  const stage = sections.find((s) => s.rootRef === 'e260')!;

  it('the stage is the band (its 900px window), exactly as in the real capture — the list overflows it', () => {
    expect(sections.map((s) => s.rootRef)).toEqual(['e2', 'e66', 'e260', 'e400', 'e500']);
    const box = els.find((e) => e.ref === 'e260')!.box!;
    expect(box.y + box.height).toBe(4498); // the later rows (y 4570 / 4706) lie below this
  });

  it('assigns the two later-row headings to the stage that owns them, by DOM ancestry', () => {
    expect(stage.adoptedRefs).toEqual(['e301', 'e305']);
  });

  it('says so in the section note — and no longer calls them "never offered to B2"', () => {
    expect(stage.note).toContain('2 element(s) lie outside this section\'s y-range but inside its own subtree');
    expect(stage.note).toContain('e301 heading "Multi-Channel Data Collection"');
    expect(stage.note).toContain('offered to B2 with it');
    expect(sections.some((s) => s.note.includes('never offered to B2'))).toBe(false);
  });

  it('B2 is offered exactly what B1 assigned: the adopted headings join the y-range\'s own elements, and are real candidates', () => {
    const info = infoOf(stage, els, 2);
    const offered = sectionElements(els, info).map((e) => e.ref);
    expect(offered).toEqual(expect.arrayContaining(['e301', 'e305', 'e277', 'e289', 'e261', 'e262']));
    const { candidates } = selectCandidates(sectionElements(els, info), { viewportWidth: 1440, allElements: els });
    const headings = candidates.filter((c) => c.role === 'heading').map((c) => c.name);
    expect(headings).toEqual(expect.arrayContaining(['Industry-Specific Insights', 'Customizable Surveys', 'Multi-Channel Data Collection', 'Ongoing Support & Consultation']));
  });

  it('without the adoption B2 would never see them — the exact gap this closes', () => {
    const info = { ...infoOf(stage, els, 2) };
    delete info.adoptedRefs;
    const offered = sectionElements(els, info).map((e) => e.ref);
    expect(offered).not.toContain('e301');
    expect(offered).not.toContain('e305');
  });

  it('no other section claims or duplicates them', () => {
    const owners = sections.filter((s) => s.adoptedRefs?.includes('e301'));
    expect(owners.map((s) => s.rootRef)).toEqual(['e260']);
  });
});

describe('adoption is by ownership only — never a guess by distance', () => {
  it('an element another section\'s y-range already covers is that section\'s to offer: the owner does not adopt it (no double claim)', () => {
    // A descendant of the stage that a transform has moved into the NEXT section's y-range (e400: y 11698..12598).
    const els = parseAriaSnapshot(
      STICKY_STAGE.replace(
        '        - generic [ref=e303] [box=792,4662,448,120]:',
        ['        - heading "Floating" [level=3] [ref=e310] [box=792,11800,448,28]', '        - generic [ref=e303] [box=792,4662,448,120]:'].join('\n'),
      ),
    );
    const sections = deterministicSections(els, PAGE);
    expect(sections.find((s) => s.rootRef === 'e260')?.adoptedRefs).toEqual(['e301', 'e305']); // e310 is NOT adopted
    expect(sections.flatMap((s) => s.adoptedRefs ?? [])).not.toContain('e310');
    // The existing, stated rule still applies to it: the section whose y-range covers it offers it, and says so.
    expect(sections.find((s) => s.rootRef === 'e400')?.note).toContain('controls of section e260');
  });

  it('a stray top-level element no band covers is promoted to its own section by the existing rescue step — not squeezed into a neighbour', () => {
    const els = parseAriaSnapshot(
      STICKY_STAGE.replace(
        '    - generic [ref=e400] [box=0,11698,1440,900]:',
        ['    - heading "Stray heading" [level=2] [ref=e450] [box=160,8000,400,40]', '    - generic [ref=e400] [box=0,11698,1440,900]:'].join('\n'),
      ),
    );
    const sections = deterministicSections(els, PAGE);
    expect(sections.flatMap((s) => s.adoptedRefs ?? [])).not.toContain('e450');
    expect(sections.map((s) => s.rootRef)).toContain('e450');
  });

  it('elements a y-range already covers are not "adopted" — nothing changes for an ordinary page', () => {
    const real = parseAriaSnapshot(readFileSync(new URL('../fixtures/real/market-entry-aria.txt', import.meta.url), 'utf-8'));
    const sections = deterministicSections(real, { pageHeight: 9516, viewportWidth: 1440 });
    expect(sections.filter((s) => s.adoptedRefs && s.adoptedRefs.length > 0)).toEqual([]);
  });
});
