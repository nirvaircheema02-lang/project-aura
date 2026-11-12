import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assessColour,
  buildDsColourIndex,
  COLOUR_RULES,
  compositeOver,
  contrastRatio,
  deltaE2000,
  evaluateColourVisible,
  extractColours,
  inferTokenRole,
  mapReferenceColour,
  parseCssColour,
  roleForProperty,
  stateDistinctness,
  strengthOf,
  type ColourContext,
  type ReferenceColourInput,
  type Rgb,
} from '../../src/resolution/ds-colours.ts';
import { buildDsTokenIndex } from '../../src/resolution/ds-evidence.ts';
import { cleanupDsFixtures, miniDsIndex, REAL_DS } from '../helpers/ds-colour-fixture.ts';

afterAll(cleanupDsFixtures);

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const WARM: Rgb = { r: 245, g: 242, b: 241 };
const DARK: Rgb = { r: 17, g: 17, b: 20 };

describe('parseCssColour', () => {
  it('reads hex, rgb()/rgba() in both syntaxes, hsl() and named colours to the same rgba', () => {
    const black8 = { r: 0, g: 0, b: 0, alpha: 0.08 };
    for (const s of ['rgba(0,0,0,.08)', 'rgba(0, 0, 0, 0.08)', 'rgb(0 0 0 / 8%)', 'rgb(0 0 0 / .08)', '#00000014', 'hsl(0 0% 0% / 8%)']) {
      const c = parseCssColour(s);
      expect(c, s).not.toBeNull();
      expect(c!.r).toBeCloseTo(black8.r, 0);
      expect(c!.alpha, s).toBeCloseTo(black8.alpha, 2);
    }
    expect(parseCssColour('#fff')).toMatchObject({ r: 255, g: 255, b: 255, alpha: 1 });
    expect(parseCssColour('#FFFFFF')).toMatchObject({ r: 255, alpha: 1 });
    expect(parseCssColour('#fff8')!.alpha).toBeCloseTo(0.533, 2);
    expect(parseCssColour('white')).toMatchObject({ r: 255, g: 255, b: 255, alpha: 1 });
    expect(parseCssColour('black')).toMatchObject({ r: 0, alpha: 1 });
    expect(parseCssColour('transparent')!.alpha).toBe(0);
  });

  it('rejects everything that is not a static colour: color-mix, calc, gradients, var(), keywords, bare numbers and unterminated input', () => {
    for (const s of ['color-mix(in srgb, red 50%, blue)', 'calc(1px + 2px)', 'linear-gradient(red, blue)', 'var(--x)', 'currentcolor', 'inherit', 'none', '400', 'normal', '12px', 'rgb(0,0,0', '#12', '#1234567', '', 'rgb(a b c)']) {
      expect(parseCssColour(s), s).toBeNull();
    }
  });
});

describe('extractColours', () => {
  it('finds every colour of a shorthand with its span, so a mapped token can be spliced back', () => {
    const value = '1px solid rgba(0,0,0,.08)';
    const [c] = extractColours(value);
    expect(c).toBeDefined();
    expect(value.slice(c!.start, c!.end)).toBe('rgba(0,0,0,.08)');
    expect(c!.rgba!.alpha).toBeCloseTo(0.08, 2);
    expect(extractColours('0 1px 3px rgba(0,0,0,.04), 0 1px 2px #00000005')).toHaveLength(2);
    expect(extractColours('1px solid #f5f5f5')[0]!.text).toBe('#f5f5f5');
  });

  it('does not mistake var(), url(), strings or lengths for colours (a named colour counts in every property: see ds-colours-literals.test.ts)', () => {
    expect(extractColours('1px solid var(--border-soft)')).toEqual([]);
    expect(extractColours('url(#white) no-repeat')).toEqual([]);
    expect(extractColours('10px')).toEqual([]);
    expect(extractColours('1px solid red').map((c) => c.text)).toEqual(['red']);
    expect(extractColours('1px solid currentcolor')).toEqual([]);
  });

  it('flags a gradient or color-mix() as an unsupported colour expression instead of looking inside it', () => {
    const [g] = extractColours('linear-gradient(90deg, #fff, #000)');
    expect(g).toMatchObject({ rgba: null });
    expect(g!.unsupported).toMatch(/gradient/);
    const [m] = extractColours('1px solid color-mix(in srgb, red 50%, blue)');
    expect(m!.rgba).toBeNull();
    expect(m!.unsupported).toMatch(/color-mix/);
  });
});

