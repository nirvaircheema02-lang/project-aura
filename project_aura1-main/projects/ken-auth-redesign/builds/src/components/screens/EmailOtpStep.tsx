'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Button, InlineLink } from '@/vendor/ds/atoms';
import { Input } from '@/vendor/ds/ui/input';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/vendor/ds/ui/input-otp';
import { checkAccountExists } from '@/lib/mockAccountCheck';

export type EmailOtpPhase = 'collecting' | 'verifying';

/** Per-phase copy set — lets both flows consume this one component (spec structural note 2)
    without re-deriving the merge logic per flow. Every string here must be transcribed
    verbatim from the consuming flow's own already-locked Copy Lock (signup-flow.spec.md /
    signin-flow.spec.md Step 1 + Step 2) — this component invents none of it. */
export interface EmailOtpStepCopy {
  collecting: {
    eyebrow: string;
    heading: string;
    subcopy: string;
    /** Helper line under the email field — the one string that genuinely differs in
        wording between flows (sign-up: "Use your professional email address."; sign-in:
        "Use your registered professional email address.") despite the rest of the
        collecting-phase copy being flow-specific too — called out separately here since it
        was previously hardcoded in this component's JSX rather than passed as copy
        (fix applied for the sign-in refinement build, otp-inline-refinement.spec.md §3). */
    helperText: string;
    primaryCta: string;
    footerPrefix: string;
    footerLinkLabel: string;
  };
  verifying: {
    eyebrow: string;
    heading: string;
    /** Function so the masked email can be interpolated at render time. */
    subcopy: (maskedEmail: string) => string;
    primaryCta: string;
    footerLinkLabel: string;
  };
}

export interface EmailOtpStepProps {
  /** Controlled email value, lifted to the parent flow (Step 3+ may reference it). */
  email: string;
  onEmailChange: (email: string) => void;
  /** Called once a well-formed 6-digit code is submitted — advances the parent flow past
      this merged step (to Complete Profile for sign-up, to Success for sign-in). */
  onVerified: () => void;
  /** Cross-flow switch handler — used by (a) the footer "Sign in"/"Create account" link,
      shown in the `collecting` phase, and (b) the inline wrong-flow nudge's action link
      ("Create account" / "Sign in instead", ken-auth-redesign Part C) that appears below
      the email field once `accountMismatch` is set — both switch the modal to the OTHER
      auth flow. Renamed from the pre-wrong-flow `onSignInClick` since that name only made
      sense from the sign-up side — both `SignupFlow.tsx` and `SigninFlow.tsx` already pass
      their own `onSwitchToSignin`/`onSwitchToSignup` callback here, unchanged, just under
      this clearer shared name. Optional + no-op default so isolated renders don't break. */
  onSwitchFlow?: () => void;
  copy: EmailOtpStepCopy;
  /** DOM id placed on the (phase-stable) heading, fed to `AuthModal`'s `aria-labelledby`.
      Kept the SAME string across both phases by the parent flow — see spec structural
      note 4 — so the modal's `aria-labelledby` never has to repoint mid-phase-change. */
  headingId: string;
  /** Which flow this instance belongs to — lets the inline wrong-flow nudge (ken-auth-
      redesign Part C) pick the right message + action label: sign-in shows "no account
      found" -> "Create account"; sign-up shows "already have an account" -> "Sign in
      instead". */
  flowKind: 'signup' | 'signin';
  /** Shared Auth preview variant (`useAuthVariant()`, read by both `SignupFlow.tsx` and
      `SigninFlow.tsx` for their own copy-object selection) — threaded down here too
      (ken-auth-redesign hierarchy-spacing refinement) so the heading block's own vertical
      rhythm can differ per variant without a second copy-object fork. V1 keeps its exact
      pre-existing margins (`mb-2` / `mb-4`, unconditional before this change) — untouched.
      V2 only: heading->subcopy tightens (`mb-2`→`mb-1`, 8px→4px) and subcopy->first-field
      opens up (`mb-4`→`mb-6`, 16px→24px) now that there's no eyebrow above stealing visual
      weight. Applies identically regardless of `accountMismatch` state since that only
      affects the helper-text slot below the field, never this heading block. */
  variant: 'v1' | 'v2';
}

