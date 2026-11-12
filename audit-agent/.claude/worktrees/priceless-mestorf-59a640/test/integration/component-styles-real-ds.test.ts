import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { effectiveTokenMap } from '../../src/ds/catalog.ts';
import { resolveToken } from '../../src/ds/d3-tokens/resolve.ts';
import {
  buildComponentStyleModel,
  componentStyleModelFromSource,
  dimensionLabel,
  enumerateAssignments,
  expectationsFor,
  UNSET_VALUE,
  type Assignment,
  type ComponentStyleModel,
} from '../../src/ds/component-styles.ts';
import { compareToExpected } from '../../src/t-layer/token-comparator.ts';

/**
 * Component style models against the REAL Design System source and tokens.
 * Every expectation asserted here was read off the component file itself;
 * the comparator round-trip at the end proves the token names the model
 * emits exist in the effective layer and resolve to the rendered values.
 */

const FILES = ['atoms/Button.tsx', 'atoms/CTALink.tsx', 'atoms/InlineLink.tsx', 'atoms/TextLink.tsx', 'atoms/Badge.tsx', 'atoms/Card.tsx'] as const;

let registry: DsRegistry;
let tokens: Map<string, string>;
const models = new Map<string, ComponentStyleModel>();

beforeAll(async () => {
  registry = await loadDsRegistry(loadConfig().designSystemPath);
  tokens = effectiveTokenMap(registry, 'editorial-light');
  for (const file of FILES) {
    const model = await buildComponentStyleModel(registry, file);
    if (!model) throw new Error(`no style model for ${file}`);
    models.set(file, model);
  }
}, 120_000);

const model = (file: (typeof FILES)[number]) => models.get(file) as ComponentStyleModel;
const byProperty = (file: (typeof FILES)[number], assignment: Assignment, viewportWidth = 1440) =>
  Object.fromEntries(expectationsFor(model(file), assignment, { viewportWidth }).map((e) => [e.property, e]));
const CORNERS = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];

