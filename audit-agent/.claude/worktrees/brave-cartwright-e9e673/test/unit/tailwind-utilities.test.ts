import { describe, expect, it } from 'vitest';
import { analyzeUtility, compareBreakpointOrder, cssPropertyDeclarations, parseClass, utilityDeclarations, type UtilityContext } from '../../src/ds/tailwind-utilities.ts';

/**
 * Tailwind v4 utility → declarations, as the DS's pinned compiler
 * (tailwindcss 4.2.4) emits them. The token map mirrors the real DS's
 * overrides of Tailwind's theme namespaces (it redefines --text-sm to 1rem,
 * the radius scale, the weights it uses) plus a few probe tokens, so these
 * cases run without loading the registry.
 */

const ctx: UtilityContext = {
  tokens: new Map([
    ['--text-sm', '1rem'],
    ['--font-weight-medium', '500'],
    ['--radius-lg', '20px'],
    ['--tracking-wide', '0.025em'],
    ['--font-sans', "'DM Sans', sans-serif"],
    ['--x', '12px'],
    ['--pair', '12px 24px'],
    ['--brand', '#b01f24'],
    ['--size-token', '1rem'],
    ['--family-token', "'DM Sans', sans-serif"],
    ['--weight-token', '600'],
    ['--gradient', 'linear-gradient(90deg, #b01f24 0%, #eb484e 100%)'],
    ['--shadow-token', '0 1px 3px rgba(0, 0, 0, 0.08)'],
  ]),
};
const noDsTokens: UtilityContext = { tokens: new Map() };

const decl = (utility: string, c: UtilityContext = ctx) => utilityDeclarations(utility, c);
const asMap = (utility: string, c: UtilityContext = ctx) =>
  Object.fromEntries((decl(utility, c) ?? []).map((d) => [d.property, d.token ?? d.literal]));