describe('colour maths', () => {
  it('composites alpha over a backdrop and measures how strongly a colour separates from it', () => {
    expect(compositeOver({ r: 0, g: 0, b: 0, alpha: 0.5 }, WHITE)).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
    const hash = parseCssColour('#f5f5f5')!;
    const black8 = parseCssColour('rgba(0,0,0,.08)')!;
    expect(strengthOf(hash, WHITE)).toBeCloseTo(2.01, 1);
    expect(strengthOf(hash, WARM)).toBeCloseTo(1.53, 1); // almost invisible on the warm band
    expect(strengthOf(black8, WHITE)).toBeCloseTo(4.19, 1);
    expect(strengthOf(black8, DARK)).toBeLessThan(0.5); // a black hairline disappears on a dark surface
    expect(deltaE2000(WHITE, WHITE)).toBe(0);
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, WHITE)).toBeCloseTo(21, 0);
  });
});

describe('token role / tier inference (from the DS naming)', () => {
  it('knows border, fill and text tokens, their tiers and sub-roles', () => {
    expect(inferTokenRole('--border-card')).toMatchObject({ tier: 'role', roles: ['border'], subRoles: expect.arrayContaining(['card']) });
    expect(inferTokenRole('--semantic-hairline-soft')).toMatchObject({ tier: 'semantic', roles: ['border'], subRoles: expect.arrayContaining(['hairline', 'soft']) });
    expect(inferTokenRole('--border-on-dark-section')).toMatchObject({ tier: 'role', roles: ['border'] });
    expect(inferTokenRole('--tint-soft')).toMatchObject({ tier: 'role', roles: ['fill'] });
    expect(inferTokenRole('--semantic-surface-white')).toMatchObject({ tier: 'semantic', roles: ['fill'] });
    expect(inferTokenRole('--semantic-ink-muted')).toMatchObject({ tier: 'semantic', roles: expect.arrayContaining(['text']) });
    expect(inferTokenRole('--color-ramp-black-100')).toMatchObject({ tier: 'primitive' });
    expect(inferTokenRole('--white')).toMatchObject({ tier: 'primitive' });
  });

  it('keeps component tokens out of the generic roles', () => {
    for (const t of ['--table-row-divider', '--table-open-last-row-border', '--glass-border', '--semantic-status-success-border', '--error-border', '--chart-gridline-color', '--cta-bg']) expect(inferTokenRole(t), t).toMatchObject({ tier: 'component' });
  });

  it('maps a CSS property to the role it plays', () => {
    expect(roleForProperty('border')).toBe('border');
    expect(roleForProperty('border-top-color')).toBe('border');
    expect(roleForProperty('outline-color')).toBe('border');
    expect(roleForProperty('background')).toBe('fill');
    expect(roleForProperty('background-color')).toBe('fill');
    expect(roleForProperty('color')).toBe('text');
    expect(roleForProperty('fill')).toBe('icon');
    expect(roleForProperty('box-shadow')).toBe('shadow');
    expect(roleForProperty('--border-on-dark')).toBe('border');
    expect(roleForProperty('--mystery')).toBe('unknown');
  });
});

describe('the DS colour index', () => {
  const idx = buildDsColourIndex(miniDsIndex());

  it('holds scope-resolved values per surface, and drops tokens that are not static colours', () => {
    expect(idx.get('light', '--border-soft')).toMatchObject({ value: 'rgba(0, 0, 0, 0.08)', tier: 'role' });
    expect(idx.get('dark', '--border-soft')).toMatchObject({ value: 'rgba(255, 255, 255, 0.10)' });
    expect(idx.get('light', '--shadow-sm')).toBeNull(); // a shadow is not a colour: it has its own whole-layer index
    expect(idx.get('light', '--radius-sm')).toBeNull();
    expect(idx.get('light', '--no-such-token')).toBeNull();
    expect(idx.shadows('light').map((s) => s.token)).toEqual(expect.arrayContaining(['--shadow-sm', '--shadow-card-rest']));
  });

  it('exposes the DS section backgrounds of the scope as the fallback backdrops', () => {
    const light = idx.backdrops('light').map((c) => `${c.r},${c.g},${c.b}`);
    expect(light).toEqual(['255,255,255', '245,242,241']);
    const dark = idx.backdrops('dark').map((c) => `${c.r},${c.g},${c.b}`);
    expect(dark).toEqual(expect.arrayContaining(['17,17,20', '26,26,30']));
    expect(dark).not.toContain('255,255,255');
  });
});

