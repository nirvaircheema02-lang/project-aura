import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { redesignPolicyViolation } from '../../src/redesign-policy.ts';
import { buildDsTokenIndex } from '../../src/resolution/ds-evidence.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { cleanupDsFixtures, miniDsIndex, REAL_DS } from '../helpers/ds-colour-fixture.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

/**
 * Round 2, defect 1 (colour lane): a raw colour never reaches the page by a neighbouring route. The guard binds by colour CONTENT, not by property name: for a
 * finding with a resolved colour / shadow / border / outline target, a style edit whose value carries a colour-like token (named, system, hex, functional, in a
 * shorthand, in a var() fallback) is refused unless it is a colour the target itself states, var(<the target's token>) or - for a property no target
 * supplies - a keyword. A value that carries injected CSS structure is refused for any finding.
 */

afterAll(() => cleanupDsFixtures());

const finding = makeFinding({ findingId: 'f1' });
const base: TargetedEdit = {
  findingId: 'f1', selector: '[data-fra-element="card"]', expectedMatches: 1, kind: 'style', property: 'border-top-color', value: '', removeValue: null,
  dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 1,
};
const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  id: 'c', findingId: 'f1', property: 'border-top-color', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
  audit: { status: 'NOT-LISTED', actual: null, expected: null, expectedToken: null, note: null, source: null }, reason: 'missing-ds-treatment', outcome: 'resolved-target',
  target: { value: 'rgba(0, 0, 0, 0.07)', comparison: 'color-deltaE', token: '--semantic-hairline-faint' },
  provenance: { kind: 'approved-project-pattern', ds: null, reference: null, evidence: [] }, decisionReason: 'mapped', route: 'css-edit', acceptance: [],
  status: { design: 'resolved', implementation: 'not-started', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
});
const res = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });
const check = (property: string, value: string, resolution: ResolutionFile | null = res(target()), selector = base.selector, ds?: ReturnType<typeof miniDsIndex>) =>
  redesignPolicyViolation({ ...base, property, value, selector }, finding, undefined, resolution, ds ? { dsIndex: ds } : undefined);

describe('colour content is bound whatever the property is called', () => {
  it.each([
    ['border', '1px solid #ff00aa'],
    ['border', '1px solid rgba(255,0,170,.5)'],
    ['border', '1px solid RED'],
    ['border-color', '#ff00aa'],
    ['border-color', 'red blue'],
    ['border-bottom-color', 'red'],
    ['border-top', '1px solid rgba(255, 0, 0, .5)'],
    ['border-inline-start-color', '#f0a'],
    ['outline', '2px solid #ff00aa'],
    ['outline-color', 'red'],
    ['box-shadow', '0 1px 2px rgba(255, 0, 0, .4)'],
    ['box-shadow', '0 0 0 1px hotpink, 0 1px 2px rgba(0,0,0,.1)'],
    ['background', 'red'],
    ['background-color', '#ff00aa'],
    ['background-image', 'linear-gradient(red, blue)'],
    ['color', '#ff00aa'],
    ['text-decoration', 'underline wavy red'],
    ['text-decoration-color', 'red'],
    ['column-rule', '1px solid red'],
    ['fill', '#f00'],
    ['border-color', 'ButtonText'],
    ['border-color', 'color-mix(in srgb, red, blue)'],
    ['border-color', 'light-dark(red, blue)'],
    ['border-color', 'lab(50% 40 59)'],
    ['filter', 'drop-shadow(0 0 2px red)'],
    ['padding', 'var(--nope, red)'],
    ['border-color', 'var(--nope, #ff00aa)'],
    ['border', '1px solid var(--nope, rgba(255,0,0,.5))'],
  ])('refuses %s: %s for a finding with a resolved border-colour target', (property, value) => {
    const v = check(property, value);
    expect(v, `${property}: ${value}`).not.toBeNull();
    expect(v).toContain('Project redesign policy:');
  });

  it('the refusal names the property, the state and the colour the target resolved to', () => {
    const v = check('border-color', '#ff00aa')!;
    expect(v).toMatch(/border-color/);
    expect(v).toMatch(/default/);
    expect(v).toMatch(/rgba\(0, 0, 0, 0\.07\)/);
    expect(v).toMatch(/--semantic-hairline-faint/);
  });

  it('other states: a hover or focus edit is held to the target of THAT state, and a state with no target takes no colour', () => {
    expect(check('border-color', '#ff00aa', res(target()), '[data-fra-element="card"]:hover')).toMatch(/hover/);
    expect(check('border-color', 'rgba(0, 0, 0, 0.07)', res(target()), '[data-fra-element="card"]:hover')).not.toBeNull();
    const withHover = res(target(), target({ id: 'h', state: 'hover', target: { value: 'rgba(0, 0, 0, 0.15)', comparison: 'color-deltaE', token: '--border-input' } }));
    expect(check('border-color', 'rgba(0, 0, 0, 0.15)', withHover, '[data-fra-element="card"]:hover')).toBeNull();
    expect(check('border-top-color', 'var(--border-input)', withHover, '[data-fra-element="card"]:hover')).toBeNull();
    expect(check('border-color', '#ff00aa', withHover, '[data-fra-element="card"]:hover')).not.toBeNull();
  });

  it('a descendant edit (selector after the stamp) of the finding is held to the same targets', () => {
    expect(check('border-top-color', '#ff00aa', res(target()), '[data-fra-element="card"] .icon')).not.toBeNull();
    expect(check('color', '#ff00aa', res(target()), '[data-fra-element="card"] .icon')).not.toBeNull();
  });

  it('a label-part target counts as a colour target of the finding: a raw colour on the same property is refused too (it used to be waved through)', () => {
    expect(check('border-top-color', '#ff00aa', res(target({ part: 'label' })))).not.toBeNull();
  });

  it('a colour target that is NOT a border still binds every colour-bearing edit of the finding (text colour target)', () => {
    const text = res(target({ property: 'color', target: { value: 'rgb(23, 23, 23)', comparison: 'color-deltaE', token: '--semantic-ink-strong' } }));
    expect(check('color', '#171717', text)).toBeNull();
    expect(check('color', 'var(--semantic-ink-strong)', text)).toBeNull();
    expect(check('color', '#ff00aa', text)).not.toBeNull();
    expect(check('border-color', '#ff00aa', text)).not.toBeNull();
    expect(check('border-color', 'transparent', text)).toBeNull();
  });
});

