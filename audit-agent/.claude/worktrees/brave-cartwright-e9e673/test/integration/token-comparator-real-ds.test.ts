import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { effectiveTokenMap } from '../../src/ds/catalog.ts';
import { resolveCssVars, resolveToken } from '../../src/ds/d3-tokens/resolve.ts';
import { compareToExpected, normalizeExpectations } from '../../src/t-layer/token-comparator.ts';

/**
 * The comparator against the REAL Design System tokens — every case here is
 * one the pre-run review reproduced as a false DEVIATION, a silent skip, or a
 * false MATCH on the real registry. Each would have shipped in the first real
 * audit's numbers.
 */

let tokens: Map<string, string>;

beforeAll(async () => {
  const registry = await loadDsRegistry(loadConfig().designSystemPath);
  tokens = effectiveTokenMap(registry, 'editorial-light');
}, 120_000);

const compare = (actual: Record<string, string>, expected: Array<{ property: string; token?: string | null; literal?: string | null }>) =>
  compareToExpected({
    actual: { 'font-size': '16px', ...actual },
    expected: expected.map((e) => ({ property: e.property, token: e.token ?? null, literal: e.literal ?? null })),
    effectiveTokens: tokens,
    rootFontSizePx: 16,
  });

describe('var() resolution over the real effective layer', () => {
  it('follows alias chains and nested fallbacks', () => {
    expect(tokens.get('--space-4')).toBe('var(--space-md)'); // stored as declared (provenance)…
    expect(resolveToken('--space-4', tokens)).toBe('1rem'); // …compared as resolved
    expect(resolveToken('--semantic-ink-strong', tokens)).toBe('#171717'); // two hops, then a fallback
    expect(resolveToken('--section-py-lg', tokens)).toBe('6rem');
  });

  it('returns null for what cannot be grounded, instead of guessing', () => {
    expect(resolveCssVars('var(--does-not-exist)', tokens)).toBeNull();
    expect(resolveCssVars('var(--does-not-exist, 4px)', tokens)).toBe('4px');
    const cyclic = new Map([['--a', 'var(--b)'], ['--b', 'var(--a)']]);
    expect(resolveToken('--a', cyclic)).toBeNull();
  });
});

