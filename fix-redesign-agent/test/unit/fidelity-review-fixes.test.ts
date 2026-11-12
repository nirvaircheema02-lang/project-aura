import { describe, expect, it } from 'vitest';
import type { CorrectionSummary } from '../../src/agents/types.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { fidelityCheckOf, fidelitySummaryOf, incompleteLine } from '../../src/fidelity/coverage.ts';
import { applyFidelityToTargets } from '../../src/fidelity/verify.ts';
import type { CapturedElement, DesignBaseline, DesignCapture, FidelityReport, SectionDesign } from '../../src/fidelity/types.ts';
import { checkG2Approval } from '../../src/preview/g2-guard.ts';
import { requiredChecksOpen } from '../../src/preview/correct.ts';
import { renderPreviewMd } from '../../src/preview/report.ts';
import type { PreviewVerification } from '../../src/preview/types.ts';
import type { Exemption, ResolvedTarget } from '../../src/resolution/schema.ts';
import { base, cap, el, hoverState, resolutionOf, sec, target } from '../helpers/fidelity-captures.ts';

/**
 * Regression tests for the defects two independent reviews found in the fidelity coverage and preserve-evidence work. Every case is built from
 * capture literals (no browser); the cases that need a real page are in test/integration/fidelity-review-fixes.test.ts.
 */

const run = (b: DesignBaseline, o: DesignCapture, over: { overrideSectionIds?: ReadonlySet<string>; exemptions?: Exemption[] } = {}): FidelityReport =>
  compareDesign({ baseline: b, observed: o, exemptions: over.exemptions ?? [], now: () => new Date(0), ...(over.overrideSectionIds ? { overrideSectionIds: over.overrideSectionIds } : {}) });
/** A second, fully compared section so "nothing was compared" never explains a result. */
const ok = (id = 'ok'): SectionDesign => sec({ sectionId: id });

