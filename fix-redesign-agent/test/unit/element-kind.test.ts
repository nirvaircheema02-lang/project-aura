import { describe, expect, it } from 'vitest';
import { canonicalKind, inferElementKinds, kindCompatibility, SEMANTIC_KINDS, type ElementEvidence, type StructureFacts } from '../../src/reference/element-kind.ts';

/**
 * The semantic element-kind classifier: a tag, an ARIA role and the audit's production type are EVIDENCE, never a component category.
 * The fixtures below are the real shapes of the audits (anchor cards, FAQ headings, icon buttons) and of a rendered page.
 */

const mapped = (over: Partial<NonNullable<ElementEvidence['mapping']>> = {}): NonNullable<ElementEvidence['mapping']> => ({ tagName: 'div', role: null, href: null, type: null, ariaExpanded: null, ariaControls: null, dsComponent: null, dsBasis: 'none', ...over });
const ev = (over: { type?: string | null; ds?: string | null; signals?: string[]; matches?: Array<{ dsComponent: string; score: number }>; mapping?: ElementEvidence['mapping']; structure?: StructureFacts | null } = {}): ElementEvidence => ({
  audit: { productionType: over.type ?? null, dsComponent: over.ds ?? null, signals: over.signals ?? [], possibleMatches: over.matches ?? [] },
  mapping: over.mapping === undefined ? mapped() : over.mapping,
  structure: over.structure ?? null,
});
const facts = (over: Partial<StructureFacts> = {}): StructureFacts => ({
  tag: 'div', role: null, displayContents: false, visible: true, viewport: 'desktop', width: 320, height: 240, widthRatio: 0.25,
  bordered: true, shadowed: false, tinted: false, gradient: false, headings: 1, textBlocks: 1, media: 1, actions: 0, controls: 0,
  interactive: false, selfAnchor: false, similarSiblings: 2, onlyChildSameBox: false, ...over,
});
const kindsOf = (e: ElementEvidence) => inferElementKinds(e).kinds.map((k) => k.kind);

describe('canonicalKind — categories, not tags', () => {
  it('folds case, plurals and the documented aliases', () => {
    expect(canonicalKind('Panel')).toBe('panel');
    expect(canonicalKind('cards')).toBe('card');
    expect(canonicalKind('  Resource_Card ')).toBe('card');
    expect(canonicalKind('faq-row')).toBe('accordion');
    expect(canonicalKind('icon-button')).toBe('button');
    expect(canonicalKind('nav-link')).toBe('link');
    expect(canonicalKind('section-heading')).toBe('heading');
    expect(canonicalKind('text-field')).toBe('input');
    expect(canonicalKind('summary')).toBeNull();
    expect(canonicalKind('accordion-trigger')).toBe('accordion-trigger');
  });

  it('a raw tag or ARIA role names no category: div, span, generic, a, li, h2, img, textbox are all null', () => {
    for (const raw of ['div', 'span', 'generic', 'a', 'li', 'h2', 'img', 'svg', 'none', 'presentation', 'textbox', 'main', '', 'unknown-thing']) expect(canonicalKind(raw), raw).toBeNull();
  });

  it('every kind of the vocabulary maps to itself', () => {
    for (const k of SEMANTIC_KINDS) expect(canonicalKind(k), k).toBe(k);
  });
});

