import { z } from 'zod';

/**
 * READ-SIDE copy of audit-agent's S0 Audit Result Contract — the schema portion of
 * `src/skills/s0-result-contract.ts` (v1.0 §12 + the v1.1 additive fields), vendored
 * 2026-09-18 (Decision Log #6). This repo only ever READS findings, so the scoring and
 * labelling helpers that live next to the schema in audit-agent are deliberately absent.
 *
 * zod strips keys it doesn't know, so an additive field audit-agent adds later is
 * ignored here; a field it removes or renames fails loudly with the field named —
 * never a silent misread of the data this whole pipeline is driven by.
 */

export const ClassificationSchema = z.enum(['MATCH', 'DEVIATION', 'INCORRECT', 'NEW_COMPONENT', 'DS_CANDIDATE', 'NEEDS_REVIEW', 'UNVERIFIED']);
export type Classification = z.infer<typeof ClassificationSchema>;

export const SeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ConfidenceBandSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export const EscalationStatusSchema = z.enum(['NONE', 'QUEUED', 'IN_REVIEW', 'RESOLVED']);
export const ReAuditDeltaSchema = z.enum(['NEW_ISSUE', 'STILL_OPEN', 'RESOLVED', 'REGRESSION', 'UNCHANGED_COMPLIANT']);

/** One measurable property difference — produced deterministically by audit-agent, never by a model's arithmetic. R3 turns these into targeted edits. */
export const MismatchSchema = z.object({
  property: z.string(),
  actual: z.string(),
  expected: z.string(),
  /** The DS token the expected value came from, when it came from one. */
  expectedToken: z.string().nullable(),
  comparison: z.enum(['exact', 'color-deltaE', 'length-px', 'unsupported']),
  delta: z.number().nullable(),
});
export type Mismatch = z.infer<typeof MismatchSchema>;

/**
 * One entry of `comparison.properties[]` — the audit's per-property record: every property it considered for
 * the finding, with WHY a value is unresolved in `note`. `mismatches` is only the comparable subset of this
 * list (status DIFFERENT with an expected value). Read-only here: the resolver stage records its own
 * decisions about UNRESOLVED properties separately and never edits this data.
 */
export const AuditPropertySchema = z.object({
  property: z.string(),
  actual: z.string().nullable(),
  expected: z.string().nullable(),
  expectedToken: z.string().nullable(),
  /** The DS file the expectation came from (e.g. `atoms/Button.tsx`); null when the audit found no DS requirement. */
  source: z.string().nullable(),
  status: z.enum(['DIFFERENT', 'MATCH', 'UNRESOLVED']),
  note: z.string().nullable(),
});
export type AuditProperty = z.infer<typeof AuditPropertySchema>;

export const EvidenceRefSchema = z.object({
  kind: z.enum(['element-screenshot', 'context-screenshot', 'page-tile', 'computed-style', 'aria-line', 'console-message', 'ds-source']),
  ref: z.string(),
  note: z.string().nullable(),
  /** Page-absolute geometry of the element this evidence is about, when known — R3's strongest hint for locating the element on the live page. */
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const PossibleMatchSchema = z.object({
  dsComponent: z.string(),
  dsFile: z.string(),
  dsVariant: z.string().nullable(),
  score: z.number(),
  why: z.string(),
});

export const ReviewSchema = z.object({
  status: z.enum(['NEEDS_REVIEW', 'UNVERIFIED']),
  reason: z.string(),
  node: z.string(),
  signals: z.array(z.string()),
  possibleMatches: z.array(PossibleMatchSchema),
  observed: z.array(z.object({ property: z.string(), actual: z.string(), expected: z.string().nullable(), expectedToken: z.string().nullable() })),
});

export const FindingSchema = z.object({
  identity: z.object({
    auditId: z.string(),
    runId: z.string(),
    /** The ONLY join key between data.json and fix-plan.json (Part 1). Stable across re-audits; excludes layout coordinates. */
    findingId: z.string(),
    timestamp: z.string(),
    dsRegistryVersion: z.string(),
    policyVersion: z.string(),
  }),
  location: z.object({
    url: z.string(),
    pageId: z.string(),
    pageName: z.string(),
    templateFamily: z.string().nullable(),
    /** Free text by design (not a stable selector) — which is why element mapping is R3's LLM-assisted job (Q7). */
    section: z.string(),
    captureState: z.string(),
  }),
  component: z.object({
    productionType: z.string(),
    productionLabel: z.string(),
    dsComponent: z.string().nullable(),
    dsVariant: z.string().nullable(),
    signature: z.string(),
  }),
  classification: ClassificationSchema,
  comparison: z.object({
    mismatches: z.array(MismatchSchema),
    /** Optional: audits older than the per-property record carry only `mismatches`. */
    properties: z.array(AuditPropertySchema).optional(),
    ruleViolations: z.array(
      z.object({
        ruleId: z.string(),
        title: z.string(),
        why: z.string(),
        severity: SeveritySchema.optional(),
      }),
    ),
  }),
  quality: z.object({
    severity: SeveritySchema,
    confidence: z.number(),
    confidenceBand: ConfidenceBandSchema,
    escalationStatus: EscalationStatusSchema,
    escalationReasons: z.array(z.string()),
    evidence: z.array(EvidenceRefSchema),
    visualVerdict: z.enum(['CONFIRMED', 'FALSE_POSITIVE', 'UNCERTAIN', 'NOT_CHECKED']),
  }),
  action: z.object({
    recommendation: z.string(),
    rootCauseRef: z.string().nullable(),
    dsCandidateNote: z.string().nullable(),
    registryUpdateRef: z.string().nullable(),
  }),
  history: z.object({
    previousStatus: ClassificationSchema.nullable(),
    currentStatus: ClassificationSchema,
    delta: ReAuditDeltaSchema.nullable(),
    previousRunId: z.string().nullable(),
    absentThisRun: z.boolean().optional(),
    baselineChanged: z.array(z.string()).optional(),
    baselineOf: z
      .object({
        runId: z.string(),
        dsRegistryVersion: z.string(),
        policyVersion: z.string(),
        dsComponent: z.string().nullable(),
        dsVariant: z.string().nullable(),
      })
      .optional(),
  }),
  review: ReviewSchema.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