const verification = (over: Partial<PreviewVerification> = {}): PreviewVerification => ({
  schemaVersion: 1, generatedAt: 't', url: 'http://x', mode: 'full-page', expectedSectionIds: ['s'], renderedSectionIds: ['s'], checks: [], findings: [], interactions: [], unavailable: [], simulated: [],
  summary: { passed: 1, failed: 0, notChecked: 0, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass', ...over,
});

const BLACK = { color: 'rgb(0, 0, 0)', 'font-size': '16px' };
const WHITE = { color: 'rgb(255, 255, 255)', 'font-size': '16px' };

// ── review 3 ────────────────────────────────────────────────────────────────────────────────

describe('review 3 · 1 — a finding element is hover-eligible whatever its role; a never-attempted one is a REQUIRED gap', () => {
  // an element another stateAttempt exists for, so the section is not the "legacy counters" shape
  const witness = el('1', { roles: ['interactive'], stateAttempt: { hover: 'captured' }, states: { hover: hoverState(WHITE) } });
  const card = (over: Partial<CapturedElement> = {}) => el('0', { tag: 'div', label: 'Card', textHash: 'card', roles: ['finding', 'design'], findingIds: ['F1'], ...over });
  const section = (card0: CapturedElement) => sec({ elements: [el(''), card0, witness] });

  it('no hover attempt recorded for a finding element: required gap state-not-attempted, verdict incomplete (was: pass, no gap)', () => {
    const r = run(base([ok(), section(card())]), cap([ok(), section(card())]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.hover.reasons).toMatchObject({ 'state-not-attempted': 1 });
    expect(r.coverage!.gaps.find((g) => g.reason === 'state-not-attempted')).toMatchObject({ required: true, findingIds: ['F1'] });
  });

  it('a plain (non-finding) element that was never attempted is not a gap: only finding elements are required', () => {
    const r = run(base([ok(), section(card({ roles: ['design'], findingIds: [] }))]), cap([ok(), section(card({ roles: ['design'], findingIds: [] }))]));
    expect(r.verdict).toBe('pass');
  });

  it('a finding element whose hover WAS captured is compared as before', () => {
    const hovered = card({ stateAttempt: { hover: 'captured' }, states: { hover: hoverState(WHITE) } });
    const r = run(base([ok(), section(hovered)]), cap([ok(), section(hovered)]));
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.families.hover.verified).toBe(2);
  });
});

describe('review 3 · 2 — a hover-subtree member that is missing from, or gained in, the output is never silently skipped', () => {
  const sub = (keys: string[], extra: Partial<{ truncated: number }> = {}) => ({ subtree: Object.fromEntries(keys.map((k) => [k, k === '' ? BLACK : { 'background-color': k === '0' ? 'rgb(176, 31, 36)' : 'rgba(0, 0, 0, 0)' }])), effect: true, ...extra });
  const card = (keys: string[], extra: Partial<{ truncated: number }> = {}) => el('0', { tag: 'a', label: 'Tile', textHash: 'tile', roles: ['finding', 'interactive'], findingIds: ['F1'], stateAttempt: { hover: 'captured' }, states: { hover: sub(keys, extra) } });
  const section = (c: CapturedElement) => sec({ elements: [el(''), c] });

  it('a baseline member (a decorative reveal layer) absent from the output\'s subtree is a required unverified gap, not "verified" (was: pass)', () => {
    const r = run(base([ok(), section(card(['', '0']))]), cap([ok(), section(card(['']))]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.hover.reasons).toMatchObject({ 'state-subtree-member-missing-in-output': 1 });
    expect(r.coverage!.families.hover).toMatchObject({ required: 1, verified: 0, unverified: 1 }); // the unit is the element's hover state: one gap makes it unverified, not verified
  });

  it('a child the original\'s subtree does not list, that shows no design of its own on hover (an inserted wrapper), is DISCLOSED, not required (round 2; a member that DOES show a design is a required reveal since round 3, see fidelity-round3.test.ts)', () => {
    const r = run(base([ok(), section(card(['']))]), cap([ok(), section(card(['', '1']))]));
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.families.hover.reasons).not.toHaveProperty('state-subtree-member-gained-in-output');
    expect(r.coverage!.gaps.find((g) => g.reason === 'state-subtree-member-gained-in-output')).toMatchObject({ required: false });
  });

  it('a subtree the capture cut at maxDescendants is disclosed WITH the count, and the gained-key check is not run on a cut subtree', () => {
    const r = run(base([ok(), section(card([''], { truncated: 7 }))]), cap([ok(), section(card(['', '0']))]));
    expect(r.coverage!.families.hover.reasons).not.toHaveProperty('state-subtree-member-gained-in-output');
    const g = r.coverage!.gaps.find((x) => x.reason === 'state-subtree-capped');
    expect(g).toMatchObject({ required: false });
    expect(g!.detail).toMatch(/7 /);
    expect(r.verdict).toBe('pass');
  });

  it('identical subtrees stay verified (no spurious gap)', () => {
    const r = run(base([ok(), section(card(['', '0']))]), cap([ok(), section(card(['', '0']))]));
    expect(r.verdict).toBe('pass');
  });
});

describe('review 3 · 4 — the G2 approval note is never silent about unverified required checks', () => {
  const fidelity = { verdict: 'incomplete' as const, requiredTotal: 40, requiredVerified: 37, requiredFailed: 0, requiredUnverified: 3, actionable: 2, byDesign: 1, open: ['design/state fidelity is INCOMPLETE: 3 of 40 required check(s) not verified', '1 preserve decision(s) could not be verified'] };
  const opts = { acceptPreviewFailures: false, note: null as string | null, verificationPath: '/v.json', redesignRunId: 'r' };

  it('approval stays ALLOWED (G2 is the user\'s decision) and the recorded note carries the counts and the open lines', () => {
    const r = checkG2Approval(verification({ fidelity }), opts);
    expect(r.ok).toBe(true);
    const note = r.ok ? (r.note ?? '') : '';
    expect(note).toMatch(/UNVERIFIED REQUIRED/);
    expect(note).toMatch(/3 of 40/);
    expect(note).toMatch(/2 actionable \/ 1 by-design/);
    expect(note).toMatch(/INCOMPLETE/);
  });

  it('the reviewer\'s own note is kept in front of it', () => {
    const r = checkG2Approval(verification({ fidelity }), { ...opts, note: 'looks right' });
    expect(r.ok && r.note).toMatch(/^looks right · /);
  });

  it('an older verification.json without the summary still carries the fidelity check\'s own text when that check is not-checked', () => {
    const v = verification({ checks: [{ id: 'fidelity.design-state', group: 'fidelity', name: 'n', status: 'not-checked', detail: 'INCOMPLETE - required 37/40 verified, 0 failed, 3 unverified: sticky 3' }] });
    const r = checkG2Approval(v, opts);
    expect(r.ok && r.note).toMatch(/INCOMPLETE - required 37\/40/);
  });

  it('a complete verification leaves the note untouched', () => {
    expect(checkG2Approval(verification({ fidelity: { ...fidelity, verdict: 'pass', requiredUnverified: 0, requiredVerified: 40, actionable: 0, byDesign: 0, open: [] } }), { ...opts, note: 'ok' })).toEqual({ ok: true, note: 'ok' });
  });
});

describe('review 3 · 5 — a legacy baseline cannot hide the sampling cap', () => {
  const legacy = (attempted: number, cap_: number) => sec({ coverage: { hover: { attempted, captured: attempted }, focusVisible: { attempted: cap_, captured: cap_ } } });

  it('attempted >= the configured cap means an unknown overflow: a required gap baseline-legacy-sampling (hover and focus)', () => {
    const r = run(base([ok(), legacy(20, 16)]), cap([ok(), sec()]));
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.families.hover.reasons).toMatchObject({ 'baseline-legacy-sampling': 1 });
    expect(r.coverage!.families['focus-visible'].reasons).toMatchObject({ 'baseline-legacy-sampling': 1 });
  });

  it('below the cap the counters are exact: no gap', () => {
    expect(run(base([ok(), legacy(19, 15)]), cap([ok(), sec()])).verdict).toBe('pass');
  });

  it('the cap that counts is the baseline\'s own recorded limit', () => {
    const b = base([ok(), legacy(5, 3)]);
    b.limits = { ...b.limits, maxHoverTargets: 5, maxFocusTargets: 3 };
    expect(run(b, cap([ok(), sec()])).coverage!.families.hover.reasons).toMatchObject({ 'baseline-legacy-sampling': 1 });
  });
});

