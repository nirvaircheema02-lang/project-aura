import type { CoverageAction, CoverageGate, CoverageGateSummary, CoverageItem, CoverageItemState, CoverageLedger, CoverageRecovery } from '../../skills/s0-result-contract.ts';
import { roleOf, type ItemRecord } from './reconcile.ts';

/**
 * The Coverage Gate and the ledger it is computed from — pure. 100% ACCOUNTING, not a claim of 100% correctness:
 * every discovered item is in exactly one state, and the gate passes only when none is `UNACCOUNTED`.
 */

const EXAMPLES_PER_REASON = 4;
const LABEL_MAX = 80;

export function toCoverageItem(r: ItemRecord): CoverageItem {
  const label = r.raw.text.length > LABEL_MAX ? `${r.raw.text.slice(0, LABEL_MAX - 1)}…` : r.raw.text;
  const role = roleOf(r.raw, r.independent ?? undefined);
  return {
    id: r.raw.id,
    kind: r.raw.kind,
    ...(role ? { role } : {}),
    label: label || `(${r.raw.kind} with no text)`,
    section: r.sectionName,
    box: r.raw.box,
    where: [...r.raw.where, ...(r.raw.visibility !== 'visible' ? [r.raw.visibility] : [])],
    state: r.state,
    reason: r.reason,
    ...(r.finding ? { findingId: r.finding.identity.findingId } : r.component ? { findingId: r.component.findingId } : {}),
    passes: r.passes,
  };
}

/** The gate: `passed` only when nothing is unaccounted; `discovered` is the sum of the states by construction. */
export function gateOf(records: Pick<ItemRecord, 'state'>[]): CoverageGate {
  const count = (state: CoverageItemState) => records.filter((r) => r.state === state).length;
  const unaccounted = count('UNACCOUNTED');
  return {
    passed: unaccounted === 0,
    discovered: records.length,
    audited: count('AUDITED'),
    excluded: count('EXCLUDED_WITH_REASON'),
    needsReview: count('NEEDS_REVIEW'),
    captureFailed: count('CAPTURE_FAILED'),
    unaccounted,
  };
}

/** Does the gate's own arithmetic hold? (`discovered` must be exactly the sum of the five buckets.) */
export function gateIsConsistent(gate: CoverageGate): boolean {
  return gate.discovered === gate.audited + gate.excluded + gate.needsReview + gate.captureFailed + gate.unaccounted && gate.passed === (gate.unaccounted === 0);
}

export function buildLedger(
  records: ItemRecord[],
  extras: { actions: CoverageAction[]; passes: number; notes: string[]; sources: string[]; roleChecks: CoverageLedger['roleChecks']; recovery?: CoverageRecovery },
): CoverageLedger {
  const byKind: CoverageLedger['byKind'] = {};
  for (const r of records) {
    const row = (byKind[r.raw.kind] ??= { discovered: 0, audited: 0, excluded: 0, needsReview: 0, captureFailed: 0, unaccounted: 0 });
    row.discovered++;
    if (r.state === 'AUDITED') row.audited++;
    else if (r.state === 'EXCLUDED_WITH_REASON') row.excluded++;
    else if (r.state === 'NEEDS_REVIEW') row.needsReview++;
    else if (r.state === 'CAPTURE_FAILED') row.captureFailed++;
    else row.unaccounted++;
  }
  const grouped = new Map<string, { count: number; examples: string[] }>();
  for (const r of records) {
    if (r.state !== 'EXCLUDED_WITH_REASON') continue;
    const g = grouped.get(r.reason) ?? { count: 0, examples: [] };
    g.count++;
    if (g.examples.length < EXAMPLES_PER_REASON) g.examples.push(r.raw.text.slice(0, 48) || `(${r.raw.kind})`);
    grouped.set(r.reason, g);
  }
  const listed = (state: CoverageItemState) => records.filter((r) => r.state === state).map(toCoverageItem);
  return {
    schemaVersion: 1,
    gate: gateOf(records),
    sources: extras.sources,
    byKind,
    excludedByReason: [...grouped.entries()].map(([reason, g]) => ({ reason, count: g.count, examples: g.examples })).sort((a, b) => b.count - a.count),
    needsReview: listed('NEEDS_REVIEW'),
    captureFailed: listed('CAPTURE_FAILED'),
    unaccounted: listed('UNACCOUNTED'),
    roleChecks: extras.roleChecks,
    actions: extras.actions,
    passes: extras.passes,
    ...(extras.recovery ? { recovery: extras.recovery } : {}),
    notes: extras.notes,
  };
}

export type CoverageStatus = 'PASSED' | 'RECHECKING' | 'INCOMPLETE';

/**
 * The compact result for the Summary and the live CLI — nothing but the verdict and how much of the page is accounted
 * for: `Coverage: PASSED · 473 discovered · 473 accounted · 0 unaccounted` (a clean audit says exactly that), or
 * `Coverage: RECHECKING · 473 discovered · 227 remaining` while B7 is still recovering, or `INCOMPLETE` if it stopped
 * with items still unaccounted. Needs-review / capture-failed items are accounted for but never hidden: they are
 * named, only when there are some. Everything else is in the Coverage details.
 */
export function coverageLine(gate: Pick<CoverageGate, 'discovered' | 'unaccounted' | 'needsReview' | 'captureFailed'> & { pagesWithoutLedger?: number }, status: CoverageStatus): string {
  const head = `Coverage: ${status} · ${gate.discovered} discovered`;
  if (status === 'PASSED') {
    const extras = [gate.needsReview > 0 ? `${gate.needsReview} need review` : '', gate.captureFailed > 0 ? `${gate.captureFailed} capture failed` : ''].filter(Boolean);
    return [head, `${gate.discovered - gate.unaccounted} accounted`, `${gate.unaccounted} unaccounted`, ...extras].join(' · ');
  }
  if (gate.unaccounted === 0 && (gate.pagesWithoutLedger ?? 0) > 0) return `${head} · ${gate.pagesWithoutLedger} page(s) not checked`;
  return `${head} · ${gate.unaccounted} remaining`;
}

/** One line for the CLI and the reports — the six numbers the gate is made of. */
export function describeGate(gate: CoverageGate): string {
  return `${gate.passed ? 'PASSED' : 'INCOMPLETE'} — ${gate.discovered} discovered · ${gate.audited} audited · ${gate.excluded} excluded with reason · ${gate.needsReview} need review · ${gate.captureFailed} capture failed · ${gate.unaccounted} unaccounted`;
}

/** The gate across pages: `passed` only when EVERY page has a ledger and none of them has anything unaccounted. */
export function summarizeGates(pages: Array<{ url: string; ledger?: CoverageLedger | undefined }>): CoverageGateSummary {
  const sum: CoverageGateSummary = { passed: false, pages: pages.length, pagesWithoutLedger: 0, discovered: 0, audited: 0, excluded: 0, needsReview: 0, captureFailed: 0, unaccounted: 0, incomplete: [] };
  for (const p of pages) {
    if (!p.ledger) {
      sum.pagesWithoutLedger++;
      continue;
    }
    const g = p.ledger.gate;
    sum.discovered += g.discovered;
    sum.audited += g.audited;
    sum.excluded += g.excluded;
    sum.needsReview += g.needsReview;
    sum.captureFailed += g.captureFailed;
    sum.unaccounted += g.unaccounted;
    if (!g.passed) sum.incomplete.push({ pageUrl: p.url, unaccounted: p.ledger.unaccounted });
  }
  sum.passed = sum.pages > 0 && sum.pagesWithoutLedger === 0 && sum.incomplete.length === 0;
  return sum;
}
