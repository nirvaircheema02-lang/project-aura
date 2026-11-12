import type { FindingCheck, IterationOutcome, StructuralDiff, VisionIssue, VisionVerdict } from '../types.ts';

/**
 * Q9's outcome rule, as a pure function so it is testable without a browser or a model:
 *
 *  PASS    every fix-decision finding deterministically re-verified fixed, no structural
 *          content/interactive-element loss, and the vision verdict is CONFIRMED or carries
 *          no CRITICAL/HIGH issue (a REJECTED verdict is never PASS).
 *  PARTIAL some but not all checks hold — its own explicit state, never silently PASS.
 *  FAIL    nothing was fixed, or content/functionality was lost — reported with exactly
 *          which checks failed and on which finding, never claimed complete.
 */
export function computeIterationOutcome(input: { checks: FindingCheck[]; structural: StructuralDiff; vision: VisionVerdict; visionIssues: VisionIssue[] }): { overall: IterationOutcome; failedChecks: string[] } {
  const failedChecks: string[] = [];
  for (const c of input.checks) if (!c.fixed) failedChecks.push(`finding ${c.findingId}: ${c.detail}`);
  if (!input.structural.ok) {
    for (const lost of input.structural.lostInteractive) failedChecks.push(`structural: interactive element lost — ${lost}`);
    for (const lost of input.structural.lostText) failedChecks.push(`structural: text content lost — ${lost}`);
    if (input.structural.lostInteractive.length === 0 && input.structural.lostText.length === 0) failedChecks.push(`structural: ${input.structural.note}`);
  }
  const severeIssues = input.visionIssues.filter((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH');
  for (const i of severeIssues) failedChecks.push(`vision (${i.severity}): ${i.description}`);
  if (input.vision === 'REJECTED') failedChecks.push('vision: verdict REJECTED — the after capture does not show the intended changes, or shows a regression');

  const fixedCount = input.checks.filter((c) => c.fixed).length;
  const allFixed = input.checks.length > 0 && fixedCount === input.checks.length;
  const visionOk = input.vision !== 'REJECTED' && severeIssues.length === 0;

  if (allFixed && input.structural.ok && visionOk) return { overall: 'PASS', failedChecks };
  if (!input.structural.ok || fixedCount === 0) return { overall: 'FAIL', failedChecks };
  return { overall: 'PARTIAL', failedChecks };
}
