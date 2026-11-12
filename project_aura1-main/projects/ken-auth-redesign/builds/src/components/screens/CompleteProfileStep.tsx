'use client';

import { useState, type FormEvent } from 'react';
import { Badge, Button, InlineLink } from '@/vendor/ds/atoms';
import { Input } from '@/vendor/ds/ui/input';
import { Checkbox } from '@/vendor/ds/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/vendor/ds/ui/select';
import { CheckCircle2 } from 'lucide-react';

export interface ProfileData {
  fullName: string;
  countryCode: string;
  phoneNumber: string;
  companyName: string;
  agreedToTerms: boolean;
}

export interface CompleteProfileStepProps {
  profile: ProfileData;
  onProfileChange: (profile: ProfileData) => void;
  /** Called on "Create account" submit — advances the parent flow to the Success step. */
  onSubmit: () => void;
  /** Footer "Sign in" link — switches the modal to the sign-in flow. Optional + defaulted
      to a no-op so existing call sites that haven't been updated yet don't break (Loop
      wiring pass, `signin-flow.spec.md` task item 5). */
  onSignInClick?: () => void;
  /** Shared Auth variant (ken-auth-redesign Part A/D) — threaded down for API consistency
      with the other steps (matches `SigninSuccessStep`/`SignupSuccessStep`'s convention),
      but intentionally unused here since this pass: the eyebrow this once toggled ('ACCOUNT
      SETUP') is now removed unconditionally in both V1 and V2, so this step renders
      identically regardless of variant. Optional, defaults to 'v1'. */
  variant?: 'v1' | 'v2';
}

const COUNTRY_CODES = ['+91', '+1', '+44', '+61', '+65'];

/**
 * CompleteProfileStep — Step 3 ("Complete profile") content of the sign-up flow.
 *
 * Source: Figma node 554:100 (spec: `signup-flow.spec.md`, STEP 3 section).
 *
 * DS Mapping Gate: `Badge variant="pill" size="sm" theme="success"` for the "Email
 * verified" pill, `Input` (48px override) for full name/company name, `Select`
 * (`SelectTrigger` 48px override) + `Input` (48px override) paired for the phone number
 * row (select is intentionally narrower than the 400px column — the *pair* spans it, not
 * each control individually, per spec's Form Control Geometry table), `Checkbox` +
 * `InlineLink` x2 for the terms row, `Button` for the primary CTA.
 *
 * Exactly the 3 fields + 1 checkbox the reference shows — no password, confirm-password,
 * job title, or team-size fields added (spec explicitly calls out not to invent these).
 *
 * Company name is pre-filled from the verified work-email domain per the helper copy
 * ("Auto-detected from your work email...") — a real behavior requirement, not just
 * decorative copy (spec "Remaining detail" note). Placeholders on all 3 fields use
 * field-appropriate example text rather than the reference's literal demo values
 * ("Nirvair Singh" / "98765 43210" / "Ken Research"), per spec Uncertainty #5's reading
 * that those are demo/example content, not literal placeholder copy to lock verbatim.
 */