describe('atoms/Button.tsx', () => {
  it('dimensions come from the destructured props: the variant/size/background unions plus booleans', () => {
    const dims = Object.fromEntries(model('atoms/Button.tsx').dimensions.map((d) => [d.name, d]));
    expect(dims.variant).toMatchObject({ kind: 'union', values: ['primary', 'secondary', 'ghost', 'brand'], defaultValue: 'primary' });
    expect(dims.size).toMatchObject({ kind: 'union', values: ['xs', 'sm', 'md', 'lg', 'xl'], defaultValue: 'md' });
    expect(dims.background).toMatchObject({ kind: 'union', values: ['light', 'dark'], defaultValue: 'light' });
    expect(dims.iconOnly).toMatchObject({ kind: 'boolean', values: ['false', 'true'], defaultValue: 'false' });
    expect(dims.fullWidth?.kind).toBe('boolean');
    // Its <a href> and <button> roots pass the same className/style: one root, no $root dimension.
    expect(dims.$root).toBeUndefined();
  });

  it('size=md: height, padding, min-width, font size, tracking, weight and radius — each traced to its source', () => {
    const e = byProperty('atoms/Button.tsx', { size: 'md' });
    expect(e.height).toMatchObject({ token: '--button-height-md', literal: null });
    expect(e['padding-left']).toMatchObject({ token: '--button-px-md' });
    expect(e['padding-right']).toMatchObject({ token: '--button-px-md' });
    expect(e['min-width']).toMatchObject({ token: '--button-min-width-md' });
    expect(e['font-size']).toMatchObject({ token: '--button-font-md' });
    expect(e['font-size']?.why).toMatch(/^atoms\/Button\.tsx: fontSize: 'var\(--button-font-md\)'.*size=md/); // the inline-style fontStyle map
    expect(e['letter-spacing']).toMatchObject({ token: null, literal: '0.0875px' });
    expect(e['font-weight']).toMatchObject({ token: '--font-weight-medium' });
    expect(e['font-weight']?.why).toContain('font-medium');
    for (const corner of CORNERS) expect(e[corner], corner).toMatchObject({ token: '--radius-button' });
    expect(e.height?.why).toBe('atoms/Button.tsx: h-[var(--button-height-md)] [iconOnly=false, size=md]');
  });

  it('variant=brand: the gradient token and the REST box-shadow — never the hover one', () => {
    const e = byProperty('atoms/Button.tsx', { variant: 'brand' });
    expect(e['background-image']).toMatchObject({ token: '--composition-gradient-brand-red-shimmer' });
    expect(e['box-shadow']).toMatchObject({ token: null, literal: '0 4px 16px rgba(176,31,36,0.15)' });
    const hoverShadow = '0 12px 32px rgba(176,31,36,0.25)';
    expect(model('atoms/Button.tsx').rules.some((r) => r.literal === hoverShadow)).toBe(false);
  });

  it('variant=secondary on light: bg-white and the inline rest color rgba(0,0,0,0.70)', () => {
    const e = byProperty('atoms/Button.tsx', { variant: 'secondary', background: 'light' });
    expect(e['background-color']).toMatchObject({ token: null, literal: '#fff' });
    expect(e['background-color']?.why).toContain('bg-white');
    expect(e.color).toMatchObject({ token: null, literal: 'rgba(0,0,0,0.70)' });
    expect(e['border-top-color']).toMatchObject({ literal: 'rgba(0,0,0,0.12)' });
    // The hover brand-red is runtime state (isHovering), never an expectation.
    expect(model('atoms/Button.tsx').rules.some((r) => r.property === 'color' && r.literal === 'var(--brand-red)')).toBe(false);
  });

  it('nothing from the shimmer overlay child, the ripple or the spinner reaches the root', () => {
    const m = model('atoms/Button.tsx');
    for (const childClass of ['w-[200%]', 'absolute', 'inset-0', 'animate-spin', '-translate-x-1/2', 'pointer-events-none', 'z-10']) {
      expect(m.classTokens, childClass).not.toContain(childClass);
      expect(m.rules.some((r) => r.source.split(/\s+/).includes(childClass)), childClass).toBe(false);
    }
  });

  it('state-prefixed classes are fingerprintable; hover/focus/active ones never become rules, disabled: ones only value-less rules', () => {
    const m = model('atoms/Button.tsx');
    expect(m.classTokens).toContain('hover:bg-white/[0.05]');
    expect(m.classTokens).toContain('focus-visible:ring-2');
    expect(m.rules.some((r) => /(^|:)(hover|focus-visible|active):/.test(r.source))).toBe(false);
    // A disabled Button renders disabled:text-black/40 — the model cannot know which instance is disabled.
    const disabledRules = m.rules.filter((r) => /(^|:)disabled:/.test(r.source));
    expect(disabledRules.length).toBeGreaterThan(0);
    expect(disabledRules.every((r) => r.token === null && r.literal === null)).toBe(true);
  });

  it('the caller-provided className is noted, not guessed', () => {
    expect(model('atoms/Button.tsx').notes.some((n) => n.includes('className') && n.includes('caller'))).toBe(true);
  });

  it('layout-dependent width (w-full sm:w-auto) is never expected; an icon-only button\'s fixed width is', () => {
    expect(byProperty('atoms/Button.tsx', {}, 1440).width).toBeUndefined();
    expect(byProperty('atoms/Button.tsx', {}, 375).width).toBeUndefined();
    expect(byProperty('atoms/Button.tsx', { iconOnly: 'true' }).width).toMatchObject({ token: '--button-height-md' });
    expect(byProperty('atoms/Button.tsx', { iconOnly: 'true', size: 'xs' }).width).toMatchObject({ literal: '1.75rem' });
  });

  it('labels and enumerates assignments, defaults first', () => {
    const m = model('atoms/Button.tsx');
    expect(dimensionLabel(m, { variant: 'brand', size: 'sm' })).toBe('brand · sm · light');
    const all = enumerateAssignments(m);
    expect(all[0]).toEqual({ variant: 'primary', size: 'md', background: 'light', fullWidth: 'false', pill: 'false', iconOnly: 'false' });
    expect(all.length).toBeLessThanOrEqual(1024);
    expect(all.some((a) => a.variant === 'brand' && a.size === 'xl')).toBe(true);
    expect(enumerateAssignments(m, 5)).toHaveLength(5);
  });
});

