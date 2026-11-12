import { describe, expect, it } from 'vitest';
import { classifyCandidate, isBadgeCandidateShape, selectCandidates } from '../../src/agents/b2-component-detector/deterministic.ts';
import type { DomFacts } from '../../src/agents/b2-component-detector/deterministic.ts';
import type { AriaElement } from '../../src/t-layer/element-registry.ts';

/**
 * B2's badge/tag/chip detection — the fix for the reported gap: a non-interactive, non-heading
 * styled element ("Phase 01", a status pill) was previously invisible to the ENTIRE pipeline, not
 * merely unmeasured. `isCandidateShape` alone never selected it ("neither a heading, a form field
 * nor clickable" was the end of B2's reach); `isBadgeCandidateShape` + `badgeSignal` (inside
 * `classifyCandidate`) extend it.
 *
 * A generic element's accessible NAME is empty by definition — Playwright's ai-mode snapshot shows
 * its rendered text as a trailing `]: <text>` annotation on the LINE instead (confirmed live
 * against the real page: `generic [ref=e234] [box=299,3170,57,28]: Phase 1`, `name: ""`). Every
 * fixture here reproduces that exact shape — never `el.name` — because reading `el.name` for this
 * was the bug caught live (0 badges detected end-to-end with that version).
 */

function badgeEl(ref: string, text: string, box: { x: number; y: number; width: number; height: number }, parentRef: string | null = 'ewrap'): AriaElement {
  return { ref, role: 'generic', name: '', line: `- generic [ref=${ref}] [box=${box.x},${box.y},${box.width},${box.height}]: ${text}`, depth: 2, parentRef, box };
}

function facts(over: Partial<Omit<DomFacts, 'style' | 'box'>> & { style?: Partial<DomFacts['style']>; box?: Partial<DomFacts['box']> } = {}): DomFacts {
  const { style, box, ...rest } = over;
  return {
    tag: 'div',
    classes: [],
    roleAttr: null,
    cursor: 'auto',
    text: 'Phase 01',
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
      paddingLeft: '8px',
      paddingTop: '4px',
      color: 'rgb(87, 62, 105)',
      fontSize: '12px',
      fontWeight: '400',
      display: 'block',
      opacity: '1',
      visibility: 'visible',
      textTransform: 'none',
      letterSpacing: 'normal',
      ...style,
    },
    box: { x: 299, y: 3170, width: 57, height: 28, ...box },
  };
}

describe('isBadgeCandidateShape — the selection-stage gate (cheap, snapshot-only)', () => {
  it('a small, childless, text-bearing generic leaf is a candidate — "Phase 01", 57×28px', () => {
    const el = badgeEl('e234', 'Phase 1', { x: 299, y: 3170, width: 57, height: 28 });
    expect(isBadgeCandidateShape(el, new Set())).toBe(true);
  });

  it('a heading/link/button/field role is already handled by isCandidateShape — never double-selected', () => {
    const heading: AriaElement = { ref: 'e1', role: 'heading', name: 'Title', line: '- heading "Title" [ref=e1] [box=0,0,100,20]', depth: 1, parentRef: null, box: { x: 0, y: 0, width: 100, height: 20 } };
    expect(isBadgeCandidateShape(heading, new Set())).toBe(false);
  });

  it('a container (has children) is not a leaf — its children are the real candidates, not it', () => {
    const el = badgeEl('e231', 'Phase 1 Plan & Align', { x: 280, y: 3150, width: 200, height: 120 });
    expect(isBadgeCandidateShape(el, new Set(['e231']))).toBe(false);
  });

  it('a generic leaf with NO trailing text is not a badge candidate — nothing a reviewer could recognise', () => {
    const el: AriaElement = { ref: 'e9', role: 'generic', name: '', line: '- generic [ref=e9] [box=0,0,24,24]', depth: 1, parentRef: null, box: { x: 0, y: 0, width: 24, height: 24 } };
    expect(isBadgeCandidateShape(el, new Set())).toBe(false);
  });

  it('too large (beyond pill/chip size) is not badge-shaped — a big block is a different check (B5 repeated-block)', () => {
    const el = badgeEl('e1', 'A whole paragraph of text', { x: 0, y: 0, width: 500, height: 200 });
    expect(isBadgeCandidateShape(el, new Set())).toBe(false);
  });

  it('[cursor=pointer] is a real control, not a badge — isCandidateShape already owns it', () => {
    const el: AriaElement = { ref: 'e1', role: 'generic', name: '', line: '- generic [ref=e1] [cursor=pointer] [box=0,0,60,24]: Click me', depth: 1, parentRef: null, box: { x: 0, y: 0, width: 60, height: 24 } };
    expect(isBadgeCandidateShape(el, new Set())).toBe(false);
  });
});

