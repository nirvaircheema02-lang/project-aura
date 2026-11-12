import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { contextualTokenMap } from '../../src/ds/catalog.ts';
import { resolveToken } from '../../src/ds/d3-tokens/resolve.ts';
import { expectationsFor, type ComponentStyleModel } from '../../src/ds/component-styles.ts';
import { assignmentsOf, dsIndex } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import { compareAnyOf } from '../../src/agents/b4-compliance-auditor/index.ts';
import { buildFoundationContext, checkFoundationRules } from '../../src/agents/b4-compliance-auditor/foundation-rules.ts';
import type { ExtractedStyle } from '../../src/t-layer/computed-style.ts';

/**
 * Regression 6 — non-heading typography: the nearest valid DS size within the CORRECT component or
 * type family, never "whichever variant was listed first". Two places pick a size for text that is
 * not a heading level: B4 choosing among equally-fitting variants of the matched component
 * (`compareAnyOf` — here Button's sm/md/lg), and the R1.3 type-scale check for text with no
 * component at all (the DS's own text sizes).
 */

let registry: DsRegistry;
let model: ComponentStyleModel;
let tokens: Map<string, string>;
/** Button sizes in the order B3 would list them — small first, so "first listed" is the WRONG answer for big text. */
let SIZES: Array<Record<string, string>>;
const DESKTOP = 1440;
const BASE = { variant: 'brand', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' };

beforeAll(async () => {
  registry = await loadDsRegistry(loadConfig().designSystemPath);
  model = (await dsIndex(registry)).byFile.get('atoms/Button.tsx')!.model;
  tokens = contextualTokenMap(registry, 'light');
  SIZES = ['sm', 'md', 'lg'].map((size) => ({ ...assignmentsOf(model)[0], ...BASE, size }));
});

const connected = (raw: Record<string, string>): Extract<ExtractedStyle, { connected: true }> => ({ connected: true, raw, rootFontSizePx: 16, box: null });

/** A real captured property the DS says a given Button size must have (so a fixture is never a hand-guessed value). */
function dsValue(size: string, property: string): string {
  const e = expectationsFor(model, SIZES.find((a) => a.size === size)!, { viewportWidth: DESKTOP }).find((x) => x.property === property)!;
  return (e.token ? resolveToken(e.token, tokens) : e.literal) as string;
}

describe('B4 variant selection: among equally-fitting variants the NEAREST font-size is published', () => {
  it('17.2px text on a Button is judged against size lg (18px, 0.8px away), not size sm just because sm was listed first', () => {
    const r = compareAnyOf(model, SIZES, connected({ 'font-size': '17.2px' }), tokens, DESKTOP);
    expect(r.chosen?.size).toBe('lg');
    expect(r.properties.find((p) => p.property === 'font-size')).toMatchObject({ actual: '17.2px', expected: dsValue('lg', 'font-size'), expectedToken: '--button-font-lg', status: 'DIFFERENT' });
    expect(r.typography).toMatchObject({ property: 'font-size', variant: 'brand · lg · light', closestToken: '--button-font-lg', semanticTag: null, followsSemanticLevel: true, decidedBy: 'distance' });
    expect(r.typography?.actualPx).toBeCloseTo(17.2, 3);
    expect(r.typography?.closestPx).toBeCloseTo(18, 3);
    expect(r.typography?.differencePx).toBeCloseTo(0.8, 3);
    // Every size the family offered was considered, nearest first — the audit can show its working.
    expect(r.typography?.considered.map((c) => c.variant)).toEqual(['brand · lg · light', 'brand · md · light', 'brand · sm · light']);
  });

  it('and 14.4px text goes the other way — nearest is sm (14px), not the first-listed one by accident', () => {
    const r = compareAnyOf(model, [...SIZES].reverse(), connected({ 'font-size': '14.9px' }), tokens, DESKTOP); // listed lg, md, sm
    expect(r.chosen?.size).toBe('sm'); // 14.9 → sm 14 (0.9) rather than md 16 (1.1) or the first-listed lg
    expect(r.typography?.variant).toBe('brand · sm · light');
  });

  it('an exact (within tolerance) size is preserved: the matching variant is published and no "closest" claim is needed', () => {
    const r = compareAnyOf(model, SIZES, connected({ 'font-size': '16.2px' }), tokens, DESKTOP);
    expect(r.chosen?.size).toBe('md');
    expect(r.properties.find((p) => p.property === 'font-size')?.status).toBe('MATCH');
    expect(r.typography).toBeUndefined();
  });

  it('equal-distance sizes (17px is 1px from md AND lg) are separated by the element\'s OTHER properties — contextual evidence, not listing order', () => {
    // The element's height is lg's: lg has one mismatch (font-size), md has two (font-size and height).
    const lgHeight = dsValue('lg', 'height');
    const r = compareAnyOf(model, SIZES, connected({ 'font-size': '17px', height: lgHeight }), tokens, DESKTOP);
    expect(r.chosen?.size).toBe('lg');
    // …and with the height of md, the same equal distance goes to md.
    const md = compareAnyOf(model, SIZES, connected({ 'font-size': '17px', height: dsValue('md', 'height') }), tokens, DESKTOP);
    expect(md.chosen?.size).toBe('md');
  });

  it('nearest size is the tie-break among EQUALLY fitting variants — it never outvotes a variant that fits the element better overall', () => {
    // Height is md's (a strong sign the element IS md-sized); the font is nearer lg. md has fewer mismatches → md.
    const r = compareAnyOf(model, SIZES, connected({ 'font-size': '17.2px', height: dsValue('md', 'height') }), tokens, DESKTOP);
    expect(r.chosen?.size).toBe('md');
  });

  it('a single variant offers no choice, so no "closest of several" claim is made', () => {
    const r = compareAnyOf(model, [SIZES[1]!], connected({ 'font-size': '17.2px' }), tokens, DESKTOP);
    expect(r.chosen?.size).toBe('md');
    expect(r.typography).toBeUndefined();
  });
});

describe('R1.3 type scale (text with no DS component): ONE nearest DS size, never "this or that"', () => {
  const style = (fontSize: string) => connected({ 'font-size': fontSize, 'font-family': "'DM Sans', sans-serif", 'font-weight': '400' });
  const r13 = (fontSize: string) =>
    checkFoundationRules({ componentType: 'button', headingLevel: null, hasText: true, style: style(fontSize), ctx: buildFoundationContext(registry) }).filter((v) => v.ruleId === 'R1.3');

  it('16.8px is not a step of the scale; the nearest step is 16px (0.8px away), not "16px or 18px"', () => {
    const [v] = r13('16.8px');
    expect(v).toBeDefined();
    expect(v?.expected).toBe('16px');
    expect(v?.why).toContain('closest: 16px, 0.8px away');
    expect(v?.expected).not.toMatch(/ or /);
  });

  it('33px → 31.25px (the nearest DS scale step); a size ON the scale (or within the comparator\'s 0.5px tolerance of it) is no violation at all', () => {
    expect(r13('33px')[0]?.expected).toBe('31.25px');
    expect(r13('16px')).toEqual([]);
    expect(r13('16.4px')).toEqual([]);
  });

  it('exactly between two steps (18px: 16px and 20px) the larger step is named — nothing else separates them, and text is never demoted on a coin-flip', () => {
    expect(r13('18px')[0]?.expected).toBe('20px');
  });

  it('the accepted scale is the DS Major Third STEPS plus the exceptions R1.3 itself documents — NOT every token that looks like a text size', () => {
    const ctx = buildFoundationContext(registry);
    // 12.8 / 16 / 20 / 25 / 31.25 / 39 / 48.8 / 61 / 76.3  +  documented exceptions 14 (compact, nav), 11 (2xs), 10 (card-micro)
    expect(ctx.textSizesPx.map((n) => Math.round(n * 100) / 100)).toEqual([10, 11, 12.8, 14, 16, 20, 25.01, 31.25, 39.06, 48.83, 61.04, 76.29]);
    for (const ok of ['10px', '11px', '12.8px', '14px', '16px', '20px']) expect(r13(ok), ok).toEqual([]);
  });

  it('18px, 24px, 30px and 32px are LEGACY remap tokens (--text-md / -24 / -30 / -32, "V0.2 remap") and 12px is a CSS fallback, not a DS size: each is off the scale, and the finding names the legacy token it equals', () => {
    const md = r13('18px')[0];
    expect(md?.why).toContain('is not a step of the Design System type scale');
    expect(md?.why).toMatch(/it equals --text-md, a legacy remap token the DS keeps outside its type scale/);
    for (const [px, nearest] of [['24px', '25.01px'], ['30px', '31.25px'], ['32px', '31.25px'], ['12px', '12.8px']] as const) {
      const v = r13(px)[0];
      expect(v, px).toBeDefined();
      expect(v?.expected, px).toBe(nearest);
    }
  });

  it('component-specific tokens do not widen the general scale: a Button\'s --button-font-lg (18px) or a badge font token makes no other text size valid', () => {
    const ctx = buildFoundationContext(registry);
    const byClass = (k: string) => (ctx.textTokens ?? []).filter((t) => t.klass === k).map((t) => t.token);
    expect(byClass('component')).toEqual(expect.arrayContaining(['--button-font-lg', '--button-font-md', '--badge-md-font']));
    expect(byClass('legacy')).toEqual(expect.arrayContaining(['--text-md', '--text-13', '--text-24', '--text-30', '--text-32']));
    expect(byClass('exception').sort()).toEqual(['--text-card-micro', '--text-compact', '--text-nav'].concat(['--text-2xs']).sort());
    expect(byClass('alias')).toContain('--typography-size-2xs'); // 11px in FOUNDATIONS, a 12px fallback in utilities.css — never trusted over --text-2xs
  });
});