describe('atoms/CTALink.tsx', () => {
  it('font-weight 500 and no color (the color is on the inner span)', () => {
    for (const size of ['sm', 'md', 'lg']) {
      const e = byProperty('atoms/CTALink.tsx', { size });
      expect(e['font-weight']?.token).toBe('--font-weight-medium');
      expect(resolveToken(e['font-weight']?.token as string, tokens)).toBe('500');
      expect(e.color, size).toBeUndefined();
    }
  });

  it('text-[var(--typography-size-*)] is what Tailwind v4 compiles to `color`: no font size is expected, and the note says why', () => {
    const m = model('atoms/CTALink.tsx');
    for (const size of ['sm', 'md', 'lg']) expect(byProperty('atoms/CTALink.tsx', { size })['font-size'], size).toBeUndefined();
    expect(m.classTokens).toEqual(expect.arrayContaining(['text-[var(--typography-size-sm)]', 'text-[var(--typography-size-base)]', 'text-[var(--typography-size-lg)]']));
    expect(m.notes.some((n) => n.startsWith('text-[var(--typography-size-sm)]: Tailwind v4 compiles') && n.includes('not a color'))).toBe(true);
  });
});

describe('atoms/InlineLink.tsx', () => {
  it('variant=solid → the brand-red color token and no underline', () => {
    const e = byProperty('atoms/InlineLink.tsx', { variant: 'solid' });
    expect(e.color).toMatchObject({ token: '--color-brand-red' });
    expect(e['text-decoration-line']).toMatchObject({ literal: 'none' });
  });

  it('default → underline in brand red over --surface-text', () => {
    const e = byProperty('atoms/InlineLink.tsx', {});
    expect(e['text-decoration-line']).toMatchObject({ literal: 'underline' });
    expect(e['text-decoration-color']).toMatchObject({ token: '--color-brand-red' });
    expect(e.color).toMatchObject({ token: '--surface-text' });
  });

  it('onDark=true → white at 70%', () => {
    const e = byProperty('atoms/InlineLink.tsx', { onDark: 'true' });
    expect(e.color).toMatchObject({ token: null, literal: 'rgba(255, 255, 255, 0.7)' });
    expect(e.color?.why).toContain('text-white/70');
  });
});

describe('atoms/TextLink.tsx', () => {
  it('size=md: the line-height token applies; the font-size class compiles to `color` and is not expected', () => {
    const e = byProperty('atoms/TextLink.tsx', { size: 'md' });
    expect(e['line-height']).toMatchObject({ token: '--typography-line-height-nav-primary' });
    expect(e['font-size']).toBeUndefined();
    expect(model('atoms/TextLink.tsx').notes.some((n) => n.startsWith('text-[var(--typography-size-nav-primary)]'))).toBe(true);
  });

  it('active=false → --surface-text-muted; active=true → brand red (the later class wins over the size class)', () => {
    expect(byProperty('atoms/TextLink.tsx', { active: 'false' }).color).toMatchObject({ token: '--surface-text-muted' });
    expect(byProperty('atoms/TextLink.tsx', { active: 'true' }).color).toMatchObject({ token: '--color-brand-red' });
  });

  it('font-[var(--typography-family-body)] compiles to font-weight and loses to the later font-normal', () => {
    expect(byProperty('atoms/TextLink.tsx', {})['font-weight']).toMatchObject({ token: '--font-weight-normal' });
    expect(byProperty('atoms/TextLink.tsx', {})['font-family']).toBeUndefined();
  });

  it('its <a> and <button> roots differ: $root picks one, and unset only the shared properties are expected', () => {
    const m = model('atoms/TextLink.tsx');
    expect(m.dimensions.find((d) => d.name === '$root')?.values).toEqual(['a', 'button']);
    expect(byProperty('atoms/TextLink.tsx', { $root: 'button' })['background-color']).toMatchObject({ literal: 'transparent' });
    expect(byProperty('atoms/TextLink.tsx', { $root: 'a' })['background-color']).toBeUndefined();
    expect(byProperty('atoms/TextLink.tsx', {})['background-color']).toBeUndefined();
    expect(byProperty('atoms/TextLink.tsx', {}).display).toMatchObject({ literal: 'inline-flex' });
    expect(dimensionLabel(m, { $root: 'button' })).toBe('sm');
  });
});

