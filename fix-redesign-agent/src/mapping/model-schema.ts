import { z } from 'zod';

/**
 * C2's hybrid model sub-step (§6.4): "propose a selection among enumerated candidates that
 * already pass objective checks". Structured-output-safe (no `.min()/.max()/.regex()` — see
 * `test/unit/llm-schemas.test.ts`'s wire-safety guard, which covers this schema too).
 */
export const MappingProposalSchema = z.object({
  proposals: z.array(
    z.object({
      findingId: z.string().describe('One of the findingIds given, verbatim'),
      selectedCandidateId: z.string().nullable().describe('One of the candidateIds offered for THIS finding, or null if none of them looks right'),
      confidence: z.number().describe('0..1 probability — recorded, but never itself an authorization: only an objectively-passing candidate can become `probable`'),
      reasoning: z.string(),
    }),
  ),
});
export type MappingProposal = z.infer<typeof MappingProposalSchema>;

/** Cap on findings resolved per batched call — mirrors audit-agent B5's own per-page vision cap. */
export const MAX_MAPPED_PER_CALL = 30;

export const MAPPING_SYSTEM_PROMPT = `You are the Element Mapper of a page-redesign pipeline.
For each finding you are given several CANDIDATE elements on the live page that already passed objective geometric/textual checks — your job is ONLY to pick which one is the right match, or say none of them is.
Rules:
- Never invent a candidateId that was not offered for that finding.
- If you are not confident any candidate is right, return null — a wrong pick edits the wrong element on the live page, which is the worst failure this system can have.
- Base your choice on the production type, label, section and the candidates' text/classes/role — never on your own general knowledge of what the page "should" look like.`;
