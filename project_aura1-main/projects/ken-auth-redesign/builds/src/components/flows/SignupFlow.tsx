'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AuthModal } from '../AuthModal';
import { useAuthVariant } from '@/lib/authVariant';
import { useAuthEmail } from '@/lib/authEmail';
import { EmailOtpStep, type EmailOtpStepCopy } from '../screens/EmailOtpStep';
import { CompleteProfileStep, type ProfileData } from '../screens/CompleteProfileStep';
import { SignupSuccessStep } from '../screens/SignupSuccessStep';
import { markAccountAsRegistered } from '@/lib/mockAccountCheck';

export type SignupStep = 'emailOtp' | 'profile' | 'success';

/** Copy set fed to the shared `EmailOtpStep` — every string transcribed verbatim from
    `signup-flow.spec.md`'s Step 1 + Step 2 Copy Lock (otp-inline-refinement.spec.md §3:
    "Copy Lock — confirmed unchanged"). Only the DOM slot/timing each string renders into
    has changed, never the string itself. This is the V1 copy set — selected when the
    shared Auth preview variant (`useAuthVariant()`) is 'v1' (the default).
    Collecting-phase eyebrow (prior pass — user-directed, applies to V1 only, extending the
    V2-only removal below to both variants): 'GET STARTED' -> '' (removed, not just emptied
    text — `EmailOtpStep` conditionally omits the eyebrow `<p>` entirely, same discipline as
    V2). Verifying-phase eyebrow (this pass — user-directed, extends the same eyebrow-removal
    discipline to the remaining V1-only eyebrow): 'VERIFY YOUR EMAIL' -> '' (removed, same
    conditional-render discipline — no stray empty `<p>`). After this change V1 and V2 both
    have zero eyebrows anywhere in this flow. */
const SIGNUP_EMAIL_OTP_COPY: EmailOtpStepCopy = {
  collecting: {
    eyebrow: '',
    heading: 'Create your account',
    subcopy: 'Use your work email to create your Ken Research account.',
    helperText: 'Use your professional email address.',
    primaryCta: 'Continue with work email',
    footerPrefix: 'Already have an account?',
    footerLinkLabel: 'Sign in',
  },
  verifying: {
    eyebrow: '',
    heading: 'Enter verification code',
    subcopy: (maskedEmail) => `We sent a 6-digit verification code to ${maskedEmail}.`,
    primaryCta: 'Verify & continue',
    footerLinkLabel: 'Back to sign up',
  },
};

/** V2 "Cleaner Auth Direction" copy (ken-auth-redesign Part D — no Figma reference exists
    for V2; this is a principled design-judgment call, disclosed in the build report). Every
    eyebrow is emptied (`''`) — `EmailOtpStep` conditionally omits the eyebrow `<p>` rather
    than rendering an empty one. Headings/CTAs/footer strings are otherwise unchanged from
    V1: "Create your account" already begins the card once the eyebrow above it is gone, and
    "Enter verification code" reads clearly without "VERIFY YOUR EMAIL" above it. Subcopy
    kept as-is (functional context, not redundant labeling) rather than tightened further. */
const SIGNUP_EMAIL_OTP_COPY_V2: EmailOtpStepCopy = {
  collecting: {
    eyebrow: '',
    heading: 'Create your account',
    subcopy: 'Use your work email to create your Ken Research account.',
    helperText: 'Use your professional email address.',
    primaryCta: 'Continue with work email',
    footerPrefix: 'Already have an account?',
    footerLinkLabel: 'Sign in',
  },
  verifying: {
    eyebrow: '',
    heading: 'Enter verification code',
    subcopy: (maskedEmail) => `We sent a 6-digit verification code to ${maskedEmail}.`,
    primaryCta: 'Verify & continue',
    footerLinkLabel: 'Back to sign up',
  },
};

export interface SignupFlowProps {
  isOpen: boolean;
  onClose: () => void;
  /** Step 1 / Step 3 footer "Sign in" links — switches the modal to the sign-in flow.
      Optional so this component still works standalone (e.g. isolated render/test) without
      a sign-in flow mounted alongside it. */
  onSwitchToSignin?: () => void;
}

const EMPTY_PROFILE: ProfileData = {
  fullName: '',
  countryCode: '+91',
  phoneNumber: '',
  companyName: '',
  agreedToTerms: false,
};

/**
 * Derive a display-cased company name from a verified work-email domain
 * (e.g. "jane@ken-research.com" -> "Ken Research"). Backs Step 3's helper copy
 * "Auto-detected from your work email. You can edit this." — a real behavior
 * requirement per the spec's "Remaining detail" note, not just decorative copy.
 * Best-effort only: strips the TLD, splits on non-alphanumeric separators, title-cases.
 */
