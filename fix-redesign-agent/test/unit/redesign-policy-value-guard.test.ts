import { afterAll, describe, expect, it } from 'vitest';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { redesignPolicyViolation } from '../../src/redesign-policy.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

/**
 * Reference lane, round 3: the VALUE guard of redesignPolicyViolation.
 *
 * Boundary (stated in the code too): a finding that has NO target in the resolution is not value-bound (no resolution => nothing new is enforced). A finding that
 * has targets of ANY outcome is: a colour-bearing style edit is refused unless a RESOLVED target of that finding and state supplies that property / colour; keywords
 * stay free only on a property no resolved target supplies; a property resolved as preserve-existing / unresolved blocks every property that supplies it, in both
 * directions (a shorthand that would overwrite a preserved longhand is refused).
 */

afterAll(() => cleanupDsFixtures());

const finding = makeFinding({ findingId: 'f1' });
const STAMP = '[data-fra-element="card"]';
const base: TargetedEdit = {
  findingId: 'f1', selector: STAMP, expectedMatches: 1, kind: 'style', property: 'border-top-color', value: '', removeValue: null,
  dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 1,
};
const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  id: 'c', findingId: 'f1', property: 'border-top-color', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
  audit: { status: 'NOT-LISTED', actual: null, expected: null, expectedToken: null, note: null, source: null }, reason: 'missing-ds-treatment', outcome: 'resolved-target',
  target: { value: 'rgba(0, 0, 0, 0.07)', comparison: 'color-deltaE', token: '--semantic-hairline-faint' },
  provenance: { kind: 'approved-project-pattern', ds: null, reference: null, evidence: [] }, decisionReason: 'mapped', route: 'css-edit', acceptance: [],
  status: { design: 'resolved', implementation: 'not-started', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
});
const blocked = (outcome: 'preserve-existing' | 'unresolved', over: Partial<ResolvedTarget> = {}): ResolvedTarget =>
  target({ outcome, target: null, reason: outcome === 'preserve-existing' ? 'no-ds-requirement' : 'state-context', decisionReason: 'not changed', route: 'none', status: { design: outcome === 'preserve-existing' ? 'preserved' : 'unresolved', implementation: 'not-applicable', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over });
const res = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });
const radius = (): ResolvedTarget => target({ id: 'r', property: 'border-top-left-radius', target: { value: '8px', comparison: 'length-px', token: null } });
/** The radius target plus a resolved target for each property: what a finding must have for a non-colour edit of these properties to be authorized (round 4). */
const grant = (...properties: string[]): ResolutionFile => res(radius(), ...properties.map((property) => target({ id: `g-${property}`, property, target: { value: 'x', comparison: 'exact', token: null } })));
const check = (property: string, value: string, resolution: ResolutionFile | null = res(target()), selector = STAMP, ds?: ReturnType<typeof miniDsIndex>, kind: TargetedEdit['kind'] = 'style') =>
  redesignPolicyViolation({ ...base, kind, property: kind === 'style' ? property : null, value, selector }, finding, undefined, resolution, ds ? { dsIndex: ds } : undefined);

