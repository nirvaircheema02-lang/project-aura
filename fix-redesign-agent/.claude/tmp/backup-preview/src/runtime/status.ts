/**
 * Reads /pv-status.json for the preview chrome. Plain TypeScript with no React or DOM so the agent's tests can run it: the wording
 * must stay identical to `statusHeadline` in the agent's src/preview/status.ts (a test compares them).
 */

export type PvVerdict = 'pass' | 'fail' | 'incomplete';
export interface PvGap { kind: 'failed' | 'unverified'; family: string; text: string }

export interface PvStatus {
  runId: string;
  mode: string;
  sections: string[];
  simulated: string[];
  unavailable: string[];
  /** null while the verification has not run yet (the file the generator writes first). */
  verdict: PvVerdict | null;
  failedRequired: number;
  unverifiedRequired: number;
  gaps: PvGap[];
  gapsTruncated: number;
  /** Optional / by-design limitations: never part of the verdict. */
  disclosed: string[];
  disclosedTruncated: number;
  /** False for a status file written before the required-check summary existed: its verdict cannot say what was left unverified. */
  detailed: boolean;
}

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);

export function readStatus(raw: unknown): PvStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const verdict: PvVerdict | null = r.verdict === 'pass' || r.verdict === 'fail' || r.verdict === 'incomplete' ? r.verdict : null;
  const gaps: PvGap[] = Array.isArray(r.gaps)
    ? r.gaps.flatMap((g) => { const o = g as Record<string, unknown> | null; return o && (o.kind === 'failed' || o.kind === 'unverified') && typeof o.text === 'string' ? [{ kind: o.kind, family: typeof o.family === 'string' ? o.family : '', text: o.text }] : []; })
    : [];
  return {
    runId: typeof r.runId === 'string' ? r.runId : '', mode: typeof r.mode === 'string' ? r.mode : '', sections: strings(r.sections), simulated: strings(r.simulated), unavailable: strings(r.unavailable),
    verdict, failedRequired: count(r.failedRequired), unverifiedRequired: count(r.unverifiedRequired), gaps, gapsTruncated: count(r.gapsTruncated), disclosed: strings(r.disclosed), disclosedTruncated: count(r.disclosedTruncated),
    detailed: typeof r.failedRequired === 'number' && typeof r.unverifiedRequired === 'number',
  };
}

/** `Verification: INCOMPLETE - 3 required check(s) not verified` - the same words as the CLI, PREVIEW.md and G2. */
export function statusLine(s: PvStatus): string {
  if (s.verdict === null) return 'Verification: pending';
  if (!s.detailed) return `Verification: ${s.verdict.toUpperCase()} (older status file: the required checks left unverified were not recorded)`;
  if (s.verdict === 'pass') return 'Verification: PASS - every required check is verified';
  if (s.verdict === 'incomplete') return `Verification: INCOMPLETE - ${s.unverifiedRequired} required check(s) not verified`;
  return `Verification: FAIL - ${s.failedRequired} required check(s) failed${s.unverifiedRequired ? `, ${s.unverifiedRequired} not verified` : ''}`;
}