describe('what stays allowed', () => {
  // round 4: a non-colour property is authorized by a resolved target of the finding (or by the audit's mismatch list); the colour guard itself leaves it alone
  const granted = res(target(), ...['padding-top', 'padding', 'font-family'].map((property) => target({ id: `g-${property}`, property, target: { value: 'x', comparison: 'exact', token: null } })));
  it.each([
    ['border-top-color', 'rgba(0, 0, 0, 0.07)'],
    ['border-top-color', 'rgba(0,0,0,.07) !important'],
    ['border-top-color', 'var(--semantic-hairline-faint)'],
    ['border-color', 'var(--semantic-hairline-faint)'],
    ['border-color', 'rgba(0, 0, 0, 0.07)'],
    ['border-color', 'rgba(0,0,0,.07) rgba(0,0,0,.07)'],
    ['border', '1px solid var(--semantic-hairline-faint)'],
    ['border', '1px solid rgba(0, 0, 0, 0.07)'],
    ['border-top', '1px solid #00000012'],
    ['border-radius', 'var(--radius-sm)'],
    ['padding-top', '12px'],
    ['padding', 'var(--space-4, 16px)'],
    ['border-top-style', 'solid'],
    ['border-top-width', '1px'],
    ['background-color', 'transparent'],
    ['box-shadow', 'none'],
    ['outline', 'none'],
    ['font-family', '"Noto Serif", serif'],
    ['border-top-color', 'rgba(0, 0, 0, 0.075)'],
  ])('allows %s: %s', (property, value) => {
    expect(check(property, value, granted), `${property}: ${value}`).toBeNull();
  });

  it('a finding whose targets are not colours authorizes no colour either (round 3: this was allowed before; see redesign-policy-value-guard.test.ts)', () => {
    const lengthOnly = res(target({ property: 'border-top-left-radius', target: { value: '8px', comparison: 'length-px', token: null } }));
    expect(check('color', '#ff00aa', lengthOnly)).not.toBeNull();
    expect(check('border-top-left-radius', '8px', lengthOnly)).toBeNull();
  });

  it('without a resolution a colour is not value-bound (the original behaviour)', () => {
    expect(check('border-top-color', 'red', null)).toBeNull();
  });

  it('a target of ANOTHER finding authorizes nothing here: the finding has none of its own, so it is bound by the audit and the DS index (round 4)', () => {
    const other = res(target({ findingId: 'other' }));
    expect(check('border-top-color', 'red', other)).not.toBeNull();
    expect(check('border-top-color', 'transparent', other)).toBeNull();
  });
});

describe('exact-comparison colour targets (border / outline / box-shadow) are covered too', () => {
  const shadow = res(target({ property: 'box-shadow', target: { value: '0px 1px 3px 0px rgba(0, 0, 0, 0.04)', comparison: 'exact', token: '--shadow-card-rest' } }));
  const border = res(target({ property: 'border', target: { value: '1px solid rgba(0, 0, 0, 0.08)', comparison: 'exact', token: '--border-card' } }));
  const outline = res(target({ property: 'outline', target: { value: '1px solid rgba(0, 0, 0, 0.2)', comparison: 'exact', token: '--border-active' } }));

  it('box-shadow: the target value, its token or its colours pass; a different colour or a different value of the property does not', () => {
    expect(check('box-shadow', '0px 1px 3px 0px rgba(0, 0, 0, 0.04)', shadow)).toBeNull();
    expect(check('box-shadow', 'var(--shadow-card-rest)', shadow)).toBeNull();
    expect(check('box-shadow', '0 1px 3px red', shadow)).not.toBeNull();
    expect(check('box-shadow', '0 8px 30px rgba(0,0,0,.5)', shadow)).not.toBeNull();
    expect(check('box-shadow', 'none', shadow)).not.toBeNull();
    expect(check('border-color', '#ff00aa', shadow)).not.toBeNull();
  });

  it('border: a raw colour is refused in the shorthand and in every longhand, the target token is not', () => {
    expect(check('border', '1px solid var(--border-card)', border)).toBeNull();
    expect(check('border', '1px solid rgba(0, 0, 0, 0.08)', border)).toBeNull();
    expect(check('border', '1px solid red', border)).not.toBeNull();
    expect(check('border-top-color', 'red', border)).not.toBeNull();
    expect(check('border-top-color', 'var(--border-card)', border)).toBeNull();
    expect(check('border-color', 'currentcolor', border)).not.toBeNull();
  });

  it('outline: the same', () => {
    expect(check('outline', '1px solid var(--border-active)', outline)).toBeNull();
    expect(check('outline', '1px solid #f0a', outline)).not.toBeNull();
    expect(check('outline-color', 'red', outline)).not.toBeNull();
  });
});