describe('review 3 · 6 — a report that says pass but recorded no coverage fails closed', () => {
  const noCoverage = (): FidelityReport => { const r = run(base([ok()]), cap([ok()])); expect(r.verdict).toBe('pass'); const { coverage: _c, ...rest } = r; return rest; };

  it('fidelityCheckOf: not-checked, INCOMPLETE, says no coverage was recorded', () => {
    const c = fidelityCheckOf(noCoverage());
    expect(c.status).toBe('not-checked');
    expect(c.detail).toMatch(/INCOMPLETE.*no coverage/i);
  });

  it('requiredChecksOpen reports it', () => {
    expect(requiredChecksOpen(verification(), noCoverage(), null).join(' ')).toMatch(/INCOMPLETE.*no coverage/i);
  });

  it('PREVIEW.md never says every required check holds', () => {
    const f = noCoverage();
    const open = requiredChecksOpen(verification(), f, null);
    const correction: CorrectionSummary = { stopReason: 'passed', budgetReason: null, cycles: [], open: [], plannerFeedback: [], corrections: { stateGuards: [], droppedEdits: [], droppedIslands: [] }, verifications: 1, required: { satisfied: true, open: [] } };
    expect(open.length).toBeGreaterThan(0);
    const md = renderPreviewMd({ runId: 'r', v: verification(), g: { sectionIds: ['s'], generatedSections: ['s'], overriddenSections: [], sourceHash: 'h', assets: { written: 0, downloaded: 0, failed: [], remoteLeft: [] }, islandsMounted: 0 }, source: '/tmp/p', fidelity: f, correction });
    expect(md).not.toMatch(/Every required check holds/);
  });
});

