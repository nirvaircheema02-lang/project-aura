import { afterAll, describe, expect, it } from 'vitest';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { redesignPolicyViolation } from '../../src/redesign-policy.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

/**
 * Reference lane, round 4 (final): the residuals of the policy guard.
 *  2. a `text` edit never writes into a raw-text / non-visual element (decided by the selector's subject here; by the matched element in applyEdit)
 *  3. every shorthand / logical alias of a preserved property is refused; `all` is refused outright
 *  4. a finding with NO target in the resolution (rule-driven / component-level) authorises no raw colour; a style property no resolved target supplies is refused
 *     unless the audit's own mismatch list names it or it is layout-neutral
 *  5. a custom-property edit is refused unless its value is exactly a target value or var(<target token>)
 *  7. a preserve / unresolved decision is per STATE: a state that preserves a property refuses any value for it, keywords included
 *  9. `bg-[--page-raw]` / `bg-[color:--page-raw]` are variables; page-defined classes are the rendered measurement's business
 *  6. a style edit's selector carries no comment, backslash or `<`
 */

afterAll(() => cleanupDsFixtures());

const STAMP = '[data-fra-element="card"]';
const mismatch = (property: string, expected: string, expectedToken: string | null = null, comparison: 'exact' | 'color-deltaE' | 'length-px' = 'exact') => ({ property, actual: 'x', expected, expectedToken, comparison, delta: null });
const finding = makeFinding({ findingId: 'f1', mismatches: [mismatch('color', 'rgb(20, 16, 22)', '--semantic-ink-strong', 'color-deltaE'), mismatch('padding-left', '28px', '--button-px-md', 'length-px')] });
const base: TargetedEdit = {
  findingId: 'f1', selector: STAMP, expectedMatches: 1, kind: 'style', property: 'border-top-color', value: '', removeValue: null,
  dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 1,
};
const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  id: over.id ?? `c-${over.property ?? 'border-top-color'}-${over.state ?? 'default'}`, findingId: 'f1', property: 'border-top-color', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
  audit: { status: 'NOT-LISTED', actual: null, expected: null, expectedToken: null, note: null, source: null }, reason: 'missing-ds-treatment', outcome: 'resolved-target',
  target: { value: 'rgba(0, 0, 0, 0.07)', comparison: 'color-deltaE', token: '--semantic-hairline-faint' },
  provenance: { kind: 'approved-project-pattern', ds: null, reference: null, evidence: [] }, decisionReason: 'mapped', route: 'css-edit', acceptance: [],
  status: { design: 'resolved', implementation: 'not-started', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
});
const preserved = (property: string, over: Partial<ResolvedTarget> = {}): ResolvedTarget =>
  target({ property, outcome: 'preserve-existing', target: null, reason: 'no-ds-requirement', decisionReason: 'not changed', route: 'none', status: { design: 'preserved', implementation: 'not-applicable', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over });
const lengthTarget = (property: string, value: string, over: Partial<ResolvedTarget> = {}): ResolvedTarget => target({ property, target: { value, comparison: 'length-px', token: null }, ...over });
const res = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });
const check = (property: string, value: string, resolution: ResolutionFile | null, over: Partial<TargetedEdit> = {}, ds?: ReturnType<typeof miniDsIndex>) =>
  redesignPolicyViolation({ ...base, property, value, ...over }, finding, undefined, resolution, ds ? { dsIndex: ds } : undefined);
const refused = (v: string | null, label: string) => { expect(v, label).not.toBeNull(); expect(v, label).toContain('Project redesign policy:'); };

