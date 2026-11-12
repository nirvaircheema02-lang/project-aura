/**
 * Semantic element kinds — what an element IS FOR, as opposed to what it is made of.
 *
 * A tag (`div`), an ARIA role (`link`, `generic`) and the audit's production type are EVIDENCE about an element; none of them is a component
 * category. A reference pattern says it fits a `card` or a `panel`; a card rendered as a `<div>` is still a card. This module is the ONE place that
 * turns the evidence into categories, so candidate selection (`findPatterns`, `hooks.find`) and verification (`verifyPattern`) ask the same
 * question with the same answer:
 *
 *   inferElementKinds(evidence)   pure, deterministic; no DOM, no I/O; never reads a judgment's text or a page label
 *   kindCompatibility(q, p)       the single predicate that decides whether query kinds fit a pattern's kinds
 *
 * It fails closed: no evidence names no kind, and conflicting evidence withholds the CONTAINER kinds (a non-container kind such as `link` or `input` is a
 * fact of its own and stays). A pattern is then neither offered nor accepted for a kind that is not established.
 *
 * Evidence is grouped by ORIGIN (audit, DS, native semantics, rendered structure, class names) and each origin contributes its strongest vote per
 * kind — two signals that come from the same audit rule are one piece of evidence, not two. A kind needs a score of ACCEPT_SCORE; a bare tag
 * (`<section>`, `<details>`, `<tr>`, ...) is one origin and never enough for a container kind; negative evidence (a control tag, a text-level tag, an
 * audit type that is not a container, a title inside a card, a wrapper, a section-wide box, a box too small to be a card, navigation/footer context)
 * vetoes a container kind. An element has ONE container kind: the strongest. Only booleans and enums reach the trail, so it does not flap with a pixel,
 * and nothing it reads depends on an animation's timing (opacity and transforms are never inputs).
 */

export const SEMANTIC_KINDS = ['card', 'panel', 'callout', 'section', 'row', 'strip', 'accordion', 'accordion-trigger', 'input', 'button', 'link', 'heading', 'text', 'stat', 'badge'] as const;
export type SemanticKind = (typeof SEMANTIC_KINDS)[number];

/** Bump when a rule or weight changes: it is recorded next to every classification. */
export const ELEMENT_KIND_RULES_VERSION = 'element-kind-v3';

/** Kinds that hold other content. Only these can be vetoed by negative evidence. */
const CONTAINER_KINDS: ReadonlySet<SemanticKind> = new Set<SemanticKind>(['card', 'panel', 'callout', 'section', 'row', 'strip', 'accordion']);

// ── the vocabulary: names that denote a category (never a bare tag or role) ───────────────────

const ALIASES: ReadonlyMap<string, SemanticKind> = new Map<string, SemanticKind>([
  ['card', 'card'], ['tile', 'card'], ['resource-card', 'card'], ['report-card', 'card'], ['stat-card', 'card'], ['product-card', 'card'], ['article-card', 'card'], ['blog-card', 'card'],
  ['panel', 'panel'],
  ['callout', 'callout'], ['alert', 'callout'], ['notice', 'callout'],
  ['section', 'section'],
  ['row', 'row'], ['list-row', 'row'],
  ['strip', 'strip'], ['rule-strip', 'strip'],
  ['accordion', 'accordion'], ['disclosure', 'accordion'], ['collapsible', 'accordion'], ['faq', 'accordion'], ['faq-row', 'accordion'],
  ['accordion-trigger', 'accordion-trigger'], ['disclosure-trigger', 'accordion-trigger'],
  ['input', 'input'], ['text-field', 'input'], ['text-input', 'input'], ['form-field', 'input'],
  ['button', 'button'], ['icon-button', 'button'], ['cta', 'button'],
  ['link', 'link'], ['nav-link', 'link'],
  ['heading', 'heading'], ['section-heading', 'heading'],
  ['text', 'text'], ['eyebrow', 'text'], ['paragraph', 'text'],
  ['stat', 'stat'],
  ['badge', 'badge'],
]);

/**
 * The category a name denotes, or null. Case, `_`/space/`-` and a plain plural are folded (`Cards`, `faq row`, `resource_card`). A raw tag or ARIA
 * role that names no category — `div`, `span`, `generic`, `a`, `li`, `h2`, `img`, `textbox` — is null by design: it is evidence, not a kind.
 */
