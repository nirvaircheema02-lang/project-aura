import { describe, expect, it } from 'vitest';
import { colourLikeTokens, extractColours, parseCssColour, suppliesProperty } from '../../src/resolution/ds-colours.ts';

/**
 * Colour-lane review (defects 1, 11, 12): a colour is recognised wherever it is written - in ANY property, as a hex/function/named/system colour and in
 * any letter case - so nothing downstream can mistake it for a harmless literal; and a shorthand "supplies" only the properties it really sets.
 */

describe('a named or system colour is a colour in EVERY property, not only the ones on a list', () => {
  const NAMED: Array<[string, string]> = [
    ['stop-color', 'red'],
    ['flood-color', 'blue'],
    ['lighting-color', 'white'],
    ['scrollbar-color', 'red blue'],
    ['text-emphasis', 'filled red'],
    ['-webkit-tap-highlight-color', 'red'],
    ['filter', 'drop-shadow(0 0 2px red)'],
    ['border-image', 'linear-gradient(red, blue) 1'],
    ['mask-border', 'solid red'],
  ];
  it.each(NAMED)('%s: %s', (property, value) => {
    expect(extractColours(value).length, `${property}: ${value}`).toBeGreaterThan(0);
  });

  it('system colours (CanvasText, Highlight, ButtonBorder ...) are spans that cannot be read as a static colour', () => {
    for (const [property, value] of [['border', '1px solid CanvasText'], ['outline', '2px solid Highlight'], ['stop-color', 'ButtonBorder'], ['scrollbar-color', 'canvastext Canvas'], ['background', 'Field']] as const) {
      const spans = extractColours(value);
      expect(spans.length, `${property}: ${value}`).toBeGreaterThan(0);
      for (const s of spans) {
        expect(s.rgba, s.text).toBeNull();
        expect(s.unsupported, s.text).toMatch(/system colour/i);
      }
    }
  });

  it('is case-insensitive for named and system colours', () => {
    expect(extractColours('1px solid RED')).toHaveLength(1);
    expect(extractColours('1px solid canvastext')[0]!.unsupported).toMatch(/system colour/i);
  });

  it('does not see colours that are not there: var()/url()/strings and non-colour words', () => {
    expect(extractColours('1px solid var(--x, red)')).toHaveLength(0);
    expect(extractColours('url(red.png)')).toHaveLength(0);
    expect(extractColours('"red"')).toHaveLength(0);
    expect(extractColours('block')).toHaveLength(0);
    expect(extractColours('border-color 0.2s ease')).toHaveLength(0);
    expect(extractColours('solid')).toHaveLength(0);
    expect(extractColours('10px')).toHaveLength(0);
  });

  it('light-dark() and the other colour-scheme/contrast functions are one unsupported span, never read part by part', () => {
    for (const v of ['light-dark(#fff, #000)', 'color-contrast(white vs red, blue)', 'contrast-color(red)']) {
      const spans = extractColours(`1px solid ${v}`);
      expect(spans, v).toHaveLength(1);
      expect(spans[0]!.rgba, v).toBeNull();
      expect(spans[0]!.unsupported, v).toBeTruthy();
    }
  });
});

describe('colourLikeTokens: every colour-like token of a value, currentcolor included', () => {
  it('lists hex, functions, named, system and currentcolor tokens; var()/url()/strings and plain lengths hold none', () => {
    expect(colourLikeTokens('1px solid currentColor').map((t) => t.toLowerCase())).toEqual(['currentcolor']);
    expect(colourLikeTokens('0 0 2px red').length).toBe(1);
    expect(colourLikeTokens('CanvasText').length).toBe(1);
    expect(colourLikeTokens('#abc').length).toBe(1);
    expect(colourLikeTokens('rgba(0,0,0,.1) 1px').length).toBe(1);
    expect(colourLikeTokens('10px')).toEqual([]);
    expect(colourLikeTokens('var(--r, red)')).toEqual([]);
    expect(colourLikeTokens('solid')).toEqual([]);
  });

  it('currentcolor is a permitted keyword, not a colour value: extractColours does not map it', () => {
    expect(extractColours('1px solid currentColor')).toHaveLength(0);
  });
});

describe('CSS function names and keywords are case-insensitive (defect 11)', () => {
  it('RGBA/HSL/Red/#FFF/TRANSPARENT parse like their lowercase forms', () => {
    expect(parseCssColour('RGBA(0,0,0,.08)')).toEqual(parseCssColour('rgba(0,0,0,.08)'));
    expect(parseCssColour('HSL(0 0% 0% / 8%)')).toEqual(parseCssColour('hsl(0 0% 0% / 8%)'));
    expect(parseCssColour('RGB(255 255 255 / 50%)')!.alpha).toBeCloseTo(0.5, 2);
    expect(parseCssColour('Red')).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(parseCssColour('#FFF')).toMatchObject({ r: 255 });
    expect(parseCssColour('TRANSPARENT')!.alpha).toBe(0);
  });
  it('an uppercase function inside a declaration is found and read', () => {
    const [c] = extractColours('1px solid RGBA(0,0,0,.08)');
    expect(c!.rgba).not.toBeNull();
    expect(c!.rgba!.alpha).toBeCloseTo(0.08, 2);
    const [h] = extractColours('1px solid HSL(0 0% 0% / 8%)');
    expect(h!.rgba).not.toBeNull();
  });
});

describe('suppliesProperty matches what a declaration really sets (defect 12)', () => {
  it('border supplies its colour, width and style longhands, not its radius', () => {
    expect(suppliesProperty('border', 'border-top-color')).toBe(true);
    expect(suppliesProperty('border', 'border-color')).toBe(true);
    expect(suppliesProperty('border', 'border-left-width')).toBe(true);
    expect(suppliesProperty('border', 'border-radius')).toBe(false);
    expect(suppliesProperty('border', 'border-top-left-radius')).toBe(false);
    expect(suppliesProperty('border', 'border-collapse')).toBe(false);
  });
  it('outline supplies its colour/width/style, not its offset', () => {
    expect(suppliesProperty('outline', 'outline-color')).toBe(true);
    expect(suppliesProperty('outline', 'outline-offset')).toBe(false);
  });
  it('a side shorthand supplies its own side only', () => {
    expect(suppliesProperty('border-top', 'border-top-width')).toBe(true);
    expect(suppliesProperty('border-top', 'border-top-color')).toBe(true);
    expect(suppliesProperty('border-top', 'border-bottom-color')).toBe(false);
    expect(suppliesProperty('border-color', 'border-left-color')).toBe(true);
    expect(suppliesProperty('border-color', 'border-left-width')).toBe(false);
  });
  it('the reverse still holds (a longhand supplies the shorthand need) and an absent need is supplied by everything', () => {
    expect(suppliesProperty('border-top-color', 'border-color')).toBe(true);
    expect(suppliesProperty('border-top-color', 'border')).toBe(true);
    expect(suppliesProperty('border', undefined)).toBe(true);
    expect(suppliesProperty('border', 'border')).toBe(true);
  });
  it('other families: background and padding keep their longhands, box-shadow supplies only itself, radius its corners', () => {
    expect(suppliesProperty('background', 'background-color')).toBe(true);
    expect(suppliesProperty('padding', 'padding-top')).toBe(true);
    expect(suppliesProperty('border-radius', 'border-top-left-radius')).toBe(true);
    expect(suppliesProperty('box-shadow', 'border-top-color')).toBe(false);
    expect(suppliesProperty('border', 'box-shadow')).toBe(false);
  });
});