describe('parseClass', () => {
  it('separates variants from the utility, respecting brackets', () => {
    expect(parseClass('bg-[image:var(--x)]')).toMatchObject({ utility: 'bg-[image:var(--x)]', variants: [], stateGated: false, media: null });
    expect(parseClass('hover:bg-white/[0.05]')).toMatchObject({ utility: 'bg-white/[0.05]', stateGated: true });
  });

  it('hover:/focus-visible:/group-hover:/aria-*/data-*/disabled:/dark:/motion-reduce: are state-gated', () => {
    for (const token of ['hover:underline', 'focus-visible:ring-2', 'group-hover:text-black', 'aria-selected:bg-white', 'data-[state=open]:flex', 'disabled:opacity-50', 'dark:bg-black', 'motion-reduce:transition-none', '*:p-2', '[&>svg]:h-3.5']) {
      expect(parseClass(token)?.stateGated, token).toBe(true);
    }
  });

  it('sm: gates at min-width 640, max-sm: below 640, and stacked breakpoints combine', () => {
    expect(parseClass('sm:w-auto')?.media).toEqual({ minWidth: 640 });
    expect(parseClass('max-sm:hidden')?.media).toEqual({ maxWidth: 639.98 });
    expect(parseClass('md:max-lg:flex')?.media).toEqual({ minWidth: 768, maxWidth: 1023.98 });
    expect(parseClass('min-[900px]:block')?.media).toEqual({ minWidth: 900 });
    expect(parseClass('2xl:p-4')?.media).toEqual({ minWidth: 1536 });
  });

  it('reads both !important spellings', () => {
    expect(parseClass('!text-white')).toMatchObject({ utility: 'text-white', important: true });
    expect(parseClass('text-white!')).toMatchObject({ utility: 'text-white', important: true });
  });

  it('flags variants it cannot evaluate instead of assuming they never apply', () => {
    expect(parseClass('@md:flex')?.unknownVariant).toBe(true);
    expect(parseClass('supports-[display:grid]:grid')?.unknownVariant).toBe(true);
    expect(parseClass('sm:flex')?.unknownVariant).toBe(false);
  });

  // Regression (review A-2): disabled:/aria-*/data-*/last: are the actual state of real instances — a disabled
  // field, the last item of a list, Radix data-state at rest. They may apply at rest; only interaction states,
  // pseudo-element and child targets, and media the rendering policy excludes never do.
  it('atRest: interaction states and child/pseudo-element targets never apply; element states and positions may', () => {
    for (const token of ['hover:underline', 'focus-visible:ring-2', 'active:bg-black', 'group-hover:text-black', 'peer-focus/field:p-1', 'before:content-none', '*:p-2', '[&>svg]:h-3.5', '[&_svg]:p-1', '[&:hover]:p-1', '[&::after]:p-1', 'dark:bg-black', 'print:hidden']) {
      expect(parseClass(token)?.atRest, token).toBe('never');
    }
    for (const token of ['disabled:opacity-50', 'enabled:p-1', 'aria-invalid:border-black', 'aria-[sort=ascending]:p-1', 'data-[state=open]:flex', 'first:p-0', 'last:mb-0', 'odd:bg-white', 'nth-3:p-1', 'open:p-1', 'read-only:p-1', 'placeholder-shown:p-1', 'group-data-[state=open]:p-1', 'peer-checked:p-1', 'motion-safe:p-1', 'motion-reduce:p-1']) {
      expect(parseClass(token)?.atRest, token).toBe('maybe');
      expect(parseClass(token)?.stateGated, token).toBe(true);
    }
    // `:not(:hover)` holds at rest; `:last-child` and `:has()` are about the element itself.
    for (const token of ['[&:not(:hover)]:p-1', '[&:last-child]:p-1', '[&:has(>svg)]:p-1', '[.dark_&]:p-1', '@md:flex', 'has-[>svg]:px-4']) {
      expect(parseClass(token)?.atRest, token).toBe('maybe');
    }
    // Every prefix must hold at once: one that never holds at rest wins.
    expect(parseClass('hover:disabled:opacity-50')?.atRest).toBe('never');
    expect(parseClass('md:last:mb-0')).toMatchObject({ atRest: 'maybe', media: { minWidth: 768 } });
    expect(parseClass('md:p-4')?.atRest).toBe('applies');
    expect(parseClass('p-4')?.atRest).toBe('applies');
  });

  it('returns null for garbage and template fragments', () => {
    for (const token of ['', 'bg-', 'active:bg-', 'hover:', "'Button'", '700', '${size}', 'h-[var(--x)', 'é']) {
      expect(parseClass(token), token).toBeNull();
    }
  });
});

// Regression (review A-3): the stylesheet order of breakpoint rules, read off the DS's pinned compiler
// (tailwindcss 4.2.4 build of these candidates). Tailwind buckets values by unit before comparing
// numbers, so px breakpoints precede rem ones whatever their width.
describe('compareBreakpointOrder follows Tailwind v4\'s real stylesheet order', () => {
  const sortByTailwind = (tokens: string[]) =>
    [...tokens].sort((a, b) => compareBreakpointOrder(parseClass(a)?.variants ?? [], parseClass(b)?.variants ?? []));

  it('max-* before min-*, px bucket before rem bucket, widest max first, narrowest min first', () => {
    const compiled = ['p-5', 'max-[500px]:p-10', 'max-2xl:p-12', 'max-[50rem]:p-9', 'max-sm:p-11', 'min-[500px]:p-3', 'min-[2000px]:p-4', 'min-[20rem]:p-2', 'sm:p-6', 'md:p-7', 'min-[50rem]:p-1'];
    const shuffled = [compiled[6], compiled[1], compiled[9], compiled[0], compiled[10], compiled[3], compiled[8], compiled[2], compiled[5], compiled[7], compiled[4]] as string[];
    expect(sortByTailwind(shuffled)).toEqual(compiled);
  });

  it('a stacked breakpoint sorts after its highest variant alone and before the next one (md < md:max-lg < sm:md < lg)', () => {
    const compiled = ['max-lg:p-4', 'md:p-2', 'md:max-lg:p-1', 'sm:md:p-5', 'lg:p-3'];
    expect(sortByTailwind(['lg:p-3', 'sm:md:p-5', 'md:max-lg:p-1', 'md:p-2', 'max-lg:p-4'])).toEqual(compiled);
  });

  it('min-md: is md:, and the arbitrary breakpoint gates still parse to px', () => {
    expect(compareBreakpointOrder(['min-md'], ['md'])).toBe(0);
    expect(parseClass('min-md:p-1')?.media).toEqual({ minWidth: 768 });
    expect(parseClass('max-[50rem]:p-1')?.media).toEqual({ maxWidth: 799.98 });
  });
});

