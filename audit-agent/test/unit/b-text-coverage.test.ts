import { describe, expect, it } from 'vitest';
import { classifyCandidate, isTextCandidateShape, selectCandidates } from '../../src/agents/b2-component-detector/deterministic.ts';
import type { DomFacts } from '../../src/agents/b2-component-detector/deterministic.ts';
import { checkFoundationRules, textFoundationChecked, textInkOf, type FoundationContext } from '../../src/agents/b4-compliance-auditor/foundation-rules.ts';
import { routesToNewComponentEvaluator } from '../../src/skills/s8-confidence-escalation-policy.ts';
import type { AriaElement } from '../../src/t-layer/element-registry.ts';
import type { ExtractedStyle } from '../../src/t-layer/computed-style.ts';

/**
 * Body text and stat numerals were never audited: B2 offered only headings, controls, pointer
 * elements and small badge-shaped leaves, so a plain `<p>` never reached B3/B4 and no foundation
 * rule ever ran on it (brand-perception-survey: the supporting paragraph, the red-gradient stats
 * and 100+ other text leaves). These tests pin the three halves of the fix: B2 offers the text,
 * B3/S8 never sends it to B6, B4's foundation rules measure its colour.
 */

type Box = { x: number; y: number; width: number; height: number };
const el = (ref: string, role: string, text: string, box: Box, parentRef: string | null = null, extra = ''): AriaElement => ({
  ref, role, name: '', depth: 1, parentRef, box,
  line: `- ${role} [ref=${ref}] ${extra}[box=${box.x},${box.y},${box.width},${box.height}]${text ? `: ${text}` : ''}`,
});

function facts(text: string, style: Partial<DomFacts['style']> = {}): DomFacts {
  return {
    tag: 'p', classes: [], roleAttr: null, cursor: 'auto', text, hasSvg: false, hasImg: false, ownText: true, childElementCount: 0,
    style: {
      backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', borderTopWidth: '0px', borderTopStyle: 'none', paddingLeft: '0px', paddingTop: '0px',
      color: 'rgb(10, 10, 10)', fontSize: '16px', fontWeight: '400', display: 'block', opacity: '1', visibility: 'visible', textTransform: 'none', letterSpacing: 'normal',
      ...style,
    },
    box: { x: 0, y: 0, width: 243, height: 40 },
  };
}

describe('B2 offers body text', () => {
  it('a <p> (paragraph role) is a text candidate, with or without inline children', () => {
    const p = el('e1', 'paragraph', 'Use real feedback', { x: 0, y: 0, width: 784, height: 68 });
    expect(isTextCandidateShape(p, new Set())).toBe(true);
    expect(isTextCandidateShape(p, new Set(['e1']))).toBe(true);
  });

  it('a childless generic or list-item leaf with text is; a container, or a leaf with no text, is not', () => {
    expect(isTextCandidateShape(el('e2', 'generic', 'Market demand', { x: 0, y: 0, width: 90, height: 20 }), new Set())).toBe(true);
    expect(isTextCandidateShape(el('e3', 'listitem', 'Price', { x: 0, y: 0, width: 90, height: 20 }), new Set())).toBe(true);
    expect(isTextCandidateShape(el('e4', 'generic', 'wrapper', { x: 0, y: 0, width: 90, height: 20 }), new Set(['e4']))).toBe(false);
    expect(isTextCandidateShape(el('e5', 'generic', '', { x: 0, y: 0, width: 90, height: 20 }), new Set())).toBe(false);
  });

  it('is selected by selectCandidates; the words inside a heading or a control-sized button are not (they belong to that element)', () => {
    const heading = el('h', 'heading', 'Title', { x: 0, y: 0, width: 300, height: 40 });
    const inHeading = el('hs', 'generic', 'Title', { x: 0, y: 0, width: 300, height: 40 }, 'h');
    const button = el('b', 'button', '', { x: 0, y: 100, width: 120, height: 40 });
    const inButton = el('bs', 'generic', 'Go', { x: 10, y: 105, width: 40, height: 20 }, 'b');
    const para = el('p', 'paragraph', 'Supporting copy', { x: 0, y: 200, width: 400, height: 40 });
    const { candidates } = selectCandidates([heading, inHeading, button, inButton, para], { viewportWidth: 1440 });
    const refs = candidates.map((c) => c.ref);
    expect(refs).toContain('p');
    expect(refs).toContain('h');
    expect(refs).not.toContain('bs'); // not even badge-shaped (a control-sized button's label)
    // A badge-sized leaf inside a heading can still reach classification (the older badge path), but
    // with no border or fill it must NOT come back as body text — the heading owns those words.
    const hs = candidates.find((c) => c.ref === 'hs');
    if (hs) expect(classifyCandidate(hs, facts('Title'))).toBeNull();
  });

  it('a paragraph inside a card-scale clickable (a card link, an accordion row) IS audited — it is body text in its own right', () => {
    const card = el('c', 'link', '', { x: 0, y: 0, width: 400, height: 300 });
    const desc = el('d', 'paragraph', 'Card description', { x: 10, y: 150, width: 380, height: 40 }, 'c');
    const { candidates } = selectCandidates([card, desc], { viewportWidth: 1440 });
    expect(candidates.map((c) => c.ref)).toContain('d');
  });

  it('classifies a bare display-size numeral as stat, any other text as paragraph, and never a bordered/filled one (that is a badge)', () => {
    const p = el('e1', 'paragraph', '250000+', { x: 0, y: 0, width: 243, height: 40 });
    expect(classifyCandidate(p, facts('250000+', { fontSize: '36px' }))?.componentType).toBe('stat');
    expect(classifyCandidate(p, facts('250000+', { fontSize: '14px' }))?.componentType).toBe('paragraph'); // small numeral: a label, not a stat
    expect(classifyCandidate(p, facts('Respondents Engaged Across 50+ Markets', { fontSize: '36px' }))?.componentType).toBe('paragraph');
    expect(classifyCandidate(p, facts('Step 01', { borderTopWidth: '1px', borderTopStyle: 'solid' }))?.componentType).toBe('badge');
  });
});