describe('inferElementKinds — positive evidence', () => {
  it('a div the audit typed card and the DS names Card is a high-confidence card; the raw tag is evidence only', () => {
    const r = inferElementKinds(ev({ type: 'card', ds: 'Card' }));
    expect(r.kinds[0]).toMatchObject({ kind: 'card', confidence: 'high' });
    expect(r.kinds[0]!.evidence.join(' ')).toMatch(/audit type card/);
    expect(r.kinds[0]!.evidence.join(' ')).toMatch(/DS component Card/);
    expect(r.raw).toEqual({ tag: 'div', role: null, productionType: 'card' });
    expect(r.kinds.map((k) => k.kind)).not.toContain('div');
    expect(r.summary).toMatch(/<div> classified as card \(high/);
  });

  it('the audit type alone is a card with medium confidence', () => {
    expect(inferElementKinds(ev({ type: 'card' })).kinds).toMatchObject([{ kind: 'card', confidence: 'medium', score: 3 }]);
  });

  it('a bare <div> with no other evidence names NO component category and says why', () => {
    const r = inferElementKinds(ev());
    expect(r.kinds).toEqual([]);
    expect(r.considered.filter((c) => c.status === 'accepted')).toEqual([]);
    expect(r.summary).toMatch(/no component category.*<div>.*a tag or ARIA role alone does not name a component category/);
    expect(inferElementKinds(ev({ mapping: null })).kinds).toEqual([]);
    expect(inferElementKinds(ev({ mapping: null })).summary).toMatch(/the element/);
  });

  it('structure alone: a repeated, bordered, composed box is a card; the same box once is a panel (not a card)', () => {
    const repeated = inferElementKinds(ev({ type: 'unknown', structure: facts({ similarSiblings: 3 }) }));
    expect(repeated.kinds.map((k) => k.kind)).toEqual(['card']);
    expect(repeated.kinds[0]!.confidence).toBe('medium');
    expect(repeated.kinds[0]!.evidence.join(' ')).toMatch(/structure: .*bordered.*composed.*repeated/);
    const single = inferElementKinds(ev({ type: 'unknown', structure: facts({ similarSiblings: 0 }) }));
    expect(single.kinds.map((k) => k.kind)).toEqual(['panel']);
    expect(single.considered.find((c) => c.kind === 'card')).toMatchObject({ status: 'below-threshold' });
  });

  it('structure alone names nothing when the box is unstyled, not composed, too small or invisible', () => {
    expect(kindsOf(ev({ structure: facts({ bordered: false }) }))).toEqual([]);
    expect(kindsOf(ev({ structure: facts({ headings: 0, textBlocks: 1, media: 0, actions: 0 }) }))).toEqual([]);
    expect(kindsOf(ev({ structure: facts({ width: 60, height: 300 }) }))).toEqual([]);
    expect(kindsOf(ev({ structure: facts({ width: 100, height: 100 }) }))).toEqual([]); // 10 000 px2 < 12 000
    expect(kindsOf(ev({ structure: facts({ visible: false }) }))).toEqual([]);
    expect(kindsOf(ev({ structure: facts({ displayContents: true }) }))).toEqual([]);
  });

  it('a styled section-wide band is a section, never a card or panel', () => {
    const r = inferElementKinds(ev({ structure: facts({ widthRatio: 1, height: 480, tinted: true, bordered: false }) }));
    expect(r.kinds.map((k) => k.kind)).toEqual(['section']);
    expect(kindsOf(ev({ structure: facts({ widthRatio: 1, height: 480 }) }))).not.toContain('card');
  });

  it('a layout wrapper (one child, same box, no own styling) names nothing, even when its content is rich', () => {
    expect(kindsOf(ev({ structure: facts({ bordered: false, onlyChildSameBox: true }) }))).toEqual([]);
  });

  it('an anchor card — the real audit shape — is a card AND a link; a possible DS match scoring 0.2 is ignored', () => {
    const signals = ['role=link', 'tag=a', 'cursor=pointer', 'has svg', 'has img', 'large clickable (area 82056px²) → card', 'class=rounded-[8px]', '4 instance(s) of this pattern on the page'];
    const e = ev({ type: 'card', signals, matches: [{ dsComponent: 'ResourceCard', score: 0.2 }, { dsComponent: 'Card', score: 0 }], mapping: mapped({ tagName: 'a', href: '/blog/x' }) });
    const r = inferElementKinds(e);
    expect(r.kinds.map((k) => k.kind).sort()).toEqual(['card', 'link']);
    expect(r.kinds.find((k) => k.kind === 'card')!.evidence.join(' ')).not.toMatch(/ResourceCard/);
    expect(r.kinds.find((k) => k.kind === 'card')!.score).toBe(3);
    // the same anchor typed nav-link, with no card phrase: a link, not a card
    const nav = inferElementKinds(ev({ type: 'nav-link', signals: ['role=link', 'tag=a', 'inside navigation'], mapping: mapped({ tagName: 'a', href: '/x' }) }));
    expect(nav.kinds.map((k) => k.kind)).toEqual(['link']);
  });

  it('a possible DS match counts only when it scores 0.5 or more', () => {
    expect(kindsOf(ev({ matches: [{ dsComponent: 'Card', score: 0.4 }] }))).toEqual([]);
    expect(kindsOf(ev({ matches: [{ dsComponent: 'Card', score: 0.8 }] }))).toEqual([]); // 2 alone is below the threshold
    expect(kindsOf(ev({ type: 'card', matches: [{ dsComponent: 'ResourceCard', score: 0.8 }] }))).toEqual(['card']);
  });

  it('inputs, buttons, details and summary come from native semantics; a checkbox is not an input', () => {
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'input', type: 'text' }) }))).toEqual(['input']);
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'input', type: null }) }))).toEqual(['input']);
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'input', type: 'checkbox' }) }))).toEqual([]);
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'textarea' }) }))).toEqual(['input']);
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'div', role: 'textbox' }) }))).toEqual(['input']);
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'button' }) }))).toEqual(['button']);
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'details' }) }))).toEqual([]); // a bare tag needs a second origin (see the tag-only tests)
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'details' }), signals: ['class=faq'] }))).toEqual(['accordion']);
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'summary' }) }))).toEqual(['accordion-trigger']);
    expect(kindsOf(ev({ type: 'input' }))).toEqual(['input']);
  });

  it('a hedged "accordion trigger or link title" signal is a trigger only with aria-expanded/aria-controls; it is never the accordion shell or a card', () => {
    const signals = ['role=heading', 'tag=h2', 'cursor=pointer', 'level=2', 'clickable heading ([cursor=pointer]) — an accordion trigger or link title, not evidently a section heading', 'class=faq_question'];
    const bare = inferElementKinds(ev({ type: 'section-heading', signals, mapping: mapped({ tagName: 'h2' }) }));
    expect(bare.kinds.map((k) => k.kind)).toEqual(['heading']);
    expect(bare.partOf).toBe('accordion');
    const aria = inferElementKinds(ev({ type: 'section-heading', signals, mapping: mapped({ tagName: 'h2', ariaExpanded: 'false', ariaControls: 'faq-1' }) }));
    expect(aria.kinds.map((k) => k.kind).sort()).toEqual(['accordion-trigger', 'heading']);
    expect(aria.kinds.map((k) => k.kind)).not.toContain('accordion');
    expect(aria.kinds.map((k) => k.kind)).not.toContain('card');
  });

  it('a whole-token class name is weak evidence (1): it corroborates structure but never classifies alone', () => {
    expect(kindsOf(ev({ signals: ['class=card'] }))).toEqual([]);
    expect(kindsOf(ev({ signals: ['class=faq_question', 'class=card-title', 'class=cardinal'] }))).toEqual([]);
    expect(kindsOf(ev({ signals: ['class=stat-card'], structure: facts({ similarSiblings: 0 }) }))).toContain('card');
  });
});