describe('theme-backed utilities resolve through the DS token map first', () => {
  it('text-sm → the DS\'s own --text-sm (1rem here), never Tailwind\'s 0.875rem, when the DS defines it', () => {
    expect(decl('text-sm')).toEqual([{ property: 'font-size', token: '--text-sm', literal: null }]);
    expect(decl('text-sm', noDsTokens)).toEqual([{ property: 'font-size', token: null, literal: '0.875rem' }]);
  });

  it('a font size marks line-height as set: its paired v4 line height is never expected, and cn() drops an earlier leading-*', () => {
    expect(analyzeUtility('text-sm', ctx).touched).toEqual(['line-height']);
    expect(analyzeUtility('text-[13px]', ctx).touched).toEqual(['line-height']);
    expect(analyzeUtility('text-sm/6', ctx).touched).toEqual([]);
  });

  it('font weights, radii, tracking and families follow the same rule', () => {
    expect(asMap('font-medium')).toEqual({ 'font-weight': '--font-weight-medium' });
    expect(asMap('font-bold')).toEqual({ 'font-weight': '700' });
    expect(asMap('tracking-wide')).toEqual({ 'letter-spacing': '--tracking-wide' });
    expect(asMap('font-sans')).toEqual({ 'font-family': '--font-sans' });
    expect(asMap('rounded-lg')).toEqual({
      'border-top-left-radius': '--radius-lg',
      'border-top-right-radius': '--radius-lg',
      'border-bottom-right-radius': '--radius-lg',
      'border-bottom-left-radius': '--radius-lg',
    });
    expect(asMap('rounded-md')['border-top-left-radius']).toBe('0.375rem');
  });

  it('a key outside Tailwind\'s default theme is not generated — unknown, with the reason', () => {
    const r = analyzeUtility('rounded-button', ctx);
    expect(r.declarations).toBeNull();
    expect(r.touched).toHaveLength(4);
    expect(r.reason).toMatch(/not a Tailwind v4 default-theme radius/);
    expect(analyzeUtility('tracking-button', ctx).declarations).toBeNull();
  });

  it('static utilities: rounded, rounded-full, rounded-none, leading-none', () => {
    expect(asMap('rounded')['border-top-left-radius']).toBe('0.25rem');
    expect(asMap('rounded-full')['border-bottom-left-radius']).toBe('9999px');
    expect(asMap('rounded-none')['border-top-right-radius']).toBe('0');
    expect(asMap('leading-none')).toEqual({ 'line-height': '1' });
  });
});