describe('2. a text edit never writes into a raw-text or non-visual element', () => {
  const text = (selector: string, value = 'x'): string | null => redesignPolicyViolation({ ...base, kind: 'text', property: null, selector, value }, finding, undefined, res(target()));

  it.each([
    `${STAMP} style`, `${STAMP} > script`, `${STAMP} noscript`, `${STAMP} xmp`, `${STAMP} iframe`, `${STAMP} textarea`, `${STAMP} template`, `${STAMP} title`, `${STAMP} object`,
    `${STAMP} .wrap > STYLE`, `${STAMP} style:hover`, `${STAMP} :is(.a, .b) script`, `${STAMP} [title="a b"] style`,
  ])('refuses %s (the report\'s repro: `</style><script>` as the value)', (selector) => {
    refused(text(selector, '</style><script>window.pwned=7</script>'), selector);
  });

  it.each([`${STAMP}`, `${STAMP} .label`, `${STAMP} span`, `${STAMP} > p.t`, `${STAMP} [data-style="x"]`, `${STAMP} .script-name`, `${STAMP} :is(style, p)`])('allows %s (the matched element decides in applyEdit)', (selector) => {
    expect(text(selector, 'Hello')).toBeNull();
  });

  it('is refused with a resolution of any kind, and with none', () => {
    for (const resolution of [res(target()), res(), null]) {
      refused(redesignPolicyViolation({ ...base, kind: 'text', property: null, selector: `${STAMP} style`, value: 'x' }, finding, undefined, resolution), 'style');
    }
  });
});

describe('3. shorthands, logical aliases and `all` of a preserved property', () => {
  it.each([
    // the report's repros: preserved border-color
    ['border-color', 'border-top', 'none'], ['border-color', 'border-top', '1px solid red'],
    // preserved border-top-color
    ['border-top-color', 'border-top', 'none'], ['border-top-color', 'border-block-start', 'none'], ['border-top-color', 'border-block', '0'], ['border-top-color', 'border-block-start-color', 'transparent'],
    ['border-top-color', 'border', 'none'], ['border-top-color', 'all', 'unset'],
    // preserved border-left-color: the inline-start side
    ['border-left-color', 'border-inline-start', 'none'], ['border-left-color', 'border-inline', '0'], ['border-left-color', 'border-inline-start-color', 'currentcolor'],
    // preserved logical property, physical edit
    ['border-block-start-color', 'border-top-color', 'transparent'], ['border-block-start-color', 'border-top', 'none'], ['border-inline-end-color', 'border-right-color', 'transparent'],
    // preserved shorthand, longhand edit
    ['border', 'border-top', '0'], ['border', 'border-block', '0'], ['border', 'border-inline-start', 'none'], ['border-block', 'border-top-color', 'transparent'], ['border-inline', 'border-left', 'none'],
    // other families
    ['padding-block', 'padding-top', '12px'], ['padding-inline-start', 'padding-left', '12px'], ['margin-block-start', 'margin-top', '0'], ['padding', 'padding-block', '12px'],
    ['border-start-start-radius', 'border-top-left-radius', '8px'], ['border-radius', 'border-end-end-radius', '8px'], ['gap', 'row-gap', '8px'], ['font', 'line-height', '1.2'],
    ['color', 'all', 'unset'], ['padding-top', 'all', 'revert'], ['padding-top', 'all', 'initial'], ['width', 'all', 'revert-layer'],
  ])('preserved %s: refuses %s: %s', (preservedProperty, property, value) => {
    for (const outcome of ['preserve-existing', 'unresolved'] as const) {
      const r = res(preserved(preservedProperty, { outcome, ...(outcome === 'unresolved' ? { reason: 'state-context' as const } : {}) }));
      refused(check(property, value, r), `${outcome}: ${preservedProperty} / ${property}: ${value}`);
    }
  });

  it('an unrelated property of the same family stays editable', () => {
    const r = res(preserved('border-top-color'));
    expect(check('border-bottom-color', 'rgba(0, 0, 0, 0.07)', res(preserved('border-top-color'), target({ property: 'border-bottom-color' })))).toBeNull();
    expect(check('border-top-width', '1px', r)).toBeNull();
    expect(check('border-left', '1px solid var(--semantic-hairline-faint)', res(preserved('border-top-color'), target({ property: 'border-left-color' }), lengthTarget('border-left-width', '1px'), lengthTarget('border-left-style', 'solid')))).toBeNull();
    expect(check('border-inline-start-color', 'rgba(0, 0, 0, 0.07)', res(preserved('border-top-color'), target({ property: 'border-left-color' })))).toBeNull();
  });

  it('`all` is refused for any finding and any resolution - it resets every property', () => {
    for (const resolution of [res(target()), res(), res(preserved('color')), null]) {
      for (const value of ['unset', 'revert', 'initial', 'revert-layer', 'inherit']) refused(check('all', value, resolution), `all: ${value}`);
    }
  });
});

