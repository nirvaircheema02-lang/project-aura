import { describe, expect, it } from 'vitest';
import { compareDesign, pseudoValuesEqual, valuesEqual } from '../../src/fidelity/compare.ts';
import { BY_DESIGN_GAP_REASONS, gapSplit } from '../../src/fidelity/coverage.ts';
import { summarizePreserve } from '../../src/fidelity/accounting.ts';
import { evaluatePreserveTargets } from '../../src/fidelity/verify.ts';
import type { CapturedElement, DesignBaseline, DesignCapture, FidelityReport, SectionDesign, StyleRecord } from '../../src/fidelity/types.ts';
import type { Exemption } from '../../src/resolution/schema.ts';
import { base, cap, el, resolutionOf, sec, target } from '../helpers/fidelity-captures.ts';

/**
 * Round 3 of the fidelity re-review, built from capture literals (no browser). The cases that need a real page are in test/integration/fidelity-round3.test.ts.
 */

const run = (b: DesignBaseline, o: DesignCapture, exemptions: Exemption[] = []): FidelityReport => compareDesign({ baseline: b, observed: o, exemptions, now: () => new Date(0) });
const ok = (id = 'ok'): SectionDesign => sec({ sectionId: id });
const BLACK: StyleRecord = { color: 'rgb(0, 0, 0)', 'font-size': '16px', 'padding-top': '40px', 'box-shadow': 'none', 'background-image': 'none' };
const ex = (property: string, over: Partial<Exemption> = {}): Exemption => ({ findingId: 'F1', property, part: 'self', state: 'default', viewport: 'any', targetId: `t-${property}`, reason: `fix ${property}`, ...over });
const regressions = (r: FidelityReport) => r.differences.filter((d) => d.classification === 'regression');

