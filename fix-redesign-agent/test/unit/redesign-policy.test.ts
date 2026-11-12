import { describe, expect, it } from 'vitest';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { redesignPolicyViolation } from '../../src/redesign-policy.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

const finding = makeFinding({ findingId: 'f1' });
const edit: TargetedEdit = {
  findingId: 'f1', selector: '[data-fra-element="button"]', expectedMatches: 1,
  kind: 'component-swap', property: null, value: '', removeValue: null,
  dsComponent: 'Button', dsVariant: 'brand', dsToken: null, rationale: 'Use existing DS variant', confidence: 1,
};

describe('persistent redesign policy', () => {
  it.each(['primary', 'primary · md · dark', 'primary · md · light'])('refuses black Button %s', (variant) => {
    expect(redesignPolicyViolation({ ...edit, dsVariant: variant }, finding)).toContain('black Button primary');
  });
  it.each(['brand', 'secondary', 'ghost', 'link'])('keeps %s available', (variant) => {
    expect(redesignPolicyViolation({ ...edit, dsVariant: variant }, finding)).toBeNull();
  });
  it.each(['var(--composition-gradient-brand-dark-shimmer)', 'black', '#000000', 'rgb(0, 0, 0)'])('refuses CTA style bypass %s', (value) => {
    expect(redesignPolicyViolation({ ...edit, kind: 'style', property: 'background', dsVariant: null, value }, finding)).not.toBeNull();
  });
  it('refuses a black fill disguised by brand metadata or a utility class', () => {
    expect(redesignPolicyViolation({ ...edit, value: 'px-4 bg-black' }, finding)).not.toBeNull();
    expect(redesignPolicyViolation({ ...edit, kind: 'style', property: 'background-image', value: 'var(--composition-gradient-brand-dark-shimmer)' }, finding)).not.toBeNull();
  });
  it('allows black text and dark non-CTA surfaces', () => {
    expect(redesignPolicyViolation({ ...edit, kind: 'style', property: 'color', value: '#000', dsVariant: null }, finding)).toBeNull();
    expect(redesignPolicyViolation({ ...edit, kind: 'style', dsComponent: 'Card', dsVariant: null, property: 'background', value: '#000' })).toBeNull();
  });
  it.each(['text-align', 'position', 'grid-template-columns', 'overflow'])('preserves unrelated %s', (property) => {
    expect(redesignPolicyViolation({ ...edit, kind: 'style', property, value: 'initial' }, finding)).toContain('preserve original');
  });
  it('allows a selected alignment mismatch and ordinary input geometry fixes', () => {
    const authorized = makeFinding({ findingId: 'f1', mismatches: [{ property: 'text-align', actual: 'left', expected: 'center', expectedToken: null, comparison: 'exact', delta: null }] });
    expect(redesignPolicyViolation({ ...edit, kind: 'style', property: 'text-align', value: 'center' }, authorized)).toBeNull();
    expect(redesignPolicyViolation({ ...edit, kind: 'style', property: 'border-radius', value: 'var(--radius-xs)' }, finding)).toBeNull();
  });
});