describe('injected structure is refused for any finding', () => {
  it.each([
    ['padding', '4px; border-top-color: var(--nope, red)'],
    ['padding', '4px; border-top-color: red'],
    ['padding', '4px } .x { color: red'],
    ['padding', '4px /* red */'],
    ['border-top-color', '\\72 ed'],
    ['border', '1px solid \\72ed'],
    ['padding', 'var(--unknown-anywhere, \\72 ed)'],
    ['background', 'url(https://evil.example/x.png)'],
    ['background-image', "image-set('a.png' 1x)"],
    ['margin', '1px !important; color: red'],
    ['margin', '1px !important 2px'],
    ['padding', '4px\\;color:red'],
  ])('refuses %s: %s', (property, value) => {
    const noColourTarget = res(target({ property: 'border-top-left-radius', target: { value: '8px', comparison: 'length-px', token: null } }));
    for (const resolution of [res(target()), noColourTarget, null]) {
      const v = check(property, value, resolution);
      expect(v, `${property}: ${value}`).not.toBeNull();
      expect(v).toContain('Project redesign policy:');
    }
  });

  it('a property name that carries more than a name is refused', () => {
    expect(redesignPolicyViolation({ ...base, property: 'padding: 1px; color', value: 'red' }, finding, undefined, res(target()))).not.toBeNull();
    expect(redesignPolicyViolation({ ...base, property: 'color }', value: 'red' }, finding, undefined, null)).not.toBeNull();
  });
});

describe('an equal-valued alias of the target token', () => {
  const audit = res(target({ property: 'background-color', target: { value: 'rgb(255, 255, 255)', comparison: 'color-deltaE', token: '--white' }, provenance: { kind: 'audit-expected', ds: null, reference: null, evidence: [] } }));
  const ds = miniDsIndex();

  it('is accepted when the DS index resolves it to the same colour', () => {
    expect(check('background-color', 'var(--semantic-surface-white)', audit, base.selector, ds)).toBeNull();
    expect(check('background-color', 'var(--white)', audit, base.selector, ds)).toBeNull();
  });

  it('is refused when it resolves to another colour, when it does not resolve, and without a DS index', () => {
    expect(check('background-color', 'var(--semantic-ink-strong)', audit, base.selector, ds)).not.toBeNull();
    expect(check('background-color', 'var(--not-in-the-ds)', audit, base.selector, ds)).not.toBeNull();
    expect(check('background-color', 'var(--semantic-surface-white)', audit)).not.toBeNull();
  });

  it('a fallback in the alias never smuggles a colour', () => {
    expect(check('background-color', 'var(--semantic-surface-white, red)', audit, base.selector, ds)).not.toBeNull();
  });
});

describe.skipIf(!existsSync(REAL_DS))('an equal-valued alias on the REAL Design System (read-only)', () => {
  const ds = () => buildDsTokenIndex(REAL_DS);
  const card = res(target({ target: { value: 'rgba(0, 0, 0, 0.08)', comparison: 'color-deltaE', token: '--border-card' } }));

  it('--semantic-hairline-soft and --border-soft are the target\'s colour (rgba(0, 0, 0, 0.08)) in the real DS: accepted for --border-card; a different real token is refused', () => {
    const index = ds();
    expect(check('border-top-color', 'var(--border-card)', card, base.selector, index)).toBeNull();
    expect(check('border-top-color', 'var(--semantic-hairline-soft)', card, base.selector, index)).toBeNull();
    expect(check('border-color', 'var(--border-soft)', card, base.selector, index)).toBeNull();
    expect(check('border-top-color', 'var(--border-active)', card, base.selector, index)).not.toBeNull();
    expect(check('border-top-color', 'var(--semantic-hairline-soft, red)', card, base.selector, index)).not.toBeNull();
  });

  it('without the index the same alias is refused (fail closed: the guard cannot show that it is the target\'s colour)', () => {
    expect(check('border-top-color', 'var(--semantic-hairline-soft)', card)).not.toBeNull();
  });
});
