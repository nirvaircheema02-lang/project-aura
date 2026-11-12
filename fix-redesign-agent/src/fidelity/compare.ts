import { fingerprintOf } from '../session/fingerprint.ts';
import { parseUserStyle } from '../preview/user-style-rules.ts';
import type { Exemption, StateName } from '../resolution/schema.ts';
import { colorDeltaEWithAlpha, lengthToPx } from '../t-layer/computed-style.ts';
import { STATES_NOT_CAPTURED } from './capture.ts';
import { CoverageLedger, unavailableFrom } from './coverage.ts';
import { unurl } from './lib.ts';
import {
  FIDELITY_SCHEMA_VERSION,
  type CapturedElement,
  type CapturedRole,
  type ElementEvidence,
  type StateEvidence,
  type UnverifiedReason,
  type DesignBaseline,
  type DesignCapture,
  type DifferenceCategory,
  type FidelityDifference,
  type FidelityReport,
  type FidelityViewportName,
  type GroupComposition,
  type PseudoRef,
  type SectionDesign,
  type StickyTrace,
  type StyleRecord,
} from './types.ts';

/** Shorthand → the longhands this verifier records, so an exemption for `border-radius` covers the four corners and nothing else. */
const PROPERTY_GROUPS: Record<string, string[]> = {
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  border: ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  background: ['background-color', 'background-image'],
  outline: ['outline-style', 'outline-width', 'outline-color', 'outline-offset'],
  'text-decoration': ['text-decoration-line', 'text-decoration-color'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function'],
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  font: ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height'],
};

/** The properties an exemption for `property` covers. */
export function coveredProperties(property: string): Set<string> {
  const p = property.trim().toLowerCase();
  return new Set([p, ...(PROPERTY_GROUPS[p] ?? [])]);
}

/**
 * CONSEQUENCES of an authorized change. A change a target authorizes on one element is not a defect where it follows from that change:
 *  - inheritance: a descendant that INHERITS the property (same value as the changed element before and after) changes with it;
 *  - currentcolor: text-decoration, outline and border colours that equalled the element's `color` follow an authorized `color` change;
 *  - line-height follows an authorized `font-size` change when its ratio to the font size is unchanged.
 * Each rule is checked on the measured values of BOTH sides, so a descendant that sets its own value is still compared.
 */
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'cursor', 'visibility']);
const CURRENT_COLOR = new Set(['text-decoration-color', 'outline-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']);
/** Values that can EMBED the element's colour (a currentcolor shadow or gradient stop): equal once that colour (at any non-zero alpha: a transparent stop is not the colour) is masked out of both sides, and it really is in both. */
const EMBEDS_COLOUR = new Set(['box-shadow', 'background-image']);
const MASK = '\u00a4';
function embedsColour(a: string | undefined, b: string | undefined, colourA: string | undefined, colourB: string | undefined): boolean {
  if (!a || !b || !colourA || !colourB) return false;
  const mask = (v: string, colour: string): string | null => {
    const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(colour);
    return m ? v.replace(new RegExp(`rgba?\\(${m[1]}, ${m[2]}, ${m[3]}(?:, (?!0\\))[\\d.]+)?\\)`, 'g'), MASK) : null;
  };
  const ma = mask(a, colourA), mb = mask(b, colourB);
  return ma !== null && ma === mb && ma.includes(MASK);
}

const COLOR = /(^|-)color$/;
const LENGTH = new Set([
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'font-size', 'letter-spacing', 'outline-width', 'outline-offset', 'row-gap', 'column-gap', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
]);

/** Tolerance-aware equality: colours within ΔE 2 (alpha-aware), lengths within 0.5px, everything else exact. */
export function valuesEqual(property: string, a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (COLOR.test(property)) {
    const d = colorDeltaEWithAlpha(a, b);
    return d !== null && d <= 2;
  }
  if (LENGTH.has(property) || property === 'line-height') {
    if (property === 'line-height' && (a === 'normal' || b === 'normal')) return a === b;
    const pa = lengthToPx(a), pb = lengthToPx(b);
    if (pa === null || pb === null) return false;
    // "fully rounded" (calc(infinity * 1px)) serializes as a huge number: any two huge radii are the same shape
    if (pa > 1e6 && pb > 1e6) return true;
    return Math.abs(pa - pb) <= 0.5;
  }
  // (the preview serves its own copy of each picture under another path: every url(...) outside a quoted string is "an image is here", see `URL_PATTERN`; a custom cursor is one too)
  if (property === 'background-image' || property === 'content' || property === 'cursor') return unurl(a) === unurl(b);
  return false;
}

export const joinKey = (base: string, rel: string): string => (base === '' ? rel : rel === '' ? base : `${base}/${rel}`);

/** A pseudo-element's key is its owner's key plus `::before` / `::after` (the owner's relative key is '' for the hovered element itself, so the pseudo's is '::after'). */
/** Disclosed when a baseline from before pseudo-elements were measured is compared: that part of the comparison did not run. */
const LEGACY_PSEUDO = '::before / ::after styling: the baseline was captured before pseudo-elements were measured, so they were not compared';
/** Disclosed when a baseline from before the focus trial is compared: its tag-list capture never tried elements that take keyboard focus without being a link or a control. */
const LEGACY_FOCUS = 'keyboard focus of elements the original\'s capture never tried: the baseline was captured before the real focus trial, so a finding element that takes focus only through a tabindex or contenteditable has no original focus state to compare';
const PSEUDO_SUFFIX = /::(before|after)$/;
const splitPseudo = (key: string): { owner: string; suffix: string } => { const m = PSEUDO_SUFFIX.exec(key); return m ? { owner: key.slice(0, m.index), suffix: m[0] } : { owner: key, suffix: '' }; };

/** Pseudo-element values: the element rules, with width / height (a laid-out size, not a declared one) allowed 1px or 1%. */
export function pseudoValuesEqual(property: string, a: string | undefined, b: string | undefined): boolean {
  if (valuesEqual(property, a, b)) return true;
  if (property === 'width' || property === 'height') {
    const pa = lengthToPx(a ?? ''), pb = lengthToPx(b ?? '');
    return pa !== null && pb !== null && Math.abs(pa - pb) <= Math.max(1, 0.01 * Math.abs(pa));
  }
  return false;
}

/** The box tolerance: the used size of an element is equal within 1px or 0.5%. Shared by the evidence the report stores and by the preserve judgement. */
export const BOX_ABS_TOL = 1;
export const BOX_REL_TOL = 0.005;
export const boxEqual = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(BOX_ABS_TOL, BOX_REL_TOL * Math.abs(a));
const bucket8 = (v: number): number => Math.round(v / 8) * 8;
/** The box evidence: the baseline's box, the verdict per axis, and — only for an axis that changed — the observed size bucketed to 8px (the raw observed box would flap the hash). */
function boxEvidence(b: { w: number; h: number } | undefined, o: { w: number; h: number } | undefined): ElementEvidence['box'] | undefined {
  if (!b) return undefined;
  if (!o) return { baseline: b, equal: null };
  const equal = { w: boxEqual(b.w, o.w), h: boxEqual(b.h, o.h) };
  const changedTo = { ...(equal.w ? {} : { w: bucket8(o.w) }), ...(equal.h ? {} : { h: bucket8(o.h) }) };
  return { baseline: b, equal, ...(Object.keys(changedTo).length ? { changedTo } : {}) };
}

/** Does this record paint anything of its own (a fill, an image, a border, a shadow)? */
function bearsDesign(r: StyleRecord): boolean {
  const bg = r['background-color'] ?? 'rgba(0, 0, 0, 0)';
  if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true;
  if ((r['background-image'] ?? 'none') !== 'none' || (r['box-shadow'] ?? 'none') !== 'none') return true;
  return ['top', 'right', 'bottom', 'left'].some((side) => parseFloat(r[`border-${side}-width`] ?? '0') > 0 && (r[`border-${side}-style`] ?? 'none') !== 'none');
}

interface Box { w: number; h: number }
/** What a pseudo-element comparison knows about its owner: colours on both sides, the box each side's pseudo is sized from, the authorized colour change, and (lazily) the font change that can explain an em-sized pseudo. */
interface PseudoOwner { ownerB: StyleRecord | undefined; ownerO: StyleRecord | undefined; refB: PseudoRef | undefined; refO: PseudoRef | undefined; colorEx: Exemption | null; fontCause: () => BoxCause | null }
const PSEUDO_SIZED = new Set(['width', 'height', 'transform']);

/** `matrix(a, b, c, d, tx, ty)` as numbers; `none` is the identity; a 3D or unparsable transform is null. */
function matrixOf(v: string | undefined): number[] | null {
  if (v === undefined) return null;
  if (v === 'none') return [1, 0, 0, 1, 0, 0];
  const m = /^matrix\(([^)]*)\)$/.exec(v);
  const n = m ? m[1]!.split(',').map((x) => Number(x.trim())) : [];
  return n.length === 6 && n.every(Number.isFinite) ? n : null;
}
const translationOnly = (a: string | undefined, b: string | undefined): boolean => { const x = matrixOf(a), y = matrixOf(b); return !!x && !!y && [0, 1, 2, 3].every((i) => Math.abs(x[i]! - y[i]!) <= 0.005); };