describe('resolution-aware authorization (the Resolver\'s derived targets)', () => {
  const t = (over: Partial<ResolvedTarget>): ResolvedTarget => ({
    id: 'x', findingId: 'f1', property: 'border-top-left-radius', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
    audit: { status: 'UNRESOLVED', actual: null, expected: null, expectedToken: null, note: null, source: null }, reason: 'no-ds-requirement', outcome: 'preserve-existing', target: null,
    provenance: { kind: 'original-baseline', ds: null, reference: null, evidence: [] }, decisionReason: 'the DS states no requirement', route: 'none', acceptance: [],
    status: { design: 'preserved', implementation: 'not-applicable', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
  });
  const file = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });
  const styleEdit = (property: string, value: string): TargetedEdit => ({ ...edit, kind: 'style', dsComponent: null, dsVariant: null, property, value });

  it('refuses a style edit of a property the Resolver PRESERVED or left UNRESOLVED, naming why', () => {
    const preserved = file(t({ property: 'padding-top' }), t({ id: 'u', property: 'background-color', outcome: 'unresolved', reason: 'state-context', decisionReason: 'hover treatment not captured', status: { design: 'unresolved', implementation: 'not-applicable', verification: 'not-run', implementationDetail: null, verificationDetail: null } }));
    expect(redesignPolicyViolation(styleEdit('padding-top', '12px'), finding, undefined, preserved)).toMatch(/padding-top was resolved as preserve-existing \(no-ds-requirement\)/);
    expect(redesignPolicyViolation(styleEdit('background-color', '#fff'), finding, undefined, preserved)).toMatch(/resolved as unresolved \(state-context\)/);
  });

  it('allows an edit of a property a resolved target authorizes, and lifts the composition protection only for that property', () => {
    const resolved = file(t({ property: 'text-align', outcome: 'resolved-target', target: { value: 'center', comparison: 'exact', token: null }, status: { design: 'resolved', implementation: 'not-started', verification: 'not-run', implementationDetail: null, verificationDetail: null } }));
    expect(redesignPolicyViolation(styleEdit('text-align', 'center'), finding, undefined, resolved)).toBeNull();
    expect(redesignPolicyViolation(styleEdit('position', 'sticky'), finding, undefined, resolved)).toContain('preserve original');
  });

  it('a property blocked for one state but resolved for another stays editable', () => {
    const mixed = file(t({ property: 'background-color', state: 'hover' }), t({ id: 'd', property: 'background-color', outcome: 'resolved-target', target: { value: '#fff', comparison: 'color-deltaE', token: null } }));
    expect(redesignPolicyViolation(styleEdit('background-color', '#fff'), finding, undefined, mixed)).toBeNull();
  });

  it('only a target of the element itself authorizes or blocks an edit of it: a label- or descendant-part target does neither', () => {
    const resolvedLabel = file(t({ property: 'text-align', part: 'label', outcome: 'resolved-target', target: { value: 'center', comparison: 'exact', token: null }, status: { design: 'resolved', implementation: 'blocked', verification: 'not-run', implementationDetail: null, verificationDetail: null } }));
    expect(redesignPolicyViolation(styleEdit('text-align', 'center'), finding, undefined, resolvedLabel)).toContain('preserve original');
    const resolvedDescendant = file(t({ property: 'text-align', part: 'descendants', outcome: 'resolved-target', target: { value: 'center', comparison: 'exact', token: null } }));
    expect(redesignPolicyViolation(styleEdit('text-align', 'center'), finding, undefined, resolvedDescendant)).toContain('preserve original');
    // a preserved LABEL padding blocks nothing on the element; the element's own padding-top is authorized by its own (self) target, not by the label's decision
    const preservedLabel = file(t({ property: 'padding-top', part: 'label' }), t({ id: 'p', property: 'padding-top', outcome: 'resolved-target', target: { value: '12px', comparison: 'length-px', token: null } }));
    expect(redesignPolicyViolation(styleEdit('padding-top', '12px'), finding, undefined, preservedLabel)).toBeNull();
    // round 4: without that self target the property is simply not authorized (the audit's mismatch list names padding-left and font-weight only)
    expect(redesignPolicyViolation(styleEdit('padding-top', '12px'), finding, undefined, file(t({ property: 'padding-top', part: 'label' })))).toMatch(/padding-top \(default state\) is not authorized/);
    // the element's own target still counts when a label target sits beside it
    const both = file(t({ id: 'l', property: 'text-align', part: 'label' }), t({ id: 's', property: 'text-align', outcome: 'resolved-target', target: { value: 'center', comparison: 'exact', token: null } }));
    expect(redesignPolicyViolation(styleEdit('text-align', 'center'), finding, undefined, both)).toBeNull();
  });

  it('the CTA protections still hold when the Resolver authorizes the property: a black fill or a primary variant is refused regardless', () => {
    const resolved = file(t({ property: 'background-color', outcome: 'resolved-target', target: { value: '#000', comparison: 'color-deltaE', token: null } }));
    expect(redesignPolicyViolation({ ...edit, kind: 'style', property: 'background-color', dsVariant: null, value: '#000000' }, finding, undefined, resolved)).toContain('black CTA fill');
    expect(redesignPolicyViolation({ ...edit, dsVariant: 'primary · md · light' }, finding, undefined, resolved)).toContain('black Button primary');
  });

  it('without a resolution the original behaviour is unchanged', () => {
    expect(redesignPolicyViolation(styleEdit('padding-top', '12px'), finding, undefined, null)).toBeNull();
    expect(redesignPolicyViolation(styleEdit('text-align', 'center'), finding, undefined, null)).toContain('preserve original');
  });
});