describe('1. a preserved or unresolved property blocks every property that supplies it, in both directions', () => {
  for (const outcome of ['preserve-existing', 'unresolved'] as const) {
    describe(outcome, () => {
      const r = res(blocked(outcome));
      it.each([
        ['border-top-color', '#ff00aa'],
        ['border-color', '#ff00aa'],
        ['border-color', 'var(--page-raw)'],
        ['border', '1px solid #ff00aa'],
        ['border-top', '1px solid red'],
        ['box-shadow', '0 0 0 1px red'],
      ])('refuses %s: %s', (property, value) => {
        const v = check(property, value, r);
        expect(v, `${property}: ${value}`).not.toBeNull();
        expect(v).toContain('Project redesign policy:');
      });

      it('names the blocked property and why when a shorthand would overwrite it', () => {
        expect(check('border-color', 'transparent', r)).toMatch(/border-top-color was resolved as/);
        expect(check('border', '1px solid var(--semantic-hairline-faint)', r)).toMatch(/border-top-color was resolved as/);
      });

      it('a property that is not related stays editable', () => {
        expect(check('padding-top', '12px', res(blocked(outcome), target({ id: 'p', property: 'padding-top', target: { value: '12px', comparison: 'length-px', token: null } })))).toBeNull();
        expect(check('border-top-width', '1px', r)).toBeNull();
        expect(check('border-radius', 'var(--radius-sm)', r)).toBeNull();
      });
    });
  }

  it('the reverse direction: a blocked SHORTHAND blocks its longhands', () => {
    const r = res(blocked('preserve-existing', { property: 'border' }));
    expect(check('border-top-color', 'rgba(0, 0, 0, 0.07)', r)).toMatch(/border was resolved as preserve-existing/);
    expect(check('border-left-width', '2px', r)).toMatch(/border was resolved as preserve-existing/);
    expect(check('border-radius', '8px', r)).toBeNull();
  });

  it('a property changeable in another state is still not blocked outright', () => {
    const r = res(blocked('preserve-existing', { state: 'hover' }), target());
    expect(check('border-color', 'rgba(0, 0, 0, 0.07)', r)).toBeNull();
  });
});

describe('2. no short-circuit: a finding with targets of any kind binds every colour-bearing edit', () => {
  const lengthOnly = res(radius());

  it.each([
    ['color', '#ff00aa'],
    ['background-color', 'red'],
    ['border', '1px solid hotpink'],
    ['box-shadow', '0 0 0 1px red'],
    ['border-color', '-webkit-link'],
    ['outline', '2px solid var(--page-raw)'],
    ['background-image', 'linear-gradient(red, blue)'],
    ['fill', '#f00'],
    ['padding', 'var(--nope, red)'],
  ])('refuses %s: %s for a finding whose only target is a radius', (property, value) => {
    const v = check(property, value, lengthOnly);
    expect(v, `${property}: ${value}`).not.toBeNull();
    expect(v).toMatch(/no resolved target|not a resolved target/);
  });

  it('a finding with only a PRESERVED target is bound the same way', () => {
    expect(check('color', '#ff00aa', res(blocked('preserve-existing', { property: 'border-top-left-radius' })))).not.toBeNull();
    expect(check('box-shadow', '0 0 0 1px red', res(blocked('unresolved', { property: 'padding-top' })))).not.toBeNull();
  });

  it('a colour on a property no resolved target supplies is refused even when another colour target exists (the hover state, a sibling property)', () => {
    expect(check('color', '#171717')).not.toBeNull();
    expect(check('border-color', '#ff00aa', res(target()), `${STAMP}:hover`)).not.toBeNull();
  });

  it('keywords stay free on a property no resolved target supplies, and only there', () => {
    expect(check('background-color', 'transparent', lengthOnly)).toBeNull();
    expect(check('box-shadow', 'none', lengthOnly)).toBeNull();
    expect(check('outline', 'none', lengthOnly)).toBeNull();
    expect(check('color', 'inherit', lengthOnly)).toBeNull();
    // a property a colour target DOES supply takes the target's colour, not a keyword
    expect(check('border-color', 'transparent')).not.toBeNull();
    expect(check('border-color', 'currentcolor')).not.toBeNull();
  });

  it('a non-colour edit is untouched BY THE COLOUR GUARD: it is authorized by a target (or is layout-neutral), see redesign-policy-round4.test.ts', () => {
    const granted = grant('padding-top', 'font-family', 'letter-spacing');
    for (const [property, value] of [['padding-top', '12px'], ['border-top-left-radius', '8px'], ['font-family', '"Noto Serif", serif'], ['transition', 'background .2s ease'], ['letter-spacing', '0.02em'], ['border-top-width', '1px'], ['border-top-style', 'solid']] as const) {
      expect(check(property, value, granted), `${property}: ${value}`).toBeNull();
    }
    // ... and without a target the layout properties are not authorized (round 4)
    for (const property of ['padding-top', 'font-family', 'letter-spacing']) expect(check(property, 'x', lengthOnly), property).not.toBeNull();
  });

  it('the target\'s own colour, token and an alias stay allowed', () => {
    expect(check('border-top-color', 'rgba(0, 0, 0, 0.07)')).toBeNull();
    expect(check('border-top-color', 'var(--semantic-hairline-faint)')).toBeNull();
    expect(check('border', '1px solid var(--semantic-hairline-faint)')).toBeNull();
  });

  it('no resolution: nothing new is enforced (the stated boundary); a finding with no target IN a resolution is bound by the audit and the DS index (round 4)', () => {
    const other = res(target({ findingId: 'other' }));
    expect(check('color', '#ff00aa', other)).not.toBeNull();
    expect(check('color', '#ff00aa', null)).toBeNull();
  });
});