describe('review 3 · 8 — permanent (by-design) gaps are counted apart from actionable ones, and all of them keep the check unsatisfied', () => {
  const override = () => {
    const mk = () => [ok(), sec({ sectionId: 'h' }), sec({ sectionId: 'h', viewport: 'mobile' }), sec({ sectionId: 'x', sticky: [{ key: '0', top: '24px', padded: true, positions: [0, 1, 2, 3, 4].map((i) => ({ requestedScroll: i, actualScroll: 0, reachable: false, rectTop: null })) }] })];
    return run(base(mk()), cap(mk()), { overrideSectionIds: new Set(['h']) });
  };

  it('the ledger knows how many required gaps are by-design (hand-authored sections) and how many are actionable (an unreachable sticky trace)', () => {
    const r = override();
    expect(r.verdict).toBe('incomplete');
    expect(r.coverage!.requiredUnverified).toBe(3);
    expect(fidelitySummaryOf(r, [])).toMatchObject({ requiredUnverified: 3, actionable: 1, byDesign: 2 });
  });

  it('required.open shows "N actionable / M by-design"', () => {
    expect(incompleteLine(override())).toMatch(/1 actionable \/ 2 by-design/);
    expect(requiredChecksOpen(verification(), override(), null).join(' ')).toMatch(/1 actionable \/ 2 by-design/);
  });

  it('PREVIEW.md shows it too, and still never says the checks hold', () => {
    const f = override();
    const open = requiredChecksOpen(verification(), f, null);
    const correction: CorrectionSummary = { stopReason: 'passed', budgetReason: null, cycles: [], open: [], plannerFeedback: [], corrections: { stateGuards: [], droppedEdits: [], droppedIslands: [] }, verifications: 1, required: { satisfied: false, open } };
    const md = renderPreviewMd({ runId: 'r', v: verification(), g: { sectionIds: ['s'], generatedSections: ['s'], overriddenSections: [], sourceHash: 'h', assets: { written: 0, downloaded: 0, failed: [], remoteLeft: [] }, islandsMounted: 0 }, source: '/tmp/p', fidelity: f, correction });
    expect(md).toMatch(/1 actionable \/ 2 by-design/);
    expect(md).toMatch(/\[by-design\] hand-authored-override/);
    expect(md).not.toMatch(/\[by-design\] sticky/);
    expect(md).not.toMatch(/Every required check holds/);
  });

  it('unverified preserve decisions are split the same way: an unmeasured property is by-design, a missing box baseline is actionable', () => {
    const t = (id: string, property: string) => target({ id, property });
    const resolution = resolutionOf(t('a', 'margin-top'), t('b', 'z-index'), t('c', 'width'));
    for (const x of resolution.targets) x.status.verification = 'unverified';
    resolution.targets[0]!.status.verificationDetail = 'not measured by the verifier: margin-top is not one of the properties';
    resolution.targets[1]!.status.verificationDetail = 'not measured by the verifier: z-index';
    resolution.targets[2]!.status.verificationDetail = 'no box evidence in the baseline: recapture';
    const line = requiredChecksOpen(verification(), run(base([ok()]), cap([ok()])), resolution).join('\n');
    expect(line).toMatch(/3 preserve decision\(s\) could not be verified.*1 actionable \/ 2 by-design/);
  });
});

describe('review 3 · 9 — a plain text element whose text differs stays a documented, DISCLOSED non-required gap (with counts)', () => {
  it('verdict pass, the gap is listed as not required, the element family counts it', () => {
    const one = (hash: string) => sec({ elements: [el(''), el('0', { roles: ['text'], tag: 'p', textHash: hash })] });
    const r = run(base([ok(), one('a')]), cap([ok(), one('b')]));
    expect(r.verdict).toBe('pass');
    expect(r.coverage!.families.element.notRequired).toBe(1);
    expect(r.coverage!.gaps.filter((g) => !g.required).map((g) => g.reason)).toEqual(['text-mismatch']);
    expect(r.coverage!.requiredUnverified).toBe(0);
  });
});

// ── review 4 ────────────────────────────────────────────────────────────────────────────────