describe('inferElementKinds — negative evidence', () => {
  it('an icon-button typed element on a styled, repeated box is a button; card is vetoed and recorded', () => {
    const r = inferElementKinds(ev({ type: 'icon-button', signals: ['small (40×40) clickable with no text → icon-button'], structure: facts({ similarSiblings: 3 }) }));
    expect(r.kinds.map((k) => k.kind)).toEqual(['button']);
    expect(r.considered.find((c) => c.kind === 'card')).toMatchObject({ status: 'vetoed' });
    expect(r.considered.find((c) => c.kind === 'card')!.vetoes.join(' ')).toMatch(/audit type icon-button is not a container/);
    expect(r.summary).toMatch(/not card/);
  });

  it.each(['button', 'input', 'select', 'textarea', 'h3', 'p', 'span', 'label', 'img'])('a <%s> never becomes a card, whatever its class names or box say', (tag) => {
    const r = inferElementKinds(ev({ signals: ['class=card'], mapping: mapped({ tagName: tag }), structure: facts({ tag, similarSiblings: 3 }) }));
    expect(r.kinds.map((k) => k.kind)).not.toContain('card');
    expect(r.kinds.map((k) => k.kind)).not.toContain('panel');
    expect(r.considered.find((c) => c.kind === 'card')).toMatchObject({ status: 'vetoed' });
  });

  it('a title inside a card is a heading that is part of a card — never the card', () => {
    const signals = ['role=heading', 'tag=h3', 'inside clickable e602 — a card or link title, not evidently a section heading', 'class=text-xl'];
    const r = inferElementKinds(ev({ type: 'section-heading', signals, mapping: mapped({ tagName: 'h3' }), structure: facts({ tag: 'h3', similarSiblings: 3 }) }));
    expect(r.partOf).toBe('card');
    expect(r.kinds.map((k) => k.kind)).toEqual(['heading']);
    expect(r.considered.find((c) => c.kind === 'card')).toMatchObject({ status: 'vetoed' });
  });

  it('a control tag against a strong audit card type fails closed: the CONTAINER kinds are withheld, a non-container kind is kept', () => {
    const r = inferElementKinds(ev({ type: 'card', mapping: mapped({ tagName: 'button' }) }));
    expect(r.considered.find((c) => c.kind === 'card')).toMatchObject({ status: 'conflict' });
    expect(r.kinds.map((k) => k.kind)).toEqual(['button']); // the native <button> is a fact; only the card is in doubt
    expect(r.summary).toMatch(/conflict/i);
    // nothing else to keep: no kind at all
    expect(kindsOf(ev({ type: 'card', structure: facts({ tag: 'button' }), mapping: mapped({ tagName: 'div' }) }))).toEqual(['button']);
    expect(kindsOf(ev({ type: 'card', signals: ['tag=p'], mapping: null, structure: null }))).toEqual([]);
  });

  it('a wrapper, a section-wide box or a too-small box does not become a card from the box alone, but an audit-typed card keeps its kind', () => {
    expect(kindsOf(ev({ structure: facts({ widthRatio: 1, height: 500, similarSiblings: 3 }) }))).not.toContain('card');
    expect(kindsOf(ev({ structure: facts({ width: 90, height: 90, similarSiblings: 3 }) }))).toEqual([]);
    // the audit measured and typed it: the size veto applies to INFERRED cards only (real audit-typed cards are 208x88 and up)
    expect(kindsOf(ev({ type: 'card', structure: facts({ width: 200, height: 50, bordered: false, headings: 0 }) }))).toEqual(['card']);
  });

  it('"inside navigation" is context, not a veto', () => {
    expect(kindsOf(ev({ type: 'card', signals: ['inside navigation'] }))).toEqual(['card']);
  });

  it('when the live DOM tag differs from the mapped tag, the live page wins', () => {
    const r = inferElementKinds(ev({ mapping: mapped({ tagName: 'div' }), structure: facts({ tag: 'button' }) }));
    expect(r.raw.tag).toBe('button');
    expect(r.kinds.map((k) => k.kind)).toEqual(['button']);
  });
});

