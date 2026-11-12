import { z } from 'zod';
import { FindingSchema } from './finding-schema.ts';
import { parseWith } from './parse.ts';

/**
 * Read-side contract for a run's `data.json` (audit-agent's C2 output — the SOLE canonical
 * truth of an audit, its Decision Log #19). Only what this pipeline consumes is required;
 * everything else C2 writes (summaries, coverage, re-audit blocks…) passes through untouched
 * via `looseObject` so nothing is lost if R7 wants to echo it.
 */
export const AuditRunInfoSchema = z.looseObject({
  runId: z.string(),
  /** The URL the audit actually captured — R2 navigates HERE, never to a re-typed URL. */
  targetUrl: z.string(),
  auditId: z.string().optional(),
  mode: z.string().optional(),
  startedAt: z.string().optional(),
  dsRegistryVersion: z.string().optional(),
  policyVersion: z.string().optional(),
  aiMode: z.string().optional(),
  /** §8.9: validation and the default preview viewport are the audit's OWN viewport — typed here (rather than left to `looseObject`'s pass-through) so R2 can read it without an unsafe cast. Optional: older runs may predate this field, and R2 falls back to the engine's own default in that case. */
  renderingPolicy: z.looseObject({ viewport: z.object({ width: z.number(), height: z.number() }).optional() }).optional(),
});
export type AuditRunInfo = z.infer<typeof AuditRunInfoSchema>;

export const AuditDataSchema = z.looseObject({
  schemaVersion: z.number(),
  run: AuditRunInfoSchema,
  findings: z.array(FindingSchema),
});
export type AuditData = z.infer<typeof AuditDataSchema>;

export function parseAuditData(json: unknown, path: string): AuditData {
  return parseWith(AuditDataSchema, json, 'data.json', path);
}