describe('round 3 · 1 — a pseudo-element sized from its owner follows an authorized layout change of the owner (the box it is sized from: see round 4 · 1)', () => {
  const PSEUDO: StyleRecord = { content: '""', display: 'block', 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(0, 0, 0)', opacity: '1', transform: 'none', width: '80px', height: '2px', 'box-shadow': 'none', 'background-image': 'none' };
  const owner = (box: { w: number; h: number } | undefined, after: StyleRecord, style: StyleRecord = BLACK) =>
    // (a block owner without padding or border: its box IS the box its pseudo is sized from)
    el('0', { tag: 'a', label: 'Tile', textHash: 'tile', roles: ['finding', 'interactive'], findingIds: ['F1'], stateAttempt: { hover: 'captured' }, style, pseudo: { after }, ...(box ? { box, pseudoRef: { after: { from: 'content-box' as const, box } } } : {}) });
  const section = (e: CapturedElement) => sec({ elements: [el(''), e], pseudoCaptured: true });
  const pair = (b: CapturedElement, o: CapturedElement) => [base([ok(), section(b)]), cap([ok(), section(o)])] as const;

  it('a pseudo sized in em (an icon): its absolute AND relative size changed with an authorized font fix — intentional, attributed to the target', () => {
    const [b, o] = pair(owner({ w: 160, h: 96 }, { ...PSEUDO, width: '80px' }), owner({ w: 120, h: 64 }, { ...PSEUDO, width: '100px' }, { ...BLACK, 'font-size': '20px' }));
    const r = run(b, o, [ex('font-size')]);
    expect(regressions(r)).toEqual([]);
    expect(r.differences.filter((d) => d.elementKey === '0::after' && d.classification === 'intentional').map((d) => d.property)).toEqual(['width']);
    expect(r.differences.find((d) => d.elementKey === '0::after')!.exemptionTargetId).toBe('t-font-size');
    expect(r.verdict).toBe('pass');
  });

  it('the same pseudo change WITHOUT the authorization is a regression', () => {
    const [b, o] = pair(owner({ w: 160, h: 96 }, { ...PSEUDO, width: '80px' }), owner({ w: 120, h: 64 }, { ...PSEUDO, width: '100px' }, { ...BLACK, 'font-size': '20px' }));
    expect(regressions(run(b, o)).filter((d) => d.elementKey.includes('::')).map((d) => `${d.elementKey} ${d.property}`)).toEqual(['0::after width']);
  });

  it('an authorization that cannot drive the size (a colour) does not explain a size change', () => {
    const [b, o] = pair(owner({ w: 160, h: 96 }, { ...PSEUDO, width: '80px' }), owner({ w: 120, h: 64 }, { ...PSEUDO, width: '100px' }, { ...BLACK, 'font-size': '20px' }));
    expect(regressions(run(b, o, [ex('color')])).filter((d) => d.elementKey.includes('::')).map((d) => d.property)).toEqual(['width']);
  });

  it('an authorized padding fix that did NOT change the owner\'s box does not explain a pseudo that shrank (a real pseudo regression)', () => {
    const [b, o] = pair(owner({ w: 160, h: 96 }, { ...PSEUDO, width: '80px' }), owner({ w: 160, h: 96 }, { ...PSEUDO, width: '50px' }));
    expect(regressions(run(b, o, [ex('padding')])).map((d) => d.property)).toEqual(['width']);
  });

  it('an overlay (inset: 0) or underline (width: 100%) keeps its size RELATIVE to the owner: no difference at all, whatever the authorization', () => {
    const [b, o] = pair(owner({ w: 200, h: 96 }, { ...PSEUDO, width: '200px', height: '96px' }), owner({ w: 150, h: 64 }, { ...PSEUDO, width: '150px', height: '64px' }));
    expect(run(b, o).differences.filter((d) => d.elementKey.includes('::'))).toEqual([]);
  });

  it('translate(-50%): the translation is compared relative to the owner\'s width', () => {
    const [b, o] = pair(owner({ w: 200, h: 96 }, { ...PSEUDO, transform: 'matrix(1, 0, 0, 1, -100, 0)' }), owner({ w: 150, h: 64 }, { ...PSEUDO, transform: 'matrix(1, 0, 0, 1, -75, 0)' }));
    expect(run(b, o).differences.filter((d) => d.elementKey.includes('::'))).toEqual([]);
    const [b2, o2] = pair(owner({ w: 200, h: 96 }, { ...PSEUDO, transform: 'matrix(1, 0, 0, 1, -100, 0)' }), owner({ w: 150, h: 64 }, { ...PSEUDO, transform: 'matrix(1, 0, 0, 1, -80, 0)' }));
    expect(regressions(run(b2, o2)).map((d) => d.property)).toEqual(['transform']);
    expect(regressions(run(b2, o2, [ex('padding')])).map((d) => d.property)).toEqual(['transform']); // an authorized padding change cannot have driven a fixed translation (round 4 · 2)
  });

  it('a small pseudo that shrinks inside a WIDE owner is not hidden by the ratio tolerance (24px to 16px in a 400px link, the owner unchanged)', () => {
    const [b, o] = pair(owner({ w: 400, h: 48 }, { ...PSEUDO, width: '24px' }), owner({ w: 400, h: 48 }, { ...PSEUDO, width: '16px' }));
    expect(regressions(run(b, o)).map((d) => `${d.elementKey} ${d.property}`)).toEqual(['0::after width']);
  });

  it('a transform that is not a translation (a rotation) is never explained by the owner\'s box', () => {
    const [b, o] = pair(owner({ w: 200, h: 96 }, { ...PSEUDO, transform: 'none' }), owner({ w: 150, h: 64 }, { ...PSEUDO, transform: 'matrix(0.7071, 0.7071, -0.7071, 0.7071, 0, 0)' }));
    expect(regressions(run(b, o, [ex('padding')])).map((d) => d.property)).toEqual(['transform']);
  });

  it('a baseline without box evidence cannot prove anything about the size: not a pass (an unverified required gap), and not a regression it cannot show', () => {
    const [b, o] = pair(owner(undefined, { ...PSEUDO, width: '80px' }), owner(undefined, { ...PSEUDO, width: '50px' }, { ...BLACK, 'padding-top': '24px' }));
    const r = run(b, o, [ex('padding')]);
    expect(regressions(r)).toEqual([]);
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.gaps.some((g) => g.reason === 'pseudo-size-box-unavailable' && g.required)).toBe(true);
  });

  describe('the currentcolor rule reaches values that EMBED the owner\'s colour', () => {
    const BRAND = 'rgb(176, 31, 36)';
    const cc = (colour: string) => ({ ...PSEUDO, color: colour, 'box-shadow': `${colour} 0px 2px 0px 0px`, 'background-image': `linear-gradient(${colour}, rgba(0, 0, 0, 0))` });
    const withColour = (colour: string): StyleRecord => ({ ...BLACK, color: colour });
    it('a pseudo box-shadow / gradient painted with the owner\'s colour follows an authorized colour change', () => {
      const [b, o] = pair(owner({ w: 100, h: 40 }, cc('rgb(0, 0, 0)')), owner({ w: 100, h: 40 }, cc(BRAND), withColour(BRAND)));
      const r = run(b, o, [ex('color')]);
      expect(regressions(r)).toEqual([]);
      expect(r.differences.filter((d) => d.classification === 'intentional' && d.elementKey === '0::after').map((d) => d.property).sort()).toEqual(['background-image', 'box-shadow', 'color']);
    });
    it('a shadow in some OTHER colour is a regression even with the authorization', () => {
      const [b, o] = pair(owner({ w: 100, h: 40 }, cc('rgb(0, 0, 0)')), owner({ w: 100, h: 40 }, { ...cc(BRAND), 'box-shadow': 'rgb(10, 200, 10) 0px 2px 0px 0px' }, withColour(BRAND)));
      expect(regressions(run(b, o, [ex('color')])).map((d) => d.property)).toEqual(['box-shadow']);
    });
    it('the same on the ELEMENT: a box-shadow that was currentcolor follows an authorized colour change', () => {
      const b = base([ok(), section(owner(undefined, PSEUDO, { ...BLACK, 'box-shadow': 'rgb(0, 0, 0) 0px 0px 0px 2px' }))]);
      const o = cap([ok(), section(owner(undefined, PSEUDO, { ...withColour(BRAND), 'box-shadow': `${BRAND} 0px 0px 0px 2px` }))]);
      expect(regressions(run(b, o, [ex('color')]))).toEqual([]);
      expect(regressions(run(b, o)).map((d) => d.property).sort()).toEqual(['box-shadow', 'color']);
    });
  });
});

