/**
 * Run types, design modes, gates, approvals and run-outcome model — ARCHITECTURE.md §1.3,
 * §8.1, §11, §7.7. These are the vocabulary the orchestrator and the CLI's `decide` command
 * share; the actual gate mechanics (fingerprinting, persistence) live in `decisions.ts`.
 */

export const RUN_TYPES = ['redesign', 'combined', 'components'] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const DESIGN_MODES = ['full-page', 'selected-sections'] as const;
export type DesignMode = (typeof DESIGN_MODES)[number];

export const GATES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'] as const;
export type Gate = (typeof GATES)[number];

/** §7.7: two axes, never conflated. A unit is one Fix finding in Workflow A, or one component in Workflow B. */
export const UNIT_STATES = ['done', 'blocked', 'awaiting-approval', 'failed'] as const;
export type UnitState = (typeof UNIT_STATES)[number];

/**
 * §7.7: the most severe unit state present, in this order, plus `running` while a run is in
 * progress. `awaiting-judgment` (judgmentProvider) is a distinct pause from `awaiting-approval`:
 * a human gate (G0–G5) waits on a DECISION; `awaiting-judgment` waits on a Session Agent
 * performing C2/R3/R5/L2/L3's judgment role itself, via `judgment submit` — never a gate, and
 * never aggregated from unit states (set directly by the orchestrator, same as
 * `awaiting-approval` sometimes is, per §11).
 */
export const RUN_OUTCOME_STATES = ['running', 'failed', 'blocked', 'awaiting-judgment', 'awaiting-approval', 'completed'] as const;
export type RunOutcomeState = (typeof RUN_OUTCOME_STATES)[number];

const SEVERITY_ORDER: Record<Exclude<UnitState, 'done'>, number> = { failed: 3, blocked: 2, 'awaiting-approval': 1 };

/**
 * §7.7's aggregation rule: `completed` only when every requested unit is `done`; otherwise
 * the most severe state present. An empty unit list (nothing was requested) is `completed` —
 * a `components` run with no page units requested is not "blocked" on work nobody asked for.
 */
export function aggregateRunOutcome(unitStates: UnitState[]): RunOutcomeState {
  if (unitStates.length === 0) return 'completed';
  let worst: Exclude<UnitState, 'done'> | null = null;
  for (const s of unitStates) {
    if (s === 'done') continue;
    if (!worst || SEVERITY_ORDER[s] > SEVERITY_ORDER[worst]) worst = s;
  }
  return worst ?? 'completed';
}

// ── Gate outcomes (one union member per gate, per §11.2) ────────────────────────────────────

export type G0Outcome = 'proceed' | 'stop';
export type G1Outcome = 'resolved';
export type G2Outcome = 'approve' | 'request-changes';
/** G3 has no chat outcome — the export itself IS the decision (§10a). Recorded here only for `decisions.json` bookkeeping. */
export type G3Outcome = 'exported' | 'reused';
export type G4Outcome = 'approve-and-push' | 'approve-design' | 'request-changes';
export type G5Outcome = 'approve' | 'decline';
export type GateOutcome = G0Outcome | G1Outcome | G2Outcome | G3Outcome | G4Outcome | G5Outcome;

/** §11.3: what each gate's fingerprint is computed over — the exact recomputation each gate's reuse check runs. */
export interface GateFingerprintInputs {
  G2: { exportedDocumentPaths: string[]; validationResultsPath: string };
  G3: { selectionPath: string; upstreamPlanPath: string | null };
  G4: { componentId: string; builtFilePaths: string[]; previewPaths: string[]; acceptancePath: string };
  G5: { branch: string; remote: string | null; baseBranch: string | null; files: Array<{ path: string; blobSha256: string }> };
}