describe('4. a finding with no target in the resolution', () => {
  const ds = miniDsIndex();
  // the resolution holds a target for ANOTHER finding only (a rule-driven or component-level finding has none of its own)
  const noTargets = () => res(target({ findingId: 'other' }));

  it.each([
    ['color', '#ff00aa'],
    ['background', 'var(--page-raw)'],
    ['background-color', 'var(--page-raw)'],
    ['box-shadow', '0 0 0 1px red'],
    ['border-top-color', 'rgba(255, 0, 170, 0.5)'],
    ['border', '1px solid hotpink'],
    ['outline', '2px solid var(--page-raw)'],
    ['background-image', 'linear-gradient(red, blue)'],
    ['fill', '#f00'],
    ['border-color', '-webkit-link'],
    ['color', 'var(--semantic-ink-strong, red)'],
    ['color', 'attr(data-c type(<color>))'],
  ])('refuses the raw colour %s: %s (with and without a DS index)', (property, value) => {
    refused(check(property, value, noTargets()), `${property}: ${value}`);
    refused(check(property, value, noTargets(), {}, ds), `${property}: ${value} (ds)`);
    refused(check(property, value, res()), `${property}: ${value} (empty resolution)`);
  });

  it('refuses a raw colour class', () => {
    for (const value of ['bg-[#f0a] text-red-500', 'border-[#ff00aa]', 'bg-[color:var(--page-raw)]', 'text-white', 'bg-(--page-raw)']) {
      for (const kind of ['class', 'component-swap'] as const) refused(redesignPolicyViolation({ ...base, kind, property: null, value }, finding, undefined, noTargets(), { dsIndex: ds }), `${kind}: ${value}`);
    }
  });

  it('allows what the rule-driven path needs: a DS token present in the DS index, keywords, and the audit-expected value', () => {
    expect(check('border-top-color', 'var(--semantic-hairline-soft)', noTargets(), {}, ds)).toBeNull();
    expect(check('background-color', 'var(--semantic-surface-white)', noTargets(), {}, ds)).toBeNull();
    expect(check('box-shadow', '0 0 0 1px var(--semantic-hairline-faint)', noTargets(), {}, ds)).toBeNull();
    expect(check('border', '1px solid var(--border-card)', noTargets(), {}, ds)).toBeNull();
    for (const [property, value] of [['background-color', 'transparent'], ['box-shadow', 'none'], ['outline', 'none'], ['fill', 'none'], ['border-top-color', 'currentcolor']] as const) {
      expect(check(property, value, noTargets()), `${property}: ${value}`).toBeNull();
    }
    // the audit's own expectation for `color`, whatever way it is written (R3 passes the expected value through)
    expect(check('color', 'rgb(20, 16, 22)', noTargets())).toBeNull();
    expect(check('color', '#141016', noTargets())).toBeNull();
    expect(check('color', 'var(--semantic-ink-strong)', noTargets(), {}, ds)).toBeNull();
    // a different colour on the same property is not the audit's expectation
    refused(check('color', 'rgb(200, 16, 22)', noTargets()), 'another colour than the audit\'s');
    refused(check('color', 'rgb(20, 16, 22)', noTargets(), { selector: `${STAMP}:hover` }), 'the audit measured the default state');
  });

  it('a DS token absent from the DS index, and any token when there is no index, is refused', () => {
    refused(check('border-top-color', 'var(--semantic-not-in-the-ds)', noTargets(), {}, ds), 'unknown token');
    refused(check('border-top-color', 'var(--semantic-hairline-soft)', noTargets()), 'no index');
  });

  describe('non-colour properties are authorised by a resolved target, the audit\'s mismatch list, or are layout-neutral', () => {
    const radiusOnly = () => res(target({ property: 'border-top-left-radius', target: { value: '8px', comparison: 'length-px', token: null } }));

    it.each([
      ['width', '50%'], ['height', '10px'], ['padding-top', '40px'], ['padding', '40px'], ['margin', '0 auto'], ['margin-top', '8px'], ['gap', '0'], ['row-gap', '4px'], ['font-size', '8px'],
      ['max-width', '200px'], ['min-height', '300px'], ['column-count', '3'], ['line-height', '3'], ['letter-spacing', '2px'], ['opacity', '0'], ['transform', 'scale(2)'], ['inline-size', '10px'],
      ['padding-inline', '40px'], ['font-family', 'serif'], ['visibility', 'hidden'], ['pointer-events', 'none'], ['--x', '1'],
    ])('refuses %s: %s for a finding whose only target is one corner radius', (property, value) => {
      refused(check(property, value, radiusOnly()), `${property}: ${value}`);
    });

    it('names the property and what would authorise it', () => {
      expect(check('padding-top', '40px', radiusOnly())).toMatch(/padding-top.*(?:no resolved target|not authorized)/s);
    });

    it('allows the property of a resolved target, its longhands, and what the audit\'s own mismatch list names', () => {
      expect(check('border-top-left-radius', '8px', radiusOnly())).toBeNull();
      // the audit measured padding-left for this finding
      expect(check('padding-left', '28px', radiusOnly())).toBeNull();
      expect(check('padding-inline-start', '28px', radiusOnly())).toBeNull();
      // ... only those: the shorthand would change the other three sides
      refused(check('padding', '28px', radiusOnly()), 'padding');
      refused(check('padding-right', '28px', radiusOnly()), 'padding-right');
      // a shorthand target authorises its longhands
      expect(check('padding-top', '12px', res(lengthTarget('padding', '12px')))).toBeNull();
      expect(check('padding', '12px', res(lengthTarget('padding-top', '12px'), lengthTarget('padding-right', '12px'), lengthTarget('padding-bottom', '12px'), lengthTarget('padding-left', '12px')))).toBeNull();
      refused(check('padding', '12px', res(lengthTarget('padding-top', '12px'))), 'one side of four');
    });

    it('a target authorises its own STATE only; the audit mismatch list authorises the default state', () => {
      const hoverOnly = res(lengthTarget('border-top-left-radius', '8px', { state: 'hover' }));
      refused(check('padding-top', '12px', res(lengthTarget('padding-top', '12px', { state: 'hover' }))), 'a hover target does not authorise the default state');
      expect(check('padding-top', '12px', res(lengthTarget('padding-top', '12px', { state: 'hover' })), { selector: `${STAMP}:hover` })).toBeNull();
      refused(check('padding-left', '28px', hoverOnly, { selector: `${STAMP}:hover` }), 'the audit measured the default state');
    });

    it('only a RESOLVED target authorises: a preserved or unresolved one never does', () => {
      refused(check('padding-top', '12px', res(preserved('padding-top'))), 'preserved');
      refused(check('margin-top', '12px', res(preserved('padding-top'), preserved('margin-top', { outcome: 'unresolved', reason: 'state-context' }))), 'unresolved');
    });

    it('the audit\'s mismatch list authorises the stamped element itself (a part-prefixed mismatch, a descendant: `label.font-size`)', () => {
      const labelFinding = makeFinding({ findingId: 'f1', mismatches: [mismatch('label.font-size', '14px', null, 'length-px'), mismatch('padding-left', '28px', null, 'length-px')] });
      const at = (property: string, value: string, selector: string) => redesignPolicyViolation({ ...base, property, value, selector }, labelFinding, undefined, res(target({ findingId: 'other' })));
      expect(at('font-size', '14px', `${STAMP} .label`)).toBeNull();
      refused(at('font-size', '14px', STAMP), 'a label mismatch does not authorise the element itself');
      expect(at('padding-left', '28px', STAMP)).toBeNull();
      refused(at('padding-left', '28px', `${STAMP} .label`), 'a self mismatch does not authorise a descendant');
    });

    it('a descendant selector may use a part target; the element itself needs a self target', () => {
      const labelTarget = res(lengthTarget('padding-top', '12px', { part: 'label' }));
      refused(check('padding-top', '12px', labelTarget), 'a label target does not authorise the stamped element');
      expect(check('padding-top', '12px', labelTarget, { selector: `${STAMP} .label` })).toBeNull();
    });

    it('layout-neutral properties are allowed for a rule-driven finding: radius, border width / style, outline, transition, cursor, text decoration', () => {
      for (const [property, value] of [['border-top-left-radius', '8px'], ['border-radius', 'var(--radius-sm)'], ['border-bottom-right-radius', '0'], ['border-top-width', '1px'], ['border-top-style', 'solid'], ['border-width', '1px'], ['outline-offset', '2px'], ['outline-width', '2px'], ['outline-style', 'solid'], ['transition', 'background .2s ease'], ['transition-duration', '.2s'], ['cursor', 'pointer'], ['text-decoration-line', 'underline'], ['text-underline-offset', '2px']] as const) {
        expect(check(property, value, res(target({ findingId: 'other' }))), `${property}: ${value}`).toBeNull();
      }
    });

    it('composition properties still need their own authorisation (the PROTECTED list is unchanged)', () => {
      refused(check('display', 'none', radiusOnly()), 'display');
      refused(check('text-align', 'center', radiusOnly()), 'text-align');
      expect(check('text-align', 'center', res(target({ property: 'text-align', target: { value: 'center', comparison: 'exact', token: null } })))).toBeNull();
    });
  });

  it('with NO resolution (the resolver\'s own call, a legacy / test call) nothing new is enforced - the stated boundary', () => {
    expect(check('color', '#ff00aa', null)).toBeNull();
    expect(check('padding-top', '40px', null)).toBeNull();
    expect(redesignPolicyViolation({ ...base, property: 'padding-top', value: '40px' }, finding, undefined, undefined)).toBeNull();
    expect(redesignPolicyViolation({ ...base, kind: 'class', property: null, value: 'bg-[#f0a]' }, finding, undefined, undefined)).toBeNull();
  });
});

