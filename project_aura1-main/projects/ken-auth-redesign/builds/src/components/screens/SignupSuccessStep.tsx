'use client';

import { Button, Divider, InlineLink } from '@/vendor/ds/atoms';
import { CheckCircle2 } from 'lucide-react';

export interface SignupSuccessStepProps {
  fullName: string;
  email: string;
  companyName: string;
  onContinueBrowsing: () => void;
  onBrowseReports: () => void;
  /** Shared Auth variant (ken-auth-redesign Part A/D) — threaded down for API consistency
      with the other steps, but intentionally unused here: this step already has no eyebrow
      in V1 (confirmed by inspection), so V1 and V2 render identically. Optional, defaults
      to 'v1'. */
  variant?: 'v1' | 'v2';
}

/**
 * SignupSuccessStep — Step 4 ("Success") content of the sign-up flow.
 *
 * Source: Figma node 554:103 (spec: `signup-flow.spec.md`, STEP 4 section).
 *
 * Layout deviation (confirmed by reference, not a build error — spec Uncertainty #14):
 * this step's heading + icon + info panel are center-aligned, unlike the left-aligned
 * rhythm on steps 1–3. Reproduced faithfully here, not "fixed" to match the other steps.
 *
 * DS Mapping Gate: the success checkmark uses `lucide-react CheckCircle2` colored via
 * `--semantic-status-success-*` tokens (the decorative sparkle/dot accents around it have
 * NO DS EQUIVALENT — bespoke illustration detail, omitted per spec rather than fabricated,
 * flagged Uncertainty #11). The info panel has no existing "key-value summary" DS
 * component (searched `Detail*`/`Summary*`/`KeyValue*`/`InfoPanel*` — none found, flagged
 * Uncertainty #12) — composed here from existing primitives only: a plain
 * `--color-ramp-black-50` container + `Divider variant="subtle"` between rows + standard
 * typography tokens, per the spec's recommended composition. "Browse reports" is the real
 * `InlineLink` atom (design-system/core-v2/src/atoms/InlineLink.tsx) using its
 * `variant="solid"` prop (added Loop fix cycle iter3) for the reference's solid-red,
 * no-underline treatment — iteration 2's hand-rolled `<button>` bypass has been reverted.
 * `CTALink` remains ruled out because it always renders its arrow and the reference shows
 * a bare text link with no arrow/button affordance (spec Uncertainty #13).
 *
 * Panel values are wired to real flow state (name/email/company the user actually
 * entered), not the reference's literal demo strings — per spec Uncertainty #5/#6's
 * reading that those are example/demo content, reinforcing that this step should reflect
 * real form state.
 */
export function SignupSuccessStep({
  fullName,
  email,
  companyName,
  onContinueBrowsing,
  onBrowseReports,
}: SignupSuccessStepProps) {
  return (
    <div className="text-center">
      {/* Success checkmark — green circle, DS status-success tokens */}
      <div className="flex justify-center mb-5">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{
            backgroundColor: 'var(--semantic-status-success-bg)',
            border: '1px solid var(--semantic-status-success-border)',
          }}
        >
          <CheckCircle2
            size={32}
            style={{ color: 'var(--semantic-status-success-text)' }}
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Heading — Copy Lock, no eyebrow (confirmed absent). font-serif (Part B item 4). */}
      <h1
        id="signup-success-heading"
        className="text-black font-medium mb-5"
        style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--typography-size-xl)' }}
      >
        Your account is ready
      </h1>

      {/* Info panel — composed from Divider + typography, no dedicated DS component exists
          (spec Uncertainty #12). mb-6 -> mb-5 (Part B item 6, one-token tightening pass). */}
      <div
        className="rounded-[var(--radius-button)] px-5 py-4 mb-5 text-left"
        style={{ backgroundColor: 'var(--color-ramp-black-50)' }}
      >
        <div className="flex items-center justify-between py-2">
          <span className="text-black/60" style={{ fontSize: 'var(--typography-size-sm)' }}>
            Name
          </span>
          <span className="text-black font-medium" style={{ fontSize: 'var(--typography-size-sm)' }}>
            {fullName}
          </span>
        </div>
        <Divider variant="subtle" />
        <div className="flex items-center justify-between py-2">
          <span className="text-black/60" style={{ fontSize: 'var(--typography-size-sm)' }}>
            Work email
          </span>
          <span className="text-black font-medium" style={{ fontSize: 'var(--typography-size-sm)' }}>
            {email}
          </span>
        </div>
        <Divider variant="subtle" />
        <div className="flex items-center justify-between py-2">
          <span className="text-black/60" style={{ fontSize: 'var(--typography-size-sm)' }}>
            Account
          </span>
          <span className="text-black font-medium" style={{ fontSize: 'var(--typography-size-sm)' }}>
            {companyName} account
          </span>
        </div>
      </div>

      {/* Primary CTA — Copy Lock */}
      <Button type="button" variant="brand" size="md" fullWidth onClick={onContinueBrowsing}>
        Continue browsing
      </Button>

      {/* Secondary link — Copy Lock. Fix (iter3, DS Mapping Gate P1): real `InlineLink`
          atom, `variant="solid"`. `onBrowseReports` (wired to the flow's close handler,
          not a distinct URL — see components/flows/SignupFlow.tsx) is a no-op-placeholder
          action, not real navigation, so `href="#"` + `preventDefault()` keeps this a
          genuine anchor element while still invoking the parent callback. */}
      <p className="mt-4">
        <InlineLink
          href="#"
          variant="solid"
          onClick={(e) => {
            e.preventDefault();
            onBrowseReports();
          }}
          className="font-medium"
          style={{ fontSize: 'var(--typography-size-sm)' }}
        >
          Browse reports
        </InlineLink>
      </p>
    </div>
  );
}