describe('inferElementKinds — classification does not depend on animation timing', () => {
  it('an element that is not visible keeps the kind the audit or the DS typed it with: invisibility is not a veto on typed evidence', () => {
    expect(kindsOf(ev({ type: 'card', structure: facts({ visible: false }) }))).toEqual(['card']);
    expect(kindsOf(ev({ type: 'unknown', ds: 'Card', structure: facts({ visible: false }) }))).toEqual(['card']);
    const r = inferElementKinds(ev({ type: 'card', structure: facts({ visible: false }) }));
    expect(r.considered.find((c) => c.kind === 'card')!.status).toBe('accepted');
  });

  it('an element that is not visible gives structure NO say: no structure kind, and no structure vote against anything', () => {
    expect(kindsOf(ev({ structure: facts({ visible: false }) }))).toEqual([]);
    expect(kindsOf(ev({ signals: ['class=product-card'], structure: facts({ visible: false }) }))).toEqual([]);
  });

  it('the same card classifies identically whatever its animation state: the only visibility facts are display/visibility/size, never opacity', () => {
    const visible = inferElementKinds(ev({ type: 'card', structure: facts({ visible: true }) }));
    const hidden = inferElementKinds(ev({ type: 'card', structure: facts({ visible: false }) }));
    expect(hidden.kinds.map((k) => k.kind)).toEqual(visible.kinds.map((k) => k.kind));
  });
});