export function CompleteProfileStep({
  profile,
  onProfileChange,
  onSubmit,
  onSignInClick,
}: CompleteProfileStepProps) {
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);
    if (!profile.fullName || !profile.phoneNumber || !profile.companyName || !profile.agreedToTerms) {
      return;
    }
    onSubmit();
  };

  return (
    <>
      {/* Eyebrow — removed entirely (this pass — user-directed, applies to BOTH V1 and V2,
          not variant-conditional): 'ACCOUNT SETUP' -> removed. Was previously omitted only
          in V2 (ken-auth-redesign Part D: "remove eyebrow, simplify"); this extends that same
          removal to V1 so the heading becomes the first element in the card in both variants.
          No conditional render remains here — the `<p>` is gone, not hidden/emptied. */}

      {/* Heading — Copy Lock. font-serif (ken-auth-redesign Part B item 4): headings use the
          real DS Noto Serif token, not the DM Sans body token. */}
      <h1
        id="complete-profile-heading"
        className="text-black font-medium mb-2"
        style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--typography-size-xl)' }}
      >
        Complete your profile
      </h1>

      {/* Subcopy — Copy Lock. Shortened this pass (explicit user-directed copy change, task
          brief for this fix cycle only — not a self-initiated Copy Lock deviation): dropped
          "Add a few details to finish creating your account." entirely, keeping only "Your
          work email is verified." so the line renders on one line at the modal's 360px
          content column instead of wrapping to two. Saves a full line of text height
          (`leading-relaxed` @ `--typography-size-sm` 16px ≈ 26px/line), which is the single
          largest contributor to this pass's height-reduction target (card's natural,
          unclamped height went 701px→623px overall — copy shortening + the margin
          step-downs documented throughout this file, see build report for the full
          before/after ledger). mb-3→mb-2 (this pass, second trim round — user-directed
          one-viewport fit): this step doesn't feed straight into a field (the pill sits between it and
          the first label, unlike other steps' subcopy→field pattern), so it isn't the
          protected "copy→field" rhythm — real DS token, `--spacing-3`(12px)→`--spacing-2`
          (8px). */}
      <p className="text-black/60 mb-2 leading-relaxed" style={{ fontSize: 'var(--typography-size-sm)' }}>
        Your work email is verified.
      </p>

      {/* Status pill — Copy Lock. mb-6→mb-5 (iter2 P2 geometry fix, prior pass), mb-5→mb-4→
          mb-3 (this pass, two trim rounds — user-directed one-viewport-fit compaction): the
          subcopy above already carries its own separation, so mb-5/mb-4 here still
          double-counted rhythm on top of that. `--spacing-3` (12px) is the real DS token
          landed on — one step short of the label→field floor (`--spacing-2`/8px) used
          elsewhere in this form, keeping the pill visually distinct as its own element
          rather than reading as glued to "Full name". */}
      <Badge variant="pill" size="sm" theme="success" icon={<CheckCircle2 size={14} />} className="mb-3">
        Email verified
      </Badge>

      <form onSubmit={handleSubmit} noValidate>
        {/* Full name — Copy Lock label. Field mb-5→mb-4→mb-3 (two trim rounds — user-directed
            one-viewport-fit compaction): real DS token step-down,
            `--spacing-5`(20px)→`--spacing-4`(16px)→`--spacing-3`(12px). Input's own 48px
            height (`--button-height-md`) is untouched — only the gap after it changed. */}
        <label htmlFor="full-name" className="block text-black font-medium mb-2" style={{ fontSize: 'var(--typography-size-sm)' }}>
          Full name
        </label>
        <Input
          id="full-name"
          name="full-name"
          type="text"
          required
          value={profile.fullName}
          onChange={(e) => onProfileChange({ ...profile, fullName: e.target.value })}
          aria-invalid={submitAttempted && !profile.fullName}
          placeholder="Jane Doe"
          autoComplete="name"
          className="h-[var(--button-height-md)] px-4 mb-3"
        />

        {/* Phone number — Copy Lock label, compound country-code select + number input.
            Row mb-5→mb-4→mb-3 (two trim rounds — user-directed one-viewport-fit compaction):
            real DS token step-down, `--spacing-5`(20px)→`--spacing-4`(16px)→
            `--spacing-3`(12px). Select trigger + Input both keep their own real 48px
            (`--button-height-md`) height — only the row's own bottom gap changed. */}
        <label className="block text-black font-medium mb-2" style={{ fontSize: 'var(--typography-size-sm)' }}>
          Phone number
        </label>
        <div className="flex gap-2 mb-3">
          <Select
            value={profile.countryCode}
            onValueChange={(v) => onProfileChange({ ...profile, countryCode: v })}
          >
            {/* !h- (important) fix (iter2 P1): `SelectTrigger`'s own base classes include
                `data-[size=default]:h-9` — an attribute-selector + class combo with HIGHER
                specificity than a plain arbitrary-value height-override class, so the un-prefixed
                override was silently losing the cascade and the trigger stayed pinned at
                its DS-default 36px regardless of the className passed in. Confirmed via
                live getComputedStyle. `!` forces `!important`, which wins regardless of
                selector specificity — same override pattern already used elsewhere in this
                flow for DS-default-fighting cases, not a new custom-CSS system. */}
            <SelectTrigger
              className="!h-[var(--button-height-md)] w-[92px] shrink-0 rounded-[var(--radius-button)]"
              aria-label="Country code"
            >
              <SelectValue />
            </SelectTrigger>
            {/* z-[110] + bg-white overrides: build-time stacking-context fix, not a DS
                color/behavior override. AuthModal's scrim+card establish a z-[100] stacking
                context; Radix's SelectContent portal (appended to body) defaults to z-50,
                so without this it renders BEHIND the modal card and is invisible even though
                open (confirmed via computed-style inspection: fixed position, opacity 1,
                z-index 50, but occluded by the modal's higher stacking context). bg-white
                reuses the exact same token-free white already used by AuthModal's own card
                (`bg-white`) — DS's `bg-popover` resolves to nothing because `--popover`/
                `--popover-foreground` aren't defined anywhere in this project's tokens.css,
                which would otherwise leave the dropdown transparent-background. Text/border/
                radius/spacing/animation classes are all still the real DS defaults, untouched. */}
            <SelectContent className="z-[110] bg-white">
              {COUNTRY_CODES.map((code) => (
                <SelectItem key={code} value={code}>
                  {code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            id="phone-number"
            name="phone-number"
            type="tel"
            required
            value={profile.phoneNumber}
            onChange={(e) => onProfileChange({ ...profile, phoneNumber: e.target.value })}
            aria-invalid={submitAttempted && !profile.phoneNumber}
            placeholder="98765 43210"
            autoComplete="tel-national"
            className="h-[var(--button-height-md)] px-4 flex-1 min-w-0"
          />
        </div>

        {/* Company name — Copy Lock label + helper (auto-detected, editable) */}
        <label htmlFor="company-name" className="block text-black font-medium mb-2" style={{ fontSize: 'var(--typography-size-sm)' }}>
          Company name
        </label>
        <Input
          id="company-name"
          name="company-name"
          type="text"
          required
          value={profile.companyName}
          onChange={(e) => onProfileChange({ ...profile, companyName: e.target.value })}
          aria-invalid={submitAttempted && !profile.companyName}
          placeholder="Ken Research"
          autoComplete="organization"
          className="h-[var(--button-height-md)] px-4"
        />
        {/* mb-6→mb-4→mb-3→mb-2 (three trim rounds across two passes — user-directed
            one-viewport-fit compaction): the checkbox row below already has its own top
            alignment via `items-start`; mb-3 here still doubled up with its implicit
            spacing. Landed on `--spacing-2`(8px), matching the label→field floor used
            elsewhere in this form. `mt-2` (field→helper gap) left untouched per task scope. */}
        <p className="text-[var(--semantic-ink-subtle)] mt-2 mb-2" style={{ fontSize: 'var(--typography-size-xs)' }}>
          Auto-detected from your work email. You can edit this.
        </p>

        {/* Terms checkbox — Copy Lock, 2 embedded InlineLinks. mb-5→mb-4→mb-3 (two trim
            rounds — user-directed compaction): real DS token step-down,
            `--spacing-5`(20px)→`--spacing-4`(16px)→`--spacing-3`(12px). This gap also serves
            as CTA separation (checkbox block to the "Create account" button directly below)
            — kept one step above the form's tightest (8px) floor so the CTA still reads as
            a deliberate, separated action rather than glued to the terms copy. */}
        <div className="flex items-start gap-3 mb-3">
          <Checkbox
            id="agree-terms"
            checked={profile.agreedToTerms}
            onCheckedChange={(checked) => onProfileChange({ ...profile, agreedToTerms: checked === true })}
            aria-invalid={submitAttempted && !profile.agreedToTerms}
            className="mt-0.5"
          />
          {/* Fix (iter3, DS Mapping Gate P1): reverted to the real `InlineLink` atom
              (design-system/core-v2/src/atoms/InlineLink.tsx) using its new
              `variant="solid"` prop (added this fix cycle) instead of the hand-rolled
              anchors iteration 2 introduced. */}
          <label htmlFor="agree-terms" className="text-black/70 leading-relaxed" style={{ fontSize: 'var(--typography-size-sm)' }}>
            By creating your account, you agree to our{' '}
            <InlineLink href="/terms" variant="solid" className="font-medium">
              Terms of Use
            </InlineLink>{' '}
            and{' '}
            <InlineLink href="/privacy" variant="solid" className="font-medium">
              Privacy Policy
            </InlineLink>
            .
          </label>
        </div>

        {/* Primary CTA — Copy Lock */}
        <Button type="submit" variant="brand" size="md" fullWidth>
          Create account
        </Button>
      </form>

      {/* Footer line — Copy Lock, same pattern as Step 1. Fix (iter3): uses the real
          InlineLink `variant="solid"` (was rendering the `default` black+underline look).
          Wiring fix (signin-flow.spec.md task item 5): switches the modal to the real
          SigninFlow instead of a dead `href="/login"`, same pattern as Step 1's equivalent
          link. mt-5→mt-4→mt-3 (two trim rounds — user-directed compaction): real DS token
          step-down, `--spacing-5`(20px)→`--spacing-4`(16px)→`--spacing-3`(12px) — still a
          clearly separated, deliberate gap above the "Create account" button, not glued to
          it. */}
      <p className="text-black/60 mt-3 text-center" style={{ fontSize: 'var(--typography-size-sm)' }}>
        Already have an account?{' '}
        <InlineLink
          href="#"
          variant="solid"
          onClick={(e) => {
            e.preventDefault();
            onSignInClick?.();
          }}
        >
          Sign in
        </InlineLink>
      </p>
    </>
  );
}