describe('S8 routing — body text is never a new-component question', () => {
  it('a foundation-only match with no DS component does not route to B6; an ordinary unmatched one still does', () => {
    expect(routesToNewComponentEvaluator({ dsComponent: null, confidence: 0.6, foundationOnly: true })).toBe(false);
    expect(routesToNewComponentEvaluator({ dsComponent: null, confidence: 0 })).toBe(true);
  });
});

describe('B4 foundation rules on body text and stat numerals', () => {
  const raw = (o: Record<string, string>): Extract<ExtractedStyle, { connected: true }> => ({ connected: true, raw: { 'font-size': '16px', 'font-family': 'DM Sans', ...o }, rootFontSizePx: 16, box: { width: 200, height: 40 } });
  const ctx: FoundationContext = {
    tokens: new Map(),
    ruleTitles: new Map([['R1.1', '92-5-3 Color Hierarchy'], ['R1.2', 'Brand Red is for CTAs ONLY'], ['R1.3', 'Major Third Typography'], ['R1.4', 'Two-Font Pairing']]),
    sansFamilies: new Set(['dm sans']), serifFamilies: new Set(['noto serif']),
    textSizesPx: [16, 36], radiiPx: [], spacingPx: [], brandRed: 'rgb(176, 31, 36)',
    palette: [{ token: '--black-900', value: '#0a0a0a' }, { token: '--color-ramp-black-700', value: '#404040' }, { token: '--white', value: '#ffffff' }],
  };
  const check = (type: string, style: ReturnType<typeof raw>) => checkFoundationRules({ componentType: type, headingLevel: null, hasText: true, style, ctx });

  it('reads a gradient-clipped numeral by its real ink — the transparent `color` is not the colour', () => {
    const style = raw({ color: 'rgba(0, 0, 0, 0)', 'background-clip': 'text', 'background-image': 'linear-gradient(109.59deg, rgb(176, 31, 36) 20%, rgb(253, 203, 205) 100%)' });
    expect(textInkOf(style)).toEqual(['rgb(176, 31, 36)', 'rgb(253, 203, 205)']);
  });

  it('R1.2: a stat painted with a brand-red gradient is CRITICAL; the same stat in a DS ink is clean', () => {
    const red = check('stat', raw({ color: 'rgba(0, 0, 0, 0)', 'background-clip': 'text', 'background-image': 'linear-gradient(90deg, rgb(176, 31, 36), rgb(253, 203, 205))' }));
    expect(red.find((v) => v.ruleId === 'R1.2')?.severity).toBe('CRITICAL');
    expect(check('stat', raw({ color: 'rgb(10, 10, 10)' }))).toEqual([]);
  });

  it('R1.1: body text in a colour that is not a DS colour is cited with the nearest DS token; a DS colour is not', () => {
    const off = check('paragraph', raw({ color: 'rgb(70, 68, 73)' })).find((v) => v.ruleId === 'R1.1');
    expect(off?.actual).toBe('rgb(70, 68, 73)');
    expect(off?.expected).toContain('--color-ramp-black-700');
    expect(check('paragraph', raw({ color: 'rgb(64, 64, 64)' }))).toEqual([]);
  });

  it('the colour rules apply to body text and stats only — a button\'s own colour is never second-guessed by R1.1', () => {
    expect(check('button', raw({ color: 'rgb(70, 68, 73)' })).some((v) => v.ruleId === 'R1.1')).toBe(false);
  });

  it('records which foundation properties a clean result verified, and none for other types', () => {
    const style = raw({ color: 'rgb(10, 10, 10)' });
    expect(textFoundationChecked({ componentType: 'paragraph', hasText: true, style, ctx })).toEqual(['font-family', 'font-size', 'color']);
    expect(textFoundationChecked({ componentType: 'button', hasText: true, style, ctx })).toEqual([]);
  });
});