/**
 * Does the pseudo-element keep the same size (or translation) relative to the box it is SIZED from on both sides (`PseudoRef`: its containing block for an absolutely positioned one, the content box
 * of its block container for an in-flow one)? Either the same fraction of it (an `inset: 0` ring, a `width: 100%` underline, a translate(-50%) marker) or the same distance from it (an `inset: -8px` ring).
 * The boxes are whole pixels, so a fraction is only trusted to 2 px of the box's size (and never finer than 0.5%) and a distance to 2 px: a 16px icon that becomes 20px inside a 100px box is a change.
 */
function tracksReferenceBox(prop: string, b: string | undefined, o: string | undefined, boxB: Box | null | undefined, boxO: Box | null | undefined): boolean {
  if (!boxB || !boxO) return false;
  const near = (x: number, y: number, ob: number, oo: number) => Math.abs(x - y) <= Math.max(0.005, 2 / Math.min(ob, oo));
  if (prop === 'width' || prop === 'height') {
    const ob = prop === 'width' ? boxB.w : boxB.h, oo = prop === 'width' ? boxO.w : boxO.h;
    const pb = lengthToPx(b ?? ''), po = lengthToPx(o ?? '');
    return pb !== null && po !== null && ob > 0 && oo > 0 && (near(pb / ob, po / oo, ob, oo) || Math.abs((ob - pb) - (oo - po)) <= 2);
  }
  const mb = matrixOf(b), mo = matrixOf(o);
  if (!mb || !mo || !translationOnly(b, o) || boxB.w <= 0 || boxO.w <= 0 || boxB.h <= 0 || boxO.h <= 0) return false;
  return near(mb[4]! / boxB.w, mo[4]! / boxO.w, boxB.w, boxO.w) && near(mb[5]! / boxB.h, mo[5]! / boxO.h, boxB.h, boxO.h);
}

/** Properties whose authorized change can scale an em-sized pseudo-element: it is sized in the owner's font size (em) or its zoom. Padding, margin, gap or width cannot drive a pseudo that is not sized from a box. */
const FONT_DRIVEN = /^(font-size|font|zoom)$/;
/** Is the pseudo's size / translation the SAME number of em of the owner's font size on both sides, with the font size really changed? (Only then can an authorized font change have driven it.) */
function followsFontSize(prop: string, b: string | undefined, o: string | undefined, ownerB: StyleRecord | undefined, ownerO: StyleRecord | undefined): boolean {
  const fb = lengthToPx(ownerB?.['font-size'] ?? ''), fo = lengthToPx(ownerO?.['font-size'] ?? '');
  if (fb === null || fo === null || fb <= 0 || fo <= 0 || valuesEqual('font-size', ownerB?.['font-size'], ownerO?.['font-size'])) return false;
  const same = (x: number, y: number) => Math.abs(x / fb - y / fo) <= 0.03;
  if (prop === 'width' || prop === 'height') { const pb = lengthToPx(b ?? ''), po = lengthToPx(o ?? ''); return pb !== null && po !== null && same(pb, po); }
  const mb = matrixOf(b), mo = matrixOf(o);
  return !!mb && !!mo && translationOnly(b, o) && same(mb[4]!, mo[4]!) && same(mb[5]!, mo[5]!);
}

export interface CompareInput {
  baseline: DesignBaseline | null;
  observed: DesignCapture | null;
  /** The ONLY changes allowed to differ from the original: finding + property + part + state. */
  exemptions: Exemption[];
  /** Sections rendered as hand-authored React: not structurally comparable, covered by their own checks, listed — never silently passed. */
  overrideSectionIds?: ReadonlySet<string>;
  /** DS-first: a mounted design-system component owns its whole design — differences on it (and inside it) are intentional, and are listed as such. */
  dsFirst?: boolean;
  now?: () => Date;
}

const idOf = (d: Pick<FidelityDifference, 'sectionId' | 'viewport' | 'elementKey' | 'category' | 'state' | 'property'>): string =>
  fingerprintOf({ s: d.sectionId, v: d.viewport, k: d.elementKey, c: d.category, st: d.state, p: d.property }).slice(0, 12);

export interface PartIndex {
  self: string[];
  label: string[];
  descendants: string[];
  named: Record<string, string[]>;
  findingKeys: string[];
  /** What the capture cut from each part's member list (see `CapturedElement.partKeys.truncated`): a cut part is never proven. */
  truncated: { label: number; descendants: number; walk: number };
  /** Members of the `label` / `descendants` parts that the element cap dropped (see `CapturedElement.partKeys.capDropped`): they have no element record, so a part holding one is never proven either. */
  capDropped: string[];
}

export function indexFindingParts(section: SectionDesign): Map<string, PartIndex> {
  const out = new Map<string, PartIndex>();
  for (const e of section.elements) {
    for (const f of e.findingIds) {
      const cur = out.get(f) ?? { self: [], label: [], descendants: [], named: {}, findingKeys: [], truncated: { label: 0, descendants: 0, walk: 0 }, capDropped: [] };
      cur.self.push(e.key);
      cur.findingKeys.push(e.key);
      if (e.partKeys?.truncated) { cur.truncated.label += e.partKeys.truncated.label ?? 0; cur.truncated.descendants += e.partKeys.truncated.descendants ?? 0; cur.truncated.walk += e.partKeys.truncated.walk ?? 0; }
      if (e.partKeys?.capDropped) cur.capDropped.push(...(e.partKeys.capDropped.label ?? []), ...(e.partKeys.capDropped.descendants ?? []));
      if (e.partKeys) { cur.label.push(...e.partKeys.label); cur.descendants.push(...e.partKeys.descendants); for (const [n, ks] of Object.entries(e.partKeys.named)) cur.named[n] = [...(cur.named[n] ?? []), ...ks]; }
      out.set(f, cur);
    }
  }
  return out;
}

export function keysForPart(idx: PartIndex, part: string): string[] {
  if (part === 'self') return idx.self;
  if (part === 'label') return idx.label;
  if (part === 'descendants') return idx.descendants;
  // an unknown part resolves to NOTHING: an exemption must be able to name what it exempts, so it fails closed
  return idx.named[part] ?? [];
}

/** How many members of `part` the capture cut (0 = the list is complete). `self` is always complete. */
export function partTruncation(idx: PartIndex, part: string): number {
  if (part === 'self') return 0;
  if (part === 'label') return idx.truncated.label + idx.truncated.walk;
  if (part === 'descendants') return idx.truncated.descendants + idx.truncated.walk;
  return idx.truncated.walk;
}

export const isUnder = (key: string, ancestor: string) => ancestor === '' || key === ancestor || key.startsWith(`${ancestor}/`);

/** Properties that can change the used size of a box. An authorized change of one of these on or around the element explains a box change. */
export const LAYOUT_AFFECTING = /^(padding|margin|font|line-height|letter-spacing|word-spacing|text-transform|white-space|(row-|column-)?gap|display|position|flex|grid|justify|align|overflow|width|height|min-|max-|box-sizing|aspect-ratio|text-indent|float|clear|order|zoom|content|writing-mode|inset|top$|left$|right$|bottom$|border(-(top|right|bottom|left))?(-width)?$|border-(top|right|bottom|left)-width$)/;

/** What an authorized layout-affecting change or a mounted component says about a changed box: the sentence, the target that authorizes it, and whether it is attributable to THIS element (on it, around it or inside it) rather than a possible side effect elsewhere. */
export interface BoxCause { sentence: string; targetId: string | null; reason: string | null; attributable: boolean }

/**
 * The cause of an element's changed box, from the authorizations in force. The box is measured at rest, so only a change that applies in the default state (or in `state`, for a pseudo-element
 * read in that state) can explain it. `drives` says which properties may (layout-affecting ones by default).
 */
export function boxCause(sb: SectionDesign, key: string, exemptions: readonly Exemption[], vp: FidelityViewportName, islandKeys: readonly string[], state: StateName = 'default', drives: RegExp = LAYOUT_AFFECTING): BoxCause | null {
  const relation = (other: string): string | null => (other === key ? 'on this element' : isUnder(key, other) ? 'on an ancestor' : isUnder(other, key) ? 'on a descendant' : null);
  const parts = indexFindingParts(sb);
  let sibling: BoxCause | null = null;
  for (const ex of exemptions) {
    if ((ex.viewport !== 'any' && ex.viewport !== vp) || (ex.state !== 'default' && ex.state !== '*' && ex.state !== state) || !drives.test(ex.property.trim().toLowerCase())) continue;
    const idx = parts.get(ex.findingId);
    if (!idx) continue;
    for (const k of idx.self) {
      const rel = relation(k);
      const sentence = (r: string) => `an authorized layout-affecting change explains it (target ${ex.targetId}: ${ex.property} ${r})`;
      if (rel) return { sentence: sentence(rel), targetId: ex.targetId, reason: ex.reason, attributable: true };
      sibling ??= { sentence: `${sentence('elsewhere in the same section')}, a possible side effect that is not attributable`, targetId: ex.targetId, reason: ex.reason, attributable: false };
    }
  }
  for (const k of islandKeys) { const rel = relation(k); if (rel) return { sentence: `a design-system component is mounted ${rel === 'on this element' ? 'in its place' : rel === 'on an ancestor' ? 'around it' : 'inside it'}, which changes the box it replaces`, targetId: null, reason: null, attributable: true }; }
  return sibling ?? (islandKeys.length ? { sentence: 'a design-system component is mounted elsewhere in the section, a possible side effect that is not attributable', targetId: null, reason: null, attributable: false } : null);
}
export const explainBox = (sb: SectionDesign, key: string, exemptions: readonly Exemption[], vp: FidelityViewportName, islandKeys: readonly string[]): string | null => boxCause(sb, key, exemptions, vp, islandKeys)?.sentence ?? null;

