import { describe, expect, it } from 'vitest';
import { buildLedger, describeGate, gateIsConsistent, gateOf, summarizeGates } from '../../src/agents/b7-coverage-qa/ledger.ts';
import type { ItemRecord } from '../../src/agents/b7-coverage-qa/reconcile.ts';
import type { CoverageItemState, CoverageLedger } from '../../src/skills/s0-result-contract.ts';

/**
 * B7's Coverage Gate — 100% ACCOUNTING, not a claim of 100% correctness. Every discovered item is in exactly one
 * state and the gate passes ONLY when nothing is unaccounted. Pure arithmetic, no page.
 */

const record = (state: CoverageItemState, over: { id?: string; text?: string; reason?: string; kind?: ItemRecord['raw']['kind'] } = {}): ItemRecord => ({
  raw: {
    id: over.id ?? `b7-${Math.random().toString(36).slice(2, 7)}`, kind: over.kind ?? 'text', role: 'paragraph', tag: 'p', text: over.text ?? 'Some words', box: { x: 0, y: 0, width: 100, height: 20 },
    visibility: 'visible', where: [], reveal: { kind: null, hostSelector: null, controlSelector: null }, place: { inNavigation: false, inFooter: false, insideOwner: false, ownerText: null },
    stamps: { self: [], inner: [], owner: [] }, source: 'dom',
    facts: { tag: 'p', classes: [], roleAttr: null, cursor: 'auto', text: over.text ?? 'Some words', hasSvg: false, hasImg: false, ownText: true, childElementCount: 0, style: { backgroundColor: '', backgroundImage: '', borderTopWidth: '', borderTopStyle: '', paddingLeft: '', paddingTop: '', color: '', fontSize: '16px', fontWeight: '400', display: 'block', opacity: '1', visibility: 'visible', textTransform: '', letterSpacing: '' }, box: { x: 0, y: 0, width: 100, height: 20 } },
  },
  sectionId: 's0', sectionName: 'Hero', aria: null, component: null, finding: null, independent: null, state, reason: over.reason ?? 'because', gap: null, passes: 0,
});

describe('the Coverage Gate passes only when unaccounted = 0', () => {
  it('every item accounted for → passed, and discovered is exactly the sum of the states', () => {
    const gate = gateOf([record('AUDITED'), record('AUDITED'), record('EXCLUDED_WITH_REASON'), record('NEEDS_REVIEW'), record('CAPTURE_FAILED')]);
    expect(gate).toEqual({ passed: true, discovered: 5, audited: 2, excluded: 1, needsReview: 1, captureFailed: 1, unaccounted: 0 });
    expect(gateIsConsistent(gate)).toBe(true);
  });

  it('ONE unaccounted item → the gate FAILS (the audit is incomplete), however much else was audited', () => {
    const gate = gateOf([...Array.from({ length: 200 }, () => record('AUDITED')), record('UNACCOUNTED')]);
    expect(gate.passed).toBe(false);
    expect(gate.unaccounted).toBe(1);
    expect(gate.discovered).toBe(201);
    expect(gateIsConsistent(gate)).toBe(true);
  });

  it('needs review and capture failed are ACCOUNTED for — they do not fail the gate (a human sees them), only unaccounted does', () => {
    expect(gateOf([record('NEEDS_REVIEW'), record('CAPTURE_FAILED')]).passed).toBe(true);
  });

  it('an empty page is not a pass by arithmetic alone across a run (no pages, no claim) — see the cross-page summary below', () => {
    expect(gateOf([]).passed).toBe(true); // nothing was discovered, nothing is missing
    expect(summarizeGates([]).passed).toBe(false); // …but a run with no audited page makes no gate claim
  });

  it('a gate whose numbers do not add up is detected', () => {
    expect(gateIsConsistent({ passed: true, discovered: 5, audited: 2, excluded: 1, needsReview: 1, captureFailed: 0, unaccounted: 0 })).toBe(false);
    expect(gateIsConsistent({ passed: true, discovered: 1, audited: 0, excluded: 0, needsReview: 0, captureFailed: 0, unaccounted: 1 })).toBe(false);
  });

  it('the one-line description carries all six numbers and the verdict', () => {
    expect(describeGate(gateOf([record('AUDITED'), record('UNACCOUNTED')]))).toBe('INCOMPLETE — 2 discovered · 1 audited · 0 excluded with reason · 0 need review · 0 capture failed · 1 unaccounted');
    expect(describeGate(gateOf([record('AUDITED')]))).toBe('PASSED — 1 discovered · 1 audited · 0 excluded with reason · 0 need review · 0 capture failed · 0 unaccounted');
  });
});

