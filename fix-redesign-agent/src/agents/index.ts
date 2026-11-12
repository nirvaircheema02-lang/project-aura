import { runR1 } from './r1-resolve-load/index.ts';
import { R2_STATUS, runR2 } from './r2-capture-original/index.ts';
import { R3_STATUS, runR3 } from './r3-redesign-plan/index.ts';
import { R4_STATUS, runR4 } from './r4-apply-render/index.ts';
import { R5_STATUS, runR5 } from './r5-compare/index.ts';
import { R6_STATUS, runR6 } from './r6-component-review/index.ts';
import { R7_STATUS, runR7 } from './r7-assemble-output/index.ts';
import { L1_STATUS, runL1 } from './l1-resolve-plan/index.ts';
import { L2_STATUS, runL2 } from './l2-component-builder/index.ts';
import { L2B_STATUS, runL2b } from './l2b-integrate/index.ts';
import { L3_STATUS, runL3 } from './l3-component-verifier/index.ts';
import { L4_STATUS, runL4 } from './l4-preview/index.ts';
import { L5_STATUS, runL5 } from './l5-publish/index.ts';
import { B1_STATUS, runB1 } from './b1-capture-behavior/index.ts';
import { R8_STATUS, runR8 } from './r8-react-preview/index.ts';
import { RV_STATUS, runRV } from './rv-resolve-targets/index.ts';
import { runC2 } from '../mapping/index.ts';
import type { NodeId } from '../node-id.ts';

export type NodeStatus = 'implemented' | 'not-implemented';

/**
 * Build status per node — the CLI reads this to refuse work that needs a node not yet
 * implemented, naming exactly which. S0 (session/discovery) has no separate node function of
 * its own type here since it produces a reference resolution, not a pipeline artifact — its
 * status is tracked by whether `session/discovery.ts` exists, which it does.
 */
export const NODE_STATUS: Record<NodeId, NodeStatus> = {
  S0: 'implemented',
  R1: 'implemented',
  R2: R2_STATUS,
  C2: 'implemented',
  B1: B1_STATUS,
  RV: RV_STATUS,
  R3: R3_STATUS,
  R4: R4_STATUS,
  R5: R5_STATUS,
  R6: R6_STATUS,
  R7: R7_STATUS,
  R8: R8_STATUS,
  L1: L1_STATUS,
  L2: L2_STATUS,
  L2b: L2B_STATUS,
  L3: L3_STATUS,
  L4: L4_STATUS,
  L5: L5_STATUS,
};

export function unimplementedNodes(): NodeId[] {
  return (Object.keys(NODE_STATUS) as NodeId[]).filter((id) => NODE_STATUS[id] !== 'implemented');
}

export { runRV, runR1, runR2, runR3, runR4, runR5, runR6, runR7, runR8, runB1, runC2, runL1, runL2, runL2b, runL3, runL4, runL5 };
