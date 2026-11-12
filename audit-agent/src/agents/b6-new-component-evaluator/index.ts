import { applyDeterministicLayoutChecks } from '../b5-visual-verifier/index.ts';
import { evaluateUnmatched } from './evaluate.ts';
import type { NodeContext } from '../../graph/engine.ts';
import type { B4Output, B6Output, PageSession } from '../types.ts';

/**
 * B6 — New Component Evaluator (v1.0 §4): when no approved DS component exists, decide New Component
 * vs DS Candidate based on foundation compliance and reuse (the evaluation itself is `evaluate.ts`).
 * This node runs it for the components B3 left without a Design System family. B5's completeness pass
 * runs the SAME evaluation for a component it recovered that B3 found no family for, so a recovered
 * element reaches B6 exactly as a first-pass one does — and B5 hands this node nothing twice: whatever
 * it evaluated is not in `input.unmatched`.
 */

export { foundationCompliance, PLAUSIBLE_MATCH_SCORE } from './evaluate.ts';

export async function runB6(ctx: NodeContext, input: B4Output & { session: PageSession }): Promise<B6Output> {
  const session = input.session;
  if (input.unmatched.length === 0) return input;

  const created = await evaluateUnmatched(session, input, input.unmatched);
  // B4's findings already went through B5's layout pass; B6's own are new as of this node and
  // never got one (B6 runs after B5 in the graph) — measured here instead (third-pass review F5).
  // Only the findings THIS node just created — B4's must not be measured a second time, which would
  // duplicate their visual: mismatches.
  const own = session.aiMode === 'no-api' ? await applyDeterministicLayoutChecks(session, created, input.components) : created;
  return { ...input, findings: [...input.findings, ...own] };
}