describe('spacing and sizing', () => {
  it('gap-1.5 → 0.375rem on both gaps (N × 0.25rem — the DS does not define --spacing)', () => {
    expect(asMap('gap-1.5')).toEqual({ 'row-gap': '0.375rem', 'column-gap': '0.375rem' });
    expect(asMap('gap-x-8')).toEqual({ 'column-gap': '2rem' });
  });

  it('px-[var(--x)] → padding-left and padding-right, both as the token', () => {
    expect(decl('px-[var(--x)]')).toEqual([
      { property: 'padding-left', token: '--x', literal: null },
      { property: 'padding-right', token: '--x', literal: null },
    ]);
  });

  it('a multi-part token under a box shorthand is split on its resolved value', () => {
    expect(asMap('p-[var(--pair)]')).toEqual({ 'padding-top': '12px', 'padding-right': '24px', 'padding-bottom': '12px', 'padding-left': '24px' });
  });

  it('numbers, px, negatives and arbitrary lengths', () => {
    expect(asMap('h-7')).toEqual({ height: '1.75rem' });
    expect(asMap('size-4')).toEqual({ width: '1rem', height: '1rem' });
    expect(asMap('px-px')).toEqual({ 'padding-left': '1px', 'padding-right': '1px' });
    expect(asMap('-mt-2')).toEqual({ 'margin-top': '-0.5rem' });
    expect(asMap('min-w-[60px]')).toEqual({ 'min-width': '60px' });
    expect(asMap('leading-6')).toEqual({ 'line-height': '1.5rem' });
    expect(asMap('p-[10px_20px]')).toEqual({ 'padding-top': '10px', 'padding-right': '20px', 'padding-bottom': '10px', 'padding-left': '20px' });
  });

  it('layout-dependent sizes are unknown, but still mark the property as set', () => {
    for (const utility of ['w-full', 'w-auto', 'h-screen', 'w-1/2', 'w-fit', 'max-w-[50%]']) {
      const r = analyzeUtility(utility, ctx);
      expect(r.declarations, utility).toBeNull();
      expect(r.touched.length, utility).toBeGreaterThan(0);
    }
    expect(analyzeUtility('mx-auto', ctx).touched).toEqual(['margin-left', 'margin-right']);
  });
});

describe('borders', () => {
  it('border-[1.5px] → all four widths', () => {
    expect(asMap('border-[1.5px]')).toEqual({
      'border-top-width': '1.5px',
      'border-right-width': '1.5px',
      'border-bottom-width': '1.5px',
      'border-left-width': '1.5px',
    });
    expect(asMap('border')['border-left-width']).toBe('1px');
    expect(asMap('border-t-2')).toEqual({ 'border-top-width': '2px' });
    expect(asMap('border-x')).toEqual({ 'border-left-width': '1px', 'border-right-width': '1px' });
  });

  it('border-black/30 → an rgba top color (the only side the T-layer extracts)', () => {
    expect(decl('border-black/30')).toEqual([{ property: 'border-top-color', token: null, literal: 'rgba(0, 0, 0, 0.3)' }]);
    expect(asMap('border-white/[0.05]')).toEqual({ 'border-top-color': 'rgba(255, 255, 255, 0.05)' });
    expect(asMap('border-[var(--brand)]')).toEqual({ 'border-top-color': '--brand' });
    expect(asMap('border-solid')).toEqual({ 'border-top-style': 'solid' });
  });
});

describe('colors', () => {
  it('white/black/transparent and opacity modifiers', () => {
    expect(asMap('text-white')).toEqual({ color: '#fff' });
    expect(asMap('bg-transparent')).toEqual({ 'background-color': 'transparent' });
    expect(asMap('text-white/70')).toEqual({ color: 'rgba(255, 255, 255, 0.7)' });
    expect(asMap('text-[#e5e5e5]')).toEqual({ color: '#e5e5e5' });
    expect(asMap('decoration-[var(--brand)]')).toEqual({ 'text-decoration-color': '--brand' });
  });

  it('bg-red-500 → null: Tailwind\'s palette is oklch, never guessed', () => {
    expect(decl('bg-red-500')).toBeNull();
    expect(analyzeUtility('bg-red-500', ctx).touched).toEqual(['background-color']);
    expect(decl('text-sky-700')).toBeNull();
  });

  it('a var() color with an opacity modifier is skipped, not approximated', () => {
    expect(decl('bg-[var(--brand)]/50')).toBeNull();
  });
});