describe('round 3 · 2 — members of a part that the element cap DROPPED keep the part unverified (actionable)', () => {
  const BLACKL: StyleRecord = { color: 'rgb(0, 0, 0)', 'font-size': '16px' };
  // <div F1> with five text children; the cap kept 0/0 and dropped 0/1 and 0/2; 0/3 is a role-less wrapper; 0/4 is kept
  const list = (over: { capDropped?: { label?: string[]; descendants?: string[] }; members?: string[]; captured?: string[]; legacy?: true } = {}) => (v: 'desktop' | 'mobile') => {
    const members = over.members ?? ['0/0', '0/1', '0/2', '0/3', '0/4'];
    const captured = over.captured ?? ['0/0', '0/4'];
    return sec({
      sectionId: 'A', viewport: v, capped: { dropped: 2 }, ...(over.legacy ? {} : { capLossRecorded: true as const }),
      elements: [el(''), el('0', { tag: 'div', label: 'List', textHash: 'list', roles: ['finding'], findingIds: ['F1'], partKeys: { label: [], descendants: members, named: {}, ...(over.capDropped ? { capDropped: over.capDropped } : {}) } }), ...captured.map((k) => el(k, { tag: 'b', label: k, textHash: k, roles: ['text'], style: BLACKL }))],
    });
  };
  const verdictOf = (mk: ReturnType<typeof list>, t = target({ part: 'descendants' }), mkOut = mk) => {
    const b = base([mk('desktop'), mk('mobile'), ok('B')]), o = cap([mkOut('desktop'), mkOut('mobile'), ok('B')]);
    const report = compareDesign({ baseline: b, observed: o, exemptions: [] });
    return evaluatePreserveTargets({ resolution: resolutionOf(t), report, baseline: b, exemptions: [] });
  };

  it('cap-dropped members: the decision is UNVERIFIED "part capped" and names the cap (was: preserved-verified, the dropped members labelled role-less wrappers)', () => {
    const [r] = verdictOf(list({ capDropped: { descendants: ['0/1', '0/2'] } }));
    expect(r!.verification).toBe('unverified');
    expect(r!.reason).toBe('part capped');
    expect(r!.detail).toMatch(/2 member\(s\)/);
    expect(r!.detail).toMatch(/element cap/);
    expect(summarizePreserve([r!]).byDesign).toBe(0); // a deliberate recapture of the baseline with a higher fidelity.maxElementsPerSection clears it: actionable
  });

  it('with NO cap-dropped member the genuinely role-less wrapper is the disclosed note and the decision verifies', () => {
    const [r] = verdictOf(list());
    expect(r!.verification).toBe('preserved-verified');
    expect(r!.detail).toMatch(/3 role-less wrapper member\(s\)/);
  });

  it('only genuinely role-less wrappers go into the note: with two dropped and one wrapper, the part is still capped', () => {
    const [r] = verdictOf(list({ capDropped: { descendants: ['0/1', '0/2'] } }));
    expect(r!.detail).not.toMatch(/role-less wrapper member/);
  });

  it('ALL members dropped by the cap: "part capped", NOT "part cannot be mapped" (which is by-design)', () => {
    const [r] = verdictOf(list({ members: ['0/0', '0/1'], captured: [], capDropped: { descendants: ['0/0', '0/1'] } }));
    expect(r!.reason).toBe('part capped');
    expect(summarizePreserve([r!]).byDesign).toBe(0);
  });

  it('members that were never captured and never dropped (wrappers only) stay "part cannot be mapped", by-design', () => {
    const [r] = verdictOf(list({ members: ['0/0'], captured: [] }));
    expect(r!.reason).toBe('part cannot be mapped');
    expect(summarizePreserve([r!]).byDesign).toBe(1);
  });

  it('a capped baseline from before the capture recorded the cap\'s losses cannot tell a dropped member from a wrapper: the part is unverified "part capped"', () => {
    const [r] = verdictOf(list({ legacy: true }));
    expect(r!.verification).toBe('unverified');
    expect(r!.reason).toBe('part capped');
  });

  it('an UNCAPPED section never has dropped members, recorded or not', () => {
    const uncapped = (v: 'desktop' | 'mobile') => ({ ...list()(v), capped: null });
    const [r] = verdictOf(uncapped);
    expect(r!.verification).toBe('preserved-verified');
  });

  it('the label part is judged the same way', () => {
    const mk = (v: 'desktop' | 'mobile') => sec({
      sectionId: 'A', viewport: v, capped: { dropped: 1 }, capLossRecorded: true,
      elements: [el(''), el('0', { tag: 'div', label: 'List', textHash: 'list', roles: ['finding'], findingIds: ['F1'], partKeys: { label: ['0/0', '0/1'], descendants: ['0/0', '0/1'], named: {}, capDropped: { label: ['0/1'], descendants: ['0/1'] } } }), el('0/0', { tag: 'b', label: 'a', textHash: 'a', roles: ['text'], style: BLACKL })],
    });
    const [r] = verdictOf(mk, target({ part: 'label' }));
    expect(r!.reason).toBe('part capped');
  });
});