const refOf = (text: string, extra: Partial<ReferenceColourInput> = {}): ReferenceColourInput => ({ text, resolved: text, rgba: parseCssColour(text)!, token: null, chain: [], declaration: `1px solid ${text}`, ...extra });
const idx = buildDsColourIndex(miniDsIndex());
const ctx = (over: Partial<ColourContext> = {}): ColourContext => ({ property: 'border', role: 'border', subRoles: ['card'], state: 'default', surface: 'light', ...over });

describe('mapReferenceColour', () => {
  it('EXACT: the same colour under another name; ranks the card sub-role first, then semantic over role over primitive', () => {
    const m = mapReferenceColour(refOf('rgba(0,0,0,.08)', { token: '--soft-edge' }), ctx(), idx);
    expect(m).toMatchObject({ outcome: 'exact', dsToken: '--border-card', tier: 'role', sameName: false });
    const noHint = mapReferenceColour(refOf('rgba(0,0,0,.08)'), ctx({ subRoles: [] }), idx);
    expect(noHint).toMatchObject({ outcome: 'exact', dsToken: '--semantic-hairline-soft', tier: 'semantic' });
  });

  it('EXACT beats NEAREST, including an exact primitive', () => {
    const m = mapReferenceColour(refOf('#f5f5f5'), ctx({ subRoles: [] }), idx);
    expect(m).toMatchObject({ outcome: 'exact', tier: 'primitive' });
    expect(m.distance!.deltaE).toBe(0);
  });

  it('same-name token: equal values keep the name; different values are mapped by value and the collision is recorded', () => {
    expect(mapReferenceColour(refOf('rgba(0,0,0,.08)', { token: '--border-soft' }), ctx(), idx)).toMatchObject({ dsToken: '--border-soft', sameName: true, nameCollision: null });
    const m = mapReferenceColour(refOf('rgba(0,0,0,.15)', { token: '--border-strong' }), ctx(), idx);
    expect(m).toMatchObject({ outcome: 'exact', dsToken: '--border-input', sameName: false });
    expect(m.nameCollision).toEqual({ referenceValue: 'rgba(0,0,0,.15)', dsValue: 'rgba(0, 0, 0, 0.18)' });
  });

  it('NEAREST: within the bound, polarity kept, not weaker, semantic first, alternatives and rejections recorded', () => {
    const m = mapReferenceColour(refOf('rgba(0,0,0,.06)'), ctx({ subRoles: [] }), idx);
    expect(m).toMatchObject({ outcome: 'nearest', dsToken: '--semantic-hairline-faint' });
    expect(m.distance!.deltaE).toBeLessThanOrEqual(COLOUR_RULES.nearestMaxDeltaE);
    expect(m.distance!.strengthRatio).toBeGreaterThanOrEqual(1);
    expect(m.rejected.map((r) => r.token)).toContain('--border-hairline');
    expect(m.verification.designTime).toMatchObject({ polarityOk: true, strengthOk: true });
  });

  it('refuses a candidate that is heavier than the reference even when it is numerically close', () => {
    // black 4%: the 7% hairline is within 2 delta-E but about 1.8x as strong - a different look; only the 5% hairline may take it
    const m = mapReferenceColour(refOf('rgba(0,0,0,.04)'), ctx({ subRoles: [] }), idx);
    expect(m.outcome).toBe('nearest');
    expect(m.dsToken).toBe('--border-hairline');
    const heavy = m.rejected.find((r) => r.token === '--semantic-hairline-faint');
    expect(heavy?.why).toMatch(/heavier/);
  });

  it('dark surface: white alpha stays white alpha; a black-alpha token is never offered', () => {
    const m = mapReferenceColour(refOf('rgba(255,255,255,.14)'), ctx({ surface: 'dark', subRoles: [] }), idx);
    expect(m.outcome).toBe('nearest');
    expect(m.dsValue).toMatch(/255, 255, 255/);
    expect(m.theme).toBe('dark');
    for (const r of m.rejected) expect(r.token).not.toMatch(/^--semantic-hairline-(strong|default|soft|faint)$/);
  });

  it('a reference border that is invisible on the surface is unmapped for that reason, not for lack of tokens', () => {
    const m = mapReferenceColour(refOf('rgba(0,0,0,.08)'), ctx({ surface: 'dark' }), idx);
    expect(m).toMatchObject({ outcome: 'unmapped', dsToken: null });
    expect(m.reason).toMatch(/not visible on this surface/);
    expect(m.reason).toMatch(/0\.\d/); // cites the measured strength
  });

  it('no suitable token: unmapped, naming the closest rejected token and the constraint', () => {
    const m = mapReferenceColour(refOf('rgba(255,0,170,.5)'), ctx(), idx);
    expect(m.outcome).toBe('unmapped');
    expect(m.reason).toMatch(/no DS border token/i);
    expect(m.rejected.length).toBeGreaterThan(0);
    expect(m.rejected[0]!.deltaE).toBeGreaterThan(COLOUR_RULES.nearestMaxDeltaE);
  });

  it('alpha rules: an alpha reference never takes an opaque token; an opaque one takes an alpha token only on a measured solid backdrop within 1 delta-E', () => {
    const opaque = refOf('#efefef');
    const measured = mapReferenceColour(opaque, ctx({ subRoles: [], backdrops: [WHITE], backdropSource: 'measured' }), idx);
    expect(measured).toMatchObject({ outcome: 'nearest', dsToken: '--semantic-hairline-faint' });
    expect(measured.distance!.deltaE).toBeLessThanOrEqual(COLOUR_RULES.opaqueToAlphaMaxDeltaE);
    const sections = mapReferenceColour(opaque, ctx({ subRoles: [], backdropSource: 'ds-section-tokens' }), idx);
    expect(sections.outcome).toBe('unmapped');
    expect(sections.reason).toMatch(/opaque|measured/i);
  });

  it('transparent is a keyword: exact, no token', () => {
    const m = mapReferenceColour(refOf('transparent'), ctx(), idx);
    expect(m).toMatchObject({ outcome: 'exact', dsToken: null });
    expect(m.keyword).toBe('transparent');
  });

  it('fill: a faint tint maps to a tint token of the surface; scope-adaptive tokens are evaluated in the surface scope', () => {
    const light = mapReferenceColour(refOf('rgba(0,0,0,.03)', { declaration: 'rgba(0,0,0,.03)' }), ctx({ property: 'background', role: 'fill', subRoles: [] }), idx);
    expect(light).toMatchObject({ outcome: 'exact', role: 'fill' });
    expect(['--tint-soft', '--semantic-surface-tint-soft']).toContain(light.dsToken);
    const dark = mapReferenceColour(refOf('rgba(255,255,255,.025)'), ctx({ property: 'background', role: 'fill', surface: 'dark', subRoles: [] }), idx);
    expect(dark).toMatchObject({ outcome: 'exact', dsToken: '--tint-soft', dsScope: '[data-variant="cinematic-dark"]' });
  });

  it('text: a mapped colour keeps every WCAG threshold the reference met', () => {
    const m = mapReferenceColour(refOf('#171717'), ctx({ property: 'color', role: 'text', subRoles: [], backdrops: [WHITE], backdropSource: 'measured' }), idx);
    expect(m.outcome).not.toBe('unmapped');
    expect(m.verification.designTime.contrastOk).toBe(true);
  });

  it('state is recorded, and an unknown role can only take an exact match', () => {
    expect(mapReferenceColour(refOf('rgba(0,0,0,.15)'), ctx({ state: 'hover' }), idx).state).toBe('hover');
    const unknown = mapReferenceColour(refOf('rgba(0,0,0,.06)'), ctx({ role: 'unknown', property: '--mystery' }), idx);
    expect(unknown.outcome).toBe('unmapped');
  });
});

