Reference Source: Figma (primary, unchanged) + Figma (secondary, pattern-only)
Reference Type: Frame (primary, flat raster steps) + Node (secondary, editable component instances)

## PRIMARY reference (unchanged — visual/copy/layout source of truth, not touched by this pass)
Figma File URL: https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login
- Sign-up frame 550:67 "SignUp" — steps 554:94 (email) / 554:97 (OTP) / 554:100 (profile) / 554:103 (success)
- Sign-in frame 550:73 "SignIn" — steps 554:85 (email) / 554:88 (OTP) / 554:91 (success)
Authoritative for: all Copy Lock strings, card geometry, component identity, step 1/2 content requirements. See `signup-flow.spec.md`, `signin-flow.spec.md`, `signup-flow-refinement.spec.md` (already built + PASSED) — none of that is re-derived here.

## SECONDARY reference (pattern/interaction source ONLY — never layout/copy/fields)
Figma File URL: https://www.figma.com/design/ivRBbB0gi6PftuzlEVCGHo
Figma Frame/Node URL: node 47:2275 "Desktop" (contains 4 sibling instances of "Sample report form -1", node ids 47:2276 / 47:2373 / 47:2497 / 47:2626 — each is a state/variant of the same form with progressively more fields, NOT 4 different screens)
Inspected directly via `get_metadata` (all 4 sibling instances) + `get_screenshot` at maxDimension 2200 on 47:2278 (state 1, pre-OTP) and 47:2375 (state 2, post-"Send OTP") + `get_design_context` on the Mobile-Number/Send-OTP row (47:2420), the OTP slot row (47:2445), the resend/countdown row (47:2453), and the Work Email input (47:2297). Used strictly for: input border/color styling, the inline "Send OTP" trigger's spatial relationship to its field, OTP box styling, and resend/countdown treatment — per task scope, never for layout, extra fields, page structure, or copy.

---

## Delta/refinement note

This is a **refinement spec, not a fresh analysis**. Both sign-up and sign-in flows already PASSED Loop QA (`signup-flow.spec.md`, `signin-flow.spec.md`, `signup-flow-refinement.spec.md` — the last of which already shipped compact geometry, `backdrop-blur-sm`, and the current whole-step `AnimatePresence mode="wait"` cross-fade/slide). This file changes **only** the OTP-reveal interaction mechanic (email step ⇄ OTP step, both flows) plus a small set of component/state style confirmations sourced from the secondary reference. It does **not** touch: Copy Lock, the Complete Profile step, either flow's Success step, modal geometry tokens, or the backdrop treatment — all of those remain exactly as already built and passed.

---

## 1. Resolved interaction-mechanic decision

### Evidence from the secondary reference (direct inspection, not inferred)

`get_metadata` on node 47:2275 returns 4 sibling instances of "Sample report form -1" at increasing height (822px → 1002px → 1192px → 1318px). Comparing instance 1 (`47:2276`) against instance 2 (`47:2373`) field-by-field:

- Instance 1 fields, in DOM order: Full Name → Work Email + Organisation → Your Designation → **Mobile Number (with inline "Send OTP" button, same row)** → What is your requirement? → checkboxes → submit. No OTP-entry block exists anywhere in this instance.
- Instance 2 has the **identical** Full Name / Work Email / Organisation / Your Designation / Mobile Number+Send-OTP row, **unchanged, same position** — then, directly after the Mobile Number row and before "What is your requirement?", a new block appears: "Enter verification code" + subcopy ("We've sent a 6-digit verification code to a*********@abcmobile.com") + 6 separated OTP boxes + a resend/countdown row ("Didn't receive the code? You can request a new code in 00:45, Resend OTP"). Every field below this point (What is your requirement?, checkboxes, submit button) is pushed down by exactly the inserted block's height. Screenshots (`state1-default.png` / `state2-otp-revealed.png`, both fetched at 2200px) confirm this visually: the Mobile Number field + red-outlined "Send OTP" button are pixel-identical between the two states; the OTP block is a pure insertion directly beneath them, not a replacement of anything above it.