describe('round 3 · 5 — a hover-subtree member the output GAINED is required when its design differs between rest and hover', () => {
  const REST = { color: 'rgb(0, 0, 0)', 'font-size': '16px', 'background-color': 'rgba(0, 0, 0, 0)' };
  const RED = 'rgb(176, 31, 36)';
  const card = (hover: Record<string, StyleRecord>, attempt = 'captured' as const) => el('0', { tag: 'a', label: 'Tile', textHash: 'tile', roles: ['finding', 'interactive'], findingIds: ['F1'], style: REST, stateAttempt: { hover: attempt }, states: { hover: { subtree: hover, effect: true } }, partKeys: { label: [], descendants: ['0/0'], named: {} } });
  const baseCard = card({ '': REST });
  const section = (c: CapturedElement, extra: CapturedElement[] = [], pseudoCaptured: true | undefined = true) => sec({ elements: [el(''), c, ...extra], pseudoCaptured });
  const member = (style: StyleRecord) => el('0/0', { tag: 'span', label: 'Tile', textHash: 'tile', roles: ['text'], style });
  const gap = (r: FidelityReport) => r.coverage!.gaps.find((g) => g.reason === 'state-reveal-gained-in-output' || g.reason === 'state-subtree-member-gained-in-output');

  it('an added reveal layer (transparent at rest, filled on hover) is a REQUIRED gap: verdict incomplete, the hover unit unverified (was: pass)', () => {
    const o = section(card({ '': REST, '0': { ...REST, 'background-color': RED } }), [member(REST)]);
    const r = run(base([ok(), section(baseCard)]), cap([ok(), o]));
    expect(r.verdict).toBe('incomplete');
    expect(gap(r)).toMatchObject({ required: true, reason: 'state-reveal-gained-in-output', state: 'hover' });
    expect(gap(r)!.detail).toMatch(/differs from their own resting design/);
    expect(r.coverage!.families.hover).toMatchObject({ unverified: 1, verified: 0 });
    expect(gapSplit(r).actionable).toBeGreaterThan(0);
  });

  it('a wrapper that only INHERITS the hover colour (its hovered style equals its resting style apart from the inherited value) stays disclosed', () => {
    const o = section(card({ '': { ...REST, color: RED }, '0': { ...REST, color: RED } }), [member(REST)]);
    const b = section(card({ '': { ...REST, color: RED } }));
    const r = run(base([ok(), b]), cap([ok(), o]));
    expect(r.verdict).toBe('pass');
    expect(gap(r)).toMatchObject({ required: false, reason: 'state-subtree-member-gained-in-output' });
    expect(r.coverage!.families.hover).toMatchObject({ verified: 1, unverified: 0 });
  });

  it('a gained member identical at rest and on hover is disclosed', () => {
    const o = section(card({ '': REST, '0': REST }), [member(REST)]);
    const r = run(base([ok(), section(baseCard)]), cap([ok(), o]));
    expect(r.verdict).toBe('pass');
    expect(gap(r)).toMatchObject({ required: false });
  });

  it('a member with no resting record that bears a design only on hover is a reveal; one that bears none is a wrapper', () => {
    const reveal = run(base([ok(), section(baseCard)]), cap([ok(), section(card({ '': REST, '0': { ...REST, 'background-color': RED } }))]));
    expect(gap(reveal)).toMatchObject({ required: true });
    const wrapper = run(base([ok(), section(baseCard)]), cap([ok(), section(card({ '': REST, '0': REST }))]));
    expect(gap(wrapper)).toMatchObject({ required: false });
  });

  it('a pseudo-element the output generates only on hover is a reveal; one it also generates at rest with the same values is not', () => {
    const PSEUDO: StyleRecord = { content: '""', display: 'block', 'background-color': RED, color: 'rgb(0, 0, 0)', opacity: '1' };
    const hoverOnly = run(base([ok(), section(baseCard)]), cap([ok(), section(card({ '': REST, '::after': PSEUDO }))]));
    expect(gap(hoverOnly)).toMatchObject({ required: true, reason: 'state-reveal-gained-in-output' });
    // static decoration present at rest as well: the default-state comparison owns it (the original has none, so it is a content regression there), the hover record adds nothing
    const o = card({ '': REST, '::after': PSEUDO });
    o.pseudo = { after: PSEUDO };
    const alsoAtRest = run(base([ok(), section(baseCard)]), cap([ok(), section(o)]));
    expect(gap(alsoAtRest)).toMatchObject({ required: false });
  });

  it('an authorized target for the member still excuses it, and a cut subtree still proves nothing', () => {
    const o = section(card({ '': REST, '0': { ...REST, 'background-color': RED } }), [member(REST)]);
    const authorised = run(base([ok(), section(baseCard)]), cap([ok(), o]), [ex('background-color', { state: 'hover', part: 'descendants' })]);
    expect(gap(authorised)).toBeUndefined();
    const cutBase = card({ '': REST });
    cutBase.states.hover!.truncated = 3;
    const cut = run(base([ok(), section(cutBase)]), cap([ok(), o]));
    expect(gap(cut)).toBeUndefined();
  });
});