const RESEND_SECONDS = 30; // Uncertainty #2 (signup-flow.spec.md), carried unchanged.

/** Mask a real email as `use***@company.com` — first 3 local chars visible, rest starred.
    Unchanged from the pre-merge `OtpVerificationStep.tsx`/`SigninOtpStep.tsx`. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const visible = local.slice(0, 3);
  return `${visible}***@${domain}`;
}

/**
 * EmailOtpStep — merged email-collection + OTP-verification step, replacing the prior
 * two-step hard cross-fade (`SignupEmail.tsx` step ⇄ `OtpVerificationStep.tsx` step) with
 * a single mounted component that tracks its own internal `phase`.
 *
 * Source: `projects/ken-auth-redesign/specs/otp-inline-refinement.spec.md` §1 — resolved
 * against direct inspection of a secondary Figma reference (node 47:2275, 4 sibling form
 * states) confirming the email/phone field and the revealed OTP block coexist in the same
 * view: the trigger field/button stays in place, the verification block grows in directly
 * below it, everything below shifts down. Every Copy Lock string still traces to the
 * primary reference (Figma nodes 554:94 "email" / 554:97 "OTP", `signup-flow.spec.md`) —
 * this component only changes which DOM slot each string renders into and how it enters.
 *
 * Interaction mechanic (replacing the old whole-step `AnimatePresence mode="wait"` swap
 * between two separately-mounted components):
 *   1. Heading block (eyebrow/heading/subcopy) — crossfades in place, 150ms, 6px/-4px y,
 *      `ease [0.4,0,0.2,1]`, `mode="wait"`. Same DOM `id` (`headingId` prop) throughout.
 *   2. Work-email field — the SAME `Input` element morphs (`readOnly`/`disabled` toggle +
 *      masked value) rather than a second field mounting; a "Change" link fades in on its
 *      label row only once verifying.
 *   3. OTP block — newly mounted directly below the email field, height+opacity expand
 *      (280ms, same easing), `overflow: hidden`, real `height: 0 -> 'auto'` (Framer measures
 *      true height, no manual math).
 *   4. Primary CTA — one physical `Button`, only its label crossfades (120ms) inside it.
 *   5. OR-divider + LinkedIn — REMOVED (ken-auth-redesign Part B item 5, shared-shell
 *      baseline, both variants): the `collecting`-phase alt-method block is gone entirely,
 *      not just hidden past `verifying`.
 *   6. Footer link — crossfades between the two approved footer strings (150ms, same
 *      treatment as the heading block); always shown in the `collecting`/`verifying`
 *      phases (see inline wrong-flow nudge note below for why it's never hidden).
 * `useReducedMotion()` collapses every duration above to 0.01 and removes y/height
 * interpolation (instant opacity swaps only) — mandatory project convention, never skipped.
 *
 * Inline wrong-flow nudge (ken-auth-redesign Part C, this pass — replaces a prior
 * `wrongFlow` phase that used to swap the ENTIRE form for a separate warning-toned alert
 * panel): gated inside the `collecting` submit handler via an async `checkAccountExists()`
 * lookup (`src/lib/mockAccountCheck.ts`) — sign-in with no matching account, or sign-up
 * with an already-existing one, sets `accountMismatch` instead of advancing `phase`. The
 * form (email field + primary CTA) stays fully mounted and visible — only the helper-text
 * slot directly below the email field swaps content, via the SAME crossfade mechanic as
 * every other transition here (150ms, same easing), from the normal helper copy to a
 * plain-text nudge ("You already have an account with this email." / "No account found for
 * this email.") plus a `variant="solid"` `InlineLink` action ("Sign in instead" / "Create
 * account") that calls `onSwitchFlow`. No separate panel, no color/border/icon-box
 * treatment — same neutral `--semantic-ink-subtle` tone as the helper text it replaces.
 * Editing the email clears `accountMismatch` (stale result) and re-checks on next submit.
 *
 * DS Mapping Gate: composition-only, zero new primitives — `ui/input.tsx`, `atoms/Button.tsx`,
 * `atoms/InlineLink.tsx`, `atoms/Divider.tsx`, `ui/input-otp.tsx` (already-passed per-slot
 * override preserved verbatim below), all animated via `framer-motion` only.
 *
 * Mock verification: no real backend for this Loop project — any well-formed 6-digit code
 * is treated as valid, and "sending the code" is a brief local timeout, not a network call.
 * // TODO: replace w/ real send-OTP / verify-OTP API calls at the two marked call sites.
 */
