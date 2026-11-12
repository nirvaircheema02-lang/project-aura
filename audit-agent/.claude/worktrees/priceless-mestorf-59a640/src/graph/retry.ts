/**
 * ARCHITECTURE.md §2.4 — error classification before any retry decision,
 * and a retry policy table differentiated by execution type. No library
 * (IMPLEMENTATION-PLAN.md §3: p-retry's shape doesn't fit the three-way
 * classification + per-execution-type table) — hand-rolled, ~30 lines.
 */

export type FailureClass = 'RETRYABLE' | 'REPAIRABLE' | 'TERMINAL';
export type ExecutionType = 'deterministic' | 'ai' | 'hybrid';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

/** §2.4's retry policy table, by execution type. */
export const RETRY_POLICY: Record<ExecutionType, RetryPolicy> = {
  deterministic: { maxAttempts: 3, baseDelayMs: 2000 },
  ai: { maxAttempts: 2, baseDelayMs: 5000 },
  hybrid: { maxAttempts: 2, baseDelayMs: 5000 }, // retries only the failed sub-step — enforced by the calling node, not here
};

export class RepairableError extends Error {
  readonly class = 'REPAIRABLE' as const;
}

export class TerminalError extends Error {
  readonly class = 'TERMINAL' as const;
}

/**
 * Classifies a thrown error. Nodes that already know their error is
 * REPAIRABLE/TERMINAL should throw RepairableError/TerminalError directly
 * (e.g. after a bounded repair re-ask fails) — this function is the
 * fallback classifier for errors surfacing from tool/network code that
 * doesn't know about those types.
 */
export function classify(err: unknown): FailureClass {
  if (err instanceof TerminalError) return 'TERMINAL';
  if (err instanceof RepairableError) return 'REPAIRABLE';

  if (err && typeof err === 'object') {
    // A wrapper that preserves its cause's class (e.g. PageAuditError around a B-node
    // TerminalError) must classify the same — otherwise wrapping silently turns a
    // "cannot succeed" into a retried page.
    const declared = (err as { class?: unknown }).class;
    if (declared === 'TERMINAL' || declared === 'REPAIRABLE') return declared;
    const code = (err as { code?: unknown }).code;
    // 4xx (except 408/429) and clearly-non-retryable Node error codes: don't burn a retry budget.
    if (typeof code === 'string' && ['ENOTFOUND', 'ECONNREFUSED'].includes(code)) return 'RETRYABLE';
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') {
      if (status === 408 || status === 429 || status >= 500) return 'RETRYABLE';
      if (status >= 400) return 'TERMINAL';
    }
  }
  // Default: assume transient rather than silently dropping a real failure.
  return 'RETRYABLE';
}

/** Exponential backoff with explicit jitter (RESEARCH-REFERENCES.md #9 — avoids retry-storm across N parallel B instances). */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * exponential;
  return Math.round(exponential / 2 + jitter / 2);
}
