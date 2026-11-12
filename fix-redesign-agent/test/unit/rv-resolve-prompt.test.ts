import { describe, expect, it } from 'vitest';
import { describeResidual, SYSTEM_PROMPT } from '../../src/agents/rv-resolve-targets/index.ts';
import { inferElementKinds } from '../../src/reference/element-kind.ts';
import type { ResidualQuestion } from '../../src/resolution/resolve.ts';

/** What the Resolver's judgment is shown: the INFERRED kind and why — not just a tag it could mistake for a category. */

const question = (over: { type: string; tag: string; ds?: string | null; note?: string | null; candidates?: ResidualQuestion['candidatePatterns'] }): ResidualQuestion => {
  const inference = inferElementKinds({
    audit: { productionType: over.type, dsComponent: over.ds ?? null, signals: [], possibleMatches: [] },
    mapping: { tagName: over.tag, role: null, href: null, type: null, ariaExpanded: null, ariaControls: null, dsComponent: null, dsBasis: 'none' },
    structure: null,
  });
  return {
    findingId: 'f1', section: 'Blog', productionType: over.type, productionLabel: 'Credit Card offers', classification: 'NEEDS_REVIEW', reviewReason: null, signals: [], possibleMatches: [],
    dsReference: { dsComponent: null, dsVariant: null, basis: 'none' }, surface: 'light', element: { selector: '[data-fra-element="e1"]', tag: over.tag, role: null },
    properties: [{ property: 'border-top-color', actual: 'rgb(0, 0, 0)', auditStatus: 'UNRESOLVED', reason: 'no-ds-requirement', rationale: 'x', currentOutcome: 'preserve-existing' }],
    elementKinds: inference, candidatePatterns: over.candidates ?? [], candidatePatternsNote: over.note ?? null,
  };
};

const flat = { project: 'competition-benchmarking-v2-react', pattern: 'flat-hairline-card', purpose: 'light card separation', declarations: { border: '1px solid var(--border-soft)' }, preferred: true, elementKinds: ['card', 'panel'] };

describe('RV prompt — the element kind', () => {
  it('shows the inferred kind with its evidence, calls the tag a tag, and lists what each candidate fits', () => {
    const text = describeResidual(question({ type: 'card', tag: 'div', ds: 'Card', candidates: [flat] }));
    expect(text).toMatch(/kind=card \(high: audit type card; DS component Card\)/);
    expect(text).toMatch(/<div> \(a tag, not a component category\)/);
    expect(text).not.toMatch(/element=div\b/);
    expect(text).toMatch(/flat-hairline-card.*fits: card, panel/);
  });

  it('says plainly that a bare div is unclassified and why there are no candidates', () => {
    const text = describeResidual(question({ type: 'unknown-thing', tag: 'div', note: 'no approved pattern can be offered: no component category could be established for this element' }));
    expect(text).toMatch(/kind=unclassified/);
    expect(text).toMatch(/a tag or ARIA role alone does not name a component category/);
    expect(text).toMatch(/approved candidate patterns: none — no approved pattern can be offered/);
  });

  it('names the kinds that were rejected', () => {
    const text = describeResidual(question({ type: 'icon-button', tag: 'div' }));
    expect(text).toMatch(/kind=button/);
    expect(text).not.toMatch(/kind=card/);
  });

  it('the system prompt states that a tag/role is not a kind and that the reason is not evidence', () => {
    expect(SYSTEM_PROMPT).toMatch(/tag or ARIA role is not a component kind/);
    expect(SYSTEM_PROMPT).toMatch(/reason is not evidence/);
    expect(SYSTEM_PROMPT).toMatch(/re-verified against this inference/);
  });
});