function deriveCompanyName(email: string): string {
  const domain = email.split('@')[1];
  if (!domain) return '';
  const label = domain.split('.')[0];
  if (!label) return '';
  return label
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** id of the heading inside the currently-rendered step — feeds AuthModal's aria-labelledby.
    `emailOtp` keeps ONE id across both its internal phases (otp-inline-refinement.spec.md
    §1 structural note 4) so AuthModal never has to repoint aria-labelledby mid-phase-change. */
const STEP_HEADING_ID: Record<SignupStep, string> = {
  emailOtp: 'signup-email-heading',
  profile: 'complete-profile-heading',
  success: 'signup-success-heading',
};

/**
 * SignupFlow — one continuous interactive sign-up flow (Create account + OTP verification
 * merged inline → Complete profile → Success), sharing the single `AuthModal` shell.
 *
 * Source: Figma frame `550:67` "SignUp", 4 stacked step images — see
 * `projects/ken-auth-redesign/specs/signup-flow.spec.md` (STEP-TRANSITION / INTERACTION
 * LOGIC section) for the original 4-step transition rules. Per
 * `otp-inline-refinement.spec.md` §1 (structural implication 1), the outer step machine here
 * now has 3 keys (`'emailOtp' | 'profile' | 'success'`) instead of 4 — the former separate
 * `'email'`/`'otp'` steps are merged into one mounted `EmailOtpStep` that tracks its own
 * internal `phase`, still visited in the same experiential order. The outer
 * `AnimatePresence mode="wait"` step-swap below is otherwise unchanged, just with fewer keys.
 *
 * Per the spec's "Step-runner requirement": the shell (`AuthModal.tsx`) has no concept of
 * steps by itself — this component owns `currentStep` (+ the form state each step reads
 * from/writes to) and renders `<AuthModal>{stepContent}</AuthModal>`, swapping only
 * `children` per step so the modal frame/chrome never remounts across the flow.
 *
 * State lifted here (not per-step local state) specifically because later steps need to
 * reference earlier steps' input: Step 2 masks the email entered in Step 1; Step 4's info
 * panel echoes the name/email/company entered in Steps 1 and 3 (spec Uncertainty #5/#6 —
 * reference's literal demo values are read as example content, reinforcing that this flow
 * should be wired to real state rather than the reference's hardcoded strings).
 *
 * `email` itself (ken-auth-redesign Part B, this pass) is no longer this component's own
 * local `useState('')` — it's read from `useAuthEmail()`, a Context shared with
 * `SigninFlow.tsx`, so switching flows (footer link or the inline wrong-flow nudge in
 * `EmailOtpStep.tsx`) never loses what the user already typed. `step`/`profile` stay local
 * — only the email value needed to move up.
 *
 * All 3 mock-backend transition points are marked `// TODO: replace w/ real ... API` at
 * their call sites in the child step components — no real backend exists for this Loop
 * project (mock-only per workspace scope).
 */
export function SignupFlow({ isOpen, onClose, onSwitchToSignin }: SignupFlowProps) {
  const [step, setStep] = useState<SignupStep>('emailOtp');
  const { email, setEmail } = useAuthEmail();
  const [profile, setProfile] = useState<ProfileData>(EMPTY_PROFILE);
  const prefersReducedMotion = useReducedMotion();
  const { variant } = useAuthVariant();
  const emailOtpCopy = variant === 'v2' ? SIGNUP_EMAIL_OTP_COPY_V2 : SIGNUP_EMAIL_OTP_COPY;

  const handleClose = () => {
    onClose();
  };

  const renderStep = () => {
    switch (step) {
      case 'emailOtp':
        // otp-inline-refinement.spec.md: email-collection + OTP-verification are now ONE
        // mounted step (internal `phase` state inside EmailOtpStep) instead of two separate
        // outer steps ('email' / 'otp') hard-cross-faded by this component. `onChangeEmail`/
        // `onBackToSignup` no longer bubble up here (structural note 3) — both are now a
        // local `setPhase('collecting')` call inside EmailOtpStep itself.
        return (
          <EmailOtpStep
            email={email}
            onEmailChange={setEmail}
            onVerified={() => {
              // Auto-detect company name from the verified email domain, only if the
              // user hasn't already typed/edited one (don't clobber their edit if they
              // go back-and-forth between steps).
              setProfile((prev) => ({
                ...prev,
                companyName: prev.companyName || deriveCompanyName(email),
              }));
              setStep('profile');
            }}
            onSwitchFlow={onSwitchToSignin}
            copy={emailOtpCopy}
            headingId={STEP_HEADING_ID.emailOtp}
            flowKind="signup"
            variant={variant}
          />
        );
      case 'profile':
        return (
          <CompleteProfileStep
            profile={profile}
            onProfileChange={setProfile}
            onSubmit={() => {
              // ken-auth-redesign Part B (logic-only pass): the ONE call site for
              // markAccountAsRegistered() — fired exactly at true Create Account
              // completion (Complete Profile successfully submitted, about to show
              // Account Ready), never earlier and never if the user abandons the flow
              // before this point. Persists (localStorage-backed, see
              // `lib/mockAccountCheck.ts`) so a later sign-in attempt with this same
              // email — this session or after a page refresh — is treated as existing.
              markAccountAsRegistered(email);
              setStep('success');
            }}
            onSignInClick={onSwitchToSignin}
            variant={variant}
          />
        );
      case 'success':
        return (
          <SignupSuccessStep
            fullName={profile.fullName}
            email={email}
            companyName={profile.companyName}
            onContinueBrowsing={handleClose}
            onBrowseReports={handleClose}
            variant={variant}
          />
        );
    }
  };

  return (
    <AuthModal isOpen={isOpen} onClose={handleClose} labelledBy={STEP_HEADING_ID[step]}>
      {/* Step-transition motion (signup-flow-refinement.spec.md §4) — subtle fade + slide on
          the inner step-content swap only; AuthModal's own open/close shell animation
          (tailwindcss-animate `fade-in`/`zoom-in-95`) is untouched and out of scope. `mode="wait"`
          ensures the outgoing step fully exits before the incoming one enters (no cross-fade
          overlap, which would read as busier than a clean sequential swap). `key={step}` scopes
          each step's own enter/exit to its real state-tracked step id (spec Uncertainty #R3 —
          confirmed `step` is a stable string union, safe to use directly as the key).
          `useReducedMotion()` collapses the slide to 0 and the duration to near-instant per
          project convention (mandatory, never fully skipped). */}
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
