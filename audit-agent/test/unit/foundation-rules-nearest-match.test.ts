import { describe, expect, it } from 'vitest';
import { checkFoundationRules, type FoundationContext } from '../../src/agents/b4-compliance-auditor/foundation-rules.ts';
import { filterFoundationViolations } from '../../src/agents/b4-compliance-auditor/index.ts';
import type { ExtractedStyle } from '../../src/t-layer/computed-style.ts';
import type { Mismatch } from '../../src/skills/s0-result-contract.ts';

/**
 * The nearest-match rule, generalized beyond typography: R1.3 (type scale), R3.5 (spacing scale)
 * and R3.6 (radius scale) all share ONE mechanism (nearestStep → pickNearestSize,
 * src/skills/nearest-typography.ts) — a measured value that is not a step of the relevant DS scale
 * is cited with the single NEAREST step as `expected`, never a generic "use a DS token" and never a
 * value borrowed from a different property's token family. A hand-built FoundationContext is used
 * throughout (not the live DS registry) so every test is exact, deterministic and independent of
 * whatever values the real Design System happens to contain today.
 */

const connected = (raw: Record<string, string>, box: { width: number; height: number } | null = { width: 200, height: 80 }): Extract<ExtractedStyle, { connected: true }> => ({
  connected: true,
  raw,
  rootFontSizePx: 16,
  box,
});

const ctx = (overrides: Partial<FoundationContext> = {}): FoundationContext => ({
  tokens: new Map(),
  ruleTitles: new Map([
    ['R1.2', 'Brand Red is for CTAs ONLY'],
    ['R1.3', 'Major Third Typography'],
    ['R3.5', 'Spacing Scale Discipline'],
    ['R3.6', 'Border Radius Decision Table'],
  ]),
  sansFamilies: new Set(),
  serifFamilies: new Set(),
  textSizesPx: [16, 18, 20, 24, 31.25, 32, 39.06, 40, 48],
  radiiPx: [0, 2.5, 5, 10, 15, 20],
  spacingPx: [4, 8, 12, 16, 24, 32, 48, 64, 96, 128],
  brandRed: null,
  ...overrides,
});

const run = (style: Extract<ExtractedStyle, { connected: true }>, c: FoundationContext, ruleId?: string) => {
  // hasText:true so R1.3 (inside the hasText branch) is exercised too; R3.5/R3.6 run unconditionally.
  const all = checkFoundationRules({ componentType: 'generic', headingLevel: null, hasText: true, style, ctx: c });
  return ruleId ? all.filter((v) => v.ruleId === ruleId) : all;
};

const runAs = (componentType: string, style: Extract<ExtractedStyle, { connected: true }>, c: FoundationContext, ruleId?: string) => {
  const all = checkFoundationRules({ componentType, headingLevel: null, hasText: true, style, ctx: c });
  return ruleId ? all.filter((v) => v.ruleId === ruleId) : all;
};

const BRAND_RED = 'rgb(176, 31, 36)'; // --brand-red #b01f24

describe('1. typography: the same mechanism this whole feature started from', () => {
  it('32px with DS steps 31.25px and 39.06px available → 31.25px, not 39.06px (R1.3, the font-size scale check)', () => {
    const [v] = run(connected({ 'font-size': '32px', 'font-family': "'DM Sans'" }, null), ctx({ textSizesPx: [31.25, 39.06] }), 'R1.3');
    expect(v?.expected).toBe('31.25px');
    expect(v?.actual).toBe('32px');
  });
});