describe('3. var(), attr(), env(), unknown functions, vendor and system colours', () => {
  const ds = miniDsIndex();
  const hairline = res(target({ target: { value: 'rgba(0, 0, 0, 0.08)', comparison: 'color-deltaE', token: '--border-card' } }));

  it('a page custom property is refused whatever the property, with or without a DS index', () => {
    for (const [property, value] of [['border-color', 'var(--page-raw)'], ['border-top-color', 'var(--page-raw)'], ['box-shadow', '0 0 0 1px var(--page-raw)'], ['outline', '2px solid var(--page-raw)'], ['background-color', 'var(--page-raw)'], ['--x', 'var(--page-raw)']] as const) {
      expect(check(property, value, hairline), `${property}: ${value}`).not.toBeNull();
      expect(check(property, value, hairline, STAMP, ds), `${property}: ${value} (ds)`).not.toBeNull();
    }
    expect(check('border-top-color', 'var(--page-raw)', hairline, `${STAMP}:hover`, ds)).not.toBeNull();
  });

  it('a DS token that is the target\'s token or an equal-valued alias is accepted (with the index); one that is not the target\'s colour is not', () => {
    expect(check('border-top-color', 'var(--border-card)', hairline, STAMP, ds)).toBeNull();
    expect(check('border-top-color', 'var(--semantic-hairline-soft)', hairline, STAMP, ds)).toBeNull();
    expect(check('border-top-color', 'var(--semantic-ink-strong)', hairline, STAMP, ds)).not.toBeNull();
    // a DS token on a property no target supplies is not a colour the guard can place
    expect(check('box-shadow', '0 0 0 1px var(--semantic-hairline-soft)', hairline, STAMP, ds)).not.toBeNull();
  });

  it.each([
    ['border-color', 'attr(data-c type(<color>))'],
    ['border-top-color', 'attr(data-c type(<color>))'],
    ['border-color', 'env(safe-area-inset-top)'],
    ['border-top-color', 'env(x, red)'],
    ['box-shadow', '0 0 0 1px attr(data-c)'],
    ['border-top-color', 'var(--semantic-hairline-faint, attr(data-c))'],
    ['--x', 'attr(data-c type(<color>))'],
    ['border-top-color', 'element(#o)'],
    ['background-image', 'paint(worklet)'],
    ['border-top-color', 'light-dark(red, blue)'],
  ])('refuses the function in %s: %s', (property, value) => {
    expect(check(property, value), `${property}: ${value}`).not.toBeNull();
  });

  it('math functions on lengths stay allowed in a colour-bearing property', () => {
    expect(check('border', 'calc(1px + 0px) solid var(--semantic-hairline-faint)')).toBeNull();
    expect(check('outline-offset', 'calc(2px + 1px)')).toBeNull();
  });

  it.each([
    '-webkit-link', '-webkit-activelink', '-webkit-focus-ring-color', '-webkit-text', '-moz-default-color', '-moz-hyperlinktext', '-moz-field', '-moz-dialogtext',
    'ActiveBorder', 'Highlight', 'ButtonFace', 'Canvas', 'LinkText', 'CanvasText', 'AccentColor', 'WindowFrame', 'ThreeDShadow', 'GrayText', 'Mark', 'Menu', 'InfoBackground',
  ])('refuses the vendor / system colour %s', (keyword) => {
    for (const property of ['border-color', 'border-top-color', 'background-color', 'color', 'outline-color']) {
      expect(check(property, keyword), `${property}: ${keyword}`).not.toBeNull();
    }
    expect(check('box-shadow', `0 0 0 1px ${keyword}`)).not.toBeNull();
    expect(check('padding', keyword, res(radius()))).not.toBeNull();
  });

  it('layout keywords that merely share the vendor prefix stay allowed on non-colour properties (given a target for them)', () => {
    const r = grant('width', 'min-height', '-webkit-box-orient');
    expect(check('width', '-webkit-fill-available', r)).toBeNull();
    expect(check('min-height', '-webkit-fill-available', r)).toBeNull();
    expect(check('-webkit-box-orient', 'vertical', r)).toBeNull();
    expect(check('transition-property', 'background', res(radius()))).toBeNull();
    expect(check('transition', 'background .2s, color .2s', res(radius()))).toBeNull();
  });
});