/** The checks whose absence is a gap: an element a finding names, a control, or a member of a card group. Plain text and decoration are checked when present and disclosed when skipped. */
const REQUIRED_ROLES: ReadonlySet<CapturedRole> = new Set<CapturedRole>(['finding', 'interactive', 'group-item', 'group-parent']);

interface Stat { elementsCompared: number; default: number; hover: number; focus: number }
interface Ctx {
  add: (d: Omit<FidelityDifference, 'id'>) => void;
  differences: FidelityDifference[];
  ledger: CoverageLedger;
  stat: Stat;
  dsFirst: boolean;
}
/** Did any regression get recorded since `from`? — the unit of work that recorded it is FAILED, otherwise it is verified. */
const regressedSince = (ctx: Ctx, from: number): boolean => ctx.differences.slice(from).some((d) => d.classification === 'regression');

/** Keys whose per-element evidence is kept (to bound the report): the elements findings name, their parts, and their ancestors (a state captured on an ancestor holds the styles of its subtree). */
function evidenceKeys(sb: SectionDesign): Set<string> {
  const out = new Set<string>();
  for (const e of sb.elements) {
    if (!e.findingIds.length) continue;
    out.add(e.key);
    if (e.partKeys) for (const k of [...e.partKeys.label, ...e.partKeys.descendants, ...Object.values(e.partKeys.named).flat()]) out.add(k);
    for (let k = e.key; k !== '';) { k = k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : ''; out.add(k); }
  }
  return out;
}

export function compareDesign(input: CompareInput): FidelityReport {
  const now = input.now ?? (() => new Date());
  const { baseline, observed } = input;
  const differences: FidelityDifference[] = [];
  const ledger = new CoverageLedger();
  const stat: Stat = { elementsCompared: 0, default: 0, hover: 0, focus: 0 };
  let sectionsCompared = 0;
  const base = {
    schemaVersion: FIDELITY_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    baselineSha256: baseline?.baselineSha256 ?? null,
    baselineHtmlSha256: baseline?.source.htmlSha256 ?? null,
    observedSource: observed?.source.url ?? null,
    // what THIS verifier does not capture, plus whatever an older baseline listed: a baseline from before a line was added still discloses it
    statesNotCaptured: [...new Set([...(baseline?.statesNotCaptured ?? []), ...STATES_NOT_CAPTURED, ...(baseline?.sections.some((s) => s.located && !s.pseudoCaptured) ? [LEGACY_PSEUDO] : []), ...(baseline?.sections.some((s) => s.located && s.viewport === 'desktop' && !s.focusTrial) ? [LEGACY_FOCUS] : [])])],
  };
  const finish = (verdictOf: (requiredUnverified: number) => FidelityReport['verdict'], extraUnavailable: string[] = []): FidelityReport => {
    const coverage = ledger.finish();
    return {
      ...base,
      differences,
      unavailable: [...extraUnavailable, ...unavailableFrom(coverage)],
      summary: {
        sections: baseline ? new Set(baseline.sections.map((s) => s.sectionId)).size : 0,
        sectionsCompared,
        elementsCompared: stat.elementsCompared,
        statesCompared: { default: stat.default, hover: stat.hover, 'focus-visible': stat.focus },
        intentional: differences.filter((d) => d.classification === 'intentional').length,
        regressions: differences.filter((d) => d.classification === 'regression').length,
        notCheckable: differences.filter((d) => d.classification === 'not-checkable').length,
      },
      coverage,
      verdict: verdictOf(coverage.requiredUnverified),
    };
  };

  if (!baseline) return finish(() => 'not-checked', ['the original page\'s design baseline was not captured for this run, so design and state fidelity could not be verified']);
  if (!observed) return finish(() => 'not-checked', ['the output was not captured, so design and state fidelity could not be verified']);
  if (!baseline.sections.some((s) => s.located)) return finish(() => 'not-checked', ['no in-scope section could be located in the baseline']);

  const add = (d: Omit<FidelityDifference, 'id'>) => differences.push({ ...d, id: idOf(d) });
  const ctx: Ctx = { add, differences, ledger, stat, dsFirst: !!input.dsFirst };

  for (const sb of baseline.sections) {
    const sectionGap = (reason: UnverifiedReason, detail: string) => ledger.unverified({ family: 'section', sectionId: sb.sectionId, viewport: sb.viewport, elementKey: null, label: sb.sectionId, state: 'default', reason, findingIds: [], detail });
    const evidence = (outcome: 'compared' | 'override' | 'baseline-not-located' | 'output-not-rendered' | 'capture-stopped', elementsCompared = 0, islandKeys: string[] = []) => ledger.sections.push({ sectionId: sb.sectionId, viewport: sb.viewport, outcome, elementsCompared, islandKeys });
    if (!sb.located) { sectionGap('section-not-located-on-original', `${sb.sectionId} (${sb.viewport}): the section could not be located on the original, so it was not compared`); evidence('baseline-not-located'); continue; }
    if (input.overrideSectionIds?.has(sb.sectionId)) { sectionGap('hand-authored-override', `${sb.sectionId}: a hand-authored section is not structurally comparable; its own checks cover it`); evidence('override'); continue; }
    const so = observed.sections.find((s) => s.sectionId === sb.sectionId && s.viewport === sb.viewport);
    if (so && !so.located && so.stopped === 'budget') {
      // the capture never reached this section: that is a missing measurement, not a section that is absent from the output
      sectionGap('section-not-captured-budget', `${sb.sectionId} (${sb.viewport}): the verification budget was exhausted before the output section was captured, so it was not compared`);
      evidence('capture-stopped');
      continue;
    }
    if (!so || !so.located) {
      add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: '', elementLabel: sb.sectionId, category: 'element-unmatched', state: 'default', property: null, baseline: 'rendered', observed: 'not rendered', classification: 'regression', findingIds: [], exemptionTargetId: null, detail: `the section "${sb.sectionId}" is not rendered in the output at the ${sb.viewport} viewport` });
      ledger.failed('section');
      evidence('output-not-rendered');
      continue;
    }
    sectionsCompared++;
    ledger.verified('section');
    const before = stat.elementsCompared;
    compareSection(sb, so, input.exemptions, ctx, baseline.limits);
    evidence('compared', stat.elementsCompared - before, so.elements.filter((e) => e.island).map((e) => e.key));
  }

  const regressions = differences.some((d) => d.classification === 'regression');
  return finish((requiredUnverified) => (regressions ? 'fail' : stat.elementsCompared === 0 ? 'not-checked' : requiredUnverified > 0 ? 'incomplete' : 'pass'));
}

const STATE_REASON: Record<string, UnverifiedReason> = {
  unsettled: 'state-unsettled-on-original',
  'not-hoverable': 'state-not-hoverable-on-original',
  interrupted: 'state-interrupted-on-original',
  'budget-stopped': 'state-budget-stopped',
  'sample-cap': 'state-not-sampled-cap',
};

/** What the structural eyebrow rule restyles (structural.ts EYEBROW_CSS) and what follows from it: the label's colours, type, display and its share of the row. */
const INDICATOR_PROPERTIES = new Set(['background-color', 'background-image', 'background', 'opacity', 'width', 'width-ratio']);
const EYEBROW_PROPERTIES = new Set(['color', 'text-decoration-color', 'outline-color', 'caret-color', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'display', 'align-items', 'width-ratio']);