const finding = (over: Partial<CapturedElement> = {}): CapturedElement => el('0', { tag: 'a', label: 'Buy now', textHash: 'buy', roles: ['finding', 'interactive', 'text'], findingIds: ['F1'], style: BLACK, ...over });
const A = (viewport: 'desktop' | 'mobile', elements: CapturedElement[] | null, over: Partial<SectionDesign> = {}): SectionDesign => sec({ sectionId: 'A', viewport, elements: elements ?? [el(''), finding()], ...over });
const B = (viewport: 'desktop' | 'mobile'): SectionDesign => sec({ sectionId: 'B', viewport, elements: [el(''), el('0', { roles: ['interactive', 'text'], label: 'other', textHash: 'o' }), el('1', { roles: ['text'], label: 'x', textHash: 'x' })] });
const sections = (a: (v: 'desktop' | 'mobile') => SectionDesign): SectionDesign[] => [a('desktop'), a('mobile'), B('desktop'), B('mobile')];

function verdictOf(t: ResolvedTarget, baseline: DesignBaseline, observed: DesignCapture, exemptions: Exemption[] = []) {
  const resolution = resolutionOf(t);
  const report = compareDesign({ baseline, observed, exemptions });
  applyFidelityToTargets(resolution, report, baseline, exemptions);
  return { status: resolution.targets[0]!.status.verification, detail: resolution.targets[0]!.status.verificationDetail ?? '', report };
}
const unchanged = (t: ResolvedTarget, over?: (v: 'desktop' | 'mobile') => SectionDesign) => verdictOf(t, base(sections((v) => A(v, null))), cap(sections(over ?? ((v) => A(v, null)))));

describe('review 4 · 1 — a part the capture cut is never preserved-verified', () => {
  const tree = (truncated?: { label?: number; descendants?: number; walk?: number }) => (v: 'desktop' | 'mobile') => A(v, [
    el(''), finding({ partKeys: { label: ['0/0'], descendants: ['0/0', '0/1'], named: {}, ...(truncated ? { truncated } : {}) } }),
    el('0/0', { roles: ['text'], textHash: 'l0', label: 'a', style: BLACK }), el('0/1', { roles: ['text'], textHash: 'l1', label: 'b', style: BLACK }),
  ]);
  const check = (part: string, truncated: Parameters<typeof tree>[0]) => verdictOf(target({ part }), base(sections(tree(truncated))), cap(sections(tree(truncated))));

  it('descendants cut at the cap: unverified "part capped", while the members that WERE captured are not blamed', () => {
    const r = check('descendants', { descendants: 22 });
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/part capped/);
    expect(r.detail).toMatch(/22/);
  });

  it('label is unaffected by a descendants cut, and the other way round; a label list cut at its own cap is unverified too', () => {
    expect(check('label', { descendants: 22 }).status).toBe('preserved-verified');
    expect(check('descendants', { label: 4 }).status).toBe('preserved-verified');
    expect(check('label', { label: 4 }).status).toBe('unverified');
  });

  it('a subtree the walk could not enter (depth / node cap) cuts every part', () => {
    expect(check('label', { walk: 3 }).status).toBe('unverified');
    expect(check('descendants', { walk: 3 }).status).toBe('unverified');
  });

  it('a measured change on a captured member of a cut part is still a failure (failed > unverified)', () => {
    const b = base(sections(tree({ descendants: 5 })));
    const o = cap(sections((v) => A(v, [el(''), finding({ partKeys: { label: ['0/0'], descendants: ['0/0', '0/1'], named: {}, truncated: { descendants: 5 } } }), el('0/0', { roles: ['text'], textHash: 'l0', label: 'a', style: WHITE }), el('0/1', { roles: ['text'], textHash: 'l1', label: 'b', style: BLACK })])));
    const resolution = resolutionOf(target({ part: 'descendants' }));
    const report = compareDesign({ baseline: b, observed: o, exemptions: [] });
    applyFidelityToTargets(resolution, report, b, []);
    expect(resolution.targets[0]!.status.verification).toBe('failed');
  });
});