describe('no false DEVIATIONs on correct implementations', () => {
  it('padding 16px vs --space-4 (an alias of 1rem) passes', () => {
    const r = compare({ 'padding-top': '16px' }, [{ property: 'padding-top', token: '--space-4' }]);
    expect(r.mismatches).toEqual([]);
    expect(r.passed).toEqual(['padding-top']);
  });

  it('radius via an alias token passes', () => {
    const r = compare({ 'border-top-left-radius': '5px' }, [{ property: 'border-top-left-radius', token: '--radius-element' }]);
    expect(r.passed).toEqual(['border-top-left-radius']);
  });

  it('box-shadow in the browser\'s serialization order matches the token', () => {
    const r = compare({ 'box-shadow': 'rgba(0, 0, 0, 0.08) 0px 1px 3px 0px' }, [{ property: 'box-shadow', token: '--shadow-sm' }]);
    expect(r.mismatches).toEqual([]);
    expect(r.passed).toEqual(['box-shadow']);
  });

  it('a semantic color alias is compared (and passes), not silently skipped', () => {
    const r = compare({ color: 'rgb(23, 23, 23)' }, [{ property: 'color', token: '--semantic-ink-strong' }]);
    expect(r.unresolved).toEqual([]);
    expect(r.passed).toEqual(['color']);
  });

  it('unitless line-height is compared as a ratio of the element\'s font size', () => {
    expect(compare({ 'line-height': '24px' }, [{ property: 'line-height', token: '--leading-normal' }]).passed).toEqual(['line-height']);
    const off = compare({ 'line-height': '28px' }, [{ property: 'line-height', token: '--leading-normal' }]);
    expect(off.mismatches[0]).toMatchObject({ property: 'line-height', comparison: 'length-px', delta: 4 });
  });

  it('letter-spacing: `normal` equals 0, and em resolves against the ELEMENT font size', () => {
    expect(compare({ 'letter-spacing': 'normal' }, [{ property: 'letter-spacing', token: '--tracking-normal' }]).passed).toEqual(['letter-spacing']);
    // 48px heading × -0.02em = -0.96px. Converting at the 16px root would report a bogus -0.64px delta.
    const heading = compare({ 'font-size': '48px', 'letter-spacing': '-0.96px' }, [{ property: 'letter-spacing', token: '--tracking-display-tight' }]);
    expect(heading.mismatches).toEqual([]);
    expect(heading.passed).toEqual(['letter-spacing']);
  });

  it('font-family matches through next/font\'s hashed family names and an unresolvable runtime var', () => {
    const r = compare({ 'font-family': '__DM_Sans_4a8b2c, __DM_Sans_Fallback_4a8b2c' }, [{ property: 'font-family', token: '--font-sans' }]);
    expect(r.passed).toEqual(['font-family']);
    // …and through a second alias hop (--font-family-body → var(--font-sans)).
    expect(compare({ 'font-family': '"DM Sans", sans-serif' }, [{ property: 'font-family', token: '--font-family-body' }]).passed).toEqual(['font-family']);
    // A genuinely wrong typeface is still caught.
    expect(compare({ 'font-family': 'Arial, sans-serif' }, [{ property: 'font-family', token: '--font-sans' }]).mismatches).toHaveLength(1);
  });

  it('model-supplied names are normalized: camelCase, a missing `--`, var(), and shorthands', () => {
    const expanded = normalizeExpectations([{ property: 'padding', token: 'space-4', literal: null }]);
    expect(expanded.map((e) => e.property)).toEqual(['padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
    expect(new Set(expanded.map((e) => e.token))).toEqual(new Set(['--space-4']));
    const r = compare(
      { 'background-color': 'rgb(176, 31, 36)', 'padding-top': '16px', 'padding-right': '16px', 'padding-bottom': '16px', 'padding-left': '16px' },
      [
        { property: 'backgroundColor', token: 'var(--color-brand-red)' },
        { property: 'padding', token: 'space-4' },
      ],
    );
    expect(r.unresolved).toEqual([]);
    expect(r.passed.sort()).toEqual(['background-color', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top']);
  });

  it('a multi-value shorthand literal is split per side', () => {
    const r = compare(
      { 'padding-top': '12px', 'padding-right': '24px', 'padding-bottom': '12px', 'padding-left': '24px' },
      [{ property: 'padding', literal: '12px 24px' }],
    );
    expect(r.mismatches).toEqual([]);
    expect(r.passed).toHaveLength(4);
  });
});

describe('real deviations are still caught', () => {
  it('the 44px CTA against the real 48px --button-height-md', () => {
    const r = compare({ height: '44px' }, [{ property: 'height', token: '--button-height-md' }]);
    expect(r.mismatches[0]).toMatchObject({ property: 'height', comparison: 'length-px', delta: -4, expectedToken: '--button-height-md' });
  });

  it('a clearly different color', () => {
    const r = compare({ 'background-color': 'rgb(0, 102, 204)' }, [{ property: 'background-color', token: '--color-brand-red' }]);
    expect(r.mismatches[0]?.comparison).toBe('color-deltaE');
  });
});

describe('colors carry alpha (second-pass review: alpha-blind false MATCHes)', () => {
  it('solid black is NOT the 60%-black text token; the matching rgba is', () => {
    expect(compare({ color: 'rgb(0, 0, 0)' }, [{ property: 'color', token: '--text-secondary' }]).mismatches[0]?.comparison).toBe('color-deltaE');
    expect(compare({ color: 'rgba(0, 0, 0, 0.6)' }, [{ property: 'color', token: '--text-secondary' }]).passed).toEqual(['color']);
  });

  it('solid brand red is NOT its 12% tint', () => {
    expect(compare({ 'background-color': 'rgb(176, 31, 36)' }, [{ property: 'background-color', token: '--semantic-brand-red-alpha-12' }]).mismatches).toHaveLength(1);
  });

  it('transparent is not black, and two transparents are equal whatever their RGB', () => {
    expect(compare({ 'background-color': 'rgba(0, 0, 0, 0)' }, [{ property: 'background-color', token: '--section-bg-contrast' }]).mismatches).toHaveLength(1);
    expect(compare({ 'background-color': 'rgba(0, 0, 0, 0)' }, [{ property: 'background-color', literal: 'rgba(255, 255, 255, 0)' }]).passed).toEqual(['background-color']);
  });

  it('a solid border is not the 12% hairline', () => {
    expect(compare({ 'border-top-color': 'rgb(0, 0, 0)' }, [{ property: 'border-top-color', token: '--semantic-hairline-default' }]).mismatches).toHaveLength(1);
  });
});

describe('Tailwind composite box-shadows (second-pass review: false DEVIATION on every shadowed card)', () => {
  // Exact Chromium 153 serializations of Tailwind's shadow utilities around the DS token.
  const v3 = 'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.08) 0px 1px 3px 0px';
  const v4 = `${'rgba(0, 0, 0, 0) 0px 0px 0px 0px, '.repeat(4)}rgba(0, 0, 0, 0.08) 0px 1px 3px 0px`;

  it('the transparent placeholder layers are ignored — v3 and v4 composites match --shadow-sm', () => {
    expect(compare({ 'box-shadow': v3 }, [{ property: 'box-shadow', token: '--shadow-sm' }]).passed).toEqual(['box-shadow']);
    expect(compare({ 'box-shadow': v4 }, [{ property: 'box-shadow', token: '--shadow-sm' }]).passed).toEqual(['box-shadow']);
  });

  it('an all-transparent composite equals --shadow-none', () => {
    expect(compare({ 'box-shadow': 'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px' }, [{ property: 'box-shadow', token: '--shadow-none' }]).passed).toEqual(['box-shadow']);
  });

  it('a shadow 7x too dark is still caught', () => {
    expect(compare({ 'box-shadow': 'rgba(0, 0, 0, 0.6) 0px 1px 3px 0px' }, [{ property: 'box-shadow', token: '--shadow-sm' }]).mismatches).toHaveLength(1);
  });
});

describe('radius, gap and min/max (second-pass review)', () => {
  it('rounded-full in exponent notation matches --radius-full; a 5px radius does not', () => {
    const pill = { 'border-top-left-radius': '3.35544e+07px', width: '120px', height: '32px' };
    expect(compare(pill, [{ property: 'border-top-left-radius', token: '--radius-full' }]).passed).toEqual(['border-top-left-radius']);
    expect(compare(pill, [{ property: 'border-top-left-radius', token: '--radius-button' }]).mismatches).toHaveLength(1);
  });

  it('gap expands to row/column; `normal` is 0 in a grid and unresolved in flex', () => {
    expect(compare({ 'row-gap': '16px', 'column-gap': '16px' }, [{ property: 'gap', token: '--space-4' }]).passed).toEqual(['row-gap', 'column-gap']);
    expect(compare({ display: 'grid', 'row-gap': 'normal', 'column-gap': 'normal' }, [{ property: 'gap', token: '--space-4' }]).mismatches).toHaveLength(2);
    expect(compare({ display: 'flex', 'row-gap': 'normal', 'column-gap': 'normal' }, [{ property: 'gap', token: '--space-4' }]).unresolved).toHaveLength(2);
  });

  it('logical pairs are start/end: padding-inline "12px 24px" puts 12px on the left', () => {
    const r = compare({ 'padding-left': '12px', 'padding-right': '24px' }, [{ property: 'padding-inline', literal: '12px 24px' }]);
    expect(r.passed).toEqual(['padding-left', 'padding-right']);
  });

  it('a DS min-width that production leaves at auto is a mismatch, not "not compared"', () => {
    expect(compare({ 'min-width': 'auto' }, [{ property: 'min-width', literal: '120px' }]).mismatches).toHaveLength(1);
  });
});

describe('gradients against Chromium\'s own re-serialization (second-pass review: every DS gradient was a false DEVIATION)', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ channel: 'chromium', headless: true });
  }, 60_000);
  afterAll(async () => browser?.close());

  it('every --*gradient* token, rendered in Chromium, passes against itself', async () => {
    const page = await (await browser.newContext()).newPage();
    const names = [...tokens.keys()].filter((n) => /gradient/.test(n) && (resolveToken(n, tokens) ?? '').includes('gradient('));
    expect(names.length).toBeGreaterThanOrEqual(14);
    const failures: string[] = [];
    for (const name of names) {
      const css = resolveToken(name, tokens)!;
      const rendered = await page.evaluate((bg) => {
        const d = document.createElement('div');
        d.style.backgroundImage = bg;
        document.body.appendChild(d);
        return getComputedStyle(d).backgroundImage;
      }, css);
      const r = compare({ 'background-image': rendered }, [{ property: 'background-image', token: name }]);
      if (r.passed[0] !== 'background-image') failures.push(`${name}: ${rendered} → ${JSON.stringify(r.mismatches[0] ?? r.unresolved[0])}`);
    }
    expect(failures).toEqual([]);
  });

  it('a solid CTA where the DS specifies the gradient is still a real difference', () => {
    expect(compare({ 'background-image': 'none' }, [{ property: 'background-image', token: '--composition-gradient-brand-red-shimmer' }]).mismatches).toHaveLength(1);
  });

  it('a gradient with the wrong color is caught', () => {
    const wrong = 'linear-gradient(90deg, rgb(0, 0, 255) 0%, rgb(235, 72, 78) 50%, rgb(176, 31, 36) 100%)';
    expect(compare({ 'background-image': wrong }, [{ property: 'background-image', token: '--composition-gradient-brand-red-shimmer' }]).mismatches).toHaveLength(1);
  });
});