export function canonicalKind(raw: string): SemanticKind | null {
  const name = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return ALIASES.get(name) ?? (name.endsWith('s') && !name.endsWith('ss') ? ALIASES.get(name.slice(0, -1)) : undefined) ?? null;
}

function canonicalKinds(raw: readonly string[]): SemanticKind[] {
  return [...new Set(raw.map(canonicalKind).filter((k): k is SemanticKind => k !== null))];
}

// ── evidence ──────────────────────────────────────────────────────────────────────────────────

/** Facts read from the rendered element (see `resolution/structure-probe.ts`). Measurements, not judgments. */
export interface StructureFacts {
  /** The LIVE tag, lower-case. */
  tag: string;
  /** The explicit `role` attribute, or null. */
  role: string | null;
  displayContents: boolean;
  /** Not display:none, not visibility:hidden and has a layout box. Opacity is NOT part of it: a fading-in element is the same element. */
  visible: boolean;
  /** The page's width class (a stacked mobile layout makes every box full width, so it cannot tell a band from a card). */
  viewport: 'desktop' | 'mobile';
  /** The LAYOUT box, measured without transforms. */
  width: number;
  height: number;
  /** The element's layout width relative to the page's. */
  widthRatio: number;
  bordered: boolean;
  /** Some shadow layer is actually painted (non-transparent, with an offset, blur or spread). */
  shadowed: boolean;
  /** Its background differs from the nearest ancestor that paints one. */
  tinted: boolean;
  /** Some gradient stop is actually painted (non-transparent). */
  gradient: boolean;
  /** Counts over the element's subtree (three levels deep): headings, text blocks, media, links/buttons, form controls. */
  headings: number;
  textBlocks: number;
  media: number;
  actions: number;
  controls: number;
  /** The element itself, or an ancestor, is a link/button, or it shows a pointer cursor. */
  interactive: boolean;
  selfAnchor: boolean;
  /** Siblings with the same tag and (nearly) the same classes. */
  similarSiblings: number;
  /** One child element that fills the same box: a layout wrapper if it paints nothing itself. */
  onlyChildSameBox: boolean;
  /** The nearest landmark the element sits in (itself included, across shadow roots): `<nav>` / role navigation, `<footer>` / role contentinfo, `<header>`. */
  landmark?: 'navigation' | 'footer' | 'header' | null;
  /** The element's (and its ancestors') finite animations had ended when this was read. False: the facts are those of a moment, and are not used. Absent: settled. */
  settled?: boolean;
}

export interface ElementEvidence {
  /** What the audit recorded. Never the production LABEL (page text) and never a judgment's reason. */
  audit: { productionType: string | null; dsComponent: string | null; signals: readonly string[]; possibleMatches: ReadonlyArray<{ dsComponent: string; score: number }> };
  /** The element mapping's affordances (the EXPLICIT role attribute only) and the DS reference C2 recorded. Null when the finding is not mapped. */
  mapping: { tagName: string; role: string | null; href: string | null; type: string | null; ariaExpanded: string | null; ariaControls: string | null; dsComponent: string | null; dsBasis: string } | null;
  /** Null when no page was probed. */
  structure: StructureFacts | null;
}

export interface KindVote {
  kind: SemanticKind;
  confidence: 'high' | 'medium';
  score: number;
  evidence: string[];
}

export interface KindConsidered {
  kind: SemanticKind;
  score: number;
  status: 'accepted' | 'below-threshold' | 'vetoed' | 'conflict';
  evidence: string[];
  vetoes: string[];
}

export interface KindInference {
  rulesVersion: string;
  /** The accepted kinds, strongest first. Empty = nothing could be established (fail closed). */
  kinds: KindVote[];
  considered: KindConsidered[];
  /** The raw evidence the kinds were read from — evidence only. */
  raw: { tag: string | null; role: string | null; productionType: string | null };
  /** The component this element is a part of (a card's title, an accordion's trigger), when the audit says so. */
  partOf: SemanticKind | null;
  /** Context a reviewer should see (`inside navigation`, a live tag that differs from the mapped one). */
  context: string[];
  /** The page width class the structure was read at (null: no page was probed). A resumed run on the same viewport reproduces the classification. */
  viewport: 'desktop' | 'mobile' | null;
  sources: Array<'audit' | 'mapping' | 'structure'>;
  summary: string;
}

// ── inference ─────────────────────────────────────────────────────────────────────────────────