describe('inferElementKinds — one container kind per element', () => {
  it('a card typed by the audit is a card only: structure never adds "panel" (so no panel pattern, no accordion row, is offered to it)', () => {
    expect(kindsOf(ev({ type: 'card', structure: facts({ similarSiblings: 0 }) }))).toEqual(['card']);
    expect(kindsOf(ev({ type: 'unknown', ds: 'Card', structure: facts({ similarSiblings: 0 }) }))).toEqual(['card']);
    const r = inferElementKinds(ev({ type: 'card', structure: facts({ similarSiblings: 0 }) }));
    expect(r.considered.find((c) => c.kind === 'panel')).toMatchObject({ status: 'vetoed' });
    expect(r.considered.find((c) => c.kind === 'panel')!.vetoes.join(' ')).toMatch(/one container kind/);
  });

  it('a single card with a card class and the same structure is a card, not a panel', () => {
    expect(kindsOf(ev({ signals: ['class=product-card'], structure: facts({ similarSiblings: 0 }) }))).toEqual(['card']);
  });

  it('structure does not add a panel to an element the audit typed otherwise (an FAQ row stays an accordion)', () => {
    expect(kindsOf(ev({ type: 'faq-row', structure: facts({ similarSiblings: 0 }) }))).toEqual(['accordion']);
  });

  it('at most one container kind is ever accepted, and a non-container kind (link) is unaffected', () => {
    const e = ev({ type: 'card', signals: ['tag=a', 'role=link'], mapping: mapped({ tagName: 'a', href: '/x' }), structure: facts({ tag: 'a', selfAnchor: true, interactive: true, similarSiblings: 0 }) });
    const kinds = kindsOf(e);
    expect(kinds.sort()).toEqual(['card', 'link']);
  });
});

describe('inferElementKinds — conflicts and label-implemented cards', () => {
  it('a conflict withholds only the container kinds: an audit card on a <button> keeps its native button kind, an input keeps input', () => {
    const r = inferElementKinds(ev({ type: 'card', mapping: mapped({ tagName: 'button' }) }));
    expect(r.kinds.map((k) => k.kind)).toEqual(['button']);
    expect(r.considered.find((c) => c.kind === 'card')).toMatchObject({ status: 'conflict' });
    expect(r.summary).toMatch(/card: a <button> is a control/);
  });

  it('a <button>/role=button implemented card typed card stays a documented conflict: no card is claimed', () => {
    expect(kindsOf(ev({ type: 'card', mapping: mapped({ tagName: 'div', role: 'button' }) }))).not.toContain('card');
    expect(kindsOf(ev({ type: 'card', mapping: mapped({ tagName: 'button' }) }))).not.toContain('card');
  });

  it('a <label> that holds a heading, media or a control is a selectable card when the audit typed it card', () => {
    const labelCard = (over: Partial<StructureFacts>) => ev({ type: 'card', mapping: mapped({ tagName: 'label' }), structure: facts({ tag: 'label', similarSiblings: 0, ...over }) });
    expect(kindsOf(labelCard({ headings: 1, media: 0, controls: 1 }))).toEqual(['card']);
    expect(kindsOf(labelCard({ headings: 0, media: 1, controls: 0, textBlocks: 1 }))).toEqual(['card']);
    expect(kindsOf(labelCard({ headings: 0, media: 0, controls: 1, textBlocks: 1 }))).toEqual(['card']);
  });

  it('a <label> with nothing but text (no heading, media or control), or with no page to read, stays a text-level element: conflict', () => {
    expect(kindsOf(ev({ type: 'card', mapping: mapped({ tagName: 'label' }), structure: facts({ tag: 'label', headings: 0, media: 0, controls: 0, textBlocks: 1 }) }))).toEqual([]);
    expect(kindsOf(ev({ type: 'card', mapping: mapped({ tagName: 'label' }) }))).toEqual([]);
  });

  it('a label is never a card from structure/class alone, even with block content (the exemption is for typed evidence only)', () => {
    expect(kindsOf(ev({ signals: ['class=card'], mapping: mapped({ tagName: 'label' }), structure: facts({ tag: 'label', similarSiblings: 3, headings: 1, controls: 1 }) }))).not.toContain('card');
  });
});