describe('the ledger shows exactly what is missing and why everything else is where it is', () => {
  const extras = { actions: [], passes: 1, notes: ['2 embedded frame(s)'], sources: ['dom'], roleChecks: { checked: 3, inconsistent: 1, corrected: 1, unresolved: 0 } };

  it('every unaccounted item is listed IN FULL with its reason — never summarised away', () => {
    const ledger = buildLedger([record('AUDITED'), record('UNACCOUNTED', { id: 'b7-9', text: 'Step 06', reason: 'collapsed behind a carousel' }), record('UNACCOUNTED', { id: 'b7-10', text: 'Step 07', reason: 'collapsed behind a carousel' })], extras);
    expect(ledger.gate.passed).toBe(false);
    expect(ledger.unaccounted.map((i) => [i.id, i.label, i.reason])).toEqual([['b7-9', 'Step 06', 'collapsed behind a carousel'], ['b7-10', 'Step 07', 'collapsed behind a carousel']]);
  });

  it('every exclusion is grouped by its stated reason, with examples — an exclusion without a reason cannot exist', () => {
    const reason = 'a member of a repeated listing — bounded listing sampling audits the first 5 per group';
    const ledger = buildLedger([...Array.from({ length: 7 }, (_, i) => record('EXCLUDED_WITH_REASON', { text: `Report ${i}`, reason })), record('EXCLUDED_WITH_REASON', { text: 'Skip to content', reason: 'visually hidden' })], extras);
    expect(ledger.excludedByReason).toEqual([
      { reason, count: 7, examples: ['Report 0', 'Report 1', 'Report 2', 'Report 3'] },
      { reason: 'visually hidden', count: 1, examples: ['Skip to content'] },
    ]);
    expect(ledger.excludedByReason.every((e) => e.reason.trim().length > 0)).toBe(true);
  });

  it('needs-review and capture-failed items are listed in full, and the per-kind counts add up to the gate', () => {
    const ledger = buildLedger([record('NEEDS_REVIEW', { text: 'Pricing', kind: 'control' }), record('CAPTURE_FAILED', { text: 'Gone', kind: 'text' }), record('AUDITED', { kind: 'control' })], extras);
    expect(ledger.needsReview.map((i) => i.label)).toEqual(['Pricing']);
    expect(ledger.captureFailed.map((i) => i.label)).toEqual(['Gone']);
    expect(ledger.byKind.control).toEqual({ discovered: 2, audited: 1, excluded: 0, needsReview: 1, captureFailed: 0, unaccounted: 0 });
    const total = Object.values(ledger.byKind).reduce((n, r) => n + r.discovered, 0);
    expect(total).toBe(ledger.gate.discovered);
  });
});

describe('the gate across pages', () => {
  const page = (url: string, records: ItemRecord[]): { url: string; ledger: CoverageLedger } => ({ url, ledger: buildLedger(records, { actions: [], passes: 0, notes: [], sources: [], roleChecks: { checked: 0, inconsistent: 0, corrected: 0, unresolved: 0 } }) });

  it('passes only when EVERY page has a ledger and none has anything unaccounted', () => {
    const ok = summarizeGates([page('https://x/a', [record('AUDITED')]), page('https://x/b', [record('AUDITED'), record('EXCLUDED_WITH_REASON')])]);
    expect(ok).toMatchObject({ passed: true, pages: 2, pagesWithoutLedger: 0, discovered: 3, audited: 2, excluded: 1, unaccounted: 0, incomplete: [] });
  });

  it('one incomplete page makes the audit incomplete, and says exactly which items are missing on which page', () => {
    const sum = summarizeGates([page('https://x/a', [record('AUDITED')]), page('https://x/b', [record('UNACCOUNTED', { text: 'Lost words' })])]);
    expect(sum.passed).toBe(false);
    expect(sum.unaccounted).toBe(1);
    expect(sum.incomplete).toHaveLength(1);
    expect(sum.incomplete[0]).toMatchObject({ pageUrl: 'https://x/b' });
    expect(sum.incomplete[0]!.unaccounted.map((i) => i.label)).toEqual(['Lost words']);
  });

  it('a page with NO ledger (reused from a run that predates B7) cannot be claimed accounted for — the gate does not pass', () => {
    const sum = summarizeGates([page('https://x/a', [record('AUDITED')]), { url: 'https://x/old' }]);
    expect(sum.passed).toBe(false);
    expect(sum.pagesWithoutLedger).toBe(1);
  });
});