describe('classifyCandidate badge confirmation — real computed style decides, never size/text alone', () => {
  it('REGRESSION 1: the exact reported shape — bordered + filled, 6px radius, brand-red border — classifies as badge', () => {
    const el = badgeEl('e234', 'Phase 1', { x: 299, y: 3170, width: 57, height: 28 });
    const result = classifyCandidate(el, facts({ style: { borderTopWidth: '1px', borderTopStyle: 'solid', backgroundColor: 'rgba(176, 31, 36, 0.1)' } }));
    expect(result?.componentType).toBe('badge');
    expect(result?.confidence).toBeLessThan(0.5); // LOW band — a structural inference, routed to review
    expect(result?.label).toBe('Phase 01'); // the REAL text (facts.text), never the empty accessible name
  });

  it('a structural type is marked as such — B3 may claim the badge family although the confidence is LOW (no role backs it)', () => {
    const el = badgeEl('e234', 'Phase 1', { x: 299, y: 3170, width: 57, height: 28 });
    const result = classifyCandidate(el, facts({ style: { borderTopWidth: '1px', borderTopStyle: 'solid', backgroundColor: 'rgba(176, 31, 36, 0.1)' } }));
    expect(result?.structural).toBe(true);
    // a heading or a clickable carries a ROLE, so it is never structural
    const heading: AriaElement = { ref: 'e5', role: 'heading', name: 'Title', line: '- heading "Title" [level=2] [ref=e5] [box=0,0,300,40]', depth: 1, parentRef: null, box: { x: 0, y: 0, width: 300, height: 40 } };
    expect(classifyCandidate(heading, facts({ tag: 'h2', text: 'Title', box: { width: 300, height: 40 } }))?.structural).toBeUndefined();
  });

  it('a border alone (no fill) is still a badge', () => {
    const el = badgeEl('e1', 'New', { x: 0, y: 0, width: 40, height: 20 });
    const result = classifyCandidate(el, facts({ text: 'New', style: { borderTopWidth: '1px', borderTopStyle: 'solid', backgroundColor: 'rgba(0, 0, 0, 0)' } }));
    expect(result?.componentType).toBe('badge');
  });

  it('a fill alone (no border) is still a badge', () => {
    const el = badgeEl('e1', 'Sale', { x: 0, y: 0, width: 40, height: 20 });
    const result = classifyCandidate(el, facts({ text: 'Sale', style: { borderTopWidth: '0px', borderTopStyle: 'none', backgroundColor: 'rgb(237, 179, 38)' } }));
    expect(result?.componentType).toBe('badge');
  });

  it('a plain text leaf with NEITHER border NOR fill is never a badge — "Company" (a plain label) is body text, not guessed into a pill', () => {
    const el = badgeEl('e9', 'Company', { x: 217, y: 10, width: 74, height: 20 });
    const result = classifyCandidate(el, facts({ text: 'Company', style: { borderTopWidth: '0px', borderTopStyle: 'none', backgroundColor: 'rgba(0, 0, 0, 0)' } }));
    expect(result?.componentType).toBe('paragraph'); // engine r3: plain text is audited as body text, never as a badge
  });
});