describe('2/3. radius: nearest valid DS token, dynamically — never a generic "use a DS token"', () => {
  it('6px radius → 5px (never the generic message)', () => {
    const [v] = run(connected({ 'border-top-left-radius': '6px' }), ctx(), 'R3.6');
    expect(v).toBeDefined();
    expect(v?.expected).toBe('5px');
    expect(v?.expected).not.toBe('a DS radius token');
    expect(v?.why).toContain('nearest: 5px, 1px away');
  });

  it('a DIFFERENT actual value resolves to a DIFFERENT nearest step — 7px radius, with 8px on the scale, → 8px (not 5px)', () => {
    const [v] = run(connected({ 'border-top-left-radius': '7px' }), ctx({ radiiPx: [0, 2.5, 5, 8, 10, 15, 20] }), 'R3.6');
    expect(v?.expected).toBe('8px');
    expect(v?.why).toContain('nearest: 8px, 1px away');
  });

  it('a radius already on the scale (or within the 0.5px comparator tolerance) is no violation at all', () => {
    expect(run(connected({ 'border-top-left-radius': '5px' }), ctx(), 'R3.6')).toEqual([]);
    expect(run(connected({ 'border-top-left-radius': '5.3px' }), ctx(), 'R3.6')).toEqual([]);
  });
});

describe('4. spacing: nearest valid DS spacing token — the same mechanism, a different token family', () => {
  it('padding 19px chooses the nearest spacing step (16px), not 24px', () => {
    const [v] = run(connected({ 'padding-left': '19px' }), ctx(), 'R3.5');
    expect(v?.property).toBe('padding-left');
    expect(v?.expected).toBe('16px');
    expect(v?.actual).toBe('19px');
  });

  it('margin and gap are checked independently of padding, each against the same spacing scale', () => {
    const style = connected({ 'margin-top': '29px', gap: '19px' });
    const margin = run(style, ctx(), 'R3.5').find((v) => v.property === 'margin-top');
    const gap = run(style, ctx(), 'R3.5').find((v) => v.property === 'gap');
    expect(margin?.expected).toBe('32px'); // 29 is 3px from 32, 5px from 24
    expect(gap?.expected).toBe('16px');
  });

  it('identical off-scale values on multiple sides of the SAME kind are cited once, not once per side', () => {
    const v = run(connected({ 'padding-top': '19px', 'padding-right': '19px', 'padding-bottom': '19px', 'padding-left': '19px' }), ctx(), 'R3.5');
    expect(v).toHaveLength(1);
  });

  it('a spacing value already on the scale is no violation', () => {
    expect(run(connected({ 'padding-left': '16px' }), ctx(), 'R3.5')).toEqual([]);
  });
});

describe('5. an exact matched component-variant value overrides the generic nearest-token recommendation', () => {
  it('a property the matched variant\'s OWN comparison already resolved (MATCH) drops the foundation citation entirely', () => {
    const raw = run(connected({ 'border-top-left-radius': '6px' }), ctx(), 'R3.6');
    expect(raw).toHaveLength(1); // the foundation check alone, in isolation, still fires
    // Button/primary/md's own comparison already found this exact radius correct (passed):
    const filtered = filterFoundationViolations(raw, ['border-top-left-radius'], []);
    expect(filtered).toEqual([]);
  });

  it('a property the matched variant found DIFFERENT (its own specific expected value) also drops the generic citation — the specific contract is the one that is reported, not a redundant generic one', () => {
    const raw = run(connected({ 'border-top-left-radius': '6px' }), ctx(), 'R3.6');
    const mismatches: Mismatch[] = [{ property: 'border-top-left-radius', actual: '6px', expected: '5px', expectedToken: '--radius-button', comparison: 'length-px', delta: 1 }];
    const filtered = filterFoundationViolations(raw, [], mismatches);
    expect(filtered).toEqual([]); // the main finding's mismatch (expected: 5px) already carries this — no duplicate
  });

  it('a property NOTHING matched covers still gets the foundation citation — the backstop still fires when there is no more specific value', () => {
    const raw = run(connected({ 'border-top-left-radius': '6px', 'padding-left': '19px' }), ctx(), undefined);
    const filtered = filterFoundationViolations(raw, ['padding-left'], []); // only padding was covered by a match
    expect(filtered.map((v) => v.property)).toEqual(['border-top-left-radius']);
  });
});

