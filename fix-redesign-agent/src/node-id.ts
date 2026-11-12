import type { ExecutionType } from './retry.ts';

/**
 * The unified node id spanning BOTH workflows — kept in its own zero-dependency file so
 * `agents/types.ts` (Workflow A contracts) and `library/types.ts` (Workflow B contracts) can
 * both reference it, and the orchestrator's tracing (one span per node, per attempt) and
 * `RedesignPipelineError` stay meaningful across the whole graph, not just Workflow A
 * (ARCHITECTURE.md §7.1's spine, §3.2's six roles plus the deterministic stages around them).
 */
export type NodeId = 'S0' | 'R1' | 'R2' | 'C2' | 'B1' | 'RV' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'L1' | 'L2' | 'L2b' | 'L3' | 'L4' | 'L5';

export const NODE_EXECUTION_TYPE: Record<NodeId, ExecutionType> = {
  S0: 'deterministic',
  R1: 'deterministic',
  R2: 'deterministic',
  C2: 'hybrid',
  B1: 'deterministic',
  RV: 'hybrid',
  R3: 'ai',
  R4: 'deterministic',
  R5: 'hybrid',
  R6: 'deterministic',
  R7: 'deterministic',
  R8: 'deterministic',
  L1: 'deterministic',
  L2: 'ai',
  L2b: 'deterministic',
  L3: 'hybrid',
  L4: 'deterministic',
  L5: 'deterministic',
};