describe('untyped var() under a multi-type utility (Tailwind v4 never infers its type)', () => {
  it('text-[var(--color)] is the color', () => {
    expect(decl('text-[var(--brand)]')).toEqual([{ property: 'color', token: '--brand', literal: null }]);
  });

  it('text-[var(--length)] compiles to `color`, sets nothing, and says so — it is NOT turned into a font size', () => {
    const r = analyzeUtility('text-[var(--size-token)]', ctx);
    expect(r.declarations).toBeNull();
    expect(r.touched).toEqual(['color']);
    expect(r.reason).toMatch(/compiles an untyped var\(\) here to `color: var\(--size-token\)`/);
    expect(r.reason).toMatch(/text-\[length:var\(--size-token\)\]|\[length:var\(--size-token\)\]/);
  });

  it('a type hint gives the intended property', () => {
    expect(decl('text-[length:var(--size-token)]')).toEqual([{ property: 'font-size', token: '--size-token', literal: null }]);
    expect(decl('bg-[image:var(--gradient)]')).toEqual([{ property: 'background-image', token: '--gradient', literal: null }]);
    expect(decl('font-[family-name:var(--family-token)]')).toEqual([{ property: 'font-family', token: '--family-token', literal: null }]);
  });

  it('bg-[var(--gradient)] and font-[var(--family)] are invalid at computed-value time; font-[var(--weight)] is a weight', () => {
    expect(analyzeUtility('bg-[var(--gradient)]', ctx)).toMatchObject({ declarations: null, touched: ['background-color'] });
    expect(analyzeUtility('font-[var(--family-token)]', ctx)).toMatchObject({ declarations: null, touched: ['font-weight'] });
    expect(decl('font-[var(--weight-token)]')).toEqual([{ property: 'font-weight', token: '--weight-token', literal: null }]);
  });

  it('an undefined token is never grounded', () => {
    expect(analyzeUtility('text-[var(--not-in-ds)]', ctx).declarations).toBeNull();
  });
});

describe('typography, display and effects', () => {
  it('arbitrary font sizes, families and weights', () => {
    expect(asMap('text-[0.813rem]')).toEqual({ 'font-size': '0.813rem' });
    expect(asMap("font-['DM_Sans',sans-serif]")).toEqual({ 'font-family': "'DM Sans',sans-serif" });
    expect(asMap('font-[500]')).toEqual({ 'font-weight': '500' });
    expect(asMap('tracking-[0.0875px]')).toEqual({ 'letter-spacing': '0.0875px' });
    expect(asMap('text-sm/6')).toEqual({ 'font-size': '--text-sm', 'line-height': '1.5rem' });
  });

  it('keyword utilities', () => {
    expect(asMap('inline-flex')).toEqual({ display: 'inline-flex' });
    expect(asMap('hidden')).toEqual({ display: 'none' });
    expect(asMap('items-start')).toEqual({ 'align-items': 'flex-start' });
    expect(asMap('justify-between')).toEqual({ 'justify-content': 'space-between' });
    expect(asMap('flex-col')).toEqual({ 'flex-direction': 'column' });
    expect(asMap('uppercase')).toEqual({ 'text-transform': 'uppercase' });
    expect(asMap('no-underline')).toEqual({ 'text-decoration-line': 'none' });
    expect(asMap('italic')).toEqual({ 'font-style': 'italic' });
    expect(asMap('opacity-50')).toEqual({ opacity: '0.5' });
  });

  it('shadow-[…] is exact; a theme shadow sets the shadow layer in cascade order — touched, value unknown', () => {
    expect(asMap('shadow-[0_4px_16px_rgba(0,0,0,0.1)]')).toEqual({ 'box-shadow': '0 4px 16px rgba(0,0,0,0.1)' });
    expect(asMap('shadow-[var(--shadow-token)]')).toEqual({ 'box-shadow': '--shadow-token' });
    for (const utility of ['shadow-md', 'shadow-2xs', 'shadow-inner', 'shadow-md/50', 'shadow-[0_1px_2px_#000]/50']) {
      expect(analyzeUtility(utility, ctx), utility).toMatchObject({ declarations: null, touched: ['box-shadow'], layered: [] });
    }
  });

  // Regression (review A-4): Tailwind v4 composes rings, ring offsets, inset rings/shadows and shadow colors
  // with shadow-*'s own layer into ONE box-shadow, whatever the class order (compiled 4.2.4: shadow-[…] is
  // `0 4px 16px var(--tw-shadow-color, …)`, ring-1 sets --tw-ring-shadow, shadow-black/10 sets --tw-shadow-color).
  it('rings, ring offsets, inset rings/shadows and shadow colors are layers of box-shadow, not values in cascade order', () => {
    for (const utility of ['ring', 'ring-1', 'ring-black/10', 'ring-inset', 'ring-offset-2', 'inset-ring-2', 'inset-shadow-sm', 'inset-shadow-black/10', 'shadow-black/10', 'shadow-red-500', 'shadow-current', 'shadow-transparent', 'shadow-[#000]', 'shadow-[color:var(--brand)]']) {
      expect(analyzeUtility(utility, ctx), utility).toMatchObject({ declarations: null, touched: [], layered: ['box-shadow'] });
    }
    // A key only a consumer's @theme could define may be a shadow or a color: a layer, with the reason.
    expect(analyzeUtility('shadow-card', ctx)).toMatchObject({ layered: ['box-shadow'], reason: expect.stringMatching(/--shadow-card or --color-card/) });
  });

  it('gradients are composite and unsupported; utilities that set nothing extracted return null', () => {
    expect(analyzeUtility('bg-gradient-to-r', ctx)).toMatchObject({ declarations: null, touched: ['background-image'] });
    for (const utility of ['from-transparent', 'transition-all', 'cursor-pointer', 'relative', 'z-10', 'overflow-hidden', 'text-center', 'flex-1', 'translate-x-0', 'group']) {
      expect(analyzeUtility(utility, ctx), utility).toEqual({ declarations: null, touched: [], layered: [], reason: null });
    }
  });

  it('arbitrary properties go through the same longhand expansion', () => {
    expect(asMap('[color:red]')).toEqual({ color: 'red' });
    expect(asMap('[background-image:var(--gradient)]')).toEqual({ 'background-image': '--gradient' });
  });
});