function compareSection(sb: SectionDesign, so: SectionDesign, exemptions: Exemption[], ctx: Ctx, limits: DesignBaseline['limits']): void {
  const { add, ledger, stat } = ctx;
  const parts = indexFindingParts(sb);
  const findingsForKey = (key: string): string[] => {
    const out = new Set<string>();
    for (const [f, idx] of parts) if (idx.findingKeys.some((fk) => isUnder(key, fk))) out.add(f);
    return [...out];
  };
  const obsByKey = new Map(so.elements.map((e) => [e.key, e] as const));
  const baseByKey = new Map(sb.elements.map((e) => [e.key, e] as const));
  const applies = (ex: Exemption, state: StateName): boolean => (ex.viewport === 'any' || ex.viewport === sb.viewport) && (ex.state === '*' || ex.state === state);
  const directExemption = (key: string, property: string, state: StateName): Exemption | null => {
    for (const ex of exemptions) {
      if (!applies(ex, state) || !coveredProperties(ex.property).has(property)) continue;
      const idx = parts.get(ex.findingId);
      if (idx && keysForPart(idx, ex.part).includes(key)) return ex;
    }
    return null;
  };
  /** Is ANY change at `key` in `state` authorized (a target names the element or one of its parts)? Used where only presence, not a property, is known. */
  const authorizedAt = (key: string, state: StateName): boolean => exemptions.some((ex) => { const idx = parts.get(ex.findingId); return !!idx && applies(ex, state) && keysForPart(idx, ex.part).includes(key); });
  const consequentialExemption = (key: string, property: string, state: StateName): Exemption | null => {
    const b = baseByKey.get(key), o = obsByKey.get(key);
    if (!b || !o) return null;
    if (INHERITED.has(property)) {
      for (const ex of exemptions) {
        if (!applies(ex, state) || !coveredProperties(ex.property).has(property) || ex.part !== 'self') continue;
        const idx = parts.get(ex.findingId);
        for (const k of idx?.self ?? []) {
          if (k === key || !isUnder(key, k)) continue;
          const ba = baseByKey.get(k), oa = obsByKey.get(k);
          if (ba && oa && valuesEqual(property, b.style[property], ba.style[property]) && valuesEqual(property, o.style[property], oa.style[property])) return ex;
        }
      }
    }
    if (CURRENT_COLOR.has(property)) {
      const colorEx = exemptionFor(key, 'color', state);
      if (colorEx && valuesEqual(property, b.style[property], b.style['color']) && valuesEqual(property, o.style[property], o.style['color'])) return colorEx;
    }
    if (EMBEDS_COLOUR.has(property)) {
      const colorEx = exemptionFor(key, 'color', state);
      if (colorEx && embedsColour(b.style[property], o.style[property], b.style['color'], o.style['color'])) return colorEx;
    }
    if (property === 'line-height') {
      const sizeEx = exemptionFor(key, 'font-size', state);
      const ratio = (st: StyleRecord) => { const lh = lengthToPx(st['line-height'] ?? ''), fs = lengthToPx(st['font-size'] ?? ''); return lh !== null && fs !== null && fs > 0 ? lh / fs : null; };
      const rb = ratio(b.style), ro = ratio(o.style);
      if (sizeEx && rb !== null && ro !== null && Math.abs(rb - ro) / rb <= 0.03) return sizeEx;
    }
    return null;
  };
  const exemptionFor = (key: string, property: string, state: StateName): Exemption | null => directExemption(key, property, state) ?? consequentialExemption(key, property, state);
  const userCovers = (key: string, property: string): boolean => { const us = obsByKey.get(key)?.userStyle; return !!us && parseUserStyle(us).some(([p]) => coveredProperties(p).has(property)); };
  /**
   * A USER style rule (user-style-rules.json) authorizes the properties it names on its element, and what FOLLOWS from them — the same consequences an authorized target has
   * (`consequentialExemption`), each checked on the measured values of BOTH sides, so a descendant that sets its own colour is still compared:
   *  - inheritance: a descendant that inherits the property (same value as the ruled element before and after) changes with it;
   *  - currentcolor: text-decoration, outline and border colours (and a shadow / gradient stop that embeds the colour) that equalled the element's `color` follow a ruled `color`.
   */
  const userConsequence = (key: string, property: string): boolean => {
    const b = baseByKey.get(key), o = obsByKey.get(key);
    if (!b || !o) return false;
    if (userCovers(key, property)) return true;
    if (INHERITED.has(property)) {
      for (const a of so.elements) {
        if (a.key === key || !isUnder(key, a.key) || !userCovers(a.key, property)) continue;
        const ba = baseByKey.get(a.key);
        if (ba && valuesEqual(property, b.style[property], ba.style[property]) && valuesEqual(property, o.style[property], a.style[property])) return true;
      }
    }
    if (CURRENT_COLOR.has(property) && userConsequence(key, 'color')) return valuesEqual(property, b.style[property], b.style['color']) && valuesEqual(property, o.style[property], o.style['color']);
    if (EMBEDS_COLOUR.has(property) && userConsequence(key, 'color')) return embedsColour(b.style[property], o.style[property], b.style['color'], o.style['color']);
    return false;
  };
  const islandRoots = so.elements.filter((e) => e.island).map((e) => e.key);
  const insideIsland = (key: string) => islandRoots.some((r) => key !== r && isUnder(key, r));
  // an output whose walk stopped early cannot prove that an element is absent from it, any more than a capped one can
  const observedCapped = !!so.capped || (so.walkCut ?? 0) > 0;
  const desktop = sb.viewport === 'desktop';

  const record = (e: CapturedElement, key: string, category: DifferenceCategory, state: StateName, property: string | null, b: string | null, o: string | null, detail: string, canExempt = true): void => {
    const ex = canExempt && property ? exemptionFor(key, property, state) : null;
    // DS-first: the mounted component (and everything inside it) is the design — its differences from the original are the redesign, not regressions
    const byComponent = !ex && ctx.dsFirst && (islandRoots.includes(key) || insideIsland(key));
    // an instruction of the USER on this element (user-style-rules.json) or a structural DS rule: authorized, named, and listed — never hidden
    const oe = obsByKey.get(key);
    const userAuth = !ex && !byComponent && property !== null && userConsequence(key, property);
    const eyebrowAuth = !ex && !byComponent && !userAuth && property !== null && ((oe?.structural === 'eyebrow' && EYEBROW_PROPERTIES.has(property)) || (oe?.structural === 'indicator' && INDICATOR_PROPERTIES.has(property)));
    add({
      sectionId: sb.sectionId, viewport: sb.viewport, elementKey: key, elementLabel: e.label || e.tag, category, state, property, baseline: b, observed: o,
      classification: ex || byComponent || userAuth || eyebrowAuth ? 'intentional' : 'regression', findingIds: findingsForKey(key),
      exemptionTargetId: ex?.targetId ?? (byComponent ? 'ds-first:component' : userAuth ? 'user-style-rule' : eyebrowAuth ? `structural:${oe?.structural}` : null),
      detail: ex ? `authorized change (${ex.reason})` : byComponent ? `design-system component owns this element (DS-first): ${detail}` : userAuth ? `user style rule (user-style-rules.json): ${detail}` : eyebrowAuth ? `structural DS rule (${oe?.structural}): ${detail}` : detail,
    });
  };

  /**
   * The differences of one ::before / ::after. A resolved target names an ELEMENT, never its pseudo-element, so none authorizes a pseudo-element's own value. What is accepted is what FOLLOWS from
   * an authorized change of its owner:
   *  - colour: where the pseudo paints with the owner's colour (currentcolor, inheriting it, or a shadow / gradient stop that embeds it) on BOTH sides, an authorized `color` change carries to it;
   *  - size (width / height / transform): a pseudo is sized from a BOX (`PseudoRef`: its containing block when absolutely positioned, the content box of its block container when in flow) and keeps the
   *    same size RELATIVE to that box (a fraction, or an inset), which is no difference at all, whatever moved the box. Otherwise only a change that can plausibly DRIVE it excuses it: an em-sized pseudo
   *    (the same number of em of the owner's font size on both sides) follows an authorized font-size / font / zoom change. A fixed-px pseudo whose size changed is a regression even when an authorized
   *    padding, margin or width change moved the owner's box. Where the box was not recorded (a baseline from before it was) a size change that could be box-relative is NOT judged: a required gap.
   * A pseudo-element that exists on one side only is a difference of `content` (none vs generated).
   * Returns true when a size change could not be judged for lack of box evidence (the caller's unit is then neither verified nor failed by it).
   */
  const pseudoDifferences = (e: CapturedElement, ownerKey: string, suffix: string, category: DifferenceCategory, state: StateName, bRec: StyleRecord | undefined, oRec: StyleRecord | undefined, f: PseudoOwner): boolean => {
    const props = bRec && oRec ? Object.keys(bRec) : ['content'];
    const what = state === 'default' ? '' : ` when ${state === 'hover' ? 'hovered' : 'keyboard-focused'}`;
    const unjudged: string[] = [];
    const label = (e.label || e.tag).slice(0, 40);
    const why = f.refB ? 'the box it is sized from could not be measured (it lies outside the section, or is an inline element)' : 'the baseline was captured before the box a pseudo-element is sized from was recorded';
    for (const prop of props) {
      if (bRec && oRec && pseudoValuesEqual(prop, bRec[prop], oRec[prop])) continue;
      const bv = bRec ? (bRec[prop] ?? null) : 'none', ov = oRec ? (oRec[prop] ?? null) : 'none';
      const at = { sectionId: sb.sectionId, viewport: sb.viewport, elementKey: ownerKey + suffix, elementLabel: `${e.label || e.tag} ${suffix}`, category, state, property: prop, baseline: bv, observed: ov, findingIds: findingsForKey(ownerKey) };
      let follows: { targetId: string; because: string } | null = null;
      if (bRec && oRec) {
        const colourFollows = !!f.colorEx && !!f.ownerB && !!f.ownerO && ((COLOR.test(prop) && valuesEqual(prop, bRec[prop], f.ownerB['color']) && valuesEqual(prop, oRec[prop], f.ownerO['color'])) || (EMBEDS_COLOUR.has(prop) && embedsColour(bRec[prop], oRec[prop], f.ownerB['color'], f.ownerO['color'])));
        if (colourFollows) follows = { targetId: f.colorEx!.targetId, because: `authorized change (${f.colorEx!.reason}) followed by its ${suffix}` };
        else if (PSEUDO_SIZED.has(prop)) {
          if (tracksReferenceBox(prop, bRec[prop], oRec[prop], f.refB?.box, f.refO?.box)) continue; // sized from its box: the same size relative to that box is no difference
          const cause = followsFontSize(prop, bRec[prop], oRec[prop], f.ownerB, f.ownerO) ? f.fontCause() : null;
          if (cause?.attributable && cause.targetId) follows = { targetId: cause.targetId, because: `authorized change (${cause.reason}) scaled the em its ${suffix} is sized in: ${cause.sentence}` };
          else if ((prop !== 'transform' || translationOnly(bRec[prop], oRec[prop])) && (!f.refB?.box || !f.refO?.box)) {
            // it may be sized from a box that this evidence cannot show: neither a regression nor a pass
            unjudged.push(prop);
            add({ ...at, classification: 'not-checkable', exemptionTargetId: null, detail: `the ${suffix} of "${label}" has ${prop} ${ov} in the output${what}, ${bv} on the original, and ${why}, so the change cannot be judged` });
            continue;
          }
        }
      }
      add({
        ...at, classification: follows ? 'intentional' : 'regression', exemptionTargetId: follows ? follows.targetId : null,
        detail: follows ? follows.because : bRec && oRec ? `the ${suffix} of "${label}" has ${prop} ${ov} in the output${what}, ${bv} on the original` : `the ${suffix} of "${label}" ${oRec ? 'exists' : 'does not exist'} in the output${what} and ${oRec ? 'does not exist' : 'exists'} on the original`,
      });
    }
    if (unjudged.length === 0) return false;
    ledger.unverified({ family: state === 'hover' || state === 'focus-visible' ? state : 'element', sectionId: sb.sectionId, viewport: sb.viewport, elementKey: ownerKey, label: `${label} ${suffix}`, state, reason: 'pseudo-size-box-unavailable', findingIds: findingsForKey(ownerKey), detail: `${sb.sectionId} (${sb.viewport}): the ${unjudged.join(' / ')} of the ${suffix} of "${label}"${what} changed, and ${why}, so whether it still follows the box it is sized from is not claimed (only recapturing the baseline, by deliberately removing design-baseline.json, can clear it)` });
    return true;
  };
  const pseudoOwner = (ownerKey: string, ownerB: StyleRecord | undefined, ownerO: StyleRecord | undefined, state: StateName, colorEx: Exemption | null, refB: PseudoRef | undefined, refO: PseudoRef | undefined): PseudoOwner =>
    ({ ownerB, ownerO, refB, refO, colorEx, fontCause: () => boxCause(sb, ownerKey, exemptions, sb.viewport, [], state, FONT_DRIVEN) });

  // ── sampling disclosure (numbers, never hidden) and by-design gaps recorded by the original's capture
  ledger.sampling.elementsDropped += sb.capped?.dropped ?? 0;
  ledger.sampling.groupsDropped += sb.groupsDropped ?? 0;
  ledger.sampling.stickyInert += sb.stickyInert ?? 0;
  ledger.sampling.animationsFrozen += sb.animationsFrozen ?? 0;
  ledger.sampling.walkCut += sb.walkCut ?? 0;
  if (desktop) {
    ledger.sampling.hoverEligible += sb.eligible?.hover ?? sb.coverage.hover.attempted;
    ledger.sampling.hoverSampled += sb.coverage.hover.attempted;
    ledger.sampling.focusEligible += sb.eligible?.focusVisible ?? sb.coverage.focusVisible.attempted;
    ledger.sampling.focusSampled += sb.coverage.focusVisible.attempted;
  }
  // The walk never cuts a finding element, so a cut only matters where it hid something ANOTHER required check needs (a control, a possible group, a sticky element). A baseline from before
  // that was counted cannot say what was hidden: required as well.
  if ((sb.walkCut ?? 0) > 0) {
    const h = sb.walkHidden;
    if (!h || h.controls + h.groups + h.sticky > 0) ledger.unverified({ family: 'section', sectionId: sb.sectionId, viewport: sb.viewport, elementKey: null, label: sb.sectionId, state: 'default', reason: 'walk-cut', findingIds: [], detail: `${sb.sectionId} (${sb.viewport}): ${sb.walkCut} node(s) beyond the walk limit were not entered${h ? `, hiding ${h.controls} control(s), ${h.groups} possible group(s) and ${h.sticky} sticky element(s)` : ' (the baseline does not say what they hid)'}, so what lies below them is not claimed as preserved` });
  }
  if (sb.stickyDropped) {
    ledger.sampling.stickyDropped += sb.stickyDropped;
    ledger.unverified({ family: 'sticky', sectionId: sb.sectionId, viewport: sb.viewport, elementKey: null, label: sb.sectionId, state: 'default', reason: 'sticky-candidate-cap', findingIds: [], detail: `${sb.sectionId} (${sb.viewport}): ${sb.stickyDropped} sticky element(s) beyond the trace cap were not traced, so their pin/release is not claimed as preserved` });
  }
  // a baseline written before the capture recorded per-element attempts only has counters: which element failed is unknown, so it stays one required gap
  if (desktop && !sb.elements.some((e) => e.stateAttempt)) {
    for (const [state, c] of [['hover', sb.coverage.hover], ['focus-visible', sb.coverage.focusVisible]] as const) {
      if (c.attempted > c.captured) ledger.unverified({ family: state, sectionId: sb.sectionId, viewport: sb.viewport, elementKey: null, label: sb.sectionId, state, reason: 'baseline-legacy-counters', findingIds: [], detail: `${sb.sectionId} (desktop): ${c.attempted - c.captured} of ${c.attempted} ${state} capture(s) on the original did not complete and the baseline does not say which elements, so they are not claimed as preserved` });
      // without per-element attempts nor an `eligible` count the cap is invisible: reaching it means an unknown number of elements were never tried
      const cap = state === 'hover' ? limits.maxHoverTargets : limits.maxFocusTargets;
      if (!sb.eligible && c.attempted > 0 && c.attempted >= cap) ledger.unverified({ family: state, sectionId: sb.sectionId, viewport: sb.viewport, elementKey: null, label: sb.sectionId, state, reason: 'baseline-legacy-sampling', findingIds: [], detail: `${sb.sectionId} (desktop): the original's ${state} capture reached its sampling cap (${c.attempted} of at most ${cap}) and the baseline does not say how many elements were eligible, so the elements beyond it are not claimed as preserved` });
    }
  }

  const keep = evidenceKeys(sb);
  /** Where the same finding / the identical text turned up in the output, at a position the original has no element of its own at. */
  const relocatedTo = (eb: CapturedElement): string | null => {
    const free = (x: CapturedElement) => !baseByKey.has(x.key);
    if (eb.findingIds.length) { const o = so.elements.find((x) => free(x) && x.findingIds.some((f) => eb.findingIds.includes(f))); if (o) return o.key; }
    if (eb.label) { const o = so.elements.find((x) => free(x) && x.tag === eb.tag && x.textHash === eb.textHash); if (o) return o.key; }
    return null;
  };

  for (const eb of sb.elements) {
    const required = eb.roles.some((r) => REQUIRED_ROLES.has(r));
    const label = (eb.label || eb.tag).slice(0, 40);
    const skip = (reason: UnverifiedReason, detail: string): void => {
      const g = { family: 'element' as const, sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, label, state: 'default' as StateName, reason, findingIds: findingsForKey(eb.key), detail };
      if (required) ledger.unverified(g); else ledger.disclose(g);
    };
    const ev: ElementEvidence | null = keep.has(eb.key)
      ? { sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, tag: eb.tag, label: eb.label, findingIds: eb.findingIds, outcome: 'compared', states: { default: 'compared', hover: desktop ? 'not-captured-on-original' : 'not-applicable', 'focus-visible': desktop ? 'not-captured-on-original' : 'not-applicable' }, ...(eb.box ? { box: boxEvidence(eb.box, obsByKey.get(eb.key)?.box)! } : {}), ...(obsByKey.has(eb.key) ? { observedFindingIds: obsByKey.get(eb.key)!.findingIds } : {}) }
      : null;
    if (ev) ledger.elements.push(ev);
    const setOutcome = (outcome: ElementEvidence['outcome'], relocated?: string | null): void => { if (ev) { ev.outcome = outcome; ev.states = { default: 'not-captured-in-output', hover: ev.states.hover, 'focus-visible': ev.states['focus-visible'] }; if (relocated) ev.relocatedTo = relocated; } };
    if (insideIsland(eb.key)) {
      // the internals of a mounted design-system component are the component's own design
      ledger.sampling.islandInternal++;
      ledger.disclose({ family: 'element', sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, label, state: 'default', reason: 'inside-component', findingIds: findingsForKey(eb.key), detail: `${sb.sectionId} (${sb.viewport}): "${label}" is inside a mounted design-system component, which owns its own design` });
      setOutcome('inside-component');
      continue;
    }
    /** The element is not (or no longer) at its position: a regression for what the audit named, a control or its text; disclosed structure otherwise. */
    const absent = (outcome: 'moved' | 'removed', moved: string | null, why: string): void => {
      if (eb.roles.some((r) => r === 'finding' || r === 'interactive' || r === 'text')) {
        add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, elementLabel: eb.label || eb.tag, category: 'element-unmatched', state: 'default', property: null, baseline: `<${eb.tag}> "${eb.label}"`, observed: null, classification: 'regression', findingIds: findingsForKey(eb.key), exemptionTargetId: null, detail: `the element <${eb.tag}> "${eb.label.slice(0, 40)}" exists on the original but not at the same position in the output${why}` });
        ledger.failed('element');
      } else {
        skip('missing-in-output-structural', `${sb.sectionId} (${sb.viewport}): "${label}" has no counterpart at the same position in the output, so it was not compared`);
      }
      setOutcome(outcome, moved);
    };
    const eo = obsByKey.get(eb.key);
    if (!eo) {
      if (observedCapped) {
        add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, elementLabel: eb.label || eb.tag, category: 'element-unmatched', state: 'default', property: null, baseline: eb.tag, observed: null, classification: 'not-checkable', findingIds: findingsForKey(eb.key), exemptionTargetId: null, detail: 'the output section exceeded the element cap, so this element was not captured' });
        skip('output-element-cap', `${sb.sectionId} (${sb.viewport}): "${label}" could not be compared because the output section exceeded the element cap`);
        setOutcome('capped-output');
        continue;
      }
      const moved = relocatedTo(eb);
      absent(moved ? 'moved' : 'removed', moved, '');
      continue;
    }
    // Identity: the element the audit named is the same element only while the output element at its position still carries its finding id. A sibling that
    // slid into the key of a removed element is not it (whatever its tag and text) and neither is an element that merely looks alike.
    if (eb.findingIds.length && !observedCapped && !eb.findingIds.some((f) => eo.findingIds.includes(f))) {
      const elsewhere = so.elements.find((x) => x !== eo && x.findingIds.some((f) => eb.findingIds.includes(f)));
      if (elsewhere) { absent('moved', elsewhere.key, ` (it carries finding ${eb.findingIds.join(', ')} at ${elsewhere.key})`); continue; }
      if (eo.tag !== eb.tag || eo.textHash !== eb.textHash) { absent('removed', null, ` (no element of the output carries finding ${eb.findingIds.join(', ')}; the element at this position is <${eo.tag}> "${eo.label.slice(0, 30)}")`); continue; }
      // identical tag and text but the finding id is nowhere: compared as before, and the evidence records that its identity is unconfirmed (preserve decisions stay unverified)
    }
    // A LABEL / descendant part of a finding whose position now holds a different text: when the finding element is still in the output and NOTHING under it has the part's text, the part is
    // gone (its successor merely slid into its key) — a confirmed removal. If the text turns up elsewhere under the finding it only moved, and a part whose finding element is itself
    // missing cannot be judged here: both stay unverified (below).
    if (!eb.findingIds.length && eb.label && eo.textHash !== eb.textHash && !eo.island && !observedCapped) {
      const owners = findingsForKey(eb.key);
      const holders = so.elements.filter((x) => x.findingIds.some((f) => owners.includes(f)));
      if (holders.length && !holders.some((h) => so.elements.some((x) => isUnder(x.key, h.key) && x.textHash === eb.textHash))) {
        absent('removed', null, ` (the finding element is still in the output, but nothing under it has this text; <${eo.tag}> "${eo.label.slice(0, 30)}" now sits at this position)`);
        continue;
      }
    }
    if (eo.tag !== eb.tag && !eo.island) {
      add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, elementLabel: eb.label || eb.tag, category: 'element-unmatched', state: 'default', property: null, baseline: eb.tag, observed: eo.tag, classification: 'not-checkable', findingIds: findingsForKey(eb.key), exemptionTargetId: null, detail: `the element at this position is <${eo.tag}> in the output and <${eb.tag}> on the original, so it is not compared (the content check reports the change)` });
      skip('tag-mismatch', `${sb.sectionId} (${sb.viewport}): "${label}" is <${eo.tag}> in the output and <${eb.tag}> on the original, so it was not compared`);
      setOutcome('tag-changed');
      continue;
    }
    if (eo.textHash !== eb.textHash && !eo.island) {
      // different text = a content difference, reported by the content checks — but a comparison that did not run is never a pass
      skip('text-mismatch', `${sb.sectionId} (${sb.viewport}): the text of "${label}" differs from the original, so its design was not compared`);
      setOutcome('text-changed');
      continue;
    }
    stat.elementsCompared++;

    // ── default appearance
    stat.default++;
    const fromDefault = ctx.differences.length;
    for (const prop of Object.keys(eb.style)) {
      if (!valuesEqual(prop, eb.style[prop], eo.style[prop])) record(eb, eb.key, 'default-style', 'default', prop, eb.style[prop] ?? null, eo.style[prop] ?? null, `${prop} is ${eo.style[prop] ?? '(missing)'} in the output, ${eb.style[prop]} on the original (default state)`);
    }
    for (const flag of new Set([...Object.keys(eb.flags), ...Object.keys(eo.flags)]) as Set<keyof CapturedElement['flags']>) {
      if (String(eb.flags[flag]) !== String(eo.flags[flag])) record(eb, eb.key, 'default-style', 'default', `flag:${flag}`, String(eb.flags[flag] ?? null), String(eo.flags[flag] ?? null), `the ${flag} state differs from the original`, false);
    }
    if (eb.hAlign !== 'none' && eo.hAlign !== 'none' && eb.hAlign !== eo.hAlign && !eo.island) {
      const ex = ['text-align', 'justify-content', 'align-items', 'width', 'display'].map((p) => exemptionFor(eb.key, p, 'default')).find(Boolean) ?? null;
      add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, elementLabel: eb.label || eb.tag, category: 'alignment', state: 'default', property: 'horizontal-alignment', baseline: eb.hAlign, observed: eo.hAlign, classification: ex ? 'intentional' : 'regression', findingIds: findingsForKey(eb.key), exemptionTargetId: ex?.targetId ?? null, detail: ex ? `authorized change (${ex.reason})` : `"${eb.label.slice(0, 40)}" is ${eo.hAlign}-aligned in its container in the output and ${eb.hAlign}-aligned on the original (${sb.viewport} viewport)` });
    }
    // 'full' = the text spans the container's whole content width (a different typeface can wrap it that way): alignment cannot be read from
    // the box, so it is never compared against left/center/right here — a real text-align change is caught by the computed `text-align` above
    if (eb.tAlign !== 'none' && eo.tAlign !== 'none' && eb.tAlign !== 'full' && eo.tAlign !== 'full' && eb.tAlign !== eo.tAlign && !eo.island) {
      const ex = ['text-align', 'justify-content', 'align-items', 'display', 'padding'].map((p) => exemptionFor(eb.key, p, 'default')).find(Boolean) ?? null;
      add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, elementLabel: eb.label || eb.tag, category: 'alignment', state: 'default', property: 'text-alignment', baseline: eb.tAlign, observed: eo.tAlign, classification: ex ? 'intentional' : 'regression', findingIds: findingsForKey(eb.key), exemptionTargetId: ex?.targetId ?? null, detail: ex ? `authorized change (${ex.reason})` : `the text of "${eb.label.slice(0, 40)}" renders ${eo.tAlign}-aligned in the output and ${eb.tAlign}-aligned on the original (${sb.viewport} viewport)` });
    }
    if (!eo.island && eb.widthRatio > 0 && eo.widthRatio > 0 && Math.abs(eb.widthRatio - eo.widthRatio) > 0.04) {
      const ex = ['width', 'max-width', 'min-width', 'flex-basis', 'padding'].map((p) => exemptionFor(eb.key, p, 'default')).find(Boolean) ?? null;
      // an eyebrow label that took the DS SectionLabel style (larger type, wide tracking) is wider: its share of the row follows from the rule (structural.ts)
      const eyebrow = !ex && (eo.structural === 'eyebrow' || eo.structural === 'indicator');
      add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, elementLabel: eb.label || eb.tag, category: 'composition', state: 'default', property: 'width-ratio', baseline: String(eb.widthRatio), observed: String(eo.widthRatio), classification: ex || eyebrow ? 'intentional' : 'regression', findingIds: findingsForKey(eb.key), exemptionTargetId: ex?.targetId ?? (eyebrow ? `structural:${eo.structural}` : null), detail: ex ? `authorized change (${ex.reason})` : eyebrow ? `structural DS rule (${eo.structural}): occupies ${(eo.widthRatio * 100).toFixed(0)}% of the section width in the output and ${(eb.widthRatio * 100).toFixed(0)}% on the original (${sb.viewport} viewport)` : `occupies ${(eo.widthRatio * 100).toFixed(0)}% of the section width in the output and ${(eb.widthRatio * 100).toFixed(0)}% on the original (${sb.viewport} viewport)` });
    }
    // ::before / ::after in the default state (a mounted component owns its own pseudo-elements, like the rest of its internals)
    let pseudoGap = false;
    if (sb.pseudoCaptured && so.pseudoCaptured && !eo.island) {
      for (const w of ['before', 'after'] as const) {
        if (eb.pseudo?.[w] || eo.pseudo?.[w]) pseudoGap = pseudoDifferences(eb, eb.key, `::${w}`, 'default-style', 'default', eb.pseudo?.[w], eo.pseudo?.[w], pseudoOwner(eb.key, eb.style, eo.style, 'default', exemptionFor(eb.key, 'color', 'default'), eb.pseudoRef?.[w], eo.pseudoRef?.[w])) || pseudoGap;
      }
    }
    if (regressedSince(ctx, fromDefault)) ledger.failed('element'); else if (!pseudoGap) ledger.verified('element');

    // ── hover / focus-visible (desktop: touch devices have no hover, see statesNotCaptured)
    if (!desktop) continue;
    for (const state of ['hover', 'focus-visible'] as const) {
      const sbs = eb.states[state];
      const sos = eo.states[state];
      const gap = (reason: UnverifiedReason, detail: string, requiredHere = true): void => {
        const g = { family: state, sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, label, state: state as StateName, reason, findingIds: findingsForKey(eb.key), detail };
        if (requiredHere) ledger.unverified(g); else ledger.disclose(g);
      };
      if (!sbs) {
        // never captured on the ORIGINAL itself: required only where a finding is attributed to the element; otherwise it is sampling, disclosed with numbers
        const attempt = eb.stateAttempt?.[state];
        if (attempt && attempt !== 'captured') {
          const findingHere = findingsForKey(eb.key).length > 0;
          const why = attempt === 'unsettled' ? 'kept changing (a running animation)' : attempt === 'not-hoverable' ? 'could not be applied (the element cannot be hovered or focused)' : attempt === 'interrupted' ? 'failed twice for a reason that is not a property of the page, so it is a transient: only recapturing the baseline (deliberately removing design-baseline.json) can clear it' : attempt === 'budget-stopped' ? 'was not reached before the verification budget ran out' : 'was beyond the sampling cap';
          gap(STATE_REASON[attempt]!, `${sb.sectionId} (desktop): ${state} on "${label}" ${why} on the original, so it is not claimed as preserved`, findingHere);
          if (ev) ev.states[state] = attempt === 'unsettled' ? 'unsettled-on-original' : 'not-captured-on-original';
        } else if (!attempt && eb.findingIds.length > 0) {
          // an element a finding NAMES that the original's capture never even tried (a baseline from before every finding element was hover-eligible): never a silent pass
          if (state === 'hover' || (eb.focusable && !eb.flags.disabled)) gap('state-not-attempted', `${sb.sectionId} (desktop): ${state} was never attempted on "${label}", an element a finding names, so it is not claimed as preserved`);
          // a baseline from before the focus trial has no `focusable` flag at all: the output taking focus where the original's tag-list capture never tried is a lost :focus-visible that would pass silently
          else if (state === 'focus-visible' && !sb.focusTrial && eo.focusable && !eo.flags.disabled) gap('baseline-legacy-focus', `${sb.sectionId} (desktop): keyboard focus was never tried on "${label}", an element a finding names that takes focus in the output, by a baseline captured before the focus trial, so its original focus design is not claimed as preserved (only recapturing the baseline, by deliberately removing design-baseline.json, can clear it)`);
        }
        continue;
      }
      if (!sos) {
        // a state captured on the original but not on the output is never claimed as preserved (even one with no visible effect: a gained effect cannot be ruled out)
        const budget = eo.stateAttempt?.[state] === 'budget-stopped';
        const cause = budget ? 'was not reached before the verification budget ran out' : 'could not be captured on the output (not hoverable/focusable there)';
        if (sbs.effect) add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, elementLabel: eb.label || eb.tag, category: 'state-unavailable', state, property: null, baseline: 'captured', observed: 'not captured', classification: 'not-checkable', findingIds: findingsForKey(eb.key), exemptionTargetId: null, detail: `${state} on "${label}" ${cause}, so it is not claimed as preserved` });
        gap(budget ? 'state-budget-stopped' : 'state-uncaptured-on-output', `${sb.sectionId} (desktop): ${state} on "${label}" ${cause}, so it is not claimed as preserved`);
        if (ev) ev.states[state] = 'not-captured-in-output';
        continue;
      }
      if (state === 'focus-visible' && sbs.focusVisibleMatched !== sos.focusVisibleMatched) {
        add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: eb.key, elementLabel: eb.label || eb.tag, category: 'focus-visible', state, property: ':focus-visible', baseline: String(!!sbs.focusVisibleMatched), observed: String(!!sos.focusVisibleMatched), classification: 'not-checkable', findingIds: findingsForKey(eb.key), exemptionTargetId: null, detail: 'keyboard focus did not match :focus-visible the same way on both sides, so the styles are not comparable' });
        gap('focus-visible-mismatch', `${sb.sectionId} (desktop): keyboard focus on "${label}" matched :focus-visible differently on the two sides, so its focus styles were not compared`);
        if (ev) ev.states[state] = 'focus-visible-mismatch';
        continue;
      }
      if (state === 'hover') stat.hover++; else stat.focus++;
      const fromState = ctx.differences.length;
      let stateGap = false;
      // members of the original's state subtree that the output's capture lacks (and the reverse) are NEVER skipped silently: each is a required gap
      const missing: string[] = [];
      const absOf = (rel: string): string => { const p = splitPseudo(rel); return joinKey(eb.key, p.owner) + p.suffix; };
      for (const [rel, bStyle] of Object.entries(sbs.subtree)) {
        const pseudo = splitPseudo(rel);
        if (pseudo.suffix) {
          // a ::before / ::after of the hovered element or of one of its members. The preview captures the keys the original listed whether or not it generates them, so a missing record
          // is a pseudo-element that is not generated here; an owner the output did not capture is already a gap of its own below.
          const ownerAbs = joinKey(eb.key, pseudo.owner);
          if (!(pseudo.owner in sos.subtree) || insideIsland(ownerAbs) || (pseudo.owner === '' && eo.island)) continue;
          const bOwnerDefault = pseudo.owner === '' ? eb.style : sb.elements.find((x) => x.key === ownerAbs)?.style, oOwnerDefault = pseudo.owner === '' ? eo.style : obsByKey.get(ownerAbs)?.style;
          const bOwner = sbs.subtree[pseudo.owner], oOwner = sos.subtree[pseudo.owner];
          const stateColourKept = !!bOwner && !!oOwner && !!bOwnerDefault && !!oOwnerDefault && valuesEqual('color', bOwner['color'], bOwnerDefault['color']) && valuesEqual('color', oOwner['color'], oOwnerDefault['color']);
          const colorEx = exemptionFor(ownerAbs, 'color', state) ?? (stateColourKept ? exemptionFor(ownerAbs, 'color', 'default') : null);
          if (pseudoDifferences(sb.elements.find((x) => x.key === ownerAbs) ?? eb, ownerAbs, pseudo.suffix, state, state, bStyle, sos.subtree[rel], pseudoOwner(ownerAbs, bOwner, oOwner, state, colorEx, sbs.pseudoRef?.[rel], sos.pseudoRef?.[rel]))) stateGap = true;
          continue;
        }
        const oStyle = sos.subtree[rel];
        const absKey = joinKey(eb.key, rel);
        if (!oStyle || insideIsland(absKey)) { // the evidence says it was not compared; a mounted component's own internals are disclosed elsewhere, anything else is a gap below
          if (ev) (ev.stateSkipped ??= {})[state] = [...(ev.stateSkipped?.[state] ?? []), rel];
          if (!oStyle && !insideIsland(absKey)) missing.push(rel);
          continue;
        }
        const bDefault = rel === '' ? eb.style : sb.elements.find((x) => x.key === absKey)?.style;
        const oDefault = rel === '' ? eo.style : obsByKey.get(absKey)?.style;
        for (const prop of Object.keys(bStyle)) {
          if (valuesEqual(prop, bStyle[prop], oStyle[prop])) continue;
          const target = rel === '' ? eb : (sb.elements.find((x) => x.key === absKey) ?? eb);
          // An authorized DEFAULT-state change carries into a state only where the original state does not itself alter that property
          // (a radius fix follows the element into :hover; the original's black→white hover fill does NOT inherit a default-fill change).
          const carriesThrough = !!bDefault && !!oDefault && !!exemptionFor(absKey, prop, 'default') && valuesEqual(prop, bStyle[prop], bDefault[prop]) && valuesEqual(prop, oStyle[prop], oDefault[prop]);
          if (carriesThrough) {
            const ex = exemptionFor(absKey, prop, 'default')!;
            add({ sectionId: sb.sectionId, viewport: sb.viewport, elementKey: absKey, elementLabel: target.label || target.tag, category: state, state, property: prop, baseline: bStyle[prop] ?? null, observed: oStyle[prop] ?? null, classification: 'intentional', findingIds: findingsForKey(absKey), exemptionTargetId: ex.targetId, detail: `authorized change (${ex.reason}) carried into ${state}: the original ${state} does not alter ${prop}` });
            continue;
          }
          record(target, absKey, state, state, prop, bStyle[prop] ?? null, oStyle[prop] ?? null, `${prop} is ${oStyle[prop] ?? '(missing)'} in the output when ${state === 'hover' ? 'hovered' : 'keyboard-focused'}, ${bStyle[prop]} on the original`);
        }
      }
      const gained = Object.keys(sos.subtree).filter((rel) => !(rel in sbs.subtree) && !insideIsland(absOf(rel)));
      /** Does this member of the OUTPUT's state subtree show a design of its own that its resting self does not (not merely what it inherits from the hovered / focused element)? */
      const addsReveal = (rel: string): boolean => {
        const hov = sos.subtree[rel]!;
        const p = splitPseudo(rel);
        const restOf = (r: string): CapturedElement | undefined => (r === '' ? eo : obsByKey.get(joinKey(eb.key, r)));
        if (p.suffix) {
          // a pseudo-element: generated only in this state is a reveal; generated at rest too, a reveal only where its values moved (apart from following the owner's colour)
          const rest = restOf(p.owner)?.pseudo?.[p.suffix.slice(2) as 'before' | 'after'];
          if (!rest) return true;
          const ownerHov = sos.subtree[p.owner], ownerRest = restOf(p.owner)?.style;
          const followsOwner = (k: string): boolean => !!ownerHov && !!ownerRest && ((COLOR.test(k) && valuesEqual(k, hov[k], ownerHov['color']) && valuesEqual(k, rest[k], ownerRest['color'])) || (EMBEDS_COLOUR.has(k) && embedsColour(rest[k], hov[k], ownerRest['color'], ownerHov['color'])));
          return Object.keys(hov).some((k) => !pseudoValuesEqual(k, rest[k], hov[k]) && !followsOwner(k));
        }
        const rest = restOf(rel)?.style;
        if (!rest) return bearsDesign(hov); // never captured at rest: it shows something only now, a design or just text it inherits
        let up = rel;
        do { up = up.includes('/') ? up.slice(0, up.lastIndexOf('/')) : ''; } while (up !== '' && !(up in sos.subtree));
        const parentHov = sos.subtree[up], parentRest = restOf(up)?.style;
        // (what changes with the hover is only what the member INHERITS from the hovered ancestor, or paints with its own colour: currentcolor borders / outlines / decoration / shadows)
        const inherits = (k: string): boolean => INHERITED.has(k) && !!parentHov && valuesEqual(k, hov[k], parentHov[k]) && (!parentRest || valuesEqual(k, rest[k], parentRest[k]));
        const paintsWithColour = (k: string): boolean => (CURRENT_COLOR.has(k) && valuesEqual(k, hov[k], hov['color']) && valuesEqual(k, rest[k], rest['color'])) || (EMBEDS_COLOUR.has(k) && embedsColour(rest[k], hov[k], rest['color'], hov['color']));
        return Object.keys(hov).some((k) => !valuesEqual(k, hov[k], rest[k]) && !inherits(k) && !paintsWithColour(k));
      };
      const cutBy = (sbs.truncated ?? 0) + (sos.truncated ?? 0);
      if (sbs.truncated) {
        ledger.sampling.hoverSubtreeDropped += sbs.truncated;
        gap('state-subtree-capped', `${sb.sectionId} (desktop): the hovered subtree of "${label}" has ${sbs.truncated} more design- or text-bearing descendant(s) than the ${limits.maxDescendants} the capture records, so those were not compared`, false);
      }
      if (missing.length) gap('state-subtree-member-missing-in-output', `${sb.sectionId} (desktop): ${missing.length} descendant(s) of "${label}" that carry a design or text in the original's ${state} (${missing.slice(0, 3).join(', ')}) are absent from the output's ${state} capture, so a ${state} reveal could be lost: not claimed as preserved`);
      // a member the original does not list can only be judged where both lists are complete: a cut list proves nothing about what lies beyond it
      const gainedHere = cutBy > 0 ? [] : gained.filter((rel) => !authorizedAt(absOf(rel), state));
      // A member the output has and the original does not hides no LOST reveal (the missing direction does), and a wrapper inserted around the same text looks exactly like this: DISCLOSED. But a member whose
      // design differs between its rest and this state is a reveal the output ADDED, which no target authorizes: REQUIRED.
      const reveals = gainedHere.filter((rel) => addsReveal(rel));
      const wrappers = gainedHere.filter((rel) => !reveals.includes(rel));
      if (reveals.length) gap('state-reveal-gained-in-output', `${sb.sectionId} (desktop): ${reveals.length} descendant(s) of "${label}" (${reveals.slice(0, 3).join(', ')}) show a design in the output's ${state} that differs from their own resting design (or exist only while ${state === 'hover' ? 'hovered' : 'focused'}), the original's ${state} shows none and no authorized target names them: a ${state} effect the output adds`);
      if (wrappers.length) gap('state-subtree-member-gained-in-output', `${sb.sectionId} (desktop): ${wrappers.length} descendant(s) of "${label}" (${wrappers.slice(0, 3).join(', ')}) carry a design or text in the output's ${state} that the original's ${state} does not show, but look the same at rest and on ${state} (disclosed; an inserted wrapper looks the same)`, false);
      if (regressedSince(ctx, fromState)) ledger.failed(state); else if (!missing.length && !reveals.length && !stateGap) ledger.verified(state);
      if (ev) ev.states[state] = 'compared' as StateEvidence;
    }
  }

  compareGroups(sb, so, record, (key) => sb.elements.find((e) => e.key === key), insideIsland, ctx);
  compareSticky(sb, so, findingsForKey, ctx);
}