describe('4. markup characters are refused in a style value and in a property name', () => {
  it.each([
    ['--x', '</style><script>window.pwned=2</script>'],
    ['--x', '<b>'],
    ['content', "'</style>'"],
    ['padding', '1px >'],
    ['font-family', 'a<b'],
  ])('refuses %s: %s for any finding', (property, value) => {
    for (const resolution of [res(target()), res(radius()), null]) {
      const v = check(property, value, resolution);
      expect(v, `${property}: ${value}`).not.toBeNull();
      expect(v).toContain('Project redesign policy:');
      expect(v).toMatch(/<|>|markup/);
    }
  });

  it('a property name with markup is refused', () => {
    expect(redesignPolicyViolation({ ...base, property: 'color</style><script>x', value: 'red' }, finding, undefined, null)).not.toBeNull();
    expect(redesignPolicyViolation({ ...base, property: '--x>', value: 'red' }, finding, undefined, null)).not.toBeNull();
  });
});

describe('5. an edit that IS a supplying target\'s value is allowed whatever its colour forms (gradients)', () => {
  const GRADIENT = 'linear-gradient(90deg, #141016 0%, #656565 50%, #141016 100%)';
  const grad = res(target({ property: 'background-image', target: { value: GRADIENT, comparison: 'color-deltaE', token: null }, provenance: { kind: 'audit-expected', ds: null, reference: null, evidence: [] } }));

  it('the exact text, a reformatted text and the same stops in another colour notation pass', () => {
    expect(check('background-image', GRADIENT, grad)).toBeNull();
    expect(check('background-image', `${GRADIENT} !important`, grad)).toBeNull();
    expect(check('background-image', 'LINEAR-GRADIENT( 90deg,#141016 0%,#656565 50%,#141016 100% )', grad)).toBeNull();
    expect(check('background-image', 'linear-gradient(90deg, rgb(20, 16, 22) 0%, rgb(101, 101, 101) 50%, rgb(20, 16, 22) 100%)', grad)).toBeNull();
    expect(check('background', GRADIENT, grad)).toBeNull();
  });

  it('is refused when any stop differs, a stop is added or the geometry changes', () => {
    expect(check('background-image', 'linear-gradient(90deg, #141016 0%, #ff0000 50%, #141016 100%)', grad)).not.toBeNull();
    expect(check('background-image', 'linear-gradient(90deg, #ff0000 0%, #656565 50%, #141016 100%)', grad)).not.toBeNull();
    expect(check('background-image', 'linear-gradient(90deg, #141016 0%, #656565 50%, #141016 100%, #ff0000 120%)', grad)).not.toBeNull();
    expect(check('background-image', 'linear-gradient(180deg, #141016 0%, #656565 50%, #141016 100%)', grad)).not.toBeNull();
    expect(check('background-image', 'radial-gradient(#141016, #656565)', grad)).not.toBeNull();
  });

  it('a gradient on a property the target does not supply is refused, and a gradient with a url is still an injection', () => {
    expect(check('color', GRADIENT, grad)).not.toBeNull();
    expect(check('background-image', `url(x.png), ${GRADIENT}`, grad)).not.toBeNull();
  });

  it('any other form of a non-gradient target value (box-shadow with several layers) passes as the target\'s own text', () => {
    const shadow = res(target({ property: 'box-shadow', target: { value: '0px 1px 3px 0px rgba(0, 0, 0, 0.04), 0 0 0 1px rgb(0 0 0 / 5%)', comparison: 'exact', token: null } }));
    expect(check('box-shadow', '0px 1px 3px 0px rgba(0, 0, 0, 0.04), 0 0 0 1px rgb(0 0 0 / 5%)', shadow)).toBeNull();
    expect(check('box-shadow', '0px 1px 3px 0px rgba(0, 0, 0, 0.04), 0 0 0 1px rgb(255 0 0 / 5%)', shadow)).not.toBeNull();
  });
});

