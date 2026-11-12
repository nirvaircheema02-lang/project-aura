import { describe, expect, it } from 'vitest';
import { coveredByAny, shorthandCovers, suppliesProperty } from '../../src/resolution/ds-colours.ts';

/**
 * Reference lane round 4 (3): `suppliesProperty` is the one table behind "this declaration changes that property" - the preserve/unresolved block, the target
 * authorization and verifyPattern's later/related check. It had gaps: the intermediate side shorthands (`border-top`, `border-block`, `border-inline-start`),
 * the logical <-> physical aliases of a property (`border-block-start-*` is `border-top-*`, `border-inline-start-*` is `border-left-*`, with the usual ltr /
 * horizontal-tb assumption), and `all` (which resets every property but the custom ones, `direction` and `unicode-bidi`).
 */

const yes = (a: string, b: string) => { expect(suppliesProperty(a, b), `${a} supplies ${b}`).toBe(true); expect(suppliesProperty(b, a), `${b} supplies ${a} (symmetric)`).toBe(true); };
const no = (a: string, b: string) => { expect(suppliesProperty(a, b), `${a} does not supply ${b}`).toBe(false); expect(suppliesProperty(b, a), `${b} does not supply ${a} (symmetric)`).toBe(false); };

describe('border shorthands at every level', () => {
  it.each([
    ['border', 'border-top'], ['border', 'border-block'], ['border', 'border-inline-start'], ['border', 'border-block-end-width'], ['border', 'border-inline-color'],
    ['border-top', 'border-top-color'], ['border-top', 'border-top-width'], ['border-top', 'border-top-style'],
    ['border-block', 'border-top-color'], ['border-block', 'border-bottom-style'], ['border-block', 'border-block-start'], ['border-block', 'border-block-end-color'], ['border-block', 'border-block-width'],
    ['border-inline', 'border-left-color'], ['border-inline', 'border-right-width'], ['border-inline', 'border-inline-end'], ['border-inline', 'border-inline-start-style'],
    ['border-inline-start', 'border-inline-start-color'], ['border-inline-start', 'border-left-color'], ['border-inline-start', 'border-left'],
    ['border-block-start', 'border-top'], ['border-block-start', 'border-top-color'], ['border-block-start-color', 'border-top-color'],
    ['border-block-end', 'border-bottom'], ['border-inline-end', 'border-right'], ['border-inline-end-width', 'border-right-width'],
    ['border-color', 'border-block-start-color'], ['border-color', 'border-inline-color'], ['border-width', 'border-inline-end-width'], ['border-style', 'border-block-end-style'],
    ['border-block-color', 'border-top-color'], ['border-block-color', 'border-bottom-color'], ['border-inline-width', 'border-left-width'], ['border-inline-style', 'border-right-style'],
  ])('%s <-> %s', (a, b) => yes(a, b));

  it.each([
    ['border-top', 'border-bottom-color'], ['border-top', 'border-left'], ['border-block', 'border-left-color'], ['border-inline', 'border-top-width'], ['border-block-start', 'border-bottom'],
    ['border-inline-start', 'border-right'], ['border-color', 'border-top-width'], ['border-top-color', 'border-top-width'], ['border-top-color', 'border-bottom-color'],
    ['border-block-start-color', 'border-bottom-color'], ['border-inline-start-color', 'border-right-color'],
  ])('%s does not supply %s', (a, b) => no(a, b));

  it('border does not set a radius, the table border-collapse or an outline', () => {
    no('border', 'border-radius'); no('border', 'border-top-left-radius'); no('border', 'border-collapse'); no('border', 'outline'); no('border-top', 'border-radius');
  });
});

describe('radius, spacing and size: logical and physical names are one property', () => {
  it.each([
    ['border-radius', 'border-start-start-radius'], ['border-radius', 'border-top-left-radius'], ['border-start-start-radius', 'border-top-left-radius'], ['border-end-end-radius', 'border-bottom-right-radius'],
    ['padding', 'padding-block'], ['padding', 'padding-inline-start'], ['padding-block', 'padding-top'], ['padding-inline-start', 'padding-left'], ['padding-block-end', 'padding-bottom'], ['padding-inline', 'padding-right'],
    ['margin', 'margin-block'], ['margin-block-start', 'margin-top'], ['margin-inline', 'margin-left'], ['margin-inline-end', 'margin-right'], ['margin', 'margin-inline-start'],
    ['inset', 'top'], ['inset', 'inset-block-start'], ['inset-block', 'bottom'], ['inset-inline', 'left'], ['inset-inline-end', 'right'],
    ['width', 'inline-size'], ['height', 'block-size'], ['min-width', 'min-inline-size'], ['max-height', 'max-block-size'],
    ['gap', 'row-gap'], ['gap', 'column-gap'], ['gap', 'grid-row-gap'], ['grid-gap', 'column-gap'],
    ['overflow', 'overflow-x'], ['overflow', 'overflow-block'], ['overflow-inline', 'overflow-x'],
    ['font', 'font-size'], ['font', 'line-height'], ['font', 'font-family'], ['font', 'font-weight'],
    ['flex', 'flex-grow'], ['flex-flow', 'flex-direction'], ['flex-flow', 'flex-wrap'],
    ['scroll-margin', 'scroll-margin-block-start'], ['scroll-padding-inline', 'scroll-padding-right'],
  ])('%s <-> %s', (a, b) => yes(a, b));

  it.each([
    ['padding-top', 'padding-bottom'], ['padding-block', 'padding-left'], ['margin-block-start', 'margin-bottom'], ['margin', 'padding'], ['width', 'block-size'], ['height', 'inline-size'],
    ['gap', 'padding'], ['row-gap', 'column-gap'], ['inset', 'margin-top'], ['font', 'letter-spacing'], ['border-start-start-radius', 'border-top-right-radius'],
  ])('%s does not supply %s', (a, b) => no(a, b));
});