type Recorder = (e: CapturedElement, key: string, category: DifferenceCategory, state: StateName, property: string | null, b: string | null, o: string | null, detail: string, canExempt?: boolean) => void;

function compareGroups(sb: SectionDesign, so: SectionDesign, record: Recorder, elementOf: (key: string) => CapturedElement | undefined, insideIsland: (key: string) => boolean, ctx: Ctx): void {
  for (const gb of sb.groups) {
    const where = `${sb.sectionId} (${sb.viewport}): the group at "${gb.parentKey || 'root'}"`;
    const gap = { family: 'composition' as const, sectionId: sb.sectionId, viewport: sb.viewport, elementKey: gb.parentKey, label: `group at ${gb.parentKey || 'root'}`, state: 'default' as StateName, findingIds: [] as string[] };
    if (insideIsland(gb.parentKey)) { ctx.ledger.disclose({ ...gap, reason: 'inside-component', detail: `${where} is inside a mounted design-system component, which owns its own design` }); continue; }
    const go = so.groups.find((g) => g.parentKey === gb.parentKey);
    const parent = elementOf(gb.parentKey) ?? sb.elements[0]!;
    if (!go) { ctx.ledger.unverified({ ...gap, reason: 'group-not-detected-in-output', detail: `${where} was not detected in the output, so its composition could not be compared` }); continue; }
    const from = ctx.differences.length;
    const diff = (property: string, b: string, o: string, detail: string) => record(parent, gb.parentKey, 'composition', 'default', property, b, o, detail);
    if (gb.columns !== go.columns) diff('columns', String(gb.columns), String(go.columns), `a group of ${gb.childKeys.length} item(s) is laid out in ${go.columns} column(s) in the output and ${gb.columns} on the original (${sb.viewport} viewport)`);
    if (gb.rows !== go.rows) diff('rows', String(gb.rows), String(go.rows), `the same group has ${go.rows} row(s) in the output and ${gb.rows} on the original (${sb.viewport} viewport)`);
    if (JSON.stringify(gb.visualOrder) !== JSON.stringify(go.visualOrder)) diff('reading-order', gb.visualOrder.join(','), go.visualOrder.join(','), `the visual order of the group's items changed (${sb.viewport} viewport)`);
    const n = Math.min(gb.topOffsets.length, go.topOffsets.length);
    for (let i = 0; i < n; i++) if (Math.abs((gb.topOffsets[i] ?? 0) - (go.topOffsets[i] ?? 0)) > 6) { diff('stagger', gb.topOffsets.join(','), go.topOffsets.join(','), `the vertical offsets of the group's first row changed (the original staggers its items: ${gb.topOffsets.join(', ')}px; the output: ${go.topOffsets.join(', ')}px)`); break; }
    const m = Math.min(gb.widthRatios.length, go.widthRatios.length);
    for (let i = 0; i < m; i++) if (Math.abs((gb.widthRatios[i] ?? 0) - (go.widthRatios[i] ?? 0)) > 0.05) { diff('item-widths', gb.widthRatios.join(','), go.widthRatios.join(','), `the widths of the group's items changed (${sb.viewport} viewport)`); break; }
    if (regressedSince(ctx, from)) ctx.ledger.failed('composition'); else ctx.ledger.verified('composition');
  }
}