describe('6. class and component-swap edits are scanned for a finding with targets', () => {
  const swap = (value: string, resolution: ResolutionFile | null = res(target()), ds?: ReturnType<typeof miniDsIndex>, kind: 'class' | 'component-swap' = 'class') => check('', value, resolution, STAMP, ds, kind);

  it.each([
    'border-[#ff00aa]',
    'border-red-500 bg-[color:red] text-[#f0a]',
    'shadow-[0_0_0_1px_#ff00aa]',
    'text-[rgb(255,0,0)]',
    'bg-[hsl(0_100%_50%)]',
    'ring-[red]',
    'text-red-500',
    'bg-slate-900',
    'border-sky-400/50',
    'hover:bg-emerald-600',
    'md:hover:text-fuchsia-300',
    '!border-rose-500',
    'bg-black',
    'text-white',
    'border-white/10',
    'from-indigo-500 to-purple-600',
    'decoration-amber-400',
    'bg-[color:var(--page-raw)]',
    'bg-(--page-raw)',
    'border-[var(--page-raw)]',
    '[--x:red]',
    '[color:red]',
    'bg-[linear-gradient(red,blue)]',
  ])('refuses the class value %s', (value) => {
    for (const kind of ['class', 'component-swap'] as const) {
      const v = swap(value, res(target()), undefined, kind);
      expect(v, `${kind}: ${value}`).not.toBeNull();
      expect(v).toContain('Project redesign policy:');
    }
  });

  it('allows classes that carry no raw colour: layout, spacing, sizing, DS-token-backed utilities, transparent / current, and arbitrary lengths', () => {
    for (const value of ['px-4 py-2 rounded-md', 'text-[14px] w-[calc(100%-2rem)] grid-cols-[1fr_2fr]', 'bg-transparent border-current text-inherit', 'font-semibold tracking-tight', 'md:flex hover:underline', 'bg-surface-card text-ink-strong border-hairline-soft', 'opacity-50', 'rounded-[var(--radius-sm)]']) {
      expect(swap(value), value).toBeNull();
    }
  });

  it('a DS token inside an arbitrary value is allowed only when it is in the DS index', () => {
    const ds = miniDsIndex();
    expect(swap('bg-[color:var(--semantic-surface-white)]', res(target()), ds)).toBeNull();
    expect(swap('border-[var(--border-card)]', res(target()), ds)).toBeNull();
    expect(swap('bg-(--semantic-surface-white)', res(target()), ds)).toBeNull();
    expect(swap('border-[var(--page-raw)]', res(target()), ds)).not.toBeNull();
    // no index: a variable cannot be shown to be a DS token
    expect(swap('border-[var(--border-card)]')).not.toBeNull();
  });

  it('is applied for a finding in a resolution, with targets or without (round 4); with no resolution nothing is enforced; the black CTA rule keeps its own message', () => {
    expect(swap('border-[#ff00aa]', null)).toBeNull();
    expect(swap('border-[#ff00aa]', res(target({ findingId: 'other' })))).not.toBeNull();
    const cta = redesignPolicyViolation({ ...base, kind: 'class', property: null, value: 'px-4 bg-black', dsComponent: 'Button' }, finding, undefined, res(target()));
    expect(cta).toContain('black CTA fill');
  });
});