describe('outline, box-shadow, background, text-decoration', () => {
  it.each([
    ['outline', 'outline-color'], ['outline', 'outline-width'], ['outline', 'outline-style'],
    ['box-shadow', 'box-shadow-color'], ['text-shadow', 'text-shadow'],
    ['background', 'background-color'], ['background', 'background-image'], ['background', 'background-position-x'], ['background', 'background-size'], ['background', 'background-repeat'], ['background', 'background-clip'],
    ['text-decoration', 'text-decoration-color'], ['column-rule', 'column-rule-color'],
  ])('%s <-> %s', (a, b) => yes(a, b));

  it.each([
    ['outline', 'outline-offset'], ['outline', 'border-top-color'], ['box-shadow', 'text-shadow'], ['box-shadow', 'border-top-color'],
    ['background', 'color'], ['background-color', 'background-image'], ['text-decoration', 'color'],
  ])('%s does not supply %s', (a, b) => no(a, b));
});

describe('`all` supplies everything the cascade can reset', () => {
  it.each(['color', 'border-top-color', 'border', 'padding-top', 'width', 'box-shadow', 'background', 'font-size', 'display', 'opacity', 'border-block-start-color'])('all <-> %s', (p) => yes('all', p));
  it.each(['--x', '--ds-token', 'direction', 'unicode-bidi'])('all does not supply %s', (p) => no('all', p));
  it('all supplies itself', () => expect(suppliesProperty('all', 'all')).toBe(true));
});

describe('what is unchanged', () => {
  it.each([['border', 'border-top-color'], ['border', 'border-color'], ['border', 'border-left-width'], ['padding', 'padding-top'], ['border-radius', 'border-top-left-radius'], ['background', 'background-color']])('%s <-> %s', (a, b) => yes(a, b));
  it('a property supplies itself, no property is supplied by an unrelated one, a missing need is supplied by everything', () => {
    expect(suppliesProperty('color', 'color')).toBe(true);
    expect(suppliesProperty('color', 'background-color')).toBe(false);
    expect(suppliesProperty('border', undefined)).toBe(true);
  });
  it('a custom property is case-sensitive and only itself', () => {
    expect(suppliesProperty('--Brand', '--Brand')).toBe(true);
    expect(suppliesProperty('--Brand', '--brand')).toBe(false);
  });
  it('shorthandCovers is strict: a property never covers itself or an alias of itself', () => {
    expect(shorthandCovers('border-top-color', 'border-block-start-color')).toBe(false);
    expect(shorthandCovers('border', 'border')).toBe(false);
    expect(shorthandCovers('border-block', 'border-top')).toBe(true);
    expect(shorthandCovers('border-top', 'border-block')).toBe(false);
  });
});

describe('coveredByAny: a property is authorized only when EVERY longhand it sets is', () => {
  it.each([
    ['border-top-color', ['border-top-color']], ['border-top-color', ['border-color']], ['border-top-color', ['border']], ['border-block-start-color', ['border-top-color']],
    ['border-color', ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']], ['border-block', ['border-top', 'border-bottom']], ['padding', ['padding-block', 'padding-inline']],
    ['padding-left', ['padding']], ['inline-size', ['width']], ['box-shadow-color', ['box-shadow']],
  ])('%s is covered by %j', (p, by) => expect(coveredByAny(p, by), `${p} by ${by.join(',')}`).toBe(true));

  it.each([
    ['border', ['border-top-color']], ['border-color', ['border-top-color']], ['padding', ['padding-left']], ['padding-block', ['padding-top']], ['border-top', ['border-top-color', 'border-top-width']],
    ['width', ['height']], ['all', ['border-top-color']], ['font', ['font-size']], ['--x', ['color']],
  ])('%s is not covered by %j', (p, by) => expect(coveredByAny(p, by), `${p} by ${by.join(',')}`).toBe(false));

  it('a custom property is covered only by itself', () => expect(coveredByAny('--x', ['--x'])).toBe(true));
});