describe('review 4 · 2 — removal is confirmed even when a sibling slides into the removed element\'s key', () => {
  const sibling = (over: Partial<CapturedElement>) => el('0', { tag: 'div', label: '', textHash: 'd1', roles: ['design'], ...over });
  const baseWith = (v: 'desktop' | 'mobile') => A(v, [el(''), finding(), el('1', { tag: 'div', label: '', textHash: 'd1', roles: ['design'] })]);

  it('tag-changed successor and no output element carrying the finding: failed (was unverified "element tag changed")', () => {
    const r = verdictOf(target(), base(sections(baseWith)), cap(sections((v) => A(v, [el(''), sibling({})]))));
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/removed/i);
    expect(r.report.differences.some((d) => d.category === 'element-unmatched' && d.classification === 'regression')).toBe(true);
    expect(r.report.verdict).toBe('fail');
  });

  it('text-changed successor (a different link slid in): failed', () => {
    const r = verdictOf(target(), base(sections(baseWith)), cap(sections((v) => A(v, [el(''), finding({ label: 'Other', textHash: 'other', findingIds: [] , roles: ['interactive', 'text'] })]))));
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/removed/i);
  });

  it('still only "moved" (unverified) when the finding turns up at another position', () => {
    const r = verdictOf(target(), base(sections(baseWith)), cap(sections((v) => A(v, [el(''), sibling({}), finding({ key: '1' })]))));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/moved|another position/i);
  });

  it('a genuinely retagged element that still carries the finding is NOT a removal (unverified tag change, as before)', () => {
    expect(unchanged(target(), (v) => A(v, [el(''), finding({ tag: 'button' })])).status).toBe('unverified');
  });

  it('an output that hit the element cap still cannot confirm it', () => {
    expect(unchanged(target(), (v) => A(v, [el(''), sibling({})], { capped: { dropped: 5 } })).status).toBe('unverified');
  });
});

describe('review 4 · 3 — identity is checked against the finding id the output element carries', () => {
  it('same key, tag and text but NO finding id anywhere in the output: unverified (the stamp is lost), not preserved-verified', () => {
    const r = unchanged(target(), (v) => A(v, [el(''), finding({ findingIds: [], roles: ['interactive', 'text'] })]));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/identity|finding id|carr/i);
  });

  it('same key, tag and text but the finding sits on another element: that is a move, unverified, naming where', () => {
    const r = unchanged(target(), (v) => A(v, [el(''), finding({ findingIds: [], roles: ['interactive', 'text'] }), el('1', { tag: 'span', label: 'x', textHash: 'x', roles: ['finding'], findingIds: ['F1'] })]));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/moved|another position/i);
  });

  it('the usual case (the output element carries the id) is still verified', () => {
    expect(unchanged(target()).status).toBe('preserved-verified');
  });
});

describe('review 4 · 4 — a theme the capture does not emulate is not "compared"', () => {
  it('dark / light targets are unverified (theme not captured); inherit is unaffected', () => {
    for (const theme of ['dark', 'light'] as const) {
      const r = unchanged(target({ theme }));
      expect(r.status, theme).toBe('unverified');
      expect(r.detail).toMatch(/theme not captured/);
    }
    expect(unchanged(target({ theme: 'inherit' })).status).toBe('preserved-verified');
  });
});

describe('review 4 · 5 — a state captured on an ancestor does not prove a descendant\'s own state', () => {
  const hov = (keys: string[]) => ({ hover: { subtree: Object.fromEntries(keys.map((k) => [k, WHITE])), effect: true }, });
  const nested = (v: 'desktop' | 'mobile') => A(v, [
    el(''), el('0', { tag: 'a', label: 'Card', textHash: 'card', roles: ['interactive'], stateAttempt: { hover: 'captured' }, states: v === 'desktop' ? hov(['', '0']) : {} }),
    el('0/0', { tag: 'span', label: 'Buy', textHash: 'buy', roles: ['finding', 'text'], findingIds: ['F1'], style: BLACK }),
  ]);

  it('hover on a finding element nested in a hovered ancestor: unverified "state captured on an ancestor only"', () => {
    const r = verdictOf(target({ state: 'hover' }), base(sections(nested)), cap(sections(nested)));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/ancestor only/);
  });

  it('the finding element holding its own hover (and its label part inside it) is still verified', () => {
    const own = (v: 'desktop' | 'mobile') => A(v, [el(''), finding({ states: v === 'desktop' ? hov(['', '0']) : {}, stateAttempt: { hover: 'captured' }, partKeys: { label: ['0/0'], descendants: ['0/0'], named: {} } }), el('0/0', { tag: 'span', roles: ['text'], textHash: 'l', label: 'x', style: BLACK })]);
    expect(verdictOf(target({ state: 'hover' }), base(sections(own)), cap(sections(own))).status).toBe('preserved-verified');
    expect(verdictOf(target({ state: 'hover', part: 'label' }), base(sections(own)), cap(sections(own))).status).toBe('preserved-verified');
  });
});

