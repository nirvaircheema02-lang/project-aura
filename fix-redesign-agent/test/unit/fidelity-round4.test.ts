import { describe, expect, it } from 'vitest';
import { compareDesign, pseudoValuesEqual, valuesEqual } from '../../src/fidelity/compare.ts';
import { gapSplit } from '../../src/fidelity/coverage.ts';
import { evaluatePreserveTargets } from '../../src/fidelity/verify.ts';
import type { CapturedElement, DesignBaseline, DesignCapture, FidelityReport, PseudoRef, SectionDesign, StateCapture, StyleRecord } from '../../src/fidelity/types.ts';
import type { Exemption } from '../../src/resolution/schema.ts';
import { base, cap, el, resolutionOf, sec, target } from '../helpers/fidelity-captures.ts';

/**
 * Round 4 of the fidelity re-review, built from capture literals (no browser): what a pseudo-element is sized from, what an authorized change can plausibly drive,
 * url() in cursor / content, and the wording of the cap note. The cases that need a real page are in test/integration/fidelity-round4.test.ts.
 */

const run = (b: DesignBaseline, o: DesignCapture, exemptions: Exemption[] = []): FidelityReport => compareDesign({ baseline: b, observed: o, exemptions, now: () => new Date(0) });
const ok = (id = 'ok'): SectionDesign => sec({ sectionId: id });
const BLACK: StyleRecord = { color: 'rgb(0, 0, 0)', 'font-size': '16px', 'padding-top': '40px', 'box-shadow': 'none', 'background-image': 'none' };
const ex = (property: string, over: Partial<Exemption> = {}): Exemption => ({ findingId: 'F1', property, part: 'self', state: 'default', viewport: 'any', targetId: `t-${property}`, reason: `fix ${property}`, ...over });
const regressions = (r: FidelityReport) => r.differences.filter((d) => d.classification === 'regression');
const PSEUDO: StyleRecord = { content: '""', display: 'block', 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(0, 0, 0)', opacity: '1', transform: 'none', width: '80px', height: '2px', 'box-shadow': 'none', 'background-image': 'none' };
const CB = (w: number, h: number): PseudoRef => ({ from: 'containing-block', box: { w, h } });
const CONTENT = (w: number, h: number): PseudoRef => ({ from: 'content-box', box: { w, h } });

const owner = (after: StyleRecord, ref: PseudoRef | undefined, over: { box?: { w: number; h: number }; style?: StyleRecord; states?: CapturedElement['states'] } = {}): CapturedElement =>
  el('0', { tag: 'a', label: 'Tile', textHash: 'tile', roles: ['finding', 'interactive'], findingIds: ['F1'], stateAttempt: { hover: 'captured' }, style: over.style ?? BLACK, pseudo: { after }, ...(ref ? { pseudoRef: { after: ref } } : {}), ...(over.box ? { box: over.box } : {}), ...(over.states ? { states: over.states } : {}) });
const section = (e: CapturedElement) => sec({ elements: [el(''), e], pseudoCaptured: true });
const pair = (b: CapturedElement, o: CapturedElement) => [base([ok(), section(b)]), cap([ok(), section(o)])] as const;

describe('round 4 · 1 — a pseudo-element is compared with the box it is actually SIZED from', () => {
  it('a stretched link (::after inset:0 sized by the positioned CARD): the owner link\'s own box does not move, the card\'s does — no difference', () => {
    const [b, o] = pair(owner({ ...PSEUDO, height: '98px', width: '300px' }, CB(300, 98), { box: { w: 80, h: 24 } }), owner({ ...PSEUDO, height: '66px', width: '300px' }, CB(300, 66), { box: { w: 80, h: 24 } }));
    const r = run(b, o, [ex('padding')]);
    expect(r.differences.filter((d) => d.elementKey.includes('::'))).toEqual([]);
    expect(r.verdict).toBe('pass');
  });

  it('an in-flow block ::after (width = the owner\'s CONTENT box): only padding-left changed, the owner\'s height did not — no difference', () => {
    const [b, o] = pair(owner({ ...PSEUDO, width: '1360px', height: '1px' }, CONTENT(1360, 40), { box: { w: 1440, h: 80 } }), owner({ ...PSEUDO, width: '1380px', height: '1px' }, CONTENT(1380, 40), { box: { w: 1440, h: 80 } }));
    expect(run(b, o, [ex('padding-left')]).differences.filter((d) => d.elementKey.includes('::'))).toEqual([]);
  });

  it('a pseudo that keeps the same INSET from its box (inset:-8px: the box plus a constant) follows it', () => {
    const [b, o] = pair(owner({ ...PSEUDO, width: '216px', height: '116px' }, CB(200, 100)), owner({ ...PSEUDO, width: '166px', height: '90px' }, CB(150, 74)));
    expect(run(b, o).differences.filter((d) => d.elementKey.includes('::'))).toEqual([]);
  });

  it('a ring that STOPPED covering its box is still a regression, whatever the authorization', () => {
    const [b, o] = pair(owner({ ...PSEUDO, width: '300px', height: '98px' }, CB(300, 98)), owner({ ...PSEUDO, width: '20px', height: '20px' }, CB(300, 66)));
    expect(regressions(run(b, o, [ex('padding')])).map((d) => `${d.elementKey} ${d.property}`)).toEqual(['0::after width', '0::after height']);
  });

  it('the same box and the same pseudo size is no difference, of course; a size change against an UNCHANGED box is one', () => {
    const [b, o] = pair(owner({ ...PSEUDO, width: '20px' }, CONTENT(200, 40)), owner({ ...PSEUDO, width: '40px' }, CONTENT(200, 40)));
    expect(regressions(run(b, o, [ex('padding')])).map((d) => d.property)).toEqual(['width']);
  });

  it('a translate(-50%) marker is judged against the containing block it is positioned in', () => {
    const [b, o] = pair(owner({ ...PSEUDO, transform: 'matrix(1, 0, 0, 1, -150, 0)' }, CB(300, 98)), owner({ ...PSEUDO, transform: 'matrix(1, 0, 0, 1, -100, 0)' }, CB(200, 98)));
    expect(run(b, o).differences.filter((d) => d.elementKey.includes('::'))).toEqual([]);
  });

  it('in the hover state the evidence recorded WITH the hovered capture is used (the card may change its size on hover)', () => {
    const hov = (h: string, ref: PseudoRef): CapturedElement['states'] => ({ hover: { subtree: { '': BLACK, '::after': { ...PSEUDO, height: h, width: '300px' } }, effect: true, pseudoRef: { '::after': ref } } satisfies StateCapture });
    const mk = (h: string, ref: PseudoRef) => owner({ ...PSEUDO, height: h, width: '300px' }, ref, { states: hov(h, ref) });
    const [b, o] = pair(mk('98px', CB(300, 98)), mk('66px', CB(300, 66)));
    expect(run(b, o, [ex('padding')]).differences.filter((d) => d.elementKey.includes('::'))).toEqual([]);
    const [b2, o2] = pair(mk('98px', CB(300, 98)), { ...mk('66px', CB(300, 98)) });
    expect(regressions(run(b2, o2)).map((d) => `${d.category} ${d.property}`)).toEqual(['default-style height', 'hover height']);
  });

  describe('without box evidence the verifier says so — an unverified required gap, never a pass and never a made-up regression', () => {
    const changed = (refB: PseudoRef | undefined, refO: PseudoRef | undefined) => pair(owner({ ...PSEUDO, width: '80px' }, refB, { box: { w: 160, h: 96 } }), owner({ ...PSEUDO, width: '50px' }, refO, { box: { w: 120, h: 64 } }));

    it('a baseline captured before the evidence existed (no pseudoRef): the size change is not-checkable and the gap is REQUIRED and ACTIONABLE; the verdict is incomplete', () => {
      const [b, o] = changed(undefined, CONTENT(120, 64));
      const r = run(b, o, [ex('padding')]);
      expect(regressions(r)).toEqual([]);
      expect(r.differences.filter((d) => d.classification === 'not-checkable' && d.elementKey === '0::after').map((d) => d.property)).toEqual(['width']);
      expect(r.verdict).toBe('incomplete');
      const gap = r.coverage!.gaps.find((g) => g.reason === 'pseudo-size-box-unavailable')!;
      expect(gap).toMatchObject({ family: 'element', required: true, state: 'default', elementKey: '0' });
      expect(gap.detail).toMatch(/before the box a pseudo-element is sized from was recorded/);
      expect(gapSplit(r)).toEqual({ actionable: 1, byDesign: 0 });
      expect(r.coverage!.requiredTotal).toBe(r.coverage!.requiredVerified + r.coverage!.requiredFailed + r.coverage!.requiredUnverified);
    });

    it('a box the capture could not measure (null) is the same gap, with its own wording', () => {
      const noBox: PseudoRef = { from: 'containing-block', box: null };
      const r = run(...changed(noBox, noBox));
      expect(regressions(r)).toEqual([]);
      expect(r.verdict).toBe('incomplete');
      expect(r.coverage!.gaps.find((g) => g.reason === 'pseudo-size-box-unavailable')!.detail).toMatch(/could not be measured/);
    });

    it('an unchanged size needs no evidence at all (legacy baseline, nothing differs: pass)', () => {
      const [b, o] = pair(owner({ ...PSEUDO, width: '80px' }, undefined), owner({ ...PSEUDO, width: '80px' }, CONTENT(120, 64)));
      expect(run(b, o).verdict).toBe('pass');
    });

    it('a rotation is never box-relative, evidence or not: a regression', () => {
      const [b, o] = pair(owner({ ...PSEUDO, transform: 'none' }, undefined), owner({ ...PSEUDO, transform: 'matrix(0.7071, 0.7071, -0.7071, 0.7071, 0, 0)' }, CONTENT(120, 64)));
      expect(regressions(run(b, o)).map((d) => d.property)).toEqual(['transform']);
    });

    it('a REAL regression elsewhere still fails the verdict (the gap does not hide it)', () => {
      const [b, o] = changed(undefined, CONTENT(120, 64));
      const o2 = { ...o, sections: o.sections.map((s) => (s.sectionId === 's' ? { ...s, elements: s.elements.map((e) => (e.key === '0' ? { ...e, style: { ...e.style, color: 'rgb(255, 0, 0)' } } : e)) } : s)) };
      expect(run(b, o2).verdict).toBe('fail');
    });
  });
});

describe('round 4 · 2 — an authorized change excuses a pseudo size change only where it can plausibly DRIVE it', () => {
  const fs = (px: number): StyleRecord => ({ ...BLACK, 'font-size': `${px}px` });
  const icon = (px: number, ref: PseudoRef | undefined, style: StyleRecord, box = { w: 100, h: 24 }) => owner({ ...PSEUDO, width: `${px}px`, height: `${px}px` }, ref, { style, box });

  it('an em-sized icon follows an authorized font-size change (intentional, attributed to the target)', () => {
    const [b, o] = pair(icon(16, CONTENT(100, 24), fs(16)), icon(20, CONTENT(100, 24), fs(20)));
    const r = run(b, o, [ex('font-size')]);
    expect(regressions(r)).toEqual([]);
    expect(r.differences.filter((d) => d.elementKey === '0::after' && d.classification === 'intentional').map((d) => d.property).sort()).toEqual(['height', 'width']);
    expect(r.differences.find((d) => d.elementKey === '0::after')!.exemptionTargetId).toBe('t-font-size');
  });

  it('the `font` shorthand and zoom-class authorizations count; a colour authorization does not', () => {
    const [b, o] = pair(icon(16, CONTENT(100, 24), fs(16)), icon(20, CONTENT(100, 24), fs(20)));
    expect(regressions(run(b, o, [ex('font')]))).toEqual([]);
    expect(regressions(run(b, o, [ex('color')])).map((d) => d.property).sort()).toEqual(['font-size', 'height', 'width']);
  });

  it('the same icon change with NO authorization is a regression', () => {
    const [b, o] = pair(icon(16, CONTENT(100, 24), fs(16)), icon(20, CONTENT(100, 24), fs(20)));
    expect(regressions(run(b, o)).map((d) => `${d.elementKey} ${d.property}`)).toContain('0::after width');
  });

  it('a FIXED-px pseudo whose size changed stays a regression although the owner\'s box moved for another authorized reason (padding)', () => {
    const [b, o] = pair(icon(20, CONTENT(200, 24), BLACK, { w: 220, h: 44 }), icon(40, CONTENT(200, 24), { ...BLACK, 'padding-top': '24px' }, { w: 248, h: 28 }));
    const r = run(b, o, [ex('padding')]);
    expect(regressions(r).map((d) => `${d.elementKey} ${d.property}`).sort()).toEqual(['0::after height', '0::after width']);
    expect(r.differences.filter((d) => d.classification === 'intentional' && d.elementKey.includes('::'))).toEqual([]);
  });

  it('...also with a width / margin / display authorization, and when the box evidence is missing (the gap, not a pass)', () => {
    for (const p of ['width', 'margin-left', 'display']) {
      const [b, o] = pair(icon(20, CONTENT(200, 24), BLACK, { w: 220, h: 44 }), icon(40, CONTENT(200, 24), BLACK, { w: 248, h: 28 }));
      expect(regressions(run(b, o, [ex(p)])).map((d) => d.property)).toContain('width');
    }
    const [b, o] = pair(icon(20, undefined, BLACK, { w: 220, h: 44 }), icon(40, CONTENT(200, 24), BLACK, { w: 248, h: 28 }));
    const r = run(b, o, [ex('padding')]);
    expect(r.verdict).toBe('incomplete');
    expect(r.differences.some((d) => d.classification === 'intentional' && d.elementKey.includes('::'))).toBe(false);
  });

  it('an authorized font-size change does NOT excuse a pseudo that stayed fixed in px when it changed some other way (the em ratio is not kept)', () => {
    const [b, o] = pair(icon(16, CONTENT(100, 24), fs(16)), icon(40, CONTENT(100, 24), fs(20)));
    expect(regressions(run(b, o, [ex('font-size')])).map((d) => d.property)).toContain('width');
  });

  it('a font-size authorization on an element whose font-size did not change drives nothing', () => {
    const [b, o] = pair(icon(16, CONTENT(100, 24), fs(16)), icon(20, CONTENT(100, 24), fs(16)));
    expect(regressions(run(b, o, [ex('font-size')])).map((d) => d.property)).toContain('width');
  });
});

describe('round 4 · 3 — url() reduction for cursor and for url() outside quoted strings', () => {
  const DATA = 'url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=") 0 0, auto';
  const ASSET = 'url("http://localhost:3040/assets/c.cur") 0 0, auto';

  it('cursor: a custom cursor image on the original and the preview\'s /assets path are the same cursor; the hotspot and the fallback still count', () => {
    expect(valuesEqual('cursor', DATA, ASSET)).toBe(true);
    expect(valuesEqual('cursor', DATA, 'url("http://localhost:3040/assets/c.cur") 4 4, auto')).toBe(false);
    expect(valuesEqual('cursor', DATA, 'url("http://localhost:3040/assets/c.cur") 0 0, pointer')).toBe(false);
    expect(valuesEqual('cursor', DATA, 'pointer')).toBe(false);
    expect(valuesEqual('cursor', 'pointer', 'pointer')).toBe(true);
  });

  it('content: a url() AFTER quoted text is reduced too; the quoted text itself is compared as text', () => {
    expect(valuesEqual('content', '"a" url("https://x/y.png")', '"a" url("http://localhost:3040/assets/y.png")')).toBe(true);
    expect(valuesEqual('content', '"a" url("https://x/y.png")', '"b" url("http://localhost:3040/assets/y.png")')).toBe(false);
    expect(valuesEqual('content', '"a" url("https://x/y.png")', '"a"')).toBe(false);
    expect(pseudoValuesEqual('content', 'url("https://x/y.png") "a"', 'url("/assets/y.png") "a"')).toBe(true);
  });

  it('quoted text that merely LOOKS like a url stays text', () => {
    expect(valuesEqual('content', '"url(a.png)"', '"url(b.png)"')).toBe(false);
    expect(valuesEqual('content', '"url(a.png)" url("x.png")', '"url(a.png)" url("y.png")')).toBe(true);
    expect(valuesEqual('content', '"it\\"s url(a)"', '"it\\"s url(b)"')).toBe(false);
  });

  it('the unchanged page with a custom cursor on an inherited chain is a clean pass', () => {
    const el1 = (cursor: string) => el('0', { tag: 'a', label: 'Link', textHash: 'l', roles: ['finding', 'interactive'], findingIds: ['F1'], stateAttempt: { hover: 'captured' }, style: { ...BLACK, cursor } });
    const r = run(base([ok(), sec({ elements: [el(''), el1(DATA)] })]), cap([ok(), sec({ elements: [el(''), el1(ASSET)] })]));
    expect(regressions(r)).toEqual([]);
    expect(r.verdict).toBe('pass');
  });
});

describe('round 4 · 5 — the "part capped" note does not suggest that raising the limit alone clears it', () => {
  it('says the cap is baked into the stored write-once baseline and that clearing it needs a deliberate recapture with a higher limit', () => {
    const list = (v: 'desktop' | 'mobile') => sec({
      sectionId: 'A', viewport: v, capped: { dropped: 2 }, capLossRecorded: true,
      elements: [el(''), el('0', { tag: 'div', label: 'List', textHash: 'list', roles: ['finding'], findingIds: ['F1'], partKeys: { label: [], descendants: ['0/0', '0/1', '0/2'], named: {}, capDropped: { descendants: ['0/1', '0/2'] } } }), el('0/0', { tag: 'b', label: '0/0', textHash: '0/0', roles: ['text'] })],
    });
    const b = base([list('desktop'), list('mobile'), ok('B')]), o = cap([list('desktop'), list('mobile'), ok('B')]);
    const report = compareDesign({ baseline: b, observed: o, exemptions: [] });
    const [r] = evaluatePreserveTargets({ resolution: resolutionOf(target({ part: 'descendants' })), report, baseline: b, exemptions: [] });
    expect(r!.reason).toBe('part capped');
    expect(r!.detail).toMatch(/stored, write-once baseline/);
    expect(r!.detail).toMatch(/remove design-baseline\.json/);
    expect(r!.detail).toMatch(/higher fidelity\.maxElementsPerSection/);
    expect(r!.detail).not.toMatch(/raising fidelity\.maxElementsPerSection clears this/);
  });
});
