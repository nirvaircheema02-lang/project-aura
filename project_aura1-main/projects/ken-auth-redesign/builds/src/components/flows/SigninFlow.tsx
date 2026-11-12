'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AuthModal } from '../AuthModal';
import { useAuthVariant } from '@/lib/authVariant';
import { useAuthEmail } from '@/lib/authEmail';
import { EmailOtpStep, type EmailOtpStepCopy } from '../screens/EmailOtpStep';
import { SigninSuccessStep } from '../screens/SigninSuccessStep';

export type SigninStep = 'emailOtp' | 'success';

/** Copy set fed to the shared `EmailOtpStep` — every string transcribed verbatim from
    `signin-flow.spec.md`'s Step 1 + Step 2 Copy Lock (otp-inline-refinement.spec.md §3:
    "Copy Lock — confirmed unchanged"). Distinct from `SignupFlow.tsx`'s own copy set — per
    `signin-flow.spec.md`'s "Differences vs. sign-up" table, sign-in has its own eyebrow/
    heading/subcopy/helper/footer strings throughout; only the primary CTA's collecting-phase
    label ("Continue with work email") happens to already match sign-up's. Only the DOM
    slot/timing each string renders into has changed vs. the pre-merge `SigninEmail.tsx`/
    `SigninOtpStep.tsx` (now retired), never the strings themselves.
    This is the V1 copy set, selected when the shared Auth preview variant is 'v1' (default).
    `footerPrefix` (ken-auth-redesign Part B item 7 — explicit user-directed copy change,
    applies to both V1 and V2): 'New to Ken Research?' -> "Don't have an account?".
    `footerLinkLabel` stays 'Create account', unchanged.
    Collecting-phase eyebrow (prior pass — user-directed, applies to V1 only, extending the
    V2-only removal below to both variants): 'WELCOME BACK' -> '' (removed, not just emptied
    text — `EmailOtpStep` conditionally omits the eyebrow `<p>` entirely, same discipline as
    V2). Verifying-phase eyebrow (this pass — user-directed, extends the same eyebrow-removal
    discipline to the remaining V1-only eyebrow): 'SECURITY CHECK' -> '' (removed, same
    conditional-render discipline — no stray empty `<p>`). After this change V1 and V2 both
    have zero eyebrows anywhere in this flow. */
const SIGNIN_EMAIL_OTP_COPY: EmailOtpStepCopy = {
  collecting: {
    eyebrow: '',
    heading: 'Sign in',
    subcopy: 'Sign in to your Ken Research account using your registered work email.',
    helperText: 'Use your registered professional email address.',
    primaryCta: 'Continue with work email',
    footerPrefix: "Don't have an account?",
    footerLinkLabel: 'Create account',
  },
  verifying: {
    eyebrow: '',
    heading: 'Verify your sign in',
    subcopy: (maskedEmail) => `We sent a 6-digit verification code to ${maskedEmail}.`,
    primaryCta: 'Verify & sign in',
    footerLinkLabel: 'Back to sign in',
  },
};

/** V2 "Cleaner Auth Direction" copy (ken-auth-redesign Part D — design-judgment call, no
    Figma reference for V2, disclosed in the build report). Eyebrows emptied (`''`) —
    `EmailOtpStep` conditionally omits the eyebrow `<p>` rather than rendering an empty one.
    Sign-in's collecting subcopy is additionally tightened per Part D's explicit "simplify
    Sign-in heading structure" instruction: the V1 sentence ("Sign in to your Ken Research
    account using your registered work email.") is shortened to a single clause that keeps
    the one functionally load-bearing detail (registered WORK email) without restating the
    product name back to a user already on its sign-in screen. Heading stays "Sign in"
    (already minimal); verifying heading stays "Enter"->"Verify your sign in" unchanged,
    clear without its eyebrow. `footerPrefix` carries the same Part B item 7 change as V1. */
const SIGNIN_EMAIL_OTP_COPY_V2: EmailOtpStepCopy = {
  collecting: {
    eyebrow: '',
    heading: 'Sign in',
    subcopy: 'Sign in with your registered work email.',
    helperText: 'Use your registered professional email address.',
    primaryCta: 'Continue with work email',
    footerPrefix: "Don't have an account?",
    footerLinkLabel: 'Create account',
  },
  verifying: {
    eyebrow: '',
    heading: 'Verify your sign in',
    subcopy: (maskedEmail) => `We sent a 6-digit verification code to ${maskedEmail}.`,
    primaryCta: 'Verify & sign in',
    footerLinkLabel: 'Back to sign in',
  },
};

export interface SigninFlowProps {
  isOpen: boolean;
  onClose: () => void;
  /** Footer "Create account" link (collecting phase) — switches the modal to the sign-up
      flow. Required (unlike SignupFlow's optional `onSwitchToSignin`) since this flow has
      always had a live cross-flow entry point wired in `page.tsx`. */
  onSwitchToSignup: () => void;
}