describe('inferElementKinds — a tag alone is not a container kind', () => {
  it.each(['section', 'article', 'aside', 'tr', 'details'])('a bare <%s> names no kind (a tag is one origin; a container kind needs a second)', (tag) => {
    expect(kindsOf(ev({ mapping: mapped({ tagName: tag }) }))).toEqual([]);
    expect(inferElementKinds(ev({ mapping: mapped({ tagName: tag }) })).summary).toMatch(/no component category/);
  });

  it('a <section> corroborated by a second origin (rendered full-width band) is a section; an audit card on a <section> is a card only', () => {
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'section' }), structure: facts({ tag: 'section', widthRatio: 1, height: 480, tinted: true, bordered: false }) }))).toEqual(['section']);
    expect(kindsOf(ev({ type: 'card', mapping: mapped({ tagName: 'section' }) }))).toEqual(['card']);
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'tr' }), signals: ['class=row'] }))).toEqual([]); // `row` is not a class-kind token
    expect(kindsOf(ev({ type: 'row', mapping: mapped({ tagName: 'tr' }) }))).toEqual(['row']);
  });

  it('"inside navigation" / "inside footer" veto container kinds inferred from structure or class alone', () => {
    for (const where of ['inside navigation', 'inside footer']) {
      expect(kindsOf(ev({ signals: [where, 'class=mega-card'], structure: facts({ similarSiblings: 3 }) })), where).toEqual([]);
      expect(kindsOf(ev({ signals: [where], structure: facts({ similarSiblings: 3 }) })), where).toEqual([]);
      expect(kindsOf(ev({ signals: [where, 'class=mega-card'] })), where).toEqual([]);
    }
  });

  it('a navigation <li> pair that looks like a bordered composed box is not a panel; an audit- or DS-typed card in the footer still is a card', () => {
    expect(kindsOf(ev({ signals: ['inside navigation'], mapping: mapped({ tagName: 'li' }), structure: facts({ tag: 'li', similarSiblings: 1 }) }))).toEqual([]);
    expect(kindsOf(ev({ type: 'card', signals: ['inside footer'] }))).toEqual(['card']);
    expect(kindsOf(ev({ ds: 'ResourceCard', signals: ['inside navigation'], structure: facts({ similarSiblings: 3 }) }))).toEqual(['card']);
    expect(inferElementKinds(ev({ signals: ['inside footer'] })).context).toContain('inside footer');
  });
});