describe('5. a custom-property edit', () => {
  const hairline = () => res(target({ target: { value: 'rgba(0, 0, 0, 0.08)', comparison: 'color-deltaE', token: '--border-card' } }));
  const ds = miniDsIndex();

  it.each([
    ['--c', '330 100% 50%'], ['--c', '12px'], ['--x', 'oops'], ['--c', 'red'], ['--c', 'var(--page-raw)'], ['--c', '#ff00aa'], ['--c', 'rgba(255, 0, 170, 1)'], ['--card-pad', 'calc(var(--semantic-space, 4px) * 2)'],
  ])('refuses %s: %s for a finding with targets', (property, value) => {
    refused(check(property, value, hairline(), {}, ds), `${property}: ${value}`);
  });

  it('refuses every custom-property edit of a finding with no targets', () => {
    for (const [property, value] of [['--c', '330 100% 50%'], ['--x', '1'], ['--c', 'var(--semantic-hairline-soft)']] as const) {
      refused(check(property, value, res(target({ findingId: 'other' })), {}, ds), `${property}: ${value}`);
    }
  });

  it('allows a value that is exactly a target value, or var(<the target token>)', () => {
    expect(check('--c', 'rgba(0, 0, 0, 0.08)', hairline(), {}, ds)).toBeNull();
    expect(check('--c', 'var(--border-card)', hairline(), {}, ds)).toBeNull();
    expect(check('--c', 'var(--border-card)', hairline())).toBeNull();
    refused(check('--c', 'var(--border-section)', hairline(), {}, ds), 'another DS token');
  });

  it('a custom property is refused with no resolution only by the structure checks (the stated boundary)', () => {
    expect(check('--c', '330 100% 50%', null)).toBeNull();
  });
});