describe('selectCandidates end to end — the full selection pipeline picks up badge-shaped elements', () => {
  it('a badge-shaped generic leaf reaches the candidates list, a plain one of the same size does not', () => {
    const badge = badgeEl('e1', 'Phase 1', { x: 0, y: 0, width: 57, height: 28 });
    const plain = badgeEl('e2', 'Company', { x: 200, y: 0, width: 74, height: 20 });
    const { candidates } = selectCandidates([badge, plain], { viewportWidth: 1440 });
    expect(candidates.map((c) => c.ref)).toEqual(expect.arrayContaining(['e1', 'e2']));
    // Both are CANDIDATES (worth a style check) — classification (badge vs. rejected) is
    // decideType's job, covered above, not selectCandidates'.
  });
});


// ── The repeated non-interactive block (the testimonial-card shape) — B5 asks B2 to classify it ──────
// B5's completeness pass finds the candidates (several same-size, card-scale siblings); WHETHER such a
// block is a card is B2's call, from its own computed style: a card has a visible SURFACE. Without
// one it is a layout column — nothing painted, nothing to audit — and B2 says so (null) instead of
// guessing a card into existence.

describe('classifyCandidate { repeatedBlock } — a surfaced repeated block is a card; a bare one is a layout column', () => {
  const block = (ref = 'e1'): AriaElement => ({ ref, role: 'generic', name: '', line: `- generic [ref=${ref}] [box=0,0,320,200]: Great work from the team`, depth: 2, parentRef: 'ewrap', box: { x: 0, y: 0, width: 320, height: 200 } });
  const blockFacts = (style: Partial<DomFacts['style']> = {}) => facts({ text: 'Great work from the team', childElementCount: 0, box: { width: 320, height: 200 }, style });

  it('a block with a border is a card — structural, LOW confidence, labelled by its own text (not "(unlabelled card)")', () => {
    const result = classifyCandidate(block(), blockFacts({ borderTopWidth: '1px', borderTopStyle: 'solid' }), { repeatedBlock: true });
    expect(result?.componentType).toBe('card');
    expect(result?.structural).toBe(true);
    expect(result?.confidence).toBeLessThan(0.5);
    expect(result?.label).toBe('Great work from the team');
    expect(result?.domSignals.join(' ')).toContain('card surface (border)');
  });

  it('a fill, a background image or a shadow alone is a surface too', () => {
    expect(classifyCandidate(block(), blockFacts({ backgroundColor: 'rgb(245, 242, 241)' }), { repeatedBlock: true })?.componentType).toBe('card');
    expect(classifyCandidate(block(), blockFacts({ backgroundImage: 'linear-gradient(red, blue)' }), { repeatedBlock: true })?.componentType).toBe('card');
    expect(classifyCandidate(block(), blockFacts({ boxShadow: '0px 4px 16px rgba(0, 0, 0, 0.1)' }), { repeatedBlock: true })?.componentType).toBe('card');
  });

  it('a block with NO surface — transparent, no border, no image, no shadow — is a layout column: not a card, not guessed', () => {
    expect(classifyCandidate(block(), blockFacts({ boxShadow: 'none' }), { repeatedBlock: true })).toBeNull();
  });

  it('a block below card scale is never a card, whatever its surface', () => {
    const small = classifyCandidate(block(), facts({ box: { width: 100, height: 100 }, style: { borderTopWidth: '1px', borderTopStyle: 'solid' } }), { repeatedBlock: true });
    expect(small).toBeNull();
  });

  it('without the flag the same element is judged as B2 always judged it — a badge candidate has no business being card-sized, and a bare block is nothing', () => {
    const asBadge = classifyCandidate(block(), blockFacts({ borderTopWidth: '1px', borderTopStyle: 'solid' }));
    expect(asBadge?.componentType).toBe('badge'); // the flag, not the size, is what makes B5's block a card
    expect(classifyCandidate(block(), blockFacts())?.componentType).toBe('paragraph'); // a bare block of text is body text (engine r3), never a badge or a card
  });
});