describe('inferElementKinds — role, size and viewport are deterministic', () => {
  it('the role comes from the live page whenever a probe exists: a null live role beats a mapped or audit role', () => {
    const e = ev({ type: 'card', signals: ['role=button'], mapping: mapped({ role: 'button' }), structure: facts({ role: null }) });
    expect(kindsOf(e)).toEqual(['card']);
    expect(inferElementKinds(e).raw.role).toBeNull();
    // without a probe the mapped role still counts
    expect(inferElementKinds(ev({ type: 'card', mapping: mapped({ role: 'button' }) })).raw.role).toBe('button');
  });

  it('a stacked full-width box on a mobile viewport is not read as a section; the same box on desktop is', () => {
    const band = { widthRatio: 1, height: 480, similarSiblings: 3 } as const;
    expect(kindsOf(ev({ structure: facts({ ...band, viewport: 'desktop' }) }))).toEqual(['section']);
    expect(kindsOf(ev({ structure: facts({ ...band, viewport: 'mobile' }) }))).toEqual(['card']);
    expect(kindsOf(ev({ structure: facts({ ...band, widthRatio: 0.3, height: 240, viewport: 'mobile' }) }))).toEqual(['card']);
  });

  it('an audit-typed card is a card at both viewport classes', () => {
    for (const viewport of ['desktop', 'mobile'] as const) expect(kindsOf(ev({ type: 'card', structure: facts({ widthRatio: 1, height: 480, viewport }) })), viewport).toEqual(['card']);
  });

  it('the viewport class is part of the inference (null without a probe), so a resumed run on the same viewport reproduces it', () => {
    expect(inferElementKinds(ev({ structure: facts({ viewport: 'mobile' }) })).viewport).toBe('mobile');
    expect(inferElementKinds(ev({ structure: facts({ viewport: 'desktop' }) })).viewport).toBe('desktop');
    expect(inferElementKinds(ev()).viewport).toBeNull();
  });
});

describe('inferElementKinds — purity and determinism', () => {
  it('the production label, the review reason and any judgment text are not inputs: extra fields change nothing', () => {
    const base = ev({ type: 'section-heading', mapping: mapped({ tagName: 'h2' }) });
    const polluted = { ...base, productionLabel: 'Credit Card', reviewReason: 'this is a card', reason: 'the card needs a hairline' } as ElementEvidence;
    expect(inferElementKinds(polluted)).toEqual(inferElementKinds(base));
    expect(kindsOf(ev({ type: 'section-heading', mapping: mapped({ tagName: 'h2' }) }))).not.toContain('card');
  });

  it('two runs are deep-equal with a stable order, and evidence of one origin is not summed', () => {
    const e = ev({ type: 'card', ds: 'ResourceCard', signals: ['large clickable (area 40000px²) → card', 'tag=a', 'role=link'], mapping: mapped({ tagName: 'a', href: '/x' }), structure: facts({ selfAnchor: true, interactive: true, similarSiblings: 3 }) });
    const a = inferElementKinds(e);
    expect(inferElementKinds(e)).toEqual(a);
    expect(JSON.stringify(inferElementKinds(e))).toBe(JSON.stringify(a));
    const card = a.kinds.find((k) => k.kind === 'card')!;
    // audit group (type 3 + signal 2 -> max 3) + DS group (3) + structure group (3) = 9, not 3+2+3+3
    expect(card.score).toBe(9);
    expect(a.kinds.map((k) => k.score)).toEqual([...a.kinds.map((k) => k.score)].sort((x, y) => y - x));
    expect(a.rulesVersion).toBe('element-kind-v3');
  });

  it('the trail holds booleans and enums only: no pixel sizes leak into the record', () => {
    const r = inferElementKinds(ev({ type: 'card', structure: facts({ width: 777, height: 555 }) }));
    expect(JSON.stringify(r)).not.toMatch(/777|555/);
  });
});