describe('atoms/Badge.tsx and atoms/Card.tsx — nested lookup maps', () => {
  it('Badge pill/md/brand/bordered: per-theme colors, per-size×variant padding, the pill radius', () => {
    const e = byProperty('atoms/Badge.tsx', { variant: 'pill', size: 'md', theme: 'brand', bordered: 'true' });
    expect(e['background-color']).toMatchObject({ token: '--color-brand-red' });
    expect(e.color).toMatchObject({ token: '--color-foundation-white' });
    expect(e['border-top-color']).toMatchObject({ token: '--color-brand-red' });
    expect(e['border-top-width']).toMatchObject({ literal: '1px' });
    expect(e['padding-left']).toMatchObject({ literal: '1rem' });
    expect(e['padding-top']).toMatchObject({ literal: '0.375rem' });
    expect(e['border-top-left-radius']).toMatchObject({ literal: '9999px' });
    expect(e['max-width']).toMatchObject({ literal: '200px' });
  });

  it('Badge minimal: transparent, unbordered even when bordered=true', () => {
    const e = byProperty('atoms/Badge.tsx', { variant: 'minimal', bordered: 'true' });
    expect(e['background-color']).toMatchObject({ literal: 'transparent' });
    expect(e['border-top-width']).toBeUndefined();
  });

  it('Card defaults: the shadow and padding tokens; shadow=none leaves box-shadow unexpected', () => {
    const e = byProperty('atoms/Card.tsx', {});
    expect(e['box-shadow']).toMatchObject({ token: '--shadow-md' });
    expect(e['padding-top']).toMatchObject({ token: '--spacing-6' });
    for (const corner of CORNERS) expect(e[corner]).toMatchObject({ token: '--radius-card' });
    expect(byProperty('atoms/Card.tsx', { shadow: 'none' })['box-shadow']).toBeUndefined();
  });
});

describe('the emitted tokens exist and resolve to the rendered values (comparator round-trip)', () => {
  const compare = (actual: Record<string, string>, expected: ReturnType<typeof expectationsFor>) =>
    compareToExpected({
      actual,
      expected: expected.map((e) => ({ property: e.property, token: e.token, literal: e.literal })),
      effectiveTokens: tokens,
      rootFontSizePx: 16,
      box: { width: 180, height: 48 },
    });

  // Chromium's computed style for a correctly built <Button variant="brand" size="md">.
  const brandMd: Record<string, string> = {
    color: 'rgb(255, 255, 255)',
    'background-image': 'linear-gradient(90deg, rgb(176, 31, 36) 0%, rgb(235, 72, 78) 50%, rgb(176, 31, 36) 100%)',
    'font-size': '16px',
    'font-weight': '500',
    'letter-spacing': '0.0875px',
    'padding-left': '28px',
    'padding-right': '28px',
    'row-gap': '8px',
    'column-gap': '8px',
    'border-top-left-radius': '5px',
    'border-top-right-radius': '5px',
    'border-bottom-right-radius': '5px',
    'border-bottom-left-radius': '5px',
    'box-shadow': 'rgba(176, 31, 36, 0.15) 0px 4px 16px 0px',
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'center',
    height: '48px',
    'min-width': '112px',
  };

  it('every token the Button model names is defined in the effective layer', () => {
    for (const file of FILES) {
      for (const rule of model(file).rules) if (rule.token) expect(tokens.has(rule.token), `${file}: ${rule.token}`).toBe(true);
    }
  });

  it('Button md/brand: every expectation passes against the right values — none mismatched, none unresolved', () => {
    const expected = expectationsFor(model('atoms/Button.tsx'), { variant: 'brand', size: 'md' }, { viewportWidth: 1440 });
    const r = compare(brandMd, expected);
    expect(r.mismatches).toEqual([]);
    expect(r.unresolved).toEqual([]);
    expect([...r.passed].sort()).toEqual(expected.map((e) => e.property).sort());
    expect(r.passed).toEqual(expect.arrayContaining(['height', 'min-width', 'font-size', 'background-image', 'box-shadow']));
  });

  it('…and the real 44px CTA is still caught, as is the hover shadow at rest', () => {
    const expected = expectationsFor(model('atoms/Button.tsx'), { variant: 'brand', size: 'md' }, { viewportWidth: 1440 });
    expect(compare({ ...brandMd, height: '44px' }, expected).mismatches).toEqual([expect.objectContaining({ property: 'height', delta: -4 })]);
    expect(compare({ ...brandMd, 'box-shadow': 'rgba(176, 31, 36, 0.25) 0px 12px 32px 0px' }, expected).mismatches.map((m) => m.property)).toEqual(['box-shadow']);
  });

  it('Button md/secondary/light passes the same way', () => {
    const expected = expectationsFor(model('atoms/Button.tsx'), { variant: 'secondary', background: 'light', size: 'md' }, { viewportWidth: 1440 });
    const actual: Record<string, string> = {
      ...brandMd,
      color: 'rgba(0, 0, 0, 0.7)',
      'background-color': 'rgb(255, 255, 255)',
      'background-image': 'none',
      'border-top-width': '1.5px',
      'border-right-width': '1.5px',
      'border-bottom-width': '1.5px',
      'border-left-width': '1.5px',
      'border-top-color': 'rgba(0, 0, 0, 0.12)',
      'box-shadow': 'rgba(0, 0, 0, 0.04) 0px 2px 8px 0px',
    };
    const r = compare(actual, expected);
    expect(r.mismatches).toEqual([]);
    expect(r.unresolved).toEqual([]);
    expect(r.passed).toHaveLength(expected.length);
  });
});