describe('cssPropertyDeclarations (inline styles)', () => {
  it('expands box shorthands per side and keeps exact var() as tokens', () => {
    expect(cssPropertyDeclarations('padding', '12px 24px', ctx).declarations.map((d) => [d.property, d.literal])).toEqual([
      ['padding-top', '12px'],
      ['padding-right', '24px'],
      ['padding-bottom', '12px'],
      ['padding-left', '24px'],
    ]);
    expect(cssPropertyDeclarations('font-size', 'var(--size-token)', ctx).declarations).toEqual([{ property: 'font-size', token: '--size-token', literal: null }]);
  });

  it('border-color → top color, border → width/style/color, background → color or image', () => {
    expect(cssPropertyDeclarations('border-color', 'rgba(0,0,0,0.12)', ctx).declarations).toEqual([{ property: 'border-top-color', token: null, literal: 'rgba(0,0,0,0.12)' }]);
    const border = cssPropertyDeclarations('border', '1px solid #e5e5e5', ctx).declarations;
    expect(border.filter((d) => d.property.endsWith('-width'))).toHaveLength(4);
    expect(border.find((d) => d.property === 'border-top-style')?.literal).toBe('solid');
    expect(border.find((d) => d.property === 'border-top-color')?.literal).toBe('#e5e5e5');
    expect(cssPropertyDeclarations('background', 'var(--gradient)', ctx).declarations[0]).toEqual({ property: 'background-image', token: '--gradient', literal: null });
  });

  it('non-extracted properties set nothing; CSS-wide keywords and `font` are touched, never guessed', () => {
    expect(cssPropertyDeclarations('transition-duration', '300ms', ctx)).toEqual({ declarations: [], touched: [] });
    expect(cssPropertyDeclarations('color', 'inherit', ctx)).toEqual({ declarations: [], touched: ['color'] });
    expect(cssPropertyDeclarations('font', '500 16px/1.5 sans-serif', ctx).touched).toContain('font-size');
  });
});
