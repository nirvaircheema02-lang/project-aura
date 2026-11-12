import { resolveL1 } from '../../library/resolve.ts';
import type { NewComponentPlan } from '../../library/new-component-plan-schema.ts';
import type { ComponentSelection } from '../../library/selection-schema.ts';
import type { ComponentManifest } from '../../manifest/schema.ts';
import type { L1Output } from '../../library/types.ts';

/**
 * L1 — Resolve Plan (deterministic, asks; §9.1). Thin node wrapper — the resolution logic
 * itself lives in `library/resolve.ts` so it is testable without a manifest built from a
 * real run.
 */

export const L1_STATUS = 'implemented' as const;

export interface L1NodeInput {
  redesignRunId: string;
  manifest: ComponentManifest;
  upstreamPlan: NewComponentPlan | null;
  checklistSelection: ComponentSelection | null;
}

export async function runL1(deps: { log?: (line: string) => void }, input: L1NodeInput): Promise<L1Output> {
  const log = deps.log ?? (() => {});
  const result = resolveL1(input.redesignRunId, input.manifest, input.upstreamPlan, input.checklistSelection);
  log(`L1 · ${result.specs.length} spec(s) resolved · ${result.ambiguous.length} ambiguous · ${result.blocked.length} blocked · ${result.resolvedPlan.disagreements.length} plan disagreement(s)`);
  return result;
}