export function EmailOtpStep({
  email,
  onEmailChange,
  onVerified,
  onSwitchFlow,
  copy,
  headingId,
  flowKind,
  variant,
}: EmailOtpStepProps) {
  const [phase, setPhase] = useState<EmailOtpPhase>('collecting');
  const [touched, setTouched] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  // Async account-existence check (ken-auth-redesign Part A) — true only while
  // `checkAccountExists()` is in flight, so the primary CTA can show the same `loading`
  // treatment it already uses for the simulated OTP send (Button's existing `loading` prop,
  // not a new treatment).
  const [checkingAccount, setCheckingAccount] = useState(false);
  // Inline wrong-flow nudge (ken-auth-redesign Part C) — set instead of advancing `phase`
  // when the account-existence check comes back "wrong door"; `null` means no nudge, show
  // the normal helper text. Cleared whenever the email is edited (a stale result no longer
  // applies) or when a later submit resolves as a match.
  const [accountMismatch, setAccountMismatch] = useState<'no-account' | 'already-exists' | null>(null);
  const [otp, setOtp] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);
  const [announcement, setAnnouncement] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const prefersReducedMotion = useReducedMotion();

  // Uncertainty #1 (signup-flow.spec.md): reference shows no error state; sensible default
  // is a client-side well-formed-email check before advancing the flow.
  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  // Resend-countdown timer — structural implication #5 (otp-inline-refinement.spec.md §1):
  // gated to start only once `phase` first becomes 'verifying', not on component mount,
  // since the merged component now mounts immediately in the 'collecting' phase.
  useEffect(() => {
    if (phase !== 'verifying') return;
    setSecondsLeft(RESEND_SECONDS);
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase]);

  // Clear any in-flight "sending OTP" timeouts on unmount (modal close mid-send).
  useEffect(() => {
    return () => {
      sendTimeoutsRef.current.forEach(clearTimeout);
    };
  }, []);

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');

  const handleResend = () => {
    if (secondsLeft > 0) return;
    // TODO: replace w/ real resend-OTP API call.
    setSecondsLeft(RESEND_SECONDS);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (phase === 'collecting') {
      setTouched(true);
      if (!isValidEmail) return;
      // Guard against a duplicate submit while the async check or the OTP-send delay from
      // a prior submit is still in flight (Button's own `disabled={loading}` already covers
      // the mouse-click case; this covers Enter-key submits too).
      if (checkingAccount || sendingOtp) return;

      // Wrong-flow guard (ken-auth-redesign Part A/C) — async account-existence check,
      // gated ahead of advancing to `verifying`. Sign-in with no matching account, or
      // sign-up with an already-existing account, both set `accountMismatch` (rendering the
      // inline nudge below the email field, form still fully visible) rather than proceeding
      // into a verification flow that would only dead-end.
      setCheckingAccount(true);
      const accountExists = await checkAccountExists(email);
      setCheckingAccount(false);

      if (flowKind === 'signin' && !accountExists) {
        setAccountMismatch('no-account');
        return;
      }
      if (flowKind === 'signup' && accountExists) {
        setAccountMismatch('already-exists');
        return;
      }
      setAccountMismatch(null);

      // Optional polish (spec §1 structural note 6, "nice-to-have"): brief `loading` state
      // on the real Button between click and the OTP block's expand-in completing, using
      // the DS's own existing `loading` prop — no new component. Reduced-motion collapses
      // both delays to near-instant, matching every other duration in this component.
      // TODO: replace w/ real send-OTP API call.
      setSendingOtp(true);
      const revealDelay = prefersReducedMotion ? 10 : 350;
      const otpExpandDuration = prefersReducedMotion ? 10 : 280;
      const t1 = setTimeout(() => {
        setPhase('verifying');
        setAnnouncement(`Verification code sent to ${maskEmail(email)}.`);
        const t2 = setTimeout(() => setSendingOtp(false), otpExpandDuration);
        sendTimeoutsRef.current.push(t2);
      }, revealDelay);
      sendTimeoutsRef.current.push(t1);
      return;
    }

    // phase === 'verifying'
    // TODO: replace w/ real verify-OTP API call — mock/demo flow treats any well-formed
    // 6-digit entry as valid, per task brief.
    if (otp.length !== 6) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onVerified();
  };

  const maskedEmail = maskEmail(email);
  const headingCrossfade = { duration: prefersReducedMotion ? 0.01 : 0.15, ease: [0.4, 0, 0.2, 1] as const };
  const headingCopy = phase === 'collecting' ? copy.collecting : copy.verifying;
  const eyebrow = headingCopy.eyebrow;

  // Inline wrong-flow nudge copy (ken-auth-redesign Part C) — exact strings per task brief,
  // keyed off `accountMismatch` rather than a phase, since the form stays mounted throughout.
  const mismatchCopy =
    accountMismatch === 'no-account'
      ? { message: 'No account found for this email.', actionLabel: 'Create account' }
      : accountMismatch === 'already-exists'
        ? { message: 'You already have an account with this email.', actionLabel: 'Sign in instead' }
        : null;

  // Clears a stale `accountMismatch` result as soon as the user edits the email — the prior
  // check no longer applies to whatever's now in the field; a fresh submit re-checks it.
  const handleEmailChange = (value: string) => {
    if (accountMismatch) setAccountMismatch(null);
    onEmailChange(value);
  };

  return (
    <>
      {/* 1. Heading block — crossfade in place, same DOM id throughout (#O3/structural note 4).
          Eyebrow conditionally rendered (ken-auth-redesign Part D, V2): an empty string means
          "no eyebrow" — this must not render an empty <p>, not just render invisible text. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={phase}
          initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4 }}
          transition={headingCrossfade}
        >
          {eyebrow && (
            <p
              className="text-[var(--color-brand-red)] font-medium uppercase tracking-wide mb-2"
              style={{ fontSize: 'var(--typography-size-xs)' }}
            >
              {eyebrow}
            </p>
          )}
          <h1
            id={headingId}
            className={`text-black font-medium ${variant === 'v2' ? 'mb-1' : 'mb-2'}`}
            style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--typography-size-xl)' }}
          >
            {phase === 'collecting' ? copy.collecting.heading : copy.verifying.heading}
          </h1>
          {/* Hierarchy-spacing refinement (ken-auth-redesign, V2-only — see prop doc above):
              heading->subcopy gap tightens (mb-2 8px -> mb-1 4px), subcopy->first-field gap
              opens up (mb-4 16px -> mb-6 24px) now that V2 has no eyebrow stealing weight
              above. V1 keeps both original values byte-identical (mb-2 / mb-4). Both values
              stay on the real DS spacing scale (`src/vendor/tokens/tokens.css`: --spacing-1
              0.25rem/4px, --spacing-6 1.5rem/24px) — no arbitrary custom px. */}
          <p
            className={`text-black/60 leading-relaxed ${variant === 'v2' ? 'mb-6' : 'mb-4'}`}
            style={{ fontSize: 'var(--typography-size-sm)' }}
          >
            {phase === 'collecting' ? copy.collecting.subcopy : copy.verifying.subcopy(maskedEmail)}
          </p>
        </motion.div>
      </AnimatePresence>

      {/* 2-4. Form (email field / OTP block / primary CTA) — always mounted; the inline
          wrong-flow nudge (Part C) only swaps the helper-text slot below the email field
          (item 2 below), never this whole block. */}
      <form onSubmit={handleSubmit} noValidate>
        {/* 2. Work-email field row — same Input element morphs; "Change" fades in */}
        <div className="flex items-center justify-between mb-2">
          <label
            htmlFor="work-email"
            className="block text-black font-medium"
            style={{ fontSize: 'var(--typography-size-sm)' }}
          >
            Work email
          </label>
          <AnimatePresence>
            {phase === 'verifying' && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: prefersReducedMotion ? 0.01 : 0.15 }}
              >
                <InlineLink
                  href="#"
                  variant="solid"
                  onClick={(e) => {
                    e.preventDefault();
                    setPhase('collecting');
                  }}
                  className="font-medium"
                  style={{ fontSize: 'var(--typography-size-sm)' }}
                >
                  Change
                </InlineLink>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <Input
          id="work-email"
          name="work-email"
          type={phase === 'collecting' ? 'email' : 'text'}
          required={phase === 'collecting'}
          readOnly={phase === 'verifying'}
          disabled={phase === 'verifying'}
          value={phase === 'collecting' ? email : maskedEmail}
          onChange={(e) => handleEmailChange(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={phase === 'collecting' && touched && !isValidEmail}
          placeholder="name@company.com"
          autoComplete="email"
          className={phase === 'verifying' ? 'h-[var(--button-height-md)] px-4 mb-5' : 'h-[var(--button-height-md)] px-4'}
        />

        {phase === 'collecting' && (
          /* Helper-text slot — normally the flow's own helper copy; swaps in place (Part C)
             to the inline wrong-flow nudge when `accountMismatch` is set. Same neutral
             `--semantic-ink-subtle` color/size/position either way — no warning/error
             styling, no boxed panel, plain text + one `variant="solid"` InlineLink action.
             Same 150ms crossfade as the heading block above, applied to this one line. */
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={mismatchCopy ? `mismatch-${accountMismatch}` : 'helper'}
              initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4 }}
              transition={headingCrossfade}
              className="text-[var(--semantic-ink-subtle)] mt-2 mb-5 leading-relaxed"
              style={{ fontSize: 'var(--typography-size-xs)' }}
            >
              {mismatchCopy ? (
                <>
                  {mismatchCopy.message}{' '}
                  <InlineLink
                    href="#"
                    variant="solid"
                    onClick={(e) => {
                      e.preventDefault();
                      onSwitchFlow?.();
                    }}
                    className="font-medium"
                    style={{ fontSize: 'var(--typography-size-xs)' }}
                  >
                    {mismatchCopy.actionLabel}
                  </InlineLink>
                </>
              ) : (
                copy.collecting.helperText
              )}
            </motion.p>
          </AnimatePresence>
        )}

        {/* 3. OTP block — height+opacity expand, mounted only once verifying, directly below
            the email field (the literal "OTP verification area directly below the relevant
            field" evidenced by the secondary reference's 2 sibling states, spec §1). */}
        <AnimatePresence initial={false}>
          {phase === 'verifying' && (
            <motion.div
              key="otp-block"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: prefersReducedMotion ? 0.01 : 0.28, ease: [0.4, 0, 0.2, 1] }}
              /* Ring-clip fix (this pass — confirmed root cause via direct getComputedStyle
                 measurement, not visual impression): this div is the actual `overflow:hidden`
                 boundary needed to clip the height 0->auto crossfade cleanly, but with zero
                 padding reserved it also clipped the active OTP slot's own focus ring
                 (`data-[active=true]:ring-[3px]`, `ui/input-otp.tsx` — a box-shadow with 0
                 ring-offset, so it paints exactly 3px past the slot's own border edge on all
                 sides). Slot 1 sits flush against this container's left edge (no earlier
                 sibling providing runway, unlike slots 2-6), so its ring's ~3px left-bleed was
                 being clipped — confirmed live via getComputedStyle + getBoundingClientRect
                 (ring's used clip region ended exactly at this div's own left edge).
                 Fix: `padding: var(--spacing-2)` (8px, `src/vendor/tokens/tokens.css:256` —
                 closest DS token comfortably covering the 3px ring with a safe buffer, chosen
                 over `--spacing-1`/4px which left only ~1px of headroom against subpixel/
                 antialiasing rounding) reserves clip room on all four sides (right/top/bottom
                 included symmetrically, matching the same theoretical risk even though only
                 the left edge was visibly clipped in the reference screenshot — slot 6 has
                 ~32px of slack before the container's right edge at this column width so was
                 never actually at risk, confirmed live below). Paired with an equal NEGATIVE
                 `margin: calc(var(--spacing-2) * -1)` on this same div so the padding is purely
                 an invisible clip-boundary expansion, not a visible layout change: for a
                 width:auto block box, content start position = containingBlockEdge + margin +
                 padding = containingBlockEdge + (-8px) + 8px = containingBlockEdge, i.e.
                 byte-identical to the pre-fix position — horizontal margins never collapse in
                 CSS, so this cancellation is exact and side-effect-free on this axis. Live-
                 verified: the "Enter 6-digit code" label, the OTP slots row, and the "Resend
                 code"/"Didn't receive it?" row below all still share the exact same left edge
                 as the "Work email" label/input above (rect.left matched to the pixel, before
                 and after) — the already-fixed left-alignment from the prior geometry pass is
                 unchanged. Vertical padding/margin deliberately included too for symmetry, but
                 note this container's own internal layout (label-above with its own `mb-2`,
                 resend-row below within the same clip boundary) already keeps the OTP row's
                 top/bottom ring bleed away from this div's own edges even before this fix — so
                 vertical clipping was never actually reproducible here (confirmed live); the
                 top/bottom padding is a no-cost proactive guard, not a fix for an observed
                 defect on that axis. */
              style={{
                overflow: 'hidden',
                padding: 'var(--spacing-2)',
                margin: 'calc(var(--spacing-2) * -1)',
              }}
            >
              <div>
                <label
                  className="block text-black font-medium mb-2"
                  style={{ fontSize: 'var(--typography-size-sm)' }}
                >
                  Enter 6-digit code
                </label>
                <InputOTP
                  maxLength={6}
                  value={otp}
                  onChange={(value) => {
                    setOtp(value);
                    setInvalid(false);
                  }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  /* Alignment fix (user-reported, live-screenshot-directed): a prior geometry
                     pass added `justify-center` here to split the 384px-column row's leftover
                     slack (328px fixed 6-slot row width vs. 384px column = 56px) evenly on
                     both sides. That directly contradicts the approved reference: both
                     `signup-flow.spec.md` ("reference shows the OTP group left-aligned to the
                     same left edge as the label above it, not centered") and
                     `signin-flow.spec.md` ("OTP row left-aligned to the label above it") are
                     explicit that this row shares the content column's left edge with its
                     "Enter 6-digit code" label sibling above and its "Resend code in mm:ss"
                     sibling below — centering it broke that shared left edge, which is exactly
                     what the user's screenshot flagged. No `containerClassName` override is
                     needed: `ui/input-otp.tsx`'s own default (`flex items-center gap-2`, no
                     justify-content set → browser default `normal`, which packs flex items at
                     flex-start) already left-aligns the row inside its full-width container. */
                >
                  {/* 6 separate single-slot groups — unchanged override from the pre-merge
                      `OtpVerificationStep.tsx`: DS default renders a connected/shared-border
                      6-slot group, the approved reference shows fully separated boxes. */}
                  {Array.from({ length: 6 }).map((_, i) => (
                    <InputOTPGroup key={i}>
                      <InputOTPSlot
                        index={i}
                        aria-invalid={invalid}
                        /* P1 fix (fix cycle iter 2, otp-inline-refinement report): the DS's own
                           default error border (`aria-invalid:border-destructive`) silently
                           fails — `--destructive`/`--input` are undefined anywhere in this
                           workspace, so both fall back to `currentColor` (black), indistinguishable
                           from the default border. Mirrors the already-working, already-passed
                           pattern from `ui/input.tsx`'s own `aria-invalid:border-[var(--brand-red)]`
                           override (report's recommended fix option b) rather than defining the
                           undefined tokens project-wide (option a) — keeps the fix scoped to the
                           one component actually exhibiting the gap. */
                        className="h-[var(--button-height-md)] w-[var(--button-height-md)] !rounded-[var(--radius-button)] data-[active=true]:border-[var(--color-brand-red)] data-[active=true]:ring-[var(--color-brand-red)]/50 aria-invalid:border-[var(--brand-red)]"
                      />
                    </InputOTPGroup>
                  ))}
                </InputOTP>
                {invalid && (
                  <p className="text-[var(--brand-red)] mt-2" style={{ fontSize: 'var(--typography-size-xs)' }}>
                    Enter all 6 digits to continue.
                  </p>
                )}

                {/* Resend row — status left, link right, same row-pairing as email/Change */}
                <div className="flex items-center justify-between mt-4 mb-5">
                  <span className="text-[var(--semantic-ink-subtle)]" style={{ fontSize: 'var(--typography-size-xs)' }}>
                    Resend code in {mm}:{ss}
                  </span>
                  <InlineLink
                    href="#"
                    variant="solid"
                    aria-disabled={secondsLeft > 0}
                    onClick={(e) => {
                      e.preventDefault();
                      if (secondsLeft > 0) return;
                      handleResend();
                    }}
                    className={secondsLeft > 0 ? 'font-medium opacity-40 pointer-events-none' : 'font-medium'}
                    style={{ fontSize: 'var(--typography-size-xs)' }}
                  >
                    Didn&apos;t receive it?
                  </InlineLink>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 4. Primary CTA — one physical Button; only the label crossfades inside it.
            `loading` now covers BOTH the async account-existence check (Part A) and the
            pre-existing simulated OTP-send delay — same DS `loading` prop, same treatment,
            no new visual state introduced for the account check. */}
        <Button type="submit" variant="brand" size="md" fullWidth loading={sendingOtp || checkingAccount}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={phase}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: prefersReducedMotion ? 0.01 : 0.12 }}
            >
              {phase === 'collecting' ? copy.collecting.primaryCta : copy.verifying.primaryCta}
            </motion.span>
          </AnimatePresence>
        </Button>
      </form>
      {/* LinkedIn "Continue with LinkedIn" alt-method (+ its "OR" divider) removed entirely
          from the `collecting` phase per ken-auth-redesign Part B item 5 — this is a shared-
          shell baseline change (applies to both V1 and V2, not variant-conditional). The
          `LinkedInGlyph` import above was removed alongside this; `icons/LinkedInGlyph.tsx`
          itself is left in place (harmless, not currently dead-code-eligible for deletion
          since removing the file is out of this change's scope). */}

      {/* 6. Footer link — crossfades between the two approved footer strings, same
          treatment as the heading block. Always shown in both phases (Part C): the inline
          wrong-flow nudge above is a separate, contextual affordance in the helper-text
          slot — it doesn't replace this footer link, which stays available regardless of
          `accountMismatch` state, exactly as it already was before that nudge existed. */}
      <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={phase}
            initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4 }}
            transition={headingCrossfade}
          >
            {phase === 'collecting' ? (
              <p className="text-black/60 mt-5 text-center" style={{ fontSize: 'var(--typography-size-sm)' }}>
                {copy.collecting.footerPrefix}{' '}
                <InlineLink
                  href="#"
                  variant="solid"
                  onClick={(e) => {
                    e.preventDefault();
                    onSwitchFlow?.();
                  }}
                >
                  {copy.collecting.footerLinkLabel}
                </InlineLink>
              </p>
            ) : (
              <p className="text-center mt-5">
                <InlineLink
                  href="#"
                  variant="muted"
                  onClick={(e) => {
                    e.preventDefault();
                    setPhase('collecting');
                  }}
                  className="font-medium"
                  style={{ fontSize: 'var(--typography-size-sm)' }}
                >
                  {copy.verifying.footerLinkLabel}
                </InlineLink>
              </p>
            )}
          </motion.div>
      </AnimatePresence>

      {/* #O3 (advisory, non-blocking): polite aria-live announcement standing in for a focus
          move, per the spec's own alternative — gives screen-reader users positive
          confirmation content changed in place, no page navigation occurred. */}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
