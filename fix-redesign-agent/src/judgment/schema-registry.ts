import type { z } from 'zod';
import { CompareVerdictsSchema, RedesignPlanSchema } from '../llm/schemas/r-nodes.ts';
import { AcceptanceReviewSchema, ComponentBuildSchema } from '../llm/schemas/l-nodes.ts';
import { MappingProposalSchema } from '../mapping/model-schema.ts';
import { ResolutionJudgmentSchema } from '../resolution/judgment-schema.ts';

/**
 * The six judgment-bearing nodes' OWN Zod schemas, by nodeId — the single source of truth
 * both `test/unit/llm-schemas.test.ts` (wire-safety) and the `judgment submit` CLI command
 * (validating a Session Agent's submitted result before it can ever reach a node) validate
 * against. A submitted judgment is checked against the REAL schema here, never just the
 * looser JSON Schema shape recorded in the pending bundle.
 */
export const JUDGMENT_NODE_IDS = ['C2', 'RV', 'R3', 'R5', 'L2', 'L3'] as const;
export type JudgmentNodeId = (typeof JUDGMENT_NODE_IDS)[number];

export const JUDGMENT_SCHEMAS: Record<JudgmentNodeId, z.ZodType> = {
  C2: MappingProposalSchema,
  RV: ResolutionJudgmentSchema,
  R3: RedesignPlanSchema,
  R5: CompareVerdictsSchema,
  L2: ComponentBuildSchema,
  L3: AcceptanceReviewSchema,
};

export function isJudgmentNodeId(nodeId: string): nodeId is JudgmentNodeId {
  return (JUDGMENT_NODE_IDS as readonly string[]).includes(nodeId);
}