function compareSticky(sb: SectionDesign, so: SectionDesign, findingsForKey: (k: string) => string[], ctx: Ctx): void {
  for (const tb of sb.sticky) {
    const to: StickyTrace | undefined = so.sticky.find((t) => t.key === tb.key);
    const base = { sectionId: sb.sectionId, viewport: sb.viewport as FidelityViewportName, elementKey: tb.key, elementLabel: `sticky element at ${tb.key || 'root'}`, state: 'default' as StateName, findingIds: findingsForKey(tb.key), exemptionTargetId: null };
    const gap = { family: 'sticky' as const, sectionId: sb.sectionId, viewport: sb.viewport, elementKey: tb.key, label: base.elementLabel, state: 'default' as StateName, findingIds: base.findingIds };
    if (!to) { ctx.add({ ...base, category: 'sticky', property: 'position:sticky', baseline: `sticky (top ${tb.top})`, observed: 'not sticky', classification: 'regression', detail: `an element that pins while the section scrolls on the original (position: sticky, top ${tb.top}) does not pin in the output` }); ctx.ledger.failed('sticky'); continue; }
    let compared = 0, unreachable = 0, differs = false;
    for (let i = 0; i < tb.positions.length; i++) {
      const pb = tb.positions[i]!, po = to.positions[i];
      if (!po || !pb.reachable || !po.reachable || pb.rectTop === null || po.rectTop === null) { unreachable++; continue; }
      compared++;
      if (Math.abs(pb.rectTop - po.rectTop) > 3) { ctx.add({ ...base, category: 'sticky', property: 'pin-trace', baseline: tb.positions.map((p) => p.rectTop).join(','), observed: to.positions.map((p) => p.rectTop).join(','), classification: 'regression', detail: `the pinned element sits ${po.rectTop}px from the viewport top in the output and ${pb.rectTop}px on the original at scroll offset ${pb.requestedScroll}px of the section's range (${sb.viewport} viewport): pin/release behaviour differs` }); differs = true; break; }
    }
    if (differs) { ctx.ledger.failed('sticky'); continue; }
    const where = `${sb.sectionId} (${sb.viewport}): the sticky element at ${tb.key || 'root'}`;
    const why = tb.padded === true ? '' : ' (the original baseline was captured without scroll padding, so its early and late positions can be out of reach)';
    if (compared === 0) ctx.ledger.unverified({ ...gap, reason: 'sticky-no-comparable-position', detail: `${where} could not be traced on both pages (the scroll range was not reachable), so pin/release is not claimed as preserved${why}` });
    else if (unreachable > 0) ctx.ledger.unverified({ ...gap, reason: 'sticky-partial', detail: `${where}: ${unreachable} of ${tb.positions.length} scroll position(s) of the sticky trace were not reachable on both pages and were not compared, so pin/release is not claimed as preserved${why}` });
    else ctx.ledger.verified('sticky');
  }
}

export type { GroupComposition };