describe('7. a preserve / unresolved decision is per state', () => {
  const stateful = () => res(
    target({ property: 'border-top-color' }), preserved('border-top-color', { state: 'hover' }),
    lengthTarget('padding-top', '12px'), preserved('padding-top', { state: 'hover' }),
  );
  const hover = { selector: `${STAMP}:hover` };

  it.each([
    ['border-top-color', 'transparent'], ['border-top-color', 'currentcolor'], ['border-top-color', 'inherit'], ['border-top-color', 'rgba(0, 0, 0, 0.07)'], ['border-top-color', 'var(--semantic-hairline-faint)'],
    ['border-color', 'transparent'], ['border', 'none'], ['border-top', 'none'], ['border-block-start', '0'], ['padding-top', '40px'], ['padding-top', '12px'], ['padding', '12px'], ['padding-block-start', '12px'],
  ])('refuses %s: %s in the hover state (the report\'s repro)', (property, value) => {
    refused(check(property, value, stateful(), hover), `${property}: ${value}`);
  });

  it('names the state of the decision', () => {
    expect(check('border-top-color', 'transparent', stateful(), hover)).toMatch(/hover/);
  });

  it('the same property in the state that RESOLVES it is edited as before, and an unrelated state is untouched', () => {
    expect(check('border-top-color', 'rgba(0, 0, 0, 0.07)', stateful())).toBeNull();
    expect(check('padding-top', '12px', stateful())).toBeNull();
    // a preserved default does not block the hover state's own resolved target
    const flipped = res(preserved('border-top-color'), target({ property: 'border-top-color', state: 'hover' }));
    expect(check('border-top-color', 'rgba(0, 0, 0, 0.07)', flipped, hover)).toBeNull();
    refused(check('border-top-color', 'transparent', flipped), 'default is preserved');
  });

  it('a focus decision does not block hover, and focus-visible / focus are one state of the edit', () => {
    const r = res(preserved('padding-top', { state: 'focus' }), lengthTarget('padding-top', '12px', { state: 'hover' }));
    expect(check('padding-top', '12px', r, hover)).toBeNull();
    refused(check('padding-top', '12px', r, { selector: `${STAMP}:focus` }), 'focus');
  });
});