This is unambiguous, direct confirmation of the first of the two candidate readings the task brief posed: **the email/phone field and the revealed OTP section coexist in the same view** — not two separate full screens. The trigger field/button stays visibly in place; the verification block grows in directly below it; everything below shifts down. (A third, hidden sibling frame — `47:2456`, `hidden="true"`, an alternate "Send Verification Code" button + shield-icon helper copy — is an unused draft state in the source file, not part of the visible design; noted for completeness, not adopted.)

### Reconciling with the primary reference's approved Step-2 content

The task brief is correct that this appears to conflict with "don't drop the approved OTP step's own eyebrow/heading/masked-email/back-link" only on the surface. The resolution: none of that approved Step 2 copy is dropped, duplicated, or rewritten — it is **redistributed across four DOM slots that already exist in Step 1's rendered view**, each slot crossfading or expanding in place rather than the whole card unmounting/remounting:

| Slot (already exists in Step 1's DOM) | Phase = `collecting` (today's Step 1) | Phase = `verifying` (today's Step 2) | Motion treatment |
|---|---|---|---|
| Top eyebrow+heading+subcopy block | "GET STARTED" / "Create your account" / "Use your work email…" | "VERIFY YOUR EMAIL" / "Enter verification code" / "We sent a 6-digit verification code to {masked email}." | crossfade in place, **same heading DOM `id`** throughout (so `AuthModal`'s `aria-labelledby` never has to repoint) |
| Work-email field row | label "Work email" + editable `Input` | label "Work email" + **same `Input` element**, now `readOnly`/`disabled`, value = masked email, **+ "Change" link fades in** on the same row | the input morphs in place (no second field is added); "Change" link fades in/out with the phase |
| (new, inserted directly below the email field) | not rendered | "Enter 6-digit code" label + `InputOTP` (6 slots) + resend/countdown row | height+opacity expand, mounted only in this phase — this is the literal "OTP verification area directly below the relevant field" the task asked for |
| Primary CTA | "Continue with work email" | "Verify & continue" (sign-up) / "Verify & sign in" (sign-in) | **same physical `Button`, same DOM position** — only its label/handler swap; neither approved label is renamed, both are shown, in sequence, on the one control |
| OR-divider + LinkedIn button | visible | **not rendered** (fades out) | the approved Step-2 screens (554:97 / 554:88) show no OR/LinkedIn — primary reference confirms these must not persist once verification begins, so they exit rather than just being pushed down |
| Bottom footer link | "Already have an account? Sign in" (sign-up) / "New to Ken Research? Create account" (sign-in) | "Back to sign up" (sign-up) / "Back to sign in" (sign-in) | crossfade in place, same footer slot |

Nothing here is new copy — every string in the "verifying" column is transcribed verbatim from the already-locked Step 2 Copy Lock in `signup-flow.spec.md`/`signin-flow.spec.md`. What changes is only **how** that already-approved content enters the view: in place, via crossfade/expand, inside the same mounted component — not via a second component mounting after the first unmounts.

### Concrete Framer Motion spec

Scope of the change: **only the email⇄OTP transition**, in both flows. The email→OTP→profile (sign-up) and email→OTP→success (sign-in) transitions on either side of this pair are unaffected — Step 2→3 (sign-up) and Step 2→3 (sign-in) keep the existing, already-passed whole-step `AnimatePresence mode="wait"` treatment from `signup-flow-refinement.spec.md` §4 unchanged.

```tsx
const [phase, setPhase] = useState<'collecting' | 'verifying'>('collecting');
const prefersReducedMotion = useReducedMotion();

// 1. Top heading block — crossfade, same DOM id throughout
<AnimatePresence mode="wait" initial={false}>
  <motion.div
    key={phase}
    initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 6 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4 }}
    transition={{ duration: prefersReducedMotion ? 0.01 : 0.15, ease: [0.4, 0, 0.2, 1] }}
  >
    <p className="eyebrow">{phase === 'collecting' ? 'GET STARTED' : 'VERIFY YOUR EMAIL'}</p>
    <h1 id="signup-email-heading">{phase === 'collecting' ? 'Create your account' : 'Enter verification code'}</h1>
    <p className="subcopy">
      {phase === 'collecting'
        ? 'Use your work email to create your Ken Research account.'
        : `We sent a 6-digit verification code to ${maskEmail(email)}.`}
    </p>
  </motion.div>
</AnimatePresence>

// 2. Email field row — element morphs in place, "Change" link fades in
<div className="flex items-center justify-between mb-2">
  <label htmlFor="work-email">Work email</label>
  <AnimatePresence>
    {phase === 'verifying' && (
      <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                   transition={{ duration: prefersReducedMotion ? 0.01 : 0.15 }}>
        <InlineLink href="#" variant="solid" onClick={(e) => { e.preventDefault(); setPhase('collecting'); }}>
          Change
        </InlineLink>
      </motion.span>
    )}
  </AnimatePresence>
</div>
<Input
  id="work-email"
  value={phase === 'collecting' ? email : maskEmail(email)}
  readOnly={phase === 'verifying'}
  disabled={phase === 'verifying'}
  onChange={(e) => onEmailChange(e.target.value)}
  className="h-[var(--button-height-lg)] px-4 mb-5"
/>

// 3. OTP block — height + opacity expand, directly below the email field, mounted only when verifying
<AnimatePresence initial={false}>
  {phase === 'verifying' && (
    <motion.div
      key="otp-block"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: prefersReducedMotion ? 0.01 : 0.28, ease: [0.4, 0, 0.2, 1] }}
      style={{ overflow: 'hidden' }}
    >
      <div className="pt-1">
        <label>Enter 6-digit code</label>
        <InputOTP maxLength={6} value={otp} onChange={setOtp} inputMode="numeric" autoComplete="one-time-code">
          {/* 6 separate single-slot InputOTPGroup wrappers — unchanged from the already-passed override */}
        </InputOTP>
        {/* resend/countdown row — unchanged from the already-passed OtpVerificationStep.tsx/SigninOtpStep.tsx markup */}
      </div>
    </motion.div>
  )}
</AnimatePresence>

// 4. Primary CTA — same Button element, label crossfades inside it
<Button type="submit" variant="brand" size="lg" fullWidth loading={sendingOtp}>
  <AnimatePresence mode="wait" initial={false}>
    <motion.span key={phase} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                 transition={{ duration: prefersReducedMotion ? 0.01 : 0.12 }}>
      {phase === 'collecting' ? 'Continue with work email' : 'Verify & continue'}
    </motion.span>
  </AnimatePresence>
</Button>

// 5. OR divider + LinkedIn — collapse out once verifying begins (matches approved Step-2 screens showing neither)
<AnimatePresence initial={false}>
  {phase === 'collecting' && (
    <motion.div key="alt-methods" initial={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }} transition={{ duration: prefersReducedMotion ? 0.01 : 0.15 }}
                style={{ overflow: 'hidden' }}>
      {/* OR divider + LinkedIn Button — unchanged markup */}
    </motion.div>
  )}
</AnimatePresence>

// 6. Footer link — crossfades between the two approved footer strings
<AnimatePresence mode="wait" initial={false}>
  <motion.div key={phase} ...>
    {phase === 'collecting'
      ? <p>Already have an account? <InlineLink variant="solid" onClick={onSignInClick}>Sign in</InlineLink></p>
      : <p className="text-center"><InlineLink variant="muted" onClick={() => setPhase('collecting')}>Back to sign up</InlineLink></p>}
  </motion.div>
</AnimatePresence>
```

Sign-in's merged component is the same shape, substituting its own already-approved copy set ("WELCOME BACK"/"Sign in"/… ⇄ "SECURITY CHECK"/"Verify your sign in"/…, "Verify & sign in", "Back to sign in") — not re-derived line-by-line here, apply the identical pattern.

**Concrete values:**
- Heading-block crossfade: 150ms, 6px/-4px y-offset, `ease [0.4,0,0.2,1]` — quick since it's a same-position text swap, not a layout change.
- OTP-block expand: 280ms (slightly longer than the heading crossfade — it's a real height/layout change, needs a touch more time to read as smooth rather than snappy), same easing. `height: 0 → 'auto'` is a documented Framer Motion capability (it measures true height and interpolates) — no manual height math needed.
- Button-label crossfade: 120ms (fastest — smallest, most localized change).
- OR/LinkedIn collapse-out: 150ms.
- `useReducedMotion()` (mandatory, per project convention): collapse every duration above to `0.01`, drop all `y`/height-interpolation motion to instant opacity swaps only — never fully skip the hook.
- `mode="wait"` on every crossfade (heading, button label, footer) so outgoing text fully exits before incoming text enters — no overlap, consistent with the existing whole-step transition's own `mode="wait"` choice in `signup-flow-refinement.spec.md` §4.

### Structural implications for `loop-builder` (flagged explicitly, not silently assumed)

1. **Step count changes for the outer step machine.** `SignupFlow.tsx`'s `SignupStep` union (`'email' | 'otp' | 'profile' | 'success'`) collapses to 3 externally-visible steps: `'emailOtp' | 'profile' | 'success'` (the `email`/`otp` pair merge into one mounted step, internally tracking its own `phase`). `SigninFlow.tsx`'s `SigninStep` collapses from `'email' | 'otp' | 'success'` to `'emailOtp' | 'success'`. The outer `AnimatePresence mode="wait"` step-swap in both flow components (per `signup-flow-refinement.spec.md` §4) is unchanged in mechanism — it now just has fewer keys to swap between.
2. **New merged component, one per flow — or one shared, parameterized component for both** (this is the same code-reuse opportunity `signin-flow.spec.md`'s UI/UX Pro Max notes already flagged for the un-merged OTP steps, now more valuable since the merge doubles the logic being duplicated if built as two separate files). Recommend a single component (e.g. `EmailOtpStep.tsx`) taking a `copy` props object (eyebrow/heading/subcopy/footer/button-label pairs for each phase) so sign-up and sign-in both consume it rather than maintaining two near-identical state machines — exact file naming/placement is a build-time decision, not locked by this spec.
3. **`onChangeEmail`/`onBackToSignup`/`onBackToSignin` simplify to internal state.** Today these are callbacks that bubble up to the parent flow to trigger `setStep('email')`. Under the merged component, both become a local `setPhase('collecting')` call **inside** the merged component — they no longer need to reach the parent flow at all, since there is no separate `'email'` step to swap back to. This is a real wiring change from the current build, flagged here so it isn't missed.
4. **`aria-labelledby` stability.** `AuthModal`'s `labelledBy` prop currently points at per-step heading ids (`signup-email-heading`, `otp-verification-heading`, …). Under the merge, the heading element's `id` must stay the **same string** across both phases (only its text content crossfades) so `AuthModal` never needs to repoint `aria-labelledby` mid-phase-change — already reflected in the code sketch above (`id="signup-email-heading"` fixed).
5. **Resend-countdown timer effect must be phase-gated.** The `setInterval` driving the "Resend code in 00:28" countdown (currently starts on mount of the separate `OtpVerificationStep`/`SigninOtpStep`) should now start only when `phase` first becomes `'verifying'`, not on mount of the merged component — otherwise it would tick down while the user is still on the email-entry phase.
6. **Optional polish, using a real existing DS capability, not invented:** `Button.tsx` already has a `loading` prop (spinner + disabled state, no new component). Recommend briefly setting it true on the primary CTA between the click that triggers `setPhase('verifying')` and the OTP block's expand-in completing, to sell "sending the code" — this is a nice-to-have, not a hard requirement, and does not change any DS token/component identity.
7. **Unaffected, confirmed unchanged:** Complete Profile step, both flows' Success steps, `AuthModal.tsx`'s shell/geometry/backdrop (464px/400px/`backdrop-blur-sm`, all from `signup-flow-refinement.spec.md`), and the whole-step `AnimatePresence` mechanism used for every OTHER step transition in both flows.

---

## 2. Component/State mapping — sourced from the secondary reference, applied to the existing fields only

**Never adopted:** the secondary reference's own extra fields (Full Name, Organisation, Designation, "What is your requirement?", consent checkboxes, budget/timeline selects) and its own copy/layout are explicitly out of scope per the task brief — nothing below transplants any of that. Only styling/interaction patterns for elements Ken's approved screens already have (email input, OTP boxes, an inline verification-trigger relationship, resend/countdown treatment) are extracted.

| Element | Secondary reference shows | Ken's real DS component/token (current build) | Conclusion |
|---|---|---|---|
| Email input, default state | `bg-white`, `border-[#c9c9c9]` (~1px light neutral gray), placeholder `#aca193`, `rounded-[8px]` | `design-system/core-v2/src/ui/input.tsx` — `border-black/10` default, `placeholder:text-black/30`, `rounded-[5px]` | **No change.** Both are a light, low-contrast neutral-gray border on white with a muted placeholder — same visual intent via a different technique (opacity-based token vs. literal hex). Ken's real `Input` component already achieves the equivalent look; do not introduce the secondary reference's literal `#c9c9c9`/`#aca193` hex values anywhere — that would violate "never invent a new color," since real DS tokens already cover this. |
| Email input, focus/hover/filled/error/disabled | not independently shown as separate states in the secondary reference (only the default/idle frame was inspected — no focus/error variant exists among the 4 sibling instances) | `Input.tsx`: hover `border-black/25`, focus `border-black/90` (no ring), filled `border-black/15`, error `aria-invalid:border-[var(--brand-red)]`, disabled `border-black/6 bg-black/[0.03] text-black/35` | **No change** — states are sourced from the DS component itself per the DS Mapping Gate rule, not from the reference; already correct in the current build, already used for both flows' email inputs. |
| OTP box, default state | `bg-white`, `border-[rgba(201,201,201,0.5)]` (soft, half-opacity neutral gray), `rounded-[8px]`, 51×56px, 16px gaps, fully separated boxes (no shared border) | `design-system/core-v2/src/ui/input-otp.tsx` `InputOTPSlot`, already overridden in the passed baseline build to `h-12 w-12` (48×48px) + `!rounded-[var(--radius-button)]` (5px) + per-slot `InputOTPGroup` wrapping for full separation | **No change to Ken's build.** The secondary reference independently confirms the same *pattern* already adopted (fully separated, individually-bordered/rounded boxes with visible gaps) — it does not override Ken's own primary-reference-measured 48px/5px-radius target, since the primary reference outranks this one on exact geometry. Treat this as reference-crossing confirmation, not a new instruction. |
| OTP box, focus/active state | not shown as a distinct state among the inspected instances | `InputOTPSlot`: `data-[active=true]:border-ring` (DS default), already token-substituted to `border-[var(--color-brand-red)]`/`ring-[var(--color-brand-red)]/50` in the passed build | **No change** — already correctly sourced from the DS component + the primary reference's own red-active-box treatment. |
| OTP box, error state | not shown | `InputOTPSlot`: `aria-invalid:border-destructive` (DS default) | **No change** — use the DS's own error state, per rule; not reference-confirmed in either reference. |
| Inline "Send OTP" trigger, spatial relationship | small (~96×44px) button positioned inline, right edge of the same row as the field it verifies (Mobile Number), not a full-width CTA of its own | n/a — Ken's approved Step-1 primary CTA ("Continue with work email") is already a full-width `Button variant="brand" size="lg" fullWidth`, confirmed by the primary reference (higher priority) | **Confirms the reveal mechanic (§1), does not change the button's visual treatment.** Ken's approved screens never show a small inline trigger next to the email field — the primary reference's full-width button is what triggers the reveal in Ken's flow; the secondary reference's *spatial pattern* (trigger sits directly beside/above the thing it's about to reveal, and stays in place afterward) is the pattern being borrowed, not the button's compact size/shape. |
| Inline "Send OTP" trigger, visual style | `bg-[rgba(255,243,241,0.3)]` (light pink tint), `border-[#e9b0b2]` (soft pink-red), `rounded-[4px]`, text `#de2128` (red) — an outline/tinted-brand micro-button | Ken's `atoms/Button.tsx` variants: `primary`/`secondary`/`ghost`/`brand` — none is a "tinted-pink-fill + soft-red-border + red-text" combination | **NO DS EQUIVALENT for this specific micro-style — and not needed.** Ken's approved reference never calls for a small tinted-outline button anywhere in this flow (Step 1's CTA is full-width brand; the OTP step's own secondary affordances are plain-text `InlineLink`s, not boxed buttons) — so this style has nothing to attach to and is correctly left un-adopted, not fabricated as a new Button variant. Flagging only for completeness per the task's explicit ask, not as an actionable gap. |
| Resend/countdown treatment | "Didn't receive the code?" (plain gray, `#303030`) + "You can request a new code in **00:45, Resend OTP**" bundled as one bold red (`#b22126`) span; a separate "Resend OTP" text node exists but is `opacity-0` (an inactive/hidden alternate — presumably the enabled-state label once the countdown reaches zero) | Ken's build (`OtpVerificationStep.tsx`/`SigninOtpStep.tsx`, already passed): "Resend code in {mm}:{ss}" (muted gray) + a real `InlineLink variant="solid"` "Didn't receive it?" that is `opacity-40 pointer-events-none` while counting down, full-opacity/enabled once `secondsLeft === 0` | **No change — the secondary reference corroborates, rather than contradicts, Ken's already-built sensible default** (Uncertainty #2 in `signup-flow.spec.md`, never fully resolved): a dimmed/inactive resend affordance during the countdown that becomes fully emphasized once it reaches zero. Ken's version is already built on a real DS component (`InlineLink`); the secondary reference's bold-red bundled treatment doesn't map to any different DS token and isn't required by the primary reference — not adopted as a style change, only as confirmation that the *behavioral* pattern (dim during countdown → emphasized when enabled) is reasonable. |
| Verified-checkmark / success badge for OTP itself | not shown — none of the 4 sibling instances of the secondary reference show a "verified" state for the phone/OTP fields (they differ only by which *later*, unrelated optional fields are present) | Ken's Step 3 "Email verified" `Badge.tsx` pill (already mapped in `signup-flow.spec.md`) | **Not applicable / no new information.** Ken's existing Step-3 verified-badge mapping is untouched by this pass. |

---

## 3. Copy Lock — confirmed unchanged

No copy is added, removed, or reworded by this refinement. Every string used in the "verifying" phase of the merged component (§1 table) is transcribed verbatim from the already-locked Copy Lock sections of `signup-flow.spec.md` (Step 1 + Step 2) and `signin-flow.spec.md` (Step 1 + Step 2) — not re-listed in full here to avoid drift between two copies of the same lock; those files remain the single source of truth for the exact strings. The only thing this spec changes is **which DOM slot** each already-approved string renders into and **when** it crossfades/expands — never the string itself. In particular:
- "Continue with work email" and "Verify & continue" / "Verify & sign in" are **not merged, renamed, or replaced with a new label** — both approved strings still appear, in sequence, on the same physical button.
- "Change", "Back to sign up" / "Back to sign in", "Didn't receive it?", "Resend code in {mm}:{ss}" are unchanged from the passed build.

---

## 4. DS Mapping Gate (this refinement's deltas only — full gate is `signup-flow.spec.md`/`signin-flow.spec.md`, unchanged)

| Element | DS component/token (actual path) | Status |
|---|---|---|
| Merged email+OTP step container | new composition, built from existing pieces only (`ui/input.tsx`, `atoms/Button.tsx`, `atoms/InlineLink.tsx`, `ui/input-otp.tsx`, `atoms/Divider.tsx`) — no new primitive | mapped — composition-only, no new DS component |
| Top heading crossfade | `framer-motion` `AnimatePresence`/`motion.div`, same typography tokens already used (`--typography-size-xs`/`-xl`/`-sm`) | mapped |
| Email field morph (editable ⇄ masked/readOnly) | `ui/input.tsx` `Input` — same element, `readOnly`/`disabled` prop toggled by phase | mapped (from DS) |
| OTP block height/opacity reveal | `framer-motion` `motion.div` (`height: 0 → 'auto'`), wrapping the already-passed `InputOTP`/`InputOTPGroup`/`InputOTPSlot` composition unchanged | mapped |
| Primary CTA label crossfade | `atoms/Button.tsx`, unchanged variant/size (`variant="brand" size="lg" fullWidth`); label wrapped in an inner `AnimatePresence`/`motion.span` | mapped |
| OR-divider/LinkedIn collapse-out | `atoms/Divider.tsx` + `atoms/Button.tsx` (`variant="secondary"`), unchanged; wrapped in `motion.div` for the exit-only collapse | mapped |
| Footer link crossfade | `atoms/InlineLink.tsx` (`variant="solid"` / `variant="muted"`), unchanged | mapped |
| Send-OTP inline tinted-button micro-style (secondary reference) | none — `atoms/Button.tsx`'s 4 variants have no tinted-pink-fill/soft-red-border combination | **NO DS EQUIVALENT — flag to user** (not required; nothing in the approved primary reference calls for this style, see §2) |

---

## 5. Modal/Card Geometry Target — confirmed unchanged, now phase-driven instead of step-driven

- Target modal max-width: **464px** (unchanged, from `signup-flow-refinement.spec.md` §1).
- Target content width (inner column): **≈400px** (unchanged).
- Rule (unchanged): modal width must not increase to fit text; text wraps within the controlled content width.
- **New note specific to this refinement:** the merged email+OTP step's height is no longer fixed per-step but grows/shrinks live as `phase` changes (email-only height → email+OTP height). `AuthModal.tsx`'s existing `max-h-[calc(100vh-4rem)] overflow-y-auto` (already built) is the safety net for this — it was already sized generously enough to handle the tallest existing step (Complete Profile), and the merged email+OTP phase's "verifying" height is comfortably shorter than that, so no new scroll-engagement risk is introduced. Flag for `loop-visual-qa` to confirm at ~900px viewport height on both flows regardless (per the existing open breathing-room uncertainty #R1, not a new one).

## 6. Form Control Geometry — confirmed unchanged

All control heights (48px via `--button-height-lg` override) and the shared 400px content column are untouched by this refinement — this pass only changes *when* controls mount/reveal and *how* the transition between them animates, never their size or width. No new mismatch introduced.

---

## Remaining detail / Uncertainties requiring visual convergence

- **#O1** — Exact component/file split for the merged step (single shared parameterized component vs. two near-duplicate files, one per flow) is left as a build-time decision per §1's structural-implications note 2 — both are valid, the shared version is recommended for maintainability but not mandated.
- **#O2** — The `loading` state on the primary CTA during the mock "sending OTP" gap (§1 note 6) is a nice-to-have, not required; if omitted, the OTP block should still expand-in immediately on click with no dead time.
- **#O3** — Focus management on reveal: not specified by either reference (neither shows a focus outline mid-transition). UI/UX Pro Max advisory recommends moving focus to the first OTP slot once the expand-in animation completes (or firing a polite `aria-live` announcement, e.g. "Verification code sent") so screen-reader users get positive confirmation that content changed without a page navigation — advisory only, does not override any DS/reference decision above, and does not block the build.
- **#O4** — The hidden sibling frame in the secondary reference (`47:2456`, "Send Verification Code" + shield icon, `hidden="true"`) is an unused draft state in the source file; noted for completeness only, explicitly not adopted (per instructions, invisible/hidden reference content is not used as design intent).
- Existing carried-forward uncertainties from `signup-flow.spec.md`/`signin-flow.spec.md`/`signup-flow-refinement.spec.md` (#1–#15, #R1–#R3, #F) are all unaffected by this pass and remain open where previously flagged — not re-listed here to avoid drift.

---

## UI/UX Pro Max Notes (advisory only — never overrides reference/DS/geometry above)

- **Focus management on reveal** (see #O3 above) — advisory, accessibility-only, does not change any DS token/component/copy.
- **`aria-live="polite"` region** announcing the phase change ("Verification code sent to your email") would improve non-visual continuity to match the visual "same card, not a new page" goal — advisory, additive, no component change.
- **`inputmode="numeric"`/`autocomplete="one-time-code"` on the OTP slots** — already recommended in the baseline spec's UI/UX Pro Max notes, still applies unchanged, not re-derived.
- **Reduced-motion parity** — confirmed the concrete Framer values above collapse correctly under `useReducedMotion()` per project convention (mandatory hook, never skipped); this is a repetition of the existing project-wide rule, not a new recommendation.

None of the above changes colors, typography, spacing tokens, radius, component identity, or copy already fixed by the DS Mapping Gate/Copy Lock above — advisory only.

---

## Mandatory return format

## Status
Done: OTP-reveal interaction-mechanic refinement spec written for both sign-up and sign-in flows, resolving the email⇄OTP transition mechanic against direct inspection of the secondary Figma reference (node 47:2275, file ivRBbB0gi6PftuzlEVCGHo) and the already-passed baseline/refinement specs.

## Reference source
Primary (unchanged): Figma frames 550:67 "SignUp" / 550:73 "SignIn", file PJtPivOzEkiTjSkGnZ2YtH.
Secondary (pattern-only, this pass): Figma node 47:2275 "Desktop" (4 sibling form-state instances), file ivRBbB0gi6PftuzlEVCGHo — inspected via `get_metadata`, `get_screenshot` (maxDimension 2200, states 47:2278/47:2375), and `get_design_context` (nodes 47:2420, 47:2445, 47:2453, 47:2297).

## Spec file
projects/ken-auth-redesign/specs/otp-inline-refinement.spec.md

## Copy Lock summary
Unchanged — 0 new/renamed strings. All copy used by this refinement is transcribed verbatim from the already-locked `signup-flow.spec.md`/`signin-flow.spec.md` Step 1 + Step 2 Copy Locks; this spec only changes which DOM slot/timing each string renders into.

## DS Mapping Gate summary
8 rows this pass (delta table, §4) — 7 mapped to real existing components/tokens (no new primitives), 1 flagged `NO DS EQUIVALENT` (the secondary reference's tinted-pink inline micro-button style) and explicitly marked not-needed since nothing in the approved primary reference calls for it.

## Modal/Card Geometry Target
Unchanged: 464px max-width / ≈400px content column (carried from `signup-flow-refinement.spec.md`). This pass adds only a note that height is now phase-driven within one step rather than step-driven across two, still covered by `AuthModal.tsx`'s existing scroll safety net.

## Form Control Geometry
Confirmed preserved: yes — all control heights (48px) and the shared 400px content width are untouched; this refinement changes reveal/timing only, never size.

## Component mapping summary
| Element | Change |
|---|---|
| `SignupFlow.tsx`/`SigninFlow.tsx` step union | `'email'\|'otp'\|...` collapses to `'emailOtp'\|...` (fewer outer steps) |
| New merged step component (naming TBD, e.g. `EmailOtpStep.tsx`) | composes existing `Input`/`Button`/`InlineLink`/`InputOTP`/`Divider` unchanged; adds internal `phase` state + the 6 Framer Motion treatments in §1 |
| `onChangeEmail`/`onBackToSignup`/`onBackToSignin` | simplify from parent-bubbling `setStep('email')` calls to a local `setPhase('collecting')` inside the merged component |
| Resend-countdown timer effect | gated to start only when `phase === 'verifying'`, not on component mount |

## Uncertainties flagged
- #O1: shared-vs-duplicated component file split — build-time choice, both valid.
- #O2: "sending OTP" loading state on the CTA — nice-to-have, not required.
- #O3: focus management / `aria-live` on reveal — advisory, not blocking.
- #O4: hidden draft sibling frame in the secondary reference — noted, not adopted.

## Self-check
- Model used: Sonnet
- Production code touched: no (read-only analysis; recommendations only, real file/line citations given, nothing edited)
- New DS primitives invented: no
- Copy transcribed verbatim (not paraphrased): yes — no new copy in this pass, all strings traced back to the already-locked baseline Copy Locks
- DS Mapping Gate complete (no approximations, no invented paths): yes — every mapped row cites a real existing file (`ui/input.tsx`, `atoms/Button.tsx`, `atoms/InlineLink.tsx`, `ui/input-otp.tsx`, `atoms/Divider.tsx`); the one unmapped row is explicitly flagged rather than approximated with custom CSS
- Confidence in spec: high — the central interaction-mechanic question was resolved by direct, pixel-level comparison of two live sibling states of the secondary reference (not inferred from a single flat image), and every DS token/component cited was re-read from its real source file this pass, not carried from memory