describe('6. unrelated token families are never compared — radius never recommends a spacing value or vice versa', () => {
  it('a radius whose off-scale value sits CLOSER to a spacing step than to any real radius step still only ever recommends from the radius family', () => {
    // 13px: nearest radius (10 or 15, both 3px away → larger wins, 15) vs nearest spacing (12, 1px away).
    // If radius ever borrowed from spacingPx, this would wrongly recommend 12px.
    const [v] = run(connected({ 'border-top-left-radius': '13px' }), ctx(), 'R3.6');
    expect(v?.expected).toBe('15px');
    expect(v?.expected).not.toBe('12px');
  });

  it('a spacing value whose off-scale value sits CLOSER to a radius step than to either tied spacing step still only ever recommends from the spacing family', () => {
    // 14px: nearest spacing (12 or 16, TIED at 2px away → larger wins, 16) vs nearest radius (15, 1px
    // away — if radius ever leaked into this scale, 15 would win outright, not need a tie-break).
    const [v] = run(connected({ 'padding-left': '14px' }), ctx(), 'R3.5');
    expect(v?.expected).toBe('16px');
    expect(v?.expected).not.toBe('15px');
  });
});

describe('7. ties are deterministic, via the SAME contextual/component-evidence tie-break order pickNearestSize already proves exhaustively', () => {
  it('a radius exactly between two valid steps picks the larger one deterministically, every time, regardless of scale order', () => {
    const scaleAscending = ctx({ radiiPx: [4, 8] });
    const scaleDescending = ctx({ radiiPx: [8, 4] });
    for (const c of [scaleAscending, scaleDescending]) {
      const [v] = run(connected({ 'border-top-left-radius': '6px' }), c, 'R3.6'); // 6 is exactly 2px from both 4 and 8
      expect(v?.expected).toBe('8px');
    }
  });

  it('a spacing value exactly between two valid steps is just as deterministic', () => {
    const [v] = run(connected({ 'padding-left': '10px' }), ctx({ spacingPx: [8, 12] }), 'R3.5'); // exactly between 8 and 12
    expect(v?.expected).toBe('12px');
  });
});

describe('8. non-DS colour: R1.2 "brand red is for CTAs only" extended to its own WHEN NOT clause — borders, section bgs, decoration', () => {
  it('REGRESSION 2: the exact reported shape — brand-red border on a non-CTA badge — is caught', () => {
    const style = connected({ 'border-top-color': BRAND_RED, 'border-top-width': '1px', 'background-color': 'rgba(176, 31, 36, 0.1)' });
    const [v] = runAs('badge', style, ctx({ brandRed: BRAND_RED }), 'R1.2');
    expect(v).toBeDefined();
    expect(v?.severity).toBe('CRITICAL');
    expect(v?.why).toContain('decoratively');
    expect(v?.why).toContain('borders');
  });

  it('a brand-red BACKGROUND alone (no border) on a non-CTA element is also caught — R1.2 forbids "section bgs" too', () => {
    const style = connected({ 'background-color': BRAND_RED, 'border-top-width': '0px' });
    const [v] = runAs('card', style, ctx({ brandRed: BRAND_RED }), 'R1.2');
    expect(v).toBeDefined();
    expect(v?.property).toBe('background-color');
  });

  it('a Button is deliberately EXEMPT — R1.2 names "button variant=brand" as the one legitimate use, and foundation-rules has no per-variant granularity to tell a brand button from any other', () => {
    const style = connected({ 'border-top-color': BRAND_RED, 'border-top-width': '1px', 'background-color': BRAND_RED });
    expect(runAs('button', style, ctx({ brandRed: BRAND_RED }), 'R1.2')).toEqual([]);
  });

  it('a non-brand border/background colour never false-positives', () => {
    const style = connected({ 'border-top-color': 'rgb(0, 0, 0)', 'border-top-width': '1px', 'background-color': 'rgb(255, 255, 255)' });
    expect(runAs('badge', style, ctx({ brandRed: BRAND_RED }), 'R1.2')).toEqual([]);
  });

  it('no ctx.brandRed configured (DS source unresolved) never guesses a violation', () => {
    const style = connected({ 'border-top-color': BRAND_RED, 'border-top-width': '1px' });
    expect(runAs('badge', style, ctx({ brandRed: null }), 'R1.2')).toEqual([]);
  });
});