/** id of the heading inside the currently-rendered step — feeds AuthModal's aria-labelledby.
    `emailOtp` keeps ONE id across both its internal phases (otp-inline-refinement.spec.md
    §1 structural note 4) so AuthModal never has to repoint aria-labelledby mid-phase-change. */
const STEP_HEADING_ID: Record<SigninStep, string> = {
  emailOtp: 'signin-email-heading',
  success: 'signin-success-heading',
};

/**
 * SigninFlow — one continuous interactive sign-in flow (Sign in + OTP verification merged
 * inline → Success), sharing the single `AuthModal` shell.
 *
 * Source: Figma frame `550:73` "SignIn" — see
 * `projects/ken-auth-redesign/specs/signin-flow.spec.md` (STEP-TRANSITION / INTERACTION
 * LOGIC section) for the original 3-step transition rules. Per
 * `otp-inline-refinement.spec.md` §1 (structural implication 1), the outer step machine here
 * now has 2 keys (`'emailOtp' | 'success'`) instead of 3 — the former separate `'email'`/
 * `'otp'` steps (previously `SigninEmail.tsx` / `SigninOtpStep.tsx`, both now retired) are
 * merged into one mounted `EmailOtpStep` — the SAME shared component `SignupFlow.tsx` uses,
 * parameterized with this flow's own `SIGNIN_EMAIL_OTP_COPY` — that tracks its own internal
 * `phase`, still visited in the same experiential order. The outer `AnimatePresence
 * mode="wait"` step-swap below is otherwise unchanged, just with fewer keys, mirroring
 * `SignupFlow.tsx`'s equivalent treatment exactly (same durations/easing/`mode="wait"`).
 *
 * Structurally the same shape as `SignupFlow.tsx`'s step-runner, minus the profile-
 * completion step: emailOtp → success, no 3rd/4th screen (spec confirms the reference frame
 * contains exactly 3 stacked images collapsing to 2 external steps once OTP verification is
 * inlined). `AuthModal.tsx` is reused unmodified — no shell-level changes required for
 * sign-in, only step-content children differ.
 *
 * State lifted here (not per-step local state) because the merged step's `verifying` phase
 * masks the email entered during `collecting`, and the success step's info panel echoes it
 * back.
 *
 * `email` itself (ken-auth-redesign Part B, this pass) is no longer this component's own
 * local `useState('')` — it's read from `useAuthEmail()`, a Context shared with
 * `SignupFlow.tsx`, so switching flows (footer link or the inline wrong-flow nudge in
 * `EmailOtpStep.tsx`) never loses what the user already typed. `step` stays local — only
 * the email value needed to move up.
 *
 * The mock OTP-verification transition point is marked `// TODO: replace w/ real ... API`
 * inside the shared `EmailOtpStep.tsx` — no real backend exists for this Loop project.
 */
export function SigninFlow({ isOpen, onClose, onSwitchToSignup }: SigninFlowProps) {
  const [step, setStep] = useState<SigninStep>('emailOtp');
  const { email, setEmail } = useAuthEmail();
  const prefersReducedMotion = useReducedMotion();
  const { variant } = useAuthVariant();
  const emailOtpCopy = variant === 'v2' ? SIGNIN_EMAIL_OTP_COPY_V2 : SIGNIN_EMAIL_OTP_COPY;

  const handleClose = () => {
    onClose();
  };

  const renderStep = () => {
    switch (step) {
      case 'emailOtp':
        // otp-inline-refinement.spec.md: email-collection + OTP-verification are now ONE
        // mounted step (internal `phase` state inside EmailOtpStep) instead of two separate
        // outer steps ('email' / 'otp') hard-cross-faded by this component. `onChangeEmail`/
        // `onBackToSignin` no longer bubble up here (structural note 3) — both are now a
        // local `setPhase('collecting')` call inside EmailOtpStep itself.
        return (
          <EmailOtpStep
            email={email}
            onEmailChange={setEmail}
            onVerified={() => setStep('success')}
            onSwitchFlow={onSwitchToSignup}
            copy={emailOtpCopy}
            headingId={STEP_HEADING_ID.emailOtp}
            flowKind="signin"
            variant={variant}
          />
        );
      case 'success':
        return (
          <SigninSuccessStep
            email={email}
            onContinueBrowsing={handleClose}
            onBrowseReports={handleClose}
            variant={variant}
          />
        );
    }
  };

  return (
    <AuthModal isOpen={isOpen} onClose={handleClose} labelledBy={STEP_HEADING_ID[step]}>
      {/* Step-transition motion (signup-flow-refinement.spec.md §4) — same subtle fade+slide
          treatment as SignupFlow.tsx, applied here for consistency across both flows sharing
          AuthModal. See SignupFlow.tsx for the full rationale comment. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -8 }}
          transition={{ duration: prefersReducedMotion ? 0.01 : 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          {renderStep()}
        </motion.div>
      </AnimatePresence>
    </AuthModal>
  );
}