describe('walk semantics on small synthetic components (real DS tokens)', () => {
  const build = (source: string) => {
    const m = componentStyleModelFromSource('atoms/Probe.tsx', source, tokens);
    if (!m) throw new Error('no model');
    return m;
  };
  const props = (m: ComponentStyleModel, a: Assignment = {}, viewportWidth = 1440) =>
    Object.fromEntries(expectationsFor(m, a, { viewportWidth }).map((e) => [e.property, e.token ?? e.literal]));

  it('a condition on a non-dimension prop yields no rule — its classes are fingerprinted only', () => {
    const m = build(`
      import { cn } from '../lib/cn';
      export function Probe({ href, className }: { href?: string; className?: string }) {
        return <a className={cn('text-black', href ? 'text-white' : '', className)} />;
      }`);
    expect(props(m).color).toBeUndefined();
    expect(m.classTokens).toEqual(['text-black', 'text-white']);
  });

  it('React state: useState(false) takes the rest branch; a hook\'s `mounted` is unknown', () => {
    const m = build(`
      import { useState } from 'react';
      export function Probe() {
        const [isHovering] = useState(false);
        const { mounted } = useMounted();
        return <div className={isHovering ? 'bg-black' : 'bg-white'} style={{ opacity: mounted ? 1 : 0 }} />;
      }`);
    expect(props(m)['background-color']).toBe('#fff');
    expect(props(m).opacity).toBeUndefined();
    expect(m.classTokens).toContain('bg-black');
  });

  it('a class glued to a ${} span is a fragment Tailwind never generated — skipped and noted', () => {
    const m = build(`
      type ProbeSize = 'sm' | 'md';
      export function Probe({ size = 'md' }: { size?: ProbeSize }) {
        return <div className={\`h-[var(--button-height-\${size})] px-4\`} />;
      }`);
    expect(props(m).height).toBeUndefined();
    expect(props(m)['padding-left']).toBe('1rem');
    expect(m.classTokens).toEqual(['px-4']);
    expect(m.notes.some((n) => n.includes('glued'))).toBe(true);
  });

  it('switch in a helper, props.x on an un-destructured props object, and an optional union without default', () => {
    const m = build(`
      type Tone = 'quiet' | 'loud';
      interface ProbeProps { tone?: Tone; surface?: 'light' | 'dark' }
      const toneClass = (tone: Tone) => {
        switch (tone) {
          case 'loud': return 'font-bold';
          default: return 'font-normal';
        }
      };
      export function Probe(props: ProbeProps) {
        const { tone = 'quiet' } = props;
        return <div className={toneClass(tone)} style={props.surface ? { color: '#111111' } : undefined} />;
      }`);
    expect(props(m)['font-weight']).toBe('--font-weight-normal');
    expect(props(m, { tone: 'loud' })['font-weight']).toBe('--font-weight-bold');
    const surface = m.dimensions.find((d) => d.name === 'surface');
    expect(surface).toMatchObject({ values: ['light', 'dark', UNSET_VALUE], defaultValue: UNSET_VALUE });
    expect(props(m).color).toBeUndefined();
    expect(props(m, { surface: 'dark' }).color).toBe('#111111');
  });

  it('breakpoints apply by viewport; inline style beats a class; !important beats inline style', () => {
    const m = build(`
      export function Probe() {
        return <div className="p-2 sm:p-4 text-black !bg-white" style={{ color: 'rgb(1, 2, 3)', backgroundColor: 'red' }} />;
      }`);
    expect(props(m, {}, 375)['padding-top']).toBe('0.5rem');
    expect(props(m, {}, 1440)['padding-top']).toBe('1rem');
    expect(props(m).color).toBe('rgb(1, 2, 3)');
    expect(props(m)['background-color']).toBe('#fff');
  });

  it('a custom property set inline shadows the global token: expectations naming it are dropped', () => {
    const m = build(`
      export function Probe() {
        return <div className="h-[var(--button-height-md)] w-[var(--button-height-sm)]" style={{ '--button-height-md': '40px' } as React.CSSProperties} />;
      }`);
    expect(props(m).height).toBeUndefined();
    expect(props(m).width).toBe('--button-height-sm');
  });

  it('framer-motion targets on a motion.* root are never expected', () => {
    const m = build(`
      export function Probe() {
        return <motion.div className="opacity-50 p-2" initial={{ opacity: 0 }} animate={{ opacity: 1 }} />;
      }`);
    expect(props(m).opacity).toBeUndefined();
    expect(props(m)['padding-top']).toBe('0.5rem');
  });

  // Regression (review A-1): a state the component sets itself (onLoad, an effect's timer) — or one the capture
  // changes by clicking disclosures open — is not at its initial value on a live page, whatever its name.
  it('useState is read at its initial value only when nothing but pointer/focus/keyboard interaction can change it', () => {
    const m = build(`
      import { useEffect, useState } from 'react';
      export function Probe() {
        const [loaded, setLoaded] = useState(false);
        const [isHovering, setIsHovering] = useState(false);
        const [isActive, setIsActive] = useState(false);
        const [isFocused, setIsFocused] = useState(false);
        const [pressed] = useState(false);
        useEffect(() => {
          const id = setTimeout(() => setIsActive(true), 10);
          return () => clearTimeout(id);
        }, [setIsActive]);
        const onEnter = () => setIsHovering(true);
        return (
          <img
            onLoad={() => setLoaded(true)}
            onMouseEnter={onEnter}
            onMouseLeave={() => setIsHovering(false)}
            onClick={() => setIsFocused(true)}
            className={cn(isHovering ? 'bg-black' : 'bg-white', isActive ? 'text-black' : 'text-white', isFocused ? 'p-4' : 'p-2', pressed ? 'mt-4' : 'mt-2')}
            style={{ opacity: loaded ? 1 : 0 }}
          />
        );
      }`);
    const e = Object.fromEntries(expectationsFor(m, {}, { viewportWidth: 1440 }).map((x) => [x.property, x]));
    expect(e.opacity).toBeUndefined(); // set by onLoad
    expect(e['background-color']).toMatchObject({ literal: '#fff' }); // hover state, set only from mouse handlers (one via a local handler)
    expect(e['background-color']?.why).toBe('atoms/Probe.tsx: bg-white (at rest: isHovering=false)');
    expect(e.color).toBeUndefined(); // an interaction name, but set from an effect's timer
    expect(e['padding-top']).toBeUndefined(); // set by onClick — the capture clicks tabs/accordions open
    expect(e['margin-top']).toMatchObject({ literal: '0.5rem' }); // no setter: it never changes
    expect(m.classTokens).toEqual(expect.arrayContaining(['bg-black', 'text-black', 'p-4', 'mt-4']));
  });

  // Regression (review A-2): disabled:/aria-*/data-*/last: gate what real instances render; when they apply
  // they beat every plain class on specificity, so class order cannot rescue the rest value.
  it('an element-state or structural class leaves its properties without expectation, whatever the class order; hover: does not', () => {
    const m = build(`
      export function Probe() {
        return <div className="pb-4 mb-4 last:mb-0 last:pb-0 hover:pt-0 pt-4 aria-invalid:border-black border-white/10 bg-white data-[state=open]:bg-black" />;
      }`);
    const p = props(m);
    for (const property of ['padding-bottom', 'margin-bottom', 'border-top-color', 'background-color']) expect(p[property], property).toBeUndefined();
    expect(p['padding-top']).toBe('1rem');
    const before = build(`export function Probe() { return <div className="disabled:opacity-50 opacity-100 last:mb-0 md:mb-2" />; }`);
    expect(props(before).opacity).toBeUndefined();
    expect(props(before, {}, 1440)['margin-bottom']).toBeUndefined();
    expect(props(before, {}, 375)['margin-bottom']).toBeUndefined();
  });

  // Regression (review A-3): Tailwind orders breakpoint rules by its compareBreakpoints (unit bucket, then
  // number) and by the bit set of stacked variants — not by width.
  it('breakpoint rules win in Tailwind\'s stylesheet order', () => {
    const at = (cls: string, vw: number) => props(build(`export function Probe() { return <div className="${cls}" />; }`), {}, vw);
    expect(at('p-5 md:p-8 min-[900px]:p-6', 1440)['padding-left']).toBe('2rem');
    expect(at('p-5 max-lg:p-2 max-[900px]:p-7', 800)['padding-left']).toBe('0.5rem');
    expect(at('p-5 md:p-8 min-[50rem]:p-6', 1440)['padding-left']).toBe('1.5rem');
    expect(at('md:max-lg:hidden md:flex', 800).display).toBe('none');
    expect(at('md:max-lg:hidden md:flex', 1440).display).toBe('flex');
  });

  // Regression (review A-4): rings, inset shadows and shadow colors compose with shadow-* into one box-shadow.
  it('a ring, inset shadow or shadow color joins the composite box-shadow in any class order — only an inline boxShadow is expected', () => {
    const shadowOf = (jsx: string, vw = 1440) => props(build(`export function Probe() { return ${jsx}; }`), {}, vw)['box-shadow'];
    for (const cls of ['ring-1 ring-black/10 shadow-[0_4px_16px_rgba(0,0,0,0.15)]', 'shadow-[0_4px_16px_rgba(0,0,0,0.15)] ring-1', 'ring-1 shadow-none', 'inset-shadow-sm shadow-[0_1px_2px_#000]', 'shadow-black/10 shadow-[0_4px_16px_rgba(0,0,0,0.15)]']) {
      expect(shadowOf(`<div className="${cls}" />`), cls).toBeUndefined();
    }
    expect(shadowOf(`<div className="ring-1 shadow-[0_1px_2px_#000]" style={{ boxShadow: '0 0 0 2px #fff' }} />`)).toBe('0 0 0 2px #fff');
    expect(shadowOf(`<div className="md:ring-1 shadow-[0_1px_2px_#000]" />`, 375)).toBe('0 1px 2px #000');
    expect(shadowOf(`<div className="md:ring-1 shadow-[0_1px_2px_#000]" />`, 1440)).toBeUndefined();
    expect(shadowOf(`<div className="focus-visible:ring-2 shadow-[0_1px_2px_#000]" />`)).toBe('0 1px 2px #000');
  });

  // Regression (review A-5): omitted, an optional boolean is `undefined`, and `undefined === false` is false.
  it('`prop === false` on an optional boolean without a default holds for only part of its "false" value', () => {
    const m = build(`
      interface ProbeProps { divider?: boolean; strong?: boolean }
      export function Probe({ divider, strong = false }: ProbeProps) {
        return <div className={cn(divider === false ? 'pb-0' : 'pb-4', strong === false ? 'font-normal' : 'font-bold', divider === true ? 'mt-1' : 'mt-2', divider === 'true' ? 'mb-1' : 'mb-2')} />;
      }`);
    expect(props(m)['padding-bottom']).toBeUndefined(); // omitted → pb-4, explicit false → pb-0
    expect(props(m, { divider: 'true' })['padding-bottom']).toBe('1rem');
    expect(props(m)['font-weight']).toBe('--font-weight-normal'); // with a default it is never undefined: exact
    expect(props(m)['margin-top']).toBe('0.5rem'); // `=== true` stays exact
    expect(props(m, { divider: 'true' })['margin-top']).toBe('0.25rem');
    expect(props(m, { divider: 'true' })['margin-bottom']).toBe('0.5rem'); // strict equality never crosses types
  });

  // Regression (review A-6): the model is named after the declaration findComponent matched, not the file.
  it('a kebab-case file is named after the component it declares', () => {
    const m = componentStyleModelFromSource('ui/probe-box.tsx', 'export function ProbeBox() { return <><div className="p-1" /></>; }', tokens);
    expect(m?.component).toBe('ProbeBox');
    expect(m?.notes.some((n) => n.startsWith('ProbeBox returns a Fragment'))).toBe(true);
  });
});