describe('round 3 · 6 — a baseline from before the focus trial: a finding element it never tried is disclosed, not silent', () => {
  const finding = (over: Partial<CapturedElement> = {}) => el('0', { tag: 'div', label: 'Go', textHash: 'go', roles: ['finding'], findingIds: ['F1'], stateAttempt: { hover: 'captured' }, states: { hover: { subtree: { '': { color: 'rgb(0, 0, 0)' } }, effect: false } }, ...over });
  const section = (e: CapturedElement, over: Partial<SectionDesign> = {}) => sec({ elements: [el(''), e], ...over });
  const legacyGap = (r: FidelityReport) => r.coverage!.gaps.find((g) => g.reason === 'baseline-legacy-focus');

  it('legacy baseline (no focus trial recorded), the output element takes keyboard focus: a REQUIRED baseline-legacy-focus gap, actionable', () => {
    const r = run(base([ok(), section(finding())]), cap([ok(), section(finding({ focusable: true }), { focusTrial: true })]));
    expect(legacyGap(r)).toMatchObject({ required: true, family: 'focus-visible', elementKey: '0', findingIds: ['F1'] });
    expect(r.verdict).toBe('incomplete');
    expect(BY_DESIGN_GAP_REASONS.has('baseline-legacy-focus')).toBe(false);
    expect(r.statesNotCaptured.join(' ')).toMatch(/focus trial/);
  });

  it('a baseline that DID run the focus trial and found the element not focusable raises nothing (the element is simply not focusable)', () => {
    const trialled = sec({ sectionId: 'ok', focusTrial: true });
    const r = run(base([trialled, section(finding(), { focusTrial: true })]), cap([trialled, section(finding(), { focusTrial: true })]));
    expect(legacyGap(r)).toBeUndefined();
    expect(r.statesNotCaptured.join(' ')).not.toMatch(/focus trial/);
    expect(r.verdict).toBe('pass');
  });

  it('legacy baseline, but the output element does not take focus either: nothing to lose, no gap', () => {
    const r = run(base([ok(), section(finding())]), cap([ok(), section(finding(), { focusTrial: true })]));
    expect(legacyGap(r)).toBeUndefined();
  });

  it('a non-finding element is never required for it', () => {
    const r = run(base([ok(), section(finding({ findingIds: [], roles: ['text'] }))]), cap([ok(), section(finding({ findingIds: [], roles: ['text'], focusable: true }), { focusTrial: true })]));
    expect(legacyGap(r)).toBeUndefined();
  });
});