describe('third-pass review regressions', () => {
  it('a slash-alpha color under the border-color shorthand is compared whole — not cut at its slash', () => {
    expect(compare({ 'border-top-color': 'rgba(0, 0, 0, 0.1)' }, [{ property: 'border-color', literal: 'rgb(0 0 0 / 0.1)' }]).passed).toEqual(['border-top-color']);
    const pad = compare({ 'padding-top': '4px', 'padding-right': '16px', 'padding-bottom': '4px', 'padding-left': '16px' }, [{ property: 'padding', literal: 'calc(8px / 2) 16px' }]);
    expect(pad.passed).toEqual(['padding-right', 'padding-left']); // the calc() sides are unresolved, not cut
    // border-radius still takes only its horizontal radii before the slash.
    expect(compare({ 'border-top-left-radius': '10px', width: '200px', height: '100px' }, [{ property: 'border-radius', literal: '10px 20px / 5px' }]).passed).toContain('border-top-left-radius');
  });

  it('an inline rounded-full pill (width auto) is clamped by its border box, not published as a 33,544,401px delta', () => {
    const inline = compareToExpected({
      actual: { 'font-size': '16px', 'border-top-left-radius': '3.35544e+07px', width: 'auto', height: 'auto' },
      expected: [{ property: 'border-top-left-radius', token: '--radius-full', literal: null }],
      effectiveTokens: tokens,
      rootFontSizePx: 16,
      box: { width: 64, height: 24 },
    });
    expect(inline.passed).toEqual(['border-top-left-radius']);
    // With no box at all, an infinite radius is unresolved — never a giant published delta.
    const unknown = compare({ 'border-top-left-radius': '3.35544e+07px', width: 'auto', height: 'auto' }, [{ property: 'border-top-left-radius', literal: '12px' }]);
    expect(unknown.mismatches).toEqual([]);
    expect(unknown.unresolved).toHaveLength(1);
  });

  it('missing stop positions are filled per CSS, not treated as wildcards', () => {
    // --composition-gradient-cinematic-overlay-tl has stops at 0% / 30% / 60%; an unpositioned copy spreads to 0/50/100%.
    const spread = 'radial-gradient(circle at 0% 0%, rgba(76, 95, 215, 0.15), rgba(76, 95, 215, 0.075), rgba(0, 0, 0, 0))';
    expect(compare({ 'background-image': spread }, [{ property: 'background-image', token: '--composition-gradient-cinematic-overlay-tl' }]).mismatches).toHaveLength(1);
    // …while an unpositioned two-stop gradient IS the same as 0% / 100%.
    expect(compare({ 'background-image': 'linear-gradient(to right, rgb(255, 255, 255) 0%, rgba(0, 0, 0, 0) 100%)' }, [{ property: 'background-image', token: '--composition-gradient-carousel-mask-left' }]).passed).toEqual(['background-image']);
    expect(compare({ 'background-image': 'linear-gradient(to right, rgb(255, 255, 255) 20%, rgba(0, 0, 0, 0) 100%)' }, [{ property: 'background-image', token: '--composition-gradient-carousel-mask-left' }]).mismatches).toHaveLength(1);
  });

  it('unitless 0 and 0px stop positions are the same; rem converts; angle units normalize', () => {
    const dots = compare({ 'background-image': 'radial-gradient(rgba(0, 0, 0, 0.1) 1px, rgba(0, 0, 0, 0) 0px)' }, [{ property: 'background-image', literal: 'radial-gradient(rgba(0,0,0,0.1) 1px, transparent 0)' }]);
    expect(dots.passed).toEqual(['background-image']);
    expect(compare({ 'background-image': 'linear-gradient(90deg, rgb(255, 0, 0) 16px, rgb(0, 0, 255) 32px)' }, [{ property: 'background-image', literal: 'linear-gradient(0.25turn, red 1rem, blue 2rem)' }]).passed).toEqual(['background-image']);
  });

  it('an interpolation-space-only difference (Tailwind v4 `in oklab`) is unresolved, not a DEVIATION', () => {
    const r = compare({ 'background-image': 'linear-gradient(to right bottom in oklab, rgb(176, 31, 36) 0%, rgb(198, 45, 49) 100%)' }, [{ property: 'background-image', literal: 'linear-gradient(to bottom right, #b01f24 0%, #c62d31 100%)' }]);
    expect(r.mismatches).toEqual([]);
    expect(r.unresolved).toHaveLength(1);
  });
});

describe('"nothing compared" is distinguishable from "all passed"', () => {
  it('an undefined token, an uncaptured property and an empty expectation are all unresolved, with zero passes', () => {
    const r = compare({ height: '48px' }, [
      { property: 'height', token: '--not-a-real-token' },
      { property: 'transition', token: '--button-height-md' },
      { property: 'height' },
    ]);
    expect(r.passed).toEqual([]);
    expect(r.mismatches).toEqual([]);
    expect(r.unresolved).toHaveLength(3);
  });
});