const ACCEPT_SCORE = 3;
const HIGH_SCORE = 5;
// Size is only ever a veto, never a positive. Calibrated on the cndp, dealers-voice and deals-and-ipo audits: audit-typed cards are >= 30 784 px2 and
// >= 128 px on the short side; stats (the nearest non-cards) reach 11 136 px2 and are 40 px high, badges <= 7 776 px2, icon buttons <= 1 600 px2.
const MIN_AREA = 12000;
const MIN_SIDE = 64;
const SECTION_WIDE_RATIO = 0.98;
const SECTION_WIDE_HEIGHT = 320;
const REPEATED_SIBLINGS = 2;

type Group = 'audit' | 'ds' | 'native' | 'structure' | 'class';
const GROUPS: readonly Group[] = ['audit', 'ds', 'native', 'structure', 'class'];
/** `bareTag`: the vote comes from a tag name alone (not an explicit ARIA role or an attribute), so it is one weak origin. */
interface Vote { kind: SemanticKind; group: Group; weight: number; why: string; bareTag?: true }
interface Veto { why: string; hard: boolean; kinds: ReadonlySet<SemanticKind> }

const CONTROL_TAGS: ReadonlySet<string> = new Set(['button', 'input', 'select', 'textarea']);
const CONTROL_ROLES: ReadonlySet<string> = new Set(['button', 'textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'switch', 'slider']);
const LEAF_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'label', 'img', 'svg', 'path', 'i', 'b', 'strong', 'em', 'small']);
const LEAF_ROLES: ReadonlySet<string> = new Set(['heading', 'img']);
const NOT_A_FIELD: ReadonlySet<string> = new Set(['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'file', 'color', 'hidden']);
const BUTTON_TYPES: ReadonlySet<string> = new Set(['button', 'submit', 'reset', 'image']);
const NO_SEMANTICS: ReadonlySet<string> = new Set(['generic', 'none', 'presentation']);

const BOX_KINDS: ReadonlySet<SemanticKind> = new Set<SemanticKind>(['card', 'panel', 'callout']);
const WIDE_KINDS: ReadonlySet<SemanticKind> = new Set<SemanticKind>(['card', 'panel']);

/** A DS component name → the kind it implements. */
const DS_NAME_KIND: ReadonlyArray<readonly [RegExp, SemanticKind]> = [
  [/(?:Accordion|Disclosure)(?:Trigger|Header|Summary)$/, 'accordion-trigger'],
  [/Card$/, 'card'],
  [/(?:Input|TextField|Textarea|Select|Combobox)$/, 'input'],
  [/^(?:Accordion|Faq|Disclosure)/, 'accordion'],
  [/Panel$/, 'panel'],
  [/(?:Callout|Alert)$/, 'callout'],
  [/Button$/, 'button'],
  [/Badge$/, 'badge'],
  [/Heading$/, 'heading'],
];

/** Class tokens: the whole token, or the word after `-`/`_` (`stat-card`, `faq__accordion`). `card-title` and `cardinal` are not cards. */
const CLASS_KIND: ReadonlyArray<readonly [RegExp, SemanticKind]> = [
  [/(?:^|[-_])(?:card|tile)$/, 'card'],
  [/(?:^|[-_])panel$/, 'panel'],
  [/(?:^|[-_])(?:accordion|faq)$/, 'accordion'],
  [/(?:^|[-_])(?:callout|alert|notice)$/, 'callout'],
];

interface ParsedSignals {
  tag: string | null;
  role: string | null;
  classes: string[];
  largeClickableCard: boolean;
  smallIconButton: boolean;
  accordionTrigger: boolean;
  cardTitle: boolean;
  insideNavigation: boolean;
  insideFooter: boolean;
}

/** The audit's `review.signals` are free text with a few stable shapes. Unknown signals carry no weight. */
function parseSignals(signals: readonly string[]): ParsedSignals {
  const out: ParsedSignals = { tag: null, role: null, classes: [], largeClickableCard: false, smallIconButton: false, accordionTrigger: false, cardTitle: false, insideNavigation: false, insideFooter: false };
  for (const s of signals) {
    const text = s.trim();
    if (/^tag=/.test(text)) out.tag = text.slice(4).trim().toLowerCase();
    else if (/^role=/.test(text)) out.role = text.slice(5).trim().toLowerCase();
    else if (/^class=/.test(text)) out.classes.push(text.slice(6).trim().toLowerCase());
    else if (/^inside navigation$/i.test(text)) out.insideNavigation = true;
    else if (/^inside footer$/i.test(text)) out.insideFooter = true;
    else {
      if (/\bclickable\b.*(?:→|->)\s*card\b/i.test(text)) out.largeClickableCard = true;
      if (/\bclickable\b.*(?:→|->)\s*icon-button\b/i.test(text)) out.smallIconButton = true;
      if (/\baccordion trigger\b/i.test(text)) out.accordionTrigger = true;
      if (/\ba card (?:or link )?title\b/i.test(text)) out.cardTitle = true;
    }
  }
  return out;
}

const isHeading = (tag: string | null, role: string | null): boolean => (tag !== null && /^h[1-6]$/.test(tag)) || role === 'heading';

function structureVotes(s: StructureFacts): { votes: Vote[]; vetoes: Veto[] } {
  const votes: Vote[] = [];
  const vetoes: Veto[] = [];
  // an element with no box (display:none, visibility:hidden, zero-size) has nothing to read: structure gives it no say, for or against. That is not a
  // veto of typed (audit/DS) evidence — the audit measured it and a hidden element is still what the audit said it is.
  if (!s.visible) return { votes, vetoes };
  // facts read while a reveal was still running describe that moment, not the element: they decide nothing (fail closed, and the same at any moment)
  if (s.settled === false) return { votes, vetoes };
  if (s.displayContents) {
    vetoes.push({ why: 'it is display:contents, so it has no box of its own', hard: true, kinds: CONTAINER_KINDS });
    return { votes, vetoes };
  }
  const styled = s.bordered || s.shadowed || s.tinted || s.gradient;
  const composed = (s.headings > 0 && (s.textBlocks > 0 || s.media > 0 || s.actions > 0)) || (s.media > 0 && s.textBlocks > 0);
  const sizeOk = s.width * s.height >= MIN_AREA && Math.min(s.width, s.height) >= MIN_SIDE;
  // a stacked mobile layout makes every box page-wide: only a desktop page can tell a band from a card
  const sectionWide = s.viewport === 'desktop' && s.widthRatio >= SECTION_WIDE_RATIO && s.height >= SECTION_WIDE_HEIGHT;
  const repeated = s.similarSiblings >= REPEATED_SIBLINGS;
  const traits = [s.bordered && 'bordered', s.shadowed && 'shadowed', s.tinted && 'tinted', s.gradient && 'gradient', composed && 'composed', repeated && 'repeated', s.selfAnchor && 'anchor'].filter(Boolean).join(', ');
  const why = `structure: ${traits || 'no box styling'}`;
  const vote = (kind: SemanticKind, weight: number): void => { votes.push({ kind, group: 'structure', weight, why }); };

  if (s.onlyChildSameBox && !styled) vetoes.push({ why: 'it is a layout wrapper (one child fills the same box and it paints nothing itself)', hard: false, kinds: BOX_KINDS });
  if (sectionWide) vetoes.push({ why: 'it spans the whole section width', hard: false, kinds: WIDE_KINDS });
  if (!sizeOk) vetoes.push({ why: 'its box is too small to be a card or panel', hard: false, kinds: BOX_KINDS });

  if (sectionWide) vote('section', styled ? 3 : 2);
  else if (composed && sizeOk && (styled || s.selfAnchor)) {
    vote('card', repeated ? 3 : 2);
    if (!repeated && !s.interactive && styled) vote('panel', 3);
  }
  return { votes, vetoes };
}

/**
 * Classifies an element by purpose. Pure and deterministic: the same evidence gives byte-identical output, in a stable order (score, then kind).
 */
export function inferElementKinds(ev: ElementEvidence): KindInference {
  const sig = parseSignals(ev.audit.signals);
  const m = ev.mapping;
  const s = ev.structure;
  const context: string[] = [];

  // the live page decides whenever it was read: its tag, and its role (none means none, whatever the mapping or the audit's printed signal say)
  const tag = (s?.tag ?? m?.tagName ?? sig.tag)?.toLowerCase() ?? null;
  const rawRole = (s !== null ? s.role : (m?.role ?? sig.role))?.toLowerCase() ?? null;
  const role = rawRole !== null && !NO_SEMANTICS.has(rawRole) ? rawRole : null;
  if (s !== null && m !== null && s.tag !== m.tagName.toLowerCase()) context.push(`the live page tag <${s.tag}> differs from the mapped <${m.tagName.toLowerCase()}>; the live page is used`);
  // navigation / footer context: the audit's own signal, or - the live-only case - the landmark the rendered element sits in
  const landmark = s?.settled === false ? null : s?.landmark ?? null;
  const insideNavigation = sig.insideNavigation || landmark === 'navigation';
  const insideFooter = sig.insideFooter || landmark === 'footer';
  const insideHeader = landmark === 'header';
  if (insideNavigation) context.push('inside navigation');
  if (insideFooter) context.push('inside footer');
  if (insideHeader && !insideNavigation && !insideFooter) context.push('inside a page header');
  if (s?.settled === false) context.push('the rendered structure was not used: the element\'s animations had not settled, so its facts depend on the moment of the probe');

  const votes: Vote[] = [];
  const vetoes: Veto[] = [];
  const vote = (kind: SemanticKind, group: Group, weight: number, why: string, bareTag = false): void => { votes.push({ kind, group, weight, why, ...(bareTag ? { bareTag: true as const } : {}) }); };

  // audit: its own type (strong) and the signals it printed (one origin: the strongest counts)
  const productionType = ev.audit.productionType;
  const auditKind = productionType === null ? null : canonicalKind(productionType);
  if (auditKind !== null) vote(auditKind, 'audit', 3, `audit type ${productionType}`);
  if (sig.largeClickableCard) vote('card', 'audit', 2, 'audit signal: large clickable box → card');
  if (sig.smallIconButton) vote('button', 'audit', 2, 'audit signal: small clickable without text → icon-button');
  if (sig.accordionTrigger) vote('accordion-trigger', 'audit', 2, 'audit signal: accordion trigger');

  // DS: the component the audit matched, the one C2 confirmed, and a possible match only when it is a real candidate
  const dsNames: Array<{ name: string; weight: number; why: string }> = [];
  if (ev.audit.dsComponent !== null) dsNames.push({ name: ev.audit.dsComponent, weight: 3, why: `DS component ${ev.audit.dsComponent}` });
  if (m?.dsComponent && m.dsBasis === 'finding-match') dsNames.push({ name: m.dsComponent, weight: 3, why: `DS component ${m.dsComponent}` });
  for (const p of ev.audit.possibleMatches) if (p.score >= 0.5) dsNames.push({ name: p.dsComponent, weight: 2, why: `possible DS match ${p.dsComponent} (score ${p.score})` });
  for (const d of dsNames) {
    const kind = DS_NAME_KIND.find(([re]) => re.test(d.name))?.[1];
    if (kind !== undefined) vote(kind, 'ds', d.weight, d.why);
  }

  // native semantics: tag, explicit role and attributes
  const href = m?.href != null || s?.selfAnchor === true;
  const inputType = (m?.type ?? 'text').toLowerCase();
  if (tag === 'input' && !NOT_A_FIELD.has(inputType)) vote('input', 'native', 3, 'native <input>');
  else if (tag === 'textarea' || tag === 'select') vote('input', 'native', 3, `native <${tag}>`);
  else if (role !== null && ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role)) vote('input', 'native', 3, `ARIA role ${role}`);
  if (tag === 'button' || role === 'button' || (tag === 'input' && BUTTON_TYPES.has(inputType))) vote('button', 'native', 3, tag === 'button' ? 'native <button>' : 'native button semantics');
  if ((tag === 'a' && href) || role === 'link') vote('link', 'native', 3, tag === 'a' ? 'native <a href>' : 'ARIA role link');
  if (tag === 'details') vote('accordion', 'native', 3, 'native <details>', true);
  if (tag === 'summary') vote('accordion-trigger', 'native', 3, 'native <summary>');
  if (tag === 'section') vote('section', 'native', 3, 'native <section>', true);
  if (role === 'region') vote('section', 'native', 3, 'ARIA role region');
  if (role === 'alert' || role === 'status') vote('callout', 'native', 2, `ARIA role ${role}`);
  if (tag === 'aside') vote('panel', 'native', 1, 'native <aside>', true);
  if (role === 'complementary') vote('panel', 'native', 1, 'ARIA role complementary');
  if (tag === 'article') vote('card', 'native', 1, 'native <article>', true);
  if (tag === 'tr') vote('row', 'native', 3, 'native table row', true);
  if (role === 'row') vote('row', 'native', 3, 'ARIA role row');
  if (m?.ariaExpanded != null && m.ariaControls != null && (tag === 'button' || isHeading(tag, role))) vote('accordion-trigger', 'native', 2, 'aria-expanded + aria-controls');

  // rendered structure
  if (s !== null) {
    const st = structureVotes(s);
    votes.push(...st.votes);
    vetoes.push(...st.vetoes);
  }

  // class names: weak, whole-token only
  for (const cls of sig.classes) {
    const kind = CLASS_KIND.find(([re]) => re.test(cls))?.[1];
    if (kind !== undefined) vote(kind, 'class', 1, `class token ${cls}`);
  }

  // negative evidence — container kinds only
  if (tag !== null && CONTROL_TAGS.has(tag)) vetoes.push({ why: `a <${tag}> is a control, not a container`, hard: true, kinds: CONTAINER_KINDS });
  else if (role !== null && CONTROL_ROLES.has(role)) vetoes.push({ why: `ARIA role ${role} is a control, not a container`, hard: true, kinds: CONTAINER_KINDS });
  // a <label> that holds a heading, media or a control is how a selectable card is built: it is a text-level element only for evidence that is not typed
  const labelHoldsBlocks = tag === 'label' && s !== null && s.headings + s.media + s.controls > 0;
  if (tag !== null && LEAF_TAGS.has(tag)) vetoes.push({ why: `a <${tag}> is a text-level element, not a container`, hard: !labelHoldsBlocks, kinds: CONTAINER_KINDS });
  else if (role !== null && LEAF_ROLES.has(role)) vetoes.push({ why: `ARIA role ${role} is a text-level element, not a container`, hard: true, kinds: CONTAINER_KINDS });
  if (auditKind !== null && !CONTAINER_KINDS.has(auditKind)) vetoes.push({ why: `audit type ${productionType} is not a container`, hard: true, kinds: CONTAINER_KINDS });
  if (sig.cardTitle) vetoes.push({ why: 'the audit says it is a card title, part of a card', hard: true, kinds: CONTAINER_KINDS });
  if (sig.accordionTrigger) vetoes.push({ why: 'the audit says it is an accordion trigger, not the accordion', hard: true, kinds: CONTAINER_KINDS });
  // navigation and footer lists look like bordered, composed, repeated boxes: structure and class names alone do not make them cards (a typed kind keeps its own)
  if (insideNavigation || insideFooter || insideHeader) vetoes.push({ why: `it is inside ${insideNavigation ? 'navigation' : insideFooter ? 'the footer' : 'a page header'}, where repeated bordered items are not cards`, hard: false, kinds: CONTAINER_KINDS });

  // score = sum over origins of the strongest vote of that origin
  const kinds = [...new Set(votes.map((v) => v.kind))];
  const considered: KindConsidered[] = [];
  const firm = new Set<SemanticKind>();
  for (const kind of kinds) {
    const mine = votes.filter((v) => v.kind === kind);
    const best = (g: Group) => Math.max(0, ...mine.filter((v) => v.group === g).map((v) => v.weight));
    const score = GROUPS.reduce((sum, g) => sum + best(g), 0);
    const evidence = [...new Set(GROUPS.flatMap((g) => mine.filter((v) => v.group === g).map((v) => v.why)))];
    // typed by the audit or the DS itself: a measured fact, which a size/shape heuristic cannot overrule — but a control tag still contradicts it
    const typed = best('audit') >= ACCEPT_SCORE || best('ds') >= ACCEPT_SCORE;
    if (typed || best('native') >= ACCEPT_SCORE) firm.add(kind);
    const container = CONTAINER_KINDS.has(kind);
    const applicable = container ? vetoes.filter((v) => v.kinds.has(kind) && (v.hard || !typed)) : [];
    // a bare tag is one origin of evidence and a container kind needs a second (the DOM is full of <section>s that are not components)
    const tagOnly = container && mine.every((v) => v.group === 'native' && v.bareTag === true);
    const status: KindConsidered['status'] = applicable.length > 0 ? (applicable.some((v) => v.hard) && typed ? 'conflict' : 'vetoed') : tagOnly ? 'below-threshold' : score >= ACCEPT_SCORE ? 'accepted' : 'below-threshold';
    considered.push({ kind, score, status, evidence, vetoes: [...new Set(applicable.map((v) => v.why))].concat(tagOnly && applicable.length === 0 ? ['a tag alone is one origin of evidence; a container kind needs a second'] : []) });
  }
  considered.sort((a, b) => b.score - a.score || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  // one container kind per element: the strongest. Typed or native evidence outranks inferred, then score, then anything over `panel` (the generic fallback
  // that structure alone can claim), then the name — so a card typed by the audit is never also a derived panel, and a faq row is never also a card.
  const acceptedContainers = considered.filter((c) => c.status === 'accepted' && CONTAINER_KINDS.has(c.kind));
  if (acceptedContainers.length > 1) {
    const rank = (c: KindConsidered): [number, number, number] => [firm.has(c.kind) ? 1 : 0, c.score, c.kind === 'panel' ? 0 : 1];
    const ordered = [...acceptedContainers].sort((a, b) => { const x = rank(a); const y = rank(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0); });
    for (const loser of ordered.slice(1)) Object.assign(loser, { status: 'vetoed', vetoes: [`one container kind per element: ${ordered[0]!.kind} is the stronger reading`] });
  }

  // contradictory evidence (a control tag against a card type): the container kinds are withheld, and recorded as such. A non-container kind (link, input,
  // the native <button>) is a fact about the element and is kept.
  const conflicted = considered.filter((c) => c.status === 'conflict');
  if (conflicted.length > 0) for (const c of considered) if (c.status === 'accepted' && CONTAINER_KINDS.has(c.kind)) Object.assign(c, { status: 'conflict', vetoes: ['not claimed: other evidence for this element conflicts'] });
  const out: KindVote[] = considered.filter((c) => c.status === 'accepted').map((c) => ({ kind: c.kind, confidence: c.score >= HIGH_SCORE ? 'high' : 'medium', score: c.score, evidence: c.evidence }));

  const who = tag !== null ? `<${tag}>` : 'the element';
  const rejected = considered.filter((c) => c.status === 'vetoed').map((c) => `not ${c.kind} (${c.vetoes[0]})`);
  const classified = out.length > 0 ? `${who} classified as ${out.map((k) => `${k.kind} (${k.confidence}: ${k.evidence.join('; ')})`).join(', ')}` : null;
  const head = conflicted.length > 0
    ? [`the evidence for ${who} conflicts (${conflicted.map((c) => `${c.kind}: ${c.vetoes[0]}`).join('; ')}); no container category is claimed`, classified].filter(Boolean).join('; ')
    : classified ?? `no component category could be established for ${who}: a tag or ARIA role alone does not name a component category, and no audit type, DS component, signal or structure evidence does`;
  const partOf: SemanticKind | null = sig.cardTitle ? 'card' : sig.accordionTrigger ? 'accordion' : null;

  return {
    rulesVersion: ELEMENT_KIND_RULES_VERSION,
    kinds: out,
    considered,
    raw: { tag, role, productionType },
    partOf,
    context,
    viewport: s?.viewport ?? null,
    sources: ['audit', ...(m !== null ? ['mapping' as const] : []), ...(s !== null ? ['structure' as const] : [])],
    summary: [head, ...rejected].join('; '),
  };
}

// ── compatibility: the one predicate ──────────────────────────────────────────────────────────

const NO_KIND_DETAIL = 'no component category was established for the element (a tag or ARIA role alone does not name a component category)';

/**
 * Does an element of these kinds fit a pattern that lists those kinds? Both sides are canonicalised, so a raw tag handed in by a caller (`div`) is
 * dropped rather than trusted, and there is no implicit hierarchy (a card is not a panel). No query kind means no match.
 * `summary` is the inference's own sentence, used in the explanation.
 */
export function kindCompatibility(queryKinds: readonly string[], patternKinds: readonly string[], summary?: string): { ok: boolean; matched: SemanticKind[]; detail: string } {
  const q = canonicalKinds(queryKinds);
  const p = canonicalKinds(patternKinds);
  const matched = q.filter((k) => p.includes(k));
  const fits = `the pattern fits ${p.join(', ') || 'no element kind'}`;
  if (matched.length > 0) return { ok: true, matched, detail: `${matched.map((k) => `"${k}"`).join(', ')} ${matched.length > 1 ? 'are' : 'is'} among the pattern's element kinds (${p.join(', ')})${summary ? ` — ${summary}` : ''}` };
  if (q.length === 0) return { ok: false, matched, detail: `${summary ?? NO_KIND_DETAIL}; ${fits}` };
  return { ok: false, matched, detail: `${summary ?? `the element was classified as ${q.join(', ')}`}; ${fits}` };
}
