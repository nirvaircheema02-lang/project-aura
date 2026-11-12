import { describe, expect, it } from 'vitest';
import { reconcile, roleOf, type ReconcileState, type Settled } from '../../src/agents/b7-coverage-qa/reconcile.ts';
import { itemKey } from '../../src/agents/b7-coverage-qa/reconcile.ts';
import { emptyVerificationReport } from '../../src/agents/b5-visual-verifier/completeness.ts';
import type { RawManifestItem } from '../../src/agents/b7-coverage-qa/manifest.ts';
import type { AriaElement } from '../../src/t-layer/element-registry.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';
import type { B2Decision, DetectedComponent, SectionInfo } from '../../src/agents/types.ts';

/**
 * B7's reconciliation, pure: for every item of an independent manifest, WHERE did the audit account for it —
 * and was it audited under the right ROLE? Every exclusion must come with a stated reason; nothing is excluded
 * because it is awkward (a stat, a hover layer, a carousel slide); and an item nothing accounts for is a gap.
 */

type Box = { x: number; y: number; width: number; height: number };

function item(over: Partial<RawManifestItem> & { id: string; text: string }): RawManifestItem {
  const box: Box = over.box ?? { x: 100, y: 200, width: 300, height: 24 };
  const tag = over.tag ?? 'p';
  const facts = over.facts ?? {
    tag, classes: [], roleAttr: null, cursor: 'auto', text: over.text, hasSvg: false, hasImg: false, ownText: true, childElementCount: 0,
    style: { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', borderTopWidth: '0px', borderTopStyle: 'none', paddingLeft: '0px', paddingTop: '0px', color: 'rgb(10, 10, 10)', fontSize: '16px', fontWeight: '400', display: 'block', opacity: '1', visibility: 'visible', textTransform: 'none', letterSpacing: 'normal' },
    box,
  };
  return {
    kind: 'text', role: tag === 'p' ? 'paragraph' : tag.startsWith('h') ? 'heading' : 'generic', tag, box, facts, visibility: 'visible', where: [], reveal: { kind: null, hostSelector: null, controlSelector: null },
    place: { inNavigation: false, inFooter: false, insideOwner: false, ownerText: null }, stamps: { self: [], inner: [], owner: [] }, source: 'dom', ...over,
  };
}

/** A text item of a given computed size/weight/transform/tracking. */
function text(id: string, tag: string, words: string, style: Partial<RawManifestItem['facts']['style']>, box: Box): RawManifestItem {
  const base = item({ id, text: words, tag, box, kind: tag.startsWith('h') ? 'heading' : 'text' });
  return { ...base, facts: { ...base.facts, tag, text: words, box, style: { ...base.facts.style, ...style } } };
}

const aria = (ref: string, role: string, words: string, box: Box): AriaElement => ({
  ref, role, name: role === 'heading' ? words : '', depth: 1, parentRef: null, box,
  line: `- ${role}${role === 'heading' ? ` "${words}" [level=2]` : ''} [ref=${ref}] [box=${box.x},${box.y},${box.width},${box.height}]${role === 'heading' ? '' : `: ${words}`}`,
});

const section = (over: Partial<SectionInfo> = {}): SectionInfo => ({ id: 's0', name: 'Intro', kind: 'content', rootRef: 'e0', personalized: false, isListing: false, note: '', box: { x: 0, y: 0, width: 1440, height: 2000 }, ...over });
const component = (over: Partial<DetectedComponent> & { elId: string; ref: string; findingId: string; componentType: string }): DetectedComponent => ({ label: 'x', headingRole: undefined, ...over }) as unknown as DetectedComponent;
const finding = (findingId: string, classification: Finding['classification'], over: Record<string, unknown> = {}): Finding => ({ identity: { findingId }, classification, component: { dsComponent: null, dsVariant: null, signature: `sig-${findingId}`, productionType: 'paragraph' }, quality: { escalationReasons: [] }, ...over }) as unknown as Finding;

const state = (over: Partial<ReconcileState> = {}): ReconcileState => ({ components: [], findings: [], ariaElements: [], sections: [section()], decisions: {}, viewportWidth: 1440, ...over });

describe('where the audit accounts for each item', () => {
  it('a stamped element is AUDITED — through the finding of the component carrying that stamp', () => {
    const p = item({ id: 'b7-1', text: 'Plain copy', stamps: { self: ['s0-0'], inner: [], owner: [] } });
    const [r] = reconcile([p], state({ components: [component({ elId: 's0-0', ref: 'e5', findingId: 'f1', componentType: 'paragraph' })], findings: [finding('f1', 'MATCH')] }));
    expect(r?.state).toBe('AUDITED');
    expect(r?.reason).toContain('paragraph');
    expect(r?.finding?.identity.findingId).toBe('f1');
  });

  it('words inside an audited heading or control are covered by it — but a CARD or SECTION around them never covers them', () => {
    const inHeading = item({ id: 'b7-1', text: 'Title', stamps: { self: [], inner: [], owner: [{ id: 's0-h', ownerLike: true }] } });
    const inCard = item({ id: 'b7-2', text: 'Card copy', stamps: { self: [], inner: [], owner: [{ id: 's0-c', ownerLike: false }] } });
    const comps = [component({ elId: 's0-h', ref: 'e1', findingId: 'fh', componentType: 'section-heading' }), component({ elId: 's0-c', ref: 'e2', findingId: 'fc', componentType: 'card' })];
    const recs = reconcile([inHeading, inCard], state({ components: comps, findings: [finding('fh', 'MATCH'), finding('fc', 'DEVIATION')] }));
    expect(recs.map((r) => r.state)).toEqual(['AUDITED', 'UNACCOUNTED']); // the card audit says nothing about the paragraph inside it
    expect(recs[1]?.gap?.type).toBe('missing');
  });

  it('a finding that says a human must decide is NEEDS_REVIEW (with the finding\'s own reason) — and so is an UNVERIFIED one', () => {
    const a = item({ id: 'b7-1', text: 'A', stamps: { self: ['s0-0'], inner: [], owner: [] } });
    const b = item({ id: 'b7-2', text: 'B', stamps: { self: ['s0-1'], inner: [], owner: [] } });
    const comps = [component({ elId: 's0-0', ref: 'e1', findingId: 'f1', componentType: 'badge' }), component({ elId: 's0-1', ref: 'e2', findingId: 'f2', componentType: 'badge' })];
    const [ra, rb] = reconcile([a, b], state({ components: comps, findings: [finding('f1', 'NEEDS_REVIEW', { review: { status: 'NEEDS_REVIEW', reason: 'resembles two components equally' } }), finding('f2', 'UNVERIFIED')] }));
    expect(ra).toMatchObject({ state: 'NEEDS_REVIEW', reason: 'resembles two components equally' });
    expect(rb?.state).toBe('NEEDS_REVIEW');
  });

  it('every decision B2 recorded becomes an EXCLUSION carrying B2\'s own reason — and an unresolvable ref is a CAPTURE_FAILED', () => {
    const cases: Array<[B2Decision['kind'], string, 'EXCLUDED_WITH_REASON' | 'CAPTURE_FAILED']> = [
      ['sampled', 'a member of a repeated listing — bounded listing sampling audits the first 5 per group and counts the rest (§2.7)', 'EXCLUDED_WITH_REASON'],
      ['off-domain', 'an off-domain utility link — not part of the audited site', 'EXCLUDED_WITH_REASON'],
      ['merged', 'same control as e9 (boxes coincide ≥ 90% both ways)', 'EXCLUDED_WITH_REASON'],
      ['hidden', 'visually hidden — clipped to ≤ 2px', 'EXCLUDED_WITH_REASON'],
      ['not-candidate', 'a repeated block with no card surface — a layout column', 'EXCLUDED_WITH_REASON'],
      ['unresolvable', 'could not be read or captured at detection time', 'CAPTURE_FAILED'],
    ];
    for (const [kind, reason, expected] of cases) {
      const box = { x: 100, y: 300, width: 300, height: 24 };
      const [r] = reconcile([item({ id: 'b7-1', text: 'Some words', box })], state({ ariaElements: [aria('e7', 'paragraph', 'Some words', box)], decisions: { e7: { kind, reason } } }));
      expect(r?.state, kind).toBe(expected);
      expect(r?.reason, kind).toBe(reason);
    }
  });

  it('B5\'s verification report is read too: what it excluded (with its reason) and what it could not capture', () => {
    const verification = emptyVerificationReport(1);
    verification.excluded.push({ ref: 'e7', sectionId: 's0', reason: 'a repeated block with no card surface — a layout column' });
    verification.captureFailures.push({ ref: 'e8', sectionId: 's0', reason: 'evidence capture failed after 2 attempts' });
    const b1 = { x: 100, y: 300, width: 300, height: 24 };
    const b2 = { x: 100, y: 400, width: 300, height: 24 };
    const recs = reconcile([item({ id: 'b7-1', text: 'One', box: b1 }), item({ id: 'b7-2', text: 'Two', box: b2 })], state({ ariaElements: [aria('e7', 'paragraph', 'One', b1), aria('e8', 'paragraph', 'Two', b2)], verification }));
    expect(recs.map((r) => [r.state, r.reason])).toEqual([['EXCLUDED_WITH_REASON', 'a repeated block with no card surface — a layout column'], ['CAPTURE_FAILED', 'evidence capture failed after 2 attempts']]);
  });

  it('policy exclusions B7 can state itself: a personalised section, a visually hidden item, a composite the classifier declines', () => {
    const personalised = item({ id: 'b7-1', text: 'Recommended for you', box: { x: 100, y: 2500, width: 300, height: 24 } });
    const srOnly = item({ id: 'b7-2', text: 'Skip to content', visibility: 'sr-only', box: { x: 0, y: 10, width: 1, height: 1 } });
    const composite = text('b7-3', 'p', 'Download the report', { fontSize: '16px' }, { x: 100, y: 300, width: 300, height: 24 });
    composite.facts = { ...composite.facts, hasSvg: true };
    const recs = reconcile([personalised, srOnly, composite], state({ sections: [section({ box: { x: 0, y: 0, width: 1440, height: 1000 } }), section({ id: 's1', name: 'Recommended', personalized: true, box: { x: 0, y: 2000, width: 1440, height: 1000 } })] }));
    expect(recs[0]).toMatchObject({ state: 'EXCLUDED_WITH_REASON' });
    expect(recs[0]?.reason).toContain('personalised section');
    expect(recs[1]?.reason).toContain('visually hidden');
    expect(recs[2]).toMatchObject({ state: 'EXCLUDED_WITH_REASON' });
    expect(recs[2]?.reason).toContain('image or icon'); // B2's own stated reason, not B7's invention
  });

  it('an item nothing accounts for is UNACCOUNTED — a gap, never an exclusion by default', () => {
    const [r] = reconcile([item({ id: 'b7-1', text: 'Orphaned words' })], state());
    expect(r).toMatchObject({ state: 'UNACCOUNTED' });
    expect(r?.gap).toMatchObject({ type: 'missing' });
  });

  it('a decision B7 itself settled (an exclusion it decided, a capture it could not make) survives a manifest rebuild', () => {
    const p = item({ id: 'b7-77', text: 'Orphaned words' });
    const settled = new Map<string, Settled>([[itemKey(p), { state: 'CAPTURE_FAILED', reason: 'evidence capture failed' }]]);
    // the same item after a rebuild carries a different id — its key is what identifies it
    const [r] = reconcile([{ ...p, id: 'b7-3' }], state(), new Map(), settled);
    expect(r).toMatchObject({ state: 'CAPTURE_FAILED', reason: 'evidence capture failed' });
  });
});

describe('content that is not painted by default is a STATE gap — never silently excluded', () => {
  const notPainted: B2Decision = { kind: 'not-candidate', reason: 'not painted (opacity: 0)' };

  it('a hover / scroll-in layer B2 declined as "not painted" is still a gap: something reveals it', () => {
    const box = { x: 100, y: 300, width: 300, height: 24 };
    const layer = item({ id: 'b7-1', text: 'Revealed on hover text', visibility: 'faded', reveal: { kind: 'hover', hostSelector: '[data-audit-b7-host="h-1"]', controlSelector: null }, box });
    const [r] = reconcile([layer], state({ ariaElements: [aria('e7', 'paragraph', 'Revealed on hover text', box)], decisions: { e7: notPainted } }));
    expect(r).toMatchObject({ state: 'UNACCOUNTED' });
    expect(r?.gap).toMatchObject({ type: 'state' });
  });

  it('FAQ / tab-panel content behind a collapsed control and an off-screen carousel slide are state gaps too', () => {
    const faq = item({ id: 'b7-1', text: 'The answer', visibility: 'collapsed', box: { x: 0, y: 0, width: 0, height: 0 }, reveal: { kind: 'accordion', hostSelector: null, controlSelector: '[aria-controls~="a1"]' }, where: ['faq'] });
    const slide = item({ id: 'b7-2', text: 'Step 06', visibility: 'collapsed', box: { x: 0, y: 0, width: 0, height: 0 }, reveal: { kind: 'carousel', hostSelector: null, controlSelector: null }, where: ['carousel'] });
    const recs = reconcile([faq, slide], state());
    expect(recs.map((r) => [r.state, r.gap?.type])).toEqual([['UNACCOUNTED', 'state'], ['UNACCOUNTED', 'state']]);
  });
});

describe('the role check — was it audited under the right role? (independent, from the whole section hierarchy)', () => {
  // The brand-perception-survey intro, as measured live.
  const eyebrowBox = { x: 188, y: 1651, width: 140, height: 15 };
  const descBox = { x: 160, y: 1684, width: 270, height: 48 };
  const mainBox = { x: 496, y: 1648, width: 784, height: 68 };
  const statBox = { x: 496, y: 1756, width: 243, height: 40 };
  const EYEBROW = () => text('b7-1', 'h2', 'ABOUT KEN SURVEY', { fontSize: '10px', fontWeight: '500', color: 'rgb(70, 68, 73)' }, eyebrowBox); // literal upper-case, NO text-transform, NO tracking
  const DESC = () => text('b7-2', 'h3', 'Built on Reach, Research, and Real Voices', { fontSize: '16px', fontWeight: '400' }, descBox);
  const MAIN = () => text('b7-3', 'p', 'Use real feedback from real audiences to understand what drives decisions and act with confidence.', { fontSize: '30px', fontWeight: '300' }, mainBox);
  const STAT = () => text('b7-4', 'p', '250000+', { fontSize: '36px' }, statBox);
  const arias = [aria('e1', 'heading', 'ABOUT KEN SURVEY', eyebrowBox), aria('e2', 'heading', 'Built on Reach, Research, and Real Voices', descBox), aria('e3', 'paragraph', 'Use real feedback…', mainBox), aria('e4', 'paragraph', '250000+', statBox)];

  const roles = () => Object.fromEntries(reconcile([EYEBROW(), DESC(), MAIN(), STAT()], state({ ariaElements: arias })).map((r) => [r.raw.text.slice(0, 12), roleOf(r.raw, r.independent ?? undefined)]));

  it('classifies the supporting heading, the main heading (a <p>), the description and the stat from the section — not from the tags', () => {
    expect(roles()).toEqual({ 'ABOUT KEN SU': 'eyebrow', 'Built on Rea': 'description', 'Use real fee': 'main-heading', '250000+': 'stat' });
  });

  it('literal upper-case text is an eyebrow even with no text-transform and no letter-spacing', () => {
    const [r] = reconcile([EYEBROW(), MAIN()], state({ ariaElements: arias }));
    expect(r?.raw.facts.style.textTransform).toBe('none');
    expect(r?.raw.facts.style.letterSpacing).toBe('normal');
    expect(roleOf(r!.raw, r!.independent ?? undefined)).toBe('eyebrow');
  });

  it('a supporting heading audited as a SECTION HEADING is a role gap (and one audited as an eyebrow is not)', () => {
    const wrong = component({ elId: 's0-0', ref: 'e1', findingId: 'f1', componentType: 'section-heading' });
    const right = component({ elId: 's0-0', ref: 'e1', findingId: 'f1', componentType: 'eyebrow', headingRole: 'eyebrow' });
    const stamped = { ...EYEBROW(), stamps: { self: ['s0-0'], inner: [], owner: [] } };
    const items = [stamped, DESC(), MAIN(), STAT()];
    const [asHeading] = reconcile(items, state({ ariaElements: arias, components: [wrong], findings: [finding('f1', 'DEVIATION')] }));
    expect(asHeading?.state).toBe('AUDITED');
    expect(asHeading?.gap).toMatchObject({ type: 'role' });
    expect(asHeading?.gap?.detail).toContain('supporting heading');
    const [asEyebrow] = reconcile(items, state({ ariaElements: arias, components: [right], findings: [finding('f1', 'DEVIATION')] }));
    expect(asEyebrow?.gap).toBeNull();
  });

  it('the dominant <p> audited as body text is a role gap — and one nobody audited at all is a missing element (never ignored)', () => {
    const asParagraph = component({ elId: 's0-2', ref: 'e3', findingId: 'f3', componentType: 'paragraph' });
    const stamped = { ...MAIN(), stamps: { self: ['s0-2'], inner: [], owner: [] } };
    const recs = reconcile([EYEBROW(), DESC(), stamped, STAT()], state({ ariaElements: arias, components: [asParagraph], findings: [finding('f3', 'MATCH')] }));
    const main = recs.find((r) => r.raw.id === 'b7-3')!;
    expect(main.gap).toMatchObject({ type: 'role' });
    expect(main.gap?.detail).toContain('main section heading');
    const unaudited = reconcile([EYEBROW(), DESC(), MAIN(), STAT()], state({ ariaElements: arias })).find((r) => r.raw.id === 'b7-3')!;
    expect(unaudited).toMatchObject({ state: 'UNACCOUNTED' });
    expect(unaudited.gap).toMatchObject({ type: 'missing' });
    expect(roleOf(unaudited.raw, unaudited.independent ?? undefined)).toBe('main-heading');
  });

  it('stat text nobody audited is UNACCOUNTED — never excluded; audited as body text it is a role gap', () => {
    const [, , , stat] = reconcile([EYEBROW(), DESC(), MAIN(), STAT()], state({ ariaElements: arias }));
    expect(stat).toMatchObject({ state: 'UNACCOUNTED' });
    const asParagraph = component({ elId: 's0-3', ref: 'e4', findingId: 'f4', componentType: 'paragraph' });
    const stamped = { ...STAT(), stamps: { self: ['s0-3'], inner: [], owner: [] } };
    const [, , , audited] = reconcile([EYEBROW(), DESC(), MAIN(), stamped], state({ ariaElements: arias, components: [asParagraph], findings: [finding('f4', 'MATCH')] }));
    expect(audited?.gap).toMatchObject({ type: 'role' });
    expect(audited?.gap?.detail).toContain('stat');
  });

  it('a model-typed audit is not judged by the deterministic classifier (checkRoles: false) — accounting still applies', () => {
    const wrong = component({ elId: 's0-0', ref: 'e1', findingId: 'f1', componentType: 'section-heading' });
    const stamped = { ...EYEBROW(), stamps: { self: ['s0-0'], inner: [], owner: [] } };
    const [r] = reconcile([stamped, DESC(), MAIN(), STAT()], state({ ariaElements: arias, components: [wrong], findings: [finding('f1', 'DEVIATION')], checkRoles: false }));
    expect(r?.state).toBe('AUDITED');
    expect(r?.gap).toBeNull();
  });
});

/**
 * What the real Customer Satisfaction Survey audit showed: audited elements — six of them `MATCH` — reported as
 * "no finding, no recorded decision and no stamp — the audit never reached it", because the page had re-rendered the
 * node and its stamp was gone. An element the audit checked must never read as unaccounted, and recovery must never
 * re-audit it (a duplicate finding).
 */
describe('an audited element whose DOM stamp is gone is still AUDITED — a MATCH included', () => {
  const where: Box = { x: 173, y: 3885, width: 223, height: 24 };
  const words = 'Industry-Specific Intelligence';
  const auditedAt = (box: Box, over: Partial<DetectedComponent> = {}) =>
    component({ elId: 's0-9', ref: 'e9', findingId: 'f9', componentType: 'paragraph', label: words, fingerprint: { box } as never, domFacts: { box } as never, ...over });

  it('same words in the same place → AUDITED through that component\'s finding (a MATCH is a valid audited result)', () => {
    const [r] = reconcile([item({ id: 'b7-1', text: words, box: where })], state({ components: [auditedAt(where)], findings: [finding('f9', 'MATCH')] }));
    expect(r).toMatchObject({ state: 'AUDITED', gap: null });
    expect(r?.finding?.identity.findingId).toBe('f9');
    expect(r?.reason).toContain('paragraph');
  });

  it('the page re-laid the node out a few px away (an entrance animation, a sub-pixel rounding): still the same element', () => {
    const captured: Box = { x: 172, y: 3884, width: 224, height: 24 };
    const [r] = reconcile([item({ id: 'b7-1', text: words, box: where })], state({ components: [auditedAt(captured)], findings: [finding('f9', 'MATCH')] }));
    expect(r?.state).toBe('AUDITED');
  });

  it('the same words ELSEWHERE on the page are a different element — still a gap', () => {
    const [r] = reconcile([item({ id: 'b7-1', text: words, box: where })], state({ components: [auditedAt({ ...where, y: where.y + 900 })], findings: [finding('f9', 'MATCH')] }));
    expect(r).toMatchObject({ state: 'UNACCOUNTED' });
    expect(r?.gap?.type).toBe('missing');
  });

  it('one-to-one: of two items with the same words only the closer one owns the component — the other stays a gap, never a second claim', () => {
    const near = item({ id: 'b7-1', text: 'Blog', box: { x: 192, y: 6648, width: 232, height: 20 } });
    const far = item({ id: 'b7-2', text: 'Blog', box: { x: 192, y: 6652, width: 232, height: 20 } });
    const blog = component({ elId: 's0-9', ref: 'e9', findingId: 'f9', componentType: 'eyebrow', label: 'Blog', fingerprint: { box: near.box } as never, domFacts: { box: near.box } as never });
    const recs = reconcile([far, near], state({ components: [blog], findings: [finding('f9', 'DEVIATION')] }));
    expect(recs.find((r) => r.raw.id === 'b7-1')?.state).toBe('AUDITED');
    expect(recs.find((r) => r.raw.id === 'b7-2')?.state).toBe('UNACCOUNTED');
  });

  it('a component an item already owns BY ITS STAMP is never offered to another item as its twin', () => {
    const stamped = item({ id: 'b7-1', text: words, box: where, stamps: { self: ['s0-9'], inner: [], owner: [] } });
    const lookalike = item({ id: 'b7-2', text: words, box: { ...where, y: where.y + 1 } });
    const recs = reconcile([stamped, lookalike], state({ components: [auditedAt(where)], findings: [finding('f9', 'MATCH')] }));
    expect(recs.map((r) => r.state)).toEqual(['AUDITED', 'UNACCOUNTED']);
  });

  it("B7's own record of what it captured for an item links it even when the words differ (and survives a lost stamp)", () => {
    const target = item({ id: 'b7-1', text: 'A long paragraph that the component label truncated differently', box: where });
    const comp = auditedAt({ x: 900, y: 10, width: 10, height: 10 }, { label: 'unrelated label' });
    const key = itemKey(target);
    const [without] = reconcile([target], state({ components: [comp], findings: [finding('f9', 'MATCH')] }));
    expect(without?.state).toBe('UNACCOUNTED');
    const [withLink] = reconcile([target], state({ components: [comp], findings: [finding('f9', 'MATCH')] }), new Map(), new Map(), new Map([[key, 's0-9']]));
    expect(withLink?.state).toBe('AUDITED');
  });

  it('an item with no box (collapsed behind a control) is linked by its stamp only — never by a place it does not have', () => {
    const collapsed = item({ id: 'b7-1', text: words, visibility: 'collapsed', box: { x: 0, y: 0, width: 0, height: 0 } });
    const [r] = reconcile([collapsed], state({ components: [auditedAt({ x: 0, y: 0, width: 0, height: 0 })], findings: [finding('f9', 'MATCH')] }));
    expect(r?.state).toBe('UNACCOUNTED');
  });
});