describe('9. a variable written without var() in a class', () => {
  const classes = (value: string, ds?: ReturnType<typeof miniDsIndex>) => redesignPolicyViolation({ ...base, kind: 'class', property: null, value }, finding, undefined, res(target()), ds ? { dsIndex: ds } : undefined);

  it.each(['bg-[--page-raw]', 'bg-[color:--page-raw]', 'border-[--page-raw]', 'text-[color:--page-raw]', 'hover:bg-[--page-raw]', 'shadow-[--page-raw]', 'ring-[color:--page-raw]'])('refuses %s', (value) => {
    refused(classes(value), value);
    refused(classes(value, miniDsIndex()), `${value} (ds)`);
  });

  it('accepts the bare variable when it is a DS token of the index, and a length variable', () => {
    const ds = miniDsIndex();
    expect(classes('bg-[--semantic-surface-white]', ds)).toBeNull();
    expect(classes('bg-[color:--semantic-surface-white]', ds)).toBeNull();
    expect(classes('w-[--page-width]', ds)).toBeNull();
    expect(classes('p-[--page-gap]', ds)).toBeNull();
  });

  it('a class the PAGE defines (bg-brand-red, .is-promo) cannot be read from its name: it is the rendered measurement (R5/R8) that sees its colour', () => {
    expect(classes('bg-brand-red is-promo')).toBeNull();
  });
});

describe('6. a style edit\'s selector', () => {
  const sel = (selector: string, kind: TargetedEdit['kind'] = 'style') => redesignPolicyViolation({ ...base, kind, property: kind === 'style' ? 'border-top-left-radius' : null, value: kind === 'style' ? '8px' : 'x', selector }, finding, undefined, res(target()));

  it.each([
    `${STAMP} .a /*"*/, #o /*"*/`, `${STAMP} /* x */ .a`, `${STAMP} .icon:not([title="\\3c /style\\3e \\3c script\\3e"])`, `${STAMP} .ic\\6f n`, `${STAMP} [title="</style><script>"]`, `${STAMP} [title="<"]`,
  ])('refuses %s', (selector) => refused(sel(selector), selector));

  it('refuses a comment in the selector of every kind of edit', () => {
    for (const kind of ['class', 'attribute', 'text', 'component-swap'] as const) refused(sel(`${STAMP} .a /* x */`, kind), kind);
  });

  it('a child combinator and a descendant selector are fine', () => {
    for (const selector of [STAMP, `${STAMP} .icon`, `${STAMP} > .icon`, `${STAMP}:hover`, `${STAMP} > ul > li:nth-child(2n + 1)`]) expect(sel(selector), selector).toBeNull();
  });

  it('a backslash is refused for a STYLE edit only (a class selector of another kind may need one: `.md\\:flex`)', () => {
    expect(sel(`${STAMP} .md\\:flex`, 'class')).toBeNull();
    refused(sel(`${STAMP} .md\\:flex`, 'style'), 'style');
  });
});