describe('kindCompatibility — the one predicate', () => {
  it('matches the intersection of canonical kinds, with no implicit hierarchy', () => {
    expect(kindCompatibility(['card'], ['card', 'panel']).ok).toBe(true);
    expect(kindCompatibility(['card'], ['card', 'panel']).matched).toEqual(['card']);
    expect(kindCompatibility(['panel'], ['panel', 'section', 'callout']).ok).toBe(true);
    expect(kindCompatibility(['card'], ['panel', 'section', 'callout']).ok).toBe(false);
    expect(kindCompatibility(['Panel'], ['panel']).ok).toBe(true);
    expect(kindCompatibility(['cards'], ['card']).ok).toBe(true);
    expect(kindCompatibility(['accordion-trigger'], ['accordion']).ok).toBe(false);
  });

  it('fails closed on no kinds and drops raw tags: ([], …) and (["div"], ["card"]) are not compatible', () => {
    const none = kindCompatibility([], ['card', 'panel']);
    expect(none.ok).toBe(false);
    expect(none.detail).toMatch(/a tag or ARIA role alone does not name a component category/);
    expect(none.detail).toMatch(/the pattern fits card, panel/);
    expect(kindCompatibility(['div'], ['card']).ok).toBe(false);
    expect(kindCompatibility(['div', 'a'], ['card']).detail).toMatch(/a tag or ARIA role alone/);
  });

  it('names the classification when the kinds do not fit', () => {
    const d = kindCompatibility(['button'], ['card', 'panel'], '<div> classified as button (high: audit type icon-button)').detail;
    expect(d).toMatch(/classified as button/);
    expect(d).toMatch(/the pattern fits card, panel/);
  });
});

describe('round 2, defect 7: rendered landmarks and unsettled facts', () => {
  const structural = (over: Partial<StructureFacts> = {}) => facts({ tag: 'li', similarSiblings: 2, ...over });

  it('a bordered, composed, repeated item inside a rendered <nav> / <footer> / <header> is no card or panel on structure alone, with the audit giving no signal', () => {
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'li' }), structure: structural() }))).toEqual(['card']); // outside a landmark it is a candidate
    for (const landmark of ['navigation', 'footer', 'header'] as const) {
      const r = inferElementKinds(ev({ mapping: mapped({ tagName: 'li' }), structure: structural({ landmark }) }));
      expect(r.kinds, landmark).toEqual([]);
      expect(r.context.join(' ')).toMatch(landmark === 'header' ? /inside a page header/ : landmark === 'footer' ? /inside footer/ : /inside navigation/);
      expect(r.summary).toMatch(/not card|not panel|no component category/);
    }
  });

  it('it is the same soft veto as the audit\'s signal: typed evidence (audit type, DS component) keeps its kind in a landmark', () => {
    for (const landmark of ['navigation', 'footer', 'header'] as const) {
      expect(kindsOf(ev({ type: 'card', structure: structural({ landmark }) })), landmark).toEqual(['card']);
      expect(kindsOf(ev({ ds: 'ResourceCard', structure: structural({ landmark }) })), landmark).toEqual(['card']);
    }
  });

  it('the audit signal and the rendered landmark together state the context once', () => {
    const r = inferElementKinds(ev({ signals: ['inside navigation'], mapping: mapped({ tagName: 'li' }), structure: structural({ landmark: 'navigation' }) }));
    expect(r.context.filter((c) => c === 'inside navigation')).toHaveLength(1);
    expect(r.kinds).toEqual([]);
  });

  it('a landmark fact that is absent or null changes nothing (an older probe, a page without landmarks)', () => {
    const base = JSON.stringify(inferElementKinds(ev({ structure: structural() })));
    expect(JSON.stringify(inferElementKinds(ev({ structure: structural({ landmark: null }) })))).toBe(base);
  });

  it('facts read while the element\'s animations had not settled decide nothing - for or against - and say so; typed evidence is untouched', () => {
    const unsettled = ev({ mapping: mapped({ tagName: 'li' }), structure: structural({ settled: false }) });
    const r = inferElementKinds(unsettled);
    expect(r.kinds).toEqual([]);
    expect(r.context.join(' ')).toMatch(/animations had not settled/);
    expect(kindsOf(ev({ type: 'card', structure: structural({ settled: false }) }))).toEqual(['card']);
    // the same facts, settled, are used
    expect(kindsOf(ev({ mapping: mapped({ tagName: 'li' }), structure: structural({ settled: true }) }))).toEqual(['card']);
  });
});
