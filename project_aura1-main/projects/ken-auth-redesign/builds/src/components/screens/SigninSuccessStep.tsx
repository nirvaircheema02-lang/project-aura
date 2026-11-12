'use client';

import { Button, Divider, InlineLink } from '@/vendor/ds/atoms';
import { CheckCircle2 } from 'lucide-react';

export interface SigninSuccessStepProps {
  email: string;
  onContinueBrowsing: () => void;
  onBrowseReports: () => void;
  /** Shared Auth variant (ken-auth-redesign Part A/D) — threaded down for API consistency
      with the other steps, but intentionally unused here: this step already has no eyebrow
      in V1 (confirmed by inspection), so V1 and V2 render identically. Optional, defaults
      to 'v1'. */
  variant?: 'v1' | 'v2';
}

/**
 * SigninSuccessStep — Step 3 ("Welcome back") content of the interactive sign-in flow.
 *
 * Source: Figma node 554:91 (spec: `signin-flow.spec.md`, STEP 3 section).
 *
 * NOT a copy-paste of `SignupSuccessStep.tsx` with a row deleted — per the spec's
 * "Differences vs. sign-up Step 4" table this step (a) has a subcopy line sign-up's
 * equivalent lacks, (b) has a 2-row info panel with different row content ("Signed in as" /
 * "Status" rather than Name/Work email/Account), and (c) introduces a colored (green) value
 * inside the panel — `--semantic-status-success-text` applied directly to the row-2 value
 * span (plain text, no pill chrome), reusing the same token already validated for sign-up's
 * "Email verified" badge but in a new application. Composed from the same NO-DS-EQUIVALENT
 * info-panel recipe as sign-up (`--color-ramp-black-50` + `Divider variant="subtle"` +
 * typography tokens — spec Uncertainty #12, carried forward).
 *
 * Center-aligned layout (spec Uncertainty #14, carried) — same confirmed intentional
 * deviation from steps 1–2's left-aligned rhythm as sign-up's step 4.
 */
export function SigninSuccessStep({ email, onContinueBrowsing, onBrowseReports }: SigninSuccessStepProps) {
  return (
    <div className="text-center">
      {/* Success checkmark — green circle, DS status-success tokens, same as sign-up's step 4 */}
      <div className="flex justify-center mb-5">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{
            backgroundColor: 'var(--semantic-status-success-bg)',
            border: '1px solid var(--semantic-status-success-border)',
          }}
        >
          <CheckCircle2 size={32} style={{ color: 'var(--semantic-status-success-text)' }} aria-hidden="true" />
        </div>
      </div>

      {/* Heading — Copy Lock, no eyebrow (confirmed absent). font-serif (Part B item 4). */}
      <h1
        id="signin-success-heading"
        className="text-black font-medium mb-2"
        style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--typography-size-xl)' }}
      >
        Welcome back
      </h1>

      {/* Subcopy — Copy Lock. Present here, unlike sign-up's equivalent step (confirmed by
          direct spec inspection, not an oversight). */}
      <p className="text-black/60 mb-5 leading-relaxed" style={{ fontSize: 'var(--typography-size-sm)' }}>
        You&apos;re successfully signed in to your Ken Research account.
      </p>

      {/* Info panel — 2 rows (Signed in as / Status), composed from Divider + typography,
          no dedicated DS component exists (spec Uncertainty #12). mb-6 -> mb-5 (Part B item
          6, one-token tightening pass). */}
      <div
        className="rounded-[var(--radius-button)] px-5 py-4 mb-5 text-left"
        style={{ backgroundColor: 'var(--color-ramp-black-50)' }}
      >
        <div className="flex items-center justify-between py-2">
          <span className="text-black/60" style={{ fontSize: 'var(--typography-size-sm)' }}>
            Signed in as
          </span>
          <span className="text-black font-medium" style={{ fontSize: 'var(--typography-size-sm)' }}>
            {email}
          </span>
        </div>
        <Divider variant="subtle" />
        <div className="flex items-center justify-between py-2">
          <span className="text-black/60" style={{ fontSize: 'var(--typography-size-sm)' }}>
            Status
          </span>
          {/* Colored value — token reuse, new application (text color, not pill background) */}
          <span
            className="font-medium"
            style={{ fontSize: 'var(--typography-size-sm)', color: 'var(--semantic-status-success-text)' }}
          >
            Verified sign-in
          </span>
        </div>
      </div>

      {/* Primary CTA — Copy Lock, identical label to sign-up's step 4 */}
      <Button type="button" variant="brand" size="md" fullWidth onClick={onContinueBrowsing}>
        Continue browsing
      </Button>

      {/* Secondary link — Copy Lock, identical label to sign-up's step 4. Real `InlineLink`
          atom, `variant="solid"`. Open choice `InlineLink` vs. `CTALink` carried unresolved
          from sign-up (spec Uncertainty #13). */}
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