describe('stateDistinctness / assessColour / evaluateColourVisible', () => {
  it('a mapped default+hover pair must stay as distinguishable as the reference pair (up to the 2 delta-E floor)', () => {
    const def = parseCssColour('rgba(0,0,0,.08)')!;
    const hov = parseCssColour('rgba(0,0,0,.15)')!;
    expect(stateDistinctness({ reference: [def, hov], mapped: [def, hov], backdrops: [WHITE] }).distinct).toBe(true);
    const collapsed = stateDistinctness({ reference: [def, hov], mapped: [def, def], backdrops: [WHITE] });
    expect(collapsed.distinct).toBe(false);
    expect(collapsed.mappedDelta).toBe(0);
    expect(stateDistinctness({ reference: [def, def], mapped: [def, def], backdrops: [WHITE] }).distinct).toBe(true); // the reference itself has no hover change
  });

  it('assessColour judges a DS colour on its real surface: a black hairline on dark fails the border floor, white alpha passes', () => {
    expect(assessColour({ role: 'border', colour: parseCssColour('rgba(0,0,0,.08)')!, backdrops: [DARK] })).toMatchObject({ ok: false });
    expect(assessColour({ role: 'border', colour: parseCssColour('rgba(255,255,255,.10)')!, backdrops: [DARK] })).toMatchObject({ ok: true });
    expect(assessColour({ role: 'border', colour: parseCssColour('rgba(0,0,0,.08)')!, backdrops: [WHITE, WARM] })).toMatchObject({ ok: true });
    expect(assessColour({ role: 'border', colour: parseCssColour('rgba(0,0,0,.08)')!, backdrops: [DARK] }).reason).toMatch(/not visible/);
    expect(assessColour({ role: 'text', colour: parseCssColour('rgba(0,0,0,.08)')!, backdrops: [WHITE] }).ok).toBe(false);
    expect(assessColour({ role: 'fill', colour: parseCssColour('rgba(0,0,0,.03)')!, backdrops: [WHITE] }).ok).toBe(true); // a fill has no visibility floor
  });

  it('the rendered "colour-visible" check passes, fails or is unverified; "unverified" is never a pass', () => {
    expect(evaluateColourVisible('border:1.5', 'rgba(0, 0, 0, 0.08)', 'rgb(255, 255, 255)')).toMatchObject({ status: 'passed' });
    const invisible = evaluateColourVisible('border:1.5', 'rgba(0, 0, 0, 0.08)', 'rgb(17, 17, 20)');
    expect(invisible.status).toBe('failed');
    expect(invisible.detail).toMatch(/not visible/);
    expect(evaluateColourVisible('border:1.5', 'rgba(0, 0, 0, 0.08)', null).status).toBe('unverified');
    expect(evaluateColourVisible('border:1.5', 'not a colour', 'rgb(255, 255, 255)').status).toBe('unverified');
  });
});