describe('a resolved colour target binds the VALUE of an edit, not only its property (colour lane, defect 7)', () => {
  const colourTarget = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
    id: 'c', findingId: 'f1', property: 'border-top-color', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
    audit: { status: 'NOT-LISTED', actual: null, expected: null, expectedToken: null, note: null, source: null }, reason: 'missing-ds-treatment', outcome: 'resolved-target',
    target: { value: 'rgba(0, 0, 0, 0.07)', comparison: 'color-deltaE', token: '--semantic-hairline-faint' },
    provenance: { kind: 'approved-project-pattern', ds: null, reference: null, evidence: [] }, decisionReason: 'mapped', route: 'css-edit', acceptance: [],
    status: { design: 'resolved', implementation: 'not-started', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
  });
  const res = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });
  const styleEdit = (property: string, value: string, selector = '[data-fra-element="button"]'): TargetedEdit => ({ ...edit, kind: 'style', dsComponent: null, dsVariant: null, property, value, selector });
  const check = (value: string, resolution = res(colourTarget()), selector?: string) => redesignPolicyViolation(styleEdit('border-top-color', value, selector), finding, undefined, resolution);

  it.each(['#ff00aa', 'rgba(255,0,170,.5)', 'red', 'rgba(0, 0, 0, 0.5)', 'var(--some-other-token)', 'currentcolor'])('refuses a raw / different colour %s for an authorized colour target', (value) => {
    const v = check(value);
    expect(v, value).not.toBeNull();
    expect(v).toContain('Project redesign policy:');
    expect(v).toMatch(/border-top-color/);
    expect(v).toMatch(/rgba\(0, 0, 0, 0\.07\)/);
  });

  it.each(['rgba(0, 0, 0, 0.07)', 'rgba(0,0,0,.07)', 'RGBA(0 0 0 / 7%)', 'hsla(0, 0%, 0%, 0.07)', '#00000012', 'rgba(0, 0, 0, 0.07) !important', 'var(--semantic-hairline-faint)', 'var( --semantic-hairline-faint )'])('allows an equivalent representation %s', (value) => {
    expect(check(value), value).toBeNull();
  });

  it('an equivalent colour within the verifier tolerance is accepted, a visibly different one is not', () => {
    expect(check('rgba(0, 0, 0, 0.075)')).toBeNull();
    expect(check('rgba(0, 0, 0, 0.2)')).not.toBeNull();
  });

  it('applies to the state the edit is for: a hover edit is held to the hover target, a default edit to the default one', () => {
    const both = res(colourTarget(), colourTarget({ id: 'h', state: 'hover', target: { value: 'rgba(0, 0, 0, 0.15)', comparison: 'color-deltaE', token: '--border-input' } }));
    expect(check('rgba(0, 0, 0, 0.15)', both, '[data-fra-element="button"]:hover')).toBeNull();
    expect(check('rgba(0, 0, 0, 0.07)', both, '[data-fra-element="button"]:hover')).not.toBeNull();
    expect(check('rgba(0, 0, 0, 0.07)', both)).toBeNull();
    expect(check('rgba(0, 0, 0, 0.15)', both)).not.toBeNull();
    expect(check('#ff00aa', both, '[data-fra-element="button"]:hover')).toMatch(/hover/);
  });

  it('holds for any provenance: an audit-expected colour target too, with its equivalent representations', () => {
    const audit = res(colourTarget({ target: { value: 'rgb(26, 26, 26)', comparison: 'color-deltaE', token: '--semantic-ink-strong' }, provenance: { kind: 'audit-expected', ds: null, reference: null, evidence: [] } }));
    expect(check('#1a1a1a', audit)).toBeNull();
    expect(check('rgb(26 26 26)', audit)).toBeNull();
    expect(check('var(--semantic-ink-strong)', audit)).toBeNull();
    expect(check('#ff00aa', audit)).not.toBeNull();
  });

  it('a keyword target (transparent) is matched as it is', () => {
    const t = res(colourTarget({ target: { value: 'transparent', comparison: 'color-deltaE', token: null } }));
    expect(check('transparent', t)).toBeNull();
    expect(check('rgba(0, 0, 0, 0)', t)).toBeNull();
    expect(check('#ff00aa', t)).not.toBeNull();
  });

  it('a length target is not value-bound; a colour target of ANOTHER part or property now binds every colour in the finding\'s edits (round 2: bound by content, not by property name)', () => {
    expect(redesignPolicyViolation(styleEdit('border-top-left-radius', '99px'), finding, undefined, res(colourTarget({ property: 'border-top-left-radius', target: { value: '8px', comparison: 'length-px', token: null } })))).toBeNull();
    // these two used to be waved through: a raw colour reached the page because the target was another part / another property
    expect(check('#ff00aa', res(colourTarget({ part: 'label' })))).not.toBeNull();
    expect(redesignPolicyViolation(styleEdit('color', '#ff00aa'), finding, undefined, res(colourTarget()))).not.toBeNull();
  });

  it('a colour target that is preserved or unresolved still refuses the edit, as before', () => {
    const preserved = res(colourTarget({ outcome: 'preserve-existing', target: null }));
    expect(check('#ff00aa', preserved)).toMatch(/resolved as preserve-existing/);
  });
});