describe('round 3 · 7 — url(...) targets are compared as "an image is there"', () => {
  const DATA = 'url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=")';
  const ASSET = 'url("http://localhost:3040/assets/9f2c1ab04e55.svg")';
  const REMOTE = 'url("https://cdn.example.com/img/hero.jpg")';

  it('background-image: a data: / remote url on the original and the preview\'s /assets path are the same image', () => {
    expect(valuesEqual('background-image', DATA, ASSET)).toBe(true);
    expect(valuesEqual('background-image', REMOTE, ASSET)).toBe(true);
    expect(valuesEqual('background-image', `linear-gradient(rgb(0, 0, 0), rgba(0, 0, 0, 0)), ${DATA}`, `linear-gradient(rgb(0, 0, 0), rgba(0, 0, 0, 0)), ${ASSET}`)).toBe(true);
  });

  it('but a missing image, a different count of images or a different gradient is still a difference', () => {
    expect(valuesEqual('background-image', DATA, 'none')).toBe(false);
    expect(valuesEqual('background-image', `${DATA}, ${DATA}`, ASSET)).toBe(false);
    expect(valuesEqual('background-image', 'linear-gradient(rgb(0, 0, 0), rgb(1, 1, 1))', 'linear-gradient(rgb(0, 0, 0), rgb(2, 2, 2))')).toBe(false);
  });

  it('pseudo content: url(...) and a pseudo background-image', () => {
    expect(pseudoValuesEqual('content', DATA, ASSET)).toBe(true);
    expect(pseudoValuesEqual('background-image', DATA, ASSET)).toBe(true);
    expect(pseudoValuesEqual('content', '"→"', '"←"')).toBe(false);
    expect(pseudoValuesEqual('content', DATA, '"→"')).toBe(false);
  });

  it('the unchanged page is a clean pass: a pseudo icon the preview serves from /assets is not a regression', () => {
    const owner = (after: StyleRecord, style: StyleRecord) => el('0', { tag: 'a', label: 'Tile', textHash: 'tile', roles: ['finding', 'interactive'], findingIds: ['F1'], stateAttempt: { hover: 'captured' }, style, pseudo: { after } });
    const P = (content: string, image: string): StyleRecord => ({ content, display: 'block', 'background-color': 'rgba(0, 0, 0, 0)', 'background-image': image, color: 'rgb(0, 0, 0)', opacity: '1' });
    const s = (e: CapturedElement) => sec({ elements: [el(''), e], pseudoCaptured: true });
    const r = run(base([ok(), s(owner(P(DATA, DATA), { ...BLACK, 'background-image': DATA }))]), cap([ok(), s(owner(P(ASSET, ASSET), { ...BLACK, 'background-image': ASSET }))]));
    expect(regressions(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
  });
});