const REAL = existsSync(REAL_DS);
describe.skipIf(!REAL)('the real Design System', () => {
  const real = buildDsColourIndex(buildDsTokenIndex(REAL_DS));

  it('resolves adaptive tokens per scope and keeps component tokens out of the generic border pool', () => {
    expect(real.get('light', '--border-soft')!.value).toBe('rgba(0, 0, 0, 0.08)');
    expect(real.get('dark', '--border-soft')!.value).toBe('rgba(255, 255, 255, 0.1)');
    expect(real.get('light', '--border-strong')!.value).toBe('rgba(0, 0, 0, 0.18)');
    expect(real.get('light', '--border-input')!.value).toBe('rgba(0, 0, 0, 0.15)');
    expect(real.get('light', '--color-ramp-white-800')!.tier).toBe('primitive');
    expect(real.get('light', '--table-open-last-row-border')!.tier).toBe('component');
    // the unscoped black-alpha hairline resolves identically in the dark scope: polarity-wrong there
    expect(real.get('dark', '--semantic-hairline-soft')!.value).toBe('rgba(0, 0, 0, 0.08)');
    expect(real.entries('light').length).toBeGreaterThan(250);
  });

  it('#f5f5f5 maps to an exact primitive; black 6% to the not-weaker semantic hairline; white 14% on dark to an on-dark token', () => {
    expect(mapReferenceColour(refOf('#f5f5f5'), ctx({ subRoles: [] }), real)).toMatchObject({ outcome: 'exact', tier: 'primitive' });
    expect(mapReferenceColour(refOf('rgba(0,0,0,.06)'), ctx({ subRoles: [] }), real)).toMatchObject({ outcome: 'nearest', dsToken: '--semantic-hairline-faint' });
    const dark = mapReferenceColour(refOf('rgba(255,255,255,.14)'), ctx({ surface: 'dark', subRoles: [] }), real);
    expect(dark.outcome).toBe('nearest');
    expect(dark.dsToken).toMatch(/on-dark|border-default|border-soft/);
  });
});
