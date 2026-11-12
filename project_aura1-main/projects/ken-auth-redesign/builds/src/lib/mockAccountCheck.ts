/**
 * mockAccountCheck — deterministic demo-only account-existence lookup backing the auth
 * flow's inline "wrong door" nudge (sign-in with no matching account / sign-up with an
 * already-existing account — see `EmailOtpStep.tsx`'s `accountMismatch` state).
 *
 * No real backend exists for this Loop project (mock-only per workspace scope) — this
 * stands in for a real "does an account exist for this email" API call.
 *
 * ken-auth-redesign Part A (prior pass): replaced the original synchronous, format/substring-
 * based `mockAccountExists(email)` (treated any local-part containing "new" as "no account
 * yet") with a genuine identity lookup against a small seeded set of known accounts. Per
 * explicit instruction, existence is no longer inferred from anything about the email's own
 * text/shape — it's a lookup, not a pattern match. Async, with a short simulated network
 * delay, so calling code (`EmailOtpStep.tsx`) can show a real loading state on its submit CTA
 * exactly as it would while awaiting a live API call.
 *
 * ken-auth-redesign Part A/B (this pass, logic-only — no UI/copy/DS changes):
 * - Part A: seeded set reduced from two hardcoded emails to exactly ONE
 *   ('test@kenresearch.com') per explicit instruction. No other predefined emails added.
 * - Part B: a completed Create Account flow now durably "registers" the new email it was
 *   completed with, via `markAccountAsRegistered()` — backed by `localStorage` (this is a
 *   client-only mock persistence layer standing in for a real backend's user table, not a
 *   new state-management system; guarded for SSR since this is a Next.js app).
 *   `checkAccountExists()` now checks BOTH the single hardcoded seed AND this
 *   localStorage-persisted set — either match means "account exists". The ONE call site for
 *   `markAccountAsRegistered()` lives in `components/flows/SignupFlow.tsx`, fired exactly at
 *   the moment Complete Profile is successfully submitted (the true end of the Create
 *   Account flow, immediately before the Success step mounts) — never earlier (not at OTP
 *   verification, not at email-collection submit), and never at all if the user abandons the
 *   flow before that point.
 */

const REGISTERED_EMAILS_STORAGE_KEY = 'ken-auth-redesign:registered-emails';

// Seeded "known existing account" — the only email this mock treats as already registered
// out of the box. QA: type this email to deterministically hit the "existing account"
// branch (sign-in → proceeds normally; sign-up → "already have an account" nudge). Type any
// other well-formed email to hit the "no account" branch (sign-in → "no account found"
// nudge; sign-up → proceeds normally) — UNLESS that email has already completed a full
// Create Account flow this session/browser (see `markAccountAsRegistered()` below), in which
// case it's also treated as existing.
const MOCK_EXISTING_ACCOUNTS = new Set(['test@kenresearch.com']);

/** Reads the localStorage-persisted set of emails that have completed Create Account.
    Returns an empty Set on the server (SSR) or if localStorage is unavailable/corrupt —
    never throws. */
function readRegisteredEmails(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(REGISTERED_EMAILS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Marks an email as a registered account, persisted in `localStorage` so a later sign-in
 * attempt with the same email — this session or after a page refresh — is treated as an
 * existing account. Call this ONLY at the true completion point of the Create Account flow
 * (immediately before the Success step mounts) — never at OTP verification, never at
 * email-collection submit, and never if the user abandons the flow before completing it.
 *
 * No-op on the server (SSR guard, this is a Next.js app) and swallows any localStorage
 * failure (private-browsing quota errors, etc.) rather than throwing — this is a best-effort
 * demo persistence layer, not a critical path.
 */
export function markAccountAsRegistered(email: string): void {
  if (typeof window === 'undefined') return;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;
  try {
    const existing = readRegisteredEmails();
    existing.add(normalized);
    window.localStorage.setItem(REGISTERED_EMAILS_STORAGE_KEY, JSON.stringify(Array.from(existing)));
  } catch {
    // Best-effort only — ignore (e.g. localStorage disabled/full).
  }
}

/**
 * Resolves whether an account already exists for the given email.
 * // TODO: replace with a real backend call, e.g. POST /api/auth/check-account { email }.
 *
 * Simulates a real async network round-trip (400ms) so `EmailOtpStep.tsx` shows a brief
 * loading state on its primary CTA exactly as it would against a real API, then looks the
 * email up by exact identity — NOT a regex/substring check on the email's own format, per
 * explicit instruction — against two sources: (a) the single hardcoded seed
 * (`MOCK_EXISTING_ACCOUNTS`), and (b) the localStorage-persisted set of emails that have
 * completed a full Create Account flow (`markAccountAsRegistered()`). Either match means the
 * account exists; neither means it doesn't.
 */
export async function checkAccountExists(email: string): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const normalized = email.trim().toLowerCase();
  if (MOCK_EXISTING_ACCOUNTS.has(normalized)) return true;
  return readRegisteredEmails().has(normalized);
}