describe('review 4 · 6 — box evidence: which authorizations explain a change, and which properties the used box can speak for', () => {
  const boxed = (w: number, h: number) => (v: 'desktop' | 'mobile') => A(v, [el(''), finding({ box: { w, h } })]);
  const go = (property: string, o: (v: 'desktop' | 'mobile') => SectionDesign, exemptions: Exemption[] = []) => verdictOf(target({ property }), base(sections(boxed(200, 40))), cap(sections(o)), exemptions);
  const ex = (property: string, state: Exemption['state']): Exemption => ({ findingId: 'F1', property, part: 'self', state, viewport: 'any', targetId: `t-${property}-${state}`, reason: 'resolved target' });

  it('an authorized aspect-ratio change explains a height change (unverified), it does not turn it into a failure', () => {
    expect(go('height', boxed(200, 70), [ex('aspect-ratio', 'default')]).status).toBe('unverified');
    for (const p of ['text-indent', 'float', 'order', 'zoom', 'content']) expect(go('height', boxed(200, 70), [ex(p, 'default')]).status, p).toBe('unverified');
  });

  it('a HOVER-only authorized padding change does not explain a default-state box change: failed', () => {
    expect(go('width', boxed(260, 40), [ex('padding', 'hover')]).status).toBe('failed');
    expect(go('width', boxed(260, 40), [ex('padding', 'default')]).status).toBe('unverified');
    expect(go('width', boxed(260, 40), [ex('padding', '*')]).status).toBe('unverified');
  });

  it('max-width / min-width / min-height / max-height / flex-basis are not measured by the used box: unverified "not measured", even with an unchanged box', () => {
    for (const property of ['max-width', 'min-width', 'min-height', 'max-height', 'flex-basis']) {
      const r = go(property, boxed(200, 40));
      expect(r.status, property).toBe('unverified');
      expect(r.detail, property).toMatch(/not measured/);
    }
  });
});

describe('review 4 · 7 — a removed element fails every preserve decision about it', () => {
  const gone = (v: 'desktop' | 'mobile') => A(v, [el('')]);

  it('also when the property is not measured (margin-top, z-index) or the state is not captured (active, disabled)', () => {
    for (const t of [target({ property: 'margin-top' }), target({ property: 'z-index' }), target({ state: 'active' }), target({ state: 'disabled' })]) {
      const r = unchanged(t, gone);
      expect(r.status, `${t.property} ${t.state}`).toBe('failed');
      expect(r.detail).toMatch(/removed/);
    }
  });

  it('also for a hover target and for a mobile hover target (the element is gone on that viewport)', () => {
    expect(unchanged(target({ state: 'hover' }), gone).status).toBe('failed');
    expect(unchanged(target({ state: 'hover', viewport: { name: 'mobile', width: 390 } }), gone).status).toBe('failed');
  });

  it('a section that is not rendered fails them as well', () => {
    const notRendered = (v: 'desktop' | 'mobile') => A(v, [el('')], { located: false });
    expect(unchanged(target({ property: 'margin-top' }), notRendered).status).toBe('failed');
  });

  it('without a removal the gates still apply', () => {
    expect(unchanged(target({ property: 'margin-top' })).status).toBe('unverified');
    expect(unchanged(target({ state: 'active' })).status).toBe('unverified');
  });
});

// ── review 4: accounting and feedback consistency ───────────────────────────────────────────