describe('7. edges of the value guard', () => {
  it('a longhand with its own resolved target is not blocked by a preserved shorthand of it - the shorthand itself still is', () => {
    const r = res(blocked('preserve-existing', { property: 'border-color' }), target());
    expect(check('border-top-color', 'rgba(0, 0, 0, 0.07)', r)).toBeNull();
    expect(check('border-top-color', '#ff00aa', r)).not.toBeNull();
    expect(check('border-color', 'rgba(0, 0, 0, 0.07)', r)).toMatch(/border-color was resolved as preserve-existing/);
    // a shorthand of the RESOLVED longhand that would overwrite the preserved sibling is refused
    const sides = res(blocked('preserve-existing', { property: 'border-left-color' }), target());
    expect(check('border-color', 'rgba(0, 0, 0, 0.07)', sides)).toMatch(/border-left-color was resolved as preserve-existing/);
  });

  it('a shorthand that names no colour resets the supplied colour to currentcolor: refused unless it is the target\'s text', () => {
    expect(check('border', '1px solid')).not.toBeNull();
    expect(check('border', 'none')).not.toBeNull();
    expect(check('border-top-color', 'inherit')).not.toBeNull();
    expect(check('border-top-width', '1px')).toBeNull();
  });

  it('names are not colours: a property name or a font that is spelled like a system colour', () => {
    const r = grant('animation-name', 'view-transition-name', 'font-family');
    expect(check('transition', 'background .2s ease, color .2s', r)).toBeNull();
    expect(check('transition-property', 'background', r)).toBeNull();
    expect(check('animation-name', 'highlight', r)).toBeNull();
    expect(check('view-transition-name', 'menu', r)).toBeNull();
    expect(check('font-family', 'Menu, serif', r)).toBeNull();
    // ... but a colour FUNCTION or hex in them is still a colour
    expect(check('transition', 'background .2s #ff00aa', r)).not.toBeNull();
  });

  it('properties that take a colour without a colour role are still colour-bearing', () => {
    for (const [property, value] of [['accent-color', 'red'], ['accent-color', 'attr(data-c type(<color>))'], ['scrollbar-color', 'red blue'], ['stop-color', '#f00'], ['filter', 'drop-shadow(0 0 2px red)']] as const) {
      expect(check(property, value, grant('filter')), `${property}: ${value}`).not.toBeNull();
    }
    expect(check('filter', 'blur(2px)', grant('filter'))).toBeNull();
  });

  it('a custom property is refused unless it states a target exactly (round 4: a plain length can feed a colour function of the page)', () => {
    expect(check('--card-pad', '12px', res(radius()))).not.toBeNull();
    expect(check('--card-pad', 'calc(var(--semantic-space, 4px) * 2)', res(radius()))).not.toBeNull();
    expect(check('--x', 'var(--page-raw)', res(radius()))).not.toBeNull();
    expect(check('--x', '9px', res(radius()))).not.toBeNull();
    // exactly a resolved target's value of the finding (here the corner radius) is allowed
    expect(check('--x', '8px', res(radius()))).toBeNull();
  });
});