describe('review A regressions on the real DS components', () => {
  const real = async (file: string) => {
    const m = await buildComponentStyleModel(registry, file);
    if (!m) throw new Error(`no style model for ${file}`);
    return m;
  };
  const expected = (m: ComponentStyleModel, a: Assignment = {}) => Object.fromEntries(expectationsFor(m, a, { viewportWidth: 1440 }).map((e) => [e.property, e]));

  it('A-1: RevealImage (onLoad) and BackToTop (scroll listener) publish no opacity; Button\'s mouse-only hover state keeps its rest shadow, marked as such', async () => {
    expect(expected(await real('molecules/RevealImage.tsx')).opacity).toBeUndefined();
    expect(expected(await real('molecules/BackToTop.tsx')).opacity).toBeUndefined();
    const shadow = byProperty('atoms/Button.tsx', { variant: 'primary' })['box-shadow'];
    expect(shadow).toMatchObject({ literal: '0 2px 8px rgba(0,0,0,0.15)' });
    expect(shadow?.why).toBe("atoms/Button.tsx: boxShadow: '0 2px 8px rgba(0,0,0,0.15)' [variant=primary] (at rest: isHovering=false)");
  });

  it('A-2: the last CheckboxFilterSection and a disabled / aria-invalid Input: no expectation for the properties those states restyle', async () => {
    const section = expected(await real('molecules/CheckboxFilterSection.tsx'));
    expect(section['padding-bottom']).toBeUndefined();
    expect(section['margin-bottom']).toBeUndefined();
    const input = expected(await real('ui/input.tsx'));
    for (const property of ['color', 'background-color', 'border-top-color']) expect(input[property], property).toBeUndefined();
    expect(input['border-top-width']).toMatchObject({ literal: '1px' }); // not state-gated: still expected
  });

  it('A-6: shadcn files are named after the component they export', async () => {
    expect((await real('ui/input.tsx')).component).toBe('Input');
    expect((await real('ui/alert-dialog.tsx')).component).toBe('AlertDialog');
    expect((await real('ui/toggle-group.tsx')).component).toBe('ToggleGroup');
  });
});

describe('every component file in the real DS', () => {
  it('builds (or is honestly absent) without throwing', async () => {
    let built = 0;
    for (const file of registry.components.componentFiles) {
      const m = await buildComponentStyleModel(registry, file);
      if (!m) continue;
      built++;
      for (const a of enumerateAssignments(m, 20)) expectationsFor(m, a, { viewportWidth: 1440 });
    }
    expect(built).toBeGreaterThan(250);
  }, 60_000);

  it('caches per (dsRegistryVersion, file)', async () => {
    expect(await buildComponentStyleModel(registry, 'atoms/Button.tsx')).toBe(model('atoms/Button.tsx'));
    expect(await buildComponentStyleModel(registry, 'atoms/DoesNotExist.tsx')).toBeNull();
  });
});