describe('review 4 · 9 — a decision-preserved finding whose preserved property changed is no longer "explained by a decision"', () => {
  const t = target({ id: 'p-dec', findingId: 'F-dec', property: 'width' });
  const failed = { targetId: 'p-dec', findingId: 'F-dec', property: 'width', state: 'default' as const, verification: 'failed' as const, detail: 'removed', reason: 'element removed', evidence: [] };

  it('reconcilePreserve clears `reported` (and flips the status), exactly as it does for fixed / component-verified', async () => {
    const { reconcilePreserve } = await import('../../src/fidelity/accounting.ts');
    const f = [{ findingId: 'F-dec', section: 's', type: 'button', label: 'x', status: 'preserved-by-decision' as const, route: 'css-edit' as const, detail: 'ok', reported: 'resolver' as const, targets: { resolved: 0, verified: 0, failed: 0, unmeasurable: 0, preserved: 1, unresolved: 0 } }];
    reconcilePreserve(f, resolutionOf(t), [failed]);
    expect(f[0]!.status).toBe('unresolved');
    expect(f[0]!.reported).toBeUndefined();
  });

  it('a preserve target whose finding is not among the findings is counted by the summary and by no finding tally', async () => {
    const { reconcilePreserve, summarizePreserve } = await import('../../src/fidelity/accounting.ts');
    const other = [{ findingId: 'F-other', section: 's', type: 'button', label: 'x', status: 'fixed-verified' as const, route: 'css-edit' as const, detail: 'ok', targets: { resolved: 1, verified: 1, failed: 0, unmeasurable: 0, preserved: 0, unresolved: 0 } }];
    reconcilePreserve(other, resolutionOf(t), [failed]);
    expect(other[0]).toMatchObject({ status: 'fixed-verified', detail: 'ok' });
    expect(other[0]!.targets).toEqual({ resolved: 1, verified: 1, failed: 0, unmeasurable: 0, preserved: 0, unresolved: 0 });
    expect(summarizePreserve([failed])).toMatchObject({ total: 1, failed: 1 });
  });
});

describe('review 4 (missing test) — preserve-broken feedback is not suppressed by an UNRELATED property-less regression', () => {
  const verificationWith = (detail: string): PreviewVerification => verification({ targetResults: [{ targetId: 'p1', findingId: 'f1', verification: 'failed', detail }] });
  const regression = (over: Partial<FidelityReport['differences'][number]> = {}) => ({ id: 'd1', sectionId: 's', viewport: 'desktop' as const, elementKey: '0/3', elementLabel: 'Footnote', category: 'element-unmatched' as const, state: 'default' as const, property: null, baseline: '<p>', observed: null, classification: 'regression' as const, findingIds: ['f1'], exemptionTargetId: null, detail: 'gone', ...over });
  const reportWith = (d: ReturnType<typeof regression>): FidelityReport => ({ ...run(base([ok()]), cap([ok()])), differences: [d], verdict: 'fail' });
  const attribution = { editsByFinding: new Map([['f1', [{ property: 'width', kind: 'style' }]]]), islandFindingIds: new Set<string>(), overrideSectionIds: new Set<string>() };
  const resolution = resolutionOf(target({ id: 'p1', findingId: 'f1', property: 'width' }));

  it('a changed width is still reported to the planner when the only other regression is a different element that disappeared', async () => {
    const { feedbackOf } = await import('../../src/preview/correct.ts');
    const fb = feedbackOf({ attempt: null, verification: verificationWith('box changed: the used width of <a> "Buy" changed from 200px to 260px'), fidelity: reportWith(regression()), attribution }, resolution);
    expect(fb.filter((x) => x.kind === 'preserve-broken')).toHaveLength(1);
  });

  it('a REMOVAL failure is already described by the property-less regression and is not reported twice', async () => {
    const { feedbackOf } = await import('../../src/preview/correct.ts');
    const fb = feedbackOf({ attempt: null, verification: verificationWith('element removed: <a> "Buy" exists on the original'), fidelity: reportWith(regression()), attribution }, resolution);
    expect(fb.filter((x) => x.kind === 'preserve-broken')).toHaveLength(0);
  });
});
