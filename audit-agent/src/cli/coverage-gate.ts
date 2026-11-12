import { coverageLine, describeGate } from '../agents/b7-coverage-qa/ledger.ts';
import type { AuditData } from '../agents/c2-json-writer/index.ts';
import type { CoverageProgress } from '../skills/s0-result-contract.ts';

/**
 * B7's Coverage Gate as the CLI states it — a pure function over the audit's own data (`coverageSummary.gate`), so
 * the wording and the exit decision are tested without running an audit. An audit with anything unaccounted must
 * never read as a clean success: it says so on stderr, lists exactly what is missing, and the process exits 3. A run
 * that predates B7 (no gate recorded) says it makes no claim — it is never shown as a pass.
 */

/** The exit code of an audit that finished but is INCOMPLETE (distinct from 1 = the audit itself failed). */
export const COVERAGE_INCOMPLETE_EXIT_CODE = 3;

/** How many missing items are listed on the terminal; every one of them is in `data.json` and the HTML report. */
const LISTED_ON_TERMINAL = 25;

export interface CoverageGateReport {
  /** The one-line statement for stdout. */
  line: string;
  /** Lines for stderr — empty when the gate passed (or was never recorded). */
  errors: string[];
  /** True when the audit is INCOMPLETE and the process must exit with `COVERAGE_INCOMPLETE_EXIT_CODE`. */
  incomplete: boolean;
}

/** The live state while B7 re-checks a page that had unaccounted items: `Coverage: RECHECKING · 473 discovered · 227 remaining`. */
export function coverageProgressLine(progress: CoverageProgress): string {
  return coverageLine({ discovered: progress.discovered, unaccounted: progress.remaining, needsReview: 0, captureFailed: 0 }, 'RECHECKING');
}

/** Text of the audited page reaches the terminal here: control characters (an ANSI escape in a page's text) never do. */
const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');

export function coverageGateReport(data: AuditData): CoverageGateReport {
  const gate = data.coverageSummary?.gate;
  if (!gate) return { line: 'Coverage gate: not recorded (this audit predates the B7 final coverage check)', errors: [], incomplete: false };
  const line = `Coverage gate: ${describeGate(gate)}`;
  if (gate.passed) return { line, errors: [], incomplete: false };

  const missing = gate.incomplete.flatMap((page) => page.unaccounted.map((item) => ({ page: page.pageUrl, item })));
  const errors = [
    `\nAUDIT INCOMPLETE — ${gate.unaccounted} item(s) found on the page are not accounted for${gate.pagesWithoutLedger > 0 ? ` and ${gate.pagesWithoutLedger} page(s) carry no coverage ledger` : ''}:`,
    ...missing.slice(0, LISTED_ON_TERMINAL).map(({ page, item }) => printable(`  · ${page} — ${item.kind} “${item.label}” (${item.section}): ${item.reason}`)),
  ];
  if (missing.length > LISTED_ON_TERMINAL) errors.push(`  … and ${missing.length - LISTED_ON_TERMINAL} more (all listed in the HTML report and data.json)`);
  return { line, errors, incomplete: true };
}
