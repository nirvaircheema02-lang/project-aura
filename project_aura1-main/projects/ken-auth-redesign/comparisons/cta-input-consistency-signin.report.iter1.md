# Loop Visual QA — CTA/Input Height Consistency, Sign-In Flow, Iteration 1

Scope: independent re-verification of `loop-builder`'s claimed height-consistency fix
("every CTA button now uses `size="md"`, every input/OTP-slot resized to match that same
height (48px target)") across the **sign-in** flow's 3 steps (email → OTP → success), plus
cross-flow consistency against the **sign-up** flow, since both share the single
`EmailOtpStep.tsx` component. This pass does not trust the builder's self-report — every
number below was captured live via `getBoundingClientRect`/`getComputedStyle` in a genuinely
visible, focused browser session.

## Status
Done: full 3-step sign-in flow driven end-to-end (email collect → OTP verify [default +
error state] → success), controlled viewport **1440×900**, dev server already running clean
on `localhost:3091`. Cross-flow spot check of sign-up's Step 1 + Step 2 (default + error
state) driven end-to-end for comparison. Iteration 1 of 4.

**Methodology note / tooling caveat (disclosed transparently):** the first pass of this QA
used the session's interactive MCP browser pane, which — reproducibly, across a fresh tab,
a fresh page load, and multiple retries — reported `document.visibilityState: "hidden"`
persistently (even immediately after a real user click established `document.hasFocus():
true`). Under that condition this app's `framer-motion`/`AnimatePresence mode="wait"`
phase-crossfades (heading, footer link, primary-CTA label) stalled indefinitely — the
underlying React state had already advanced (OTP block mounted, email masked+disabled) but
the crossfading text blocks stayed on their pre-transition content until, eventually, given
enough real wall-clock time, they resolved correctly (confirmed: the flow did complete to
"Welcome back" with the correct dynamically-typed email). This is the same class of artifact
already disclosed and diagnosed in `otp-inline-refinement-signin.report.iter1.md`. Critically,
**every element's actual geometry (height/width/radius) is set via static Tailwind
classes, not by the animation engine**, so this stall never affected the geometry numbers
themselves — but out of rigor this pass switched to a second, independent measurement method:
a standalone headless-Chromium **Playwright** script (browser launched fresh via
`node`/`playwright`, not the MCP pane), which reported `visibilityState: "visible"` /
`hasFocus: true` throughout and drove the entire flow with zero stalls, zero console errors,
and byte-identical geometry to the (non-stalled) numbers already captured via the MCP pane.
All numbers in this report are the Playwright-verified set; the MCP-pane numbers are not
relied upon anywhere they might have coincided with a stalled render. Both methods used the
repo's already-configured `playwright` dependency (root workspace `node_modules`), consistent
with "use the repository's existing browser/render capability."

## Reference source
Figma frame `550:73` "SignIn", file `PJtPivOzEkiTjSkGnZ2YtH` (step nodes `554:85`/`554:88`/
`554:91`), per `signin-flow.spec.md`. This pass is a targeted height-regression/consistency
re-verification, not a new visual-composition comparison — the code diff under test is scoped
to control-height classes only (`Button` `size` prop + `Input`/`InputOTPSlot` height
overrides), no composition/copy/layout code changed. Composition/order/spacing were visually
re-confirmed unchanged against the already-passed baseline via the screenshots captured this
pass (below), consistent with how `otp-inline-refinement-signup.report.iter2.md` handled an
analogously-scoped diff (reused the prior pass's fidelity finding rather than re-fetching an
unchanged Figma image).

Screenshots captured this pass (Playwright, 1440×900):
`comparisons/assets/render.signin.iter1.step1.png`,
`comparisons/assets/render.signin.iter1.step2.png`,
`comparisons/assets/render.signin.iter1.step2_error.png`,
`comparisons/assets/render.signin.iter1.step3.png`,
`comparisons/assets/render.signup.iter1.step1.png` (cross-flow),
`comparisons/assets/render.signup.iter1.step2.png` (cross-flow).

## Modal/Card geometry (explicit numbers, required)
- Modal width: **464px** (target: 464px, established `signup-flow-refinement.spec.md`
  baseline — unchanged by this fix, out of this iteration's scope) — MATCH, identical across
  all 3 sign-in steps and both sign-up steps checked
- Modal height: step 1 (collecting) **545.78px** · step 2 (verifying, default) **554.91px** ·
  step 2 (verifying, error state — extra error-text line) **583.38px** · step 3 (success)
  **506.97px** — all content-driven, expected, no unaccounted growth
- Content width: **400px** (464 − 2×32) (target: ≈400px) — MATCH
- Viewport size: **1440×900**
- Modal-to-viewport width ratio: **32.2%** (464/1440)
- Left/right padding: **32px** (`getComputedStyle` on the card, all steps) — MATCH
- Top/bottom padding: **32px** — MATCH
- Card border-radius: **10px** (`--radius-card`) — unchanged, MATCH

## Form control geometry (explicit numbers, required)
Measured on **every** control, every step, both flows — this is the mandatory core of this
pass.

| Control | Step | Width×Height | Radius | DS component confirmed |
|---|---|---|---|---|
| Email input (editable) | Signin Step 1 | 400×48 | 5px | yes (`ui/input.tsx`, `data-slot="input"`) |
| Primary CTA "Continue with work email" | Signin Step 1 | 400×48 | 5px | yes (`atoms/Button.tsx`, `data-component="Button"`) |
| Secondary/social CTA "Continue with LinkedIn" | Signin Step 1 | 400×48 | 5px | yes (`atoms/Button.tsx`, `data-component="Button"`) |
| Email input (masked, read-only/disabled) | Signin Step 2 | 400×48 | 5px | yes (same element, `disabled`/`readOnly` toggled) |
| OTP slot ×6 (default) | Signin Step 2 | 48×48 each | 5px | yes (`ui/input-otp.tsx` `InputOTPSlot`) |
| OTP slot ×6 (error state, `aria-invalid`) | Signin Step 2 | 48×48 each (unchanged) | 5px | yes — border `rgb(176,31,36)`, geometry undistorted by error styling |
| Primary CTA "Verify & sign in" | Signin Step 2 | 400×48 | 5px | yes |
| Primary CTA "Continue browsing" | Signin Step 3 | 400×48 | 5px | yes |
| Email input (editable) | Signup Step 1 (cross-flow) | 400×48 | 5px | yes |
| Primary/secondary CTA | Signup Step 1 (cross-flow) | 400×48 both | 5px | yes |
| Email input (masked) | Signup Step 2 (cross-flow) | 400×48 | 5px | yes |
| OTP slot ×6 (default + error) | Signup Step 2 (cross-flow) | 48×48 each, both states | 5px | yes |
| Primary CTA "Verify & continue" | Signup Step 2 (cross-flow) | 400×48 | 5px | yes |

- **Shared content width across all three controls, every step, both flows: yes** — every
  input/button sits at the same 400px content column (x-origin 520, right edge 920 at
  1440-wide viewport).
- **Every CTA button, every input, and every OTP slot resolves to the same 48px control
  height** — confirmed identical (a) within each step, (b) across all 3 sign-in steps, and
  (c) across the sign-in vs. sign-up flow (byte-identical numbers at every equivalent
  control). This is exactly the consistency the fix set out to achieve, and it is
  independently confirmed here via live `getComputedStyle`, not the builder's self-report.
- OTP slot pitch: 56px center-to-center (48px box + 8px gap), identical both flows.
- Non-DS-mapped control for reference only: the modal's `×` close button is 44×44px, radius
  4px — this is `AuthModal.tsx`'s own inline icon button, not a Form-Control-Geometry-gated
  element (no DS `Button`/`Input` component involved), unaffected by and out of scope for
  this fix.

**DS token root-cause context (why `size="md"` — not `size="lg"` — is the correct fix):**
confirmed via direct read of `design-system/core-v2/src/styles/base.css`:
`--button-height-lg: 56px` (not 48px) and `--button-height-md: 48px`. Every prior QA pass in
this project's history (`signup-flow.report.iter3.md` etc.) measured `size="lg"` buttons at a
live 56px while the Input's manual override targeted 48px — a real, if narrow, cross-control
mismatch that simply hadn't been the explicit audit target until now. `size="md"` is also the
DS's own documented recommended default (`design-system/core-v2/docs/ANTI_PATTERNS.md`:
"Never use `size="lg"` as default... `lg` only for homepage hero"). The fix is therefore not
just visually-consistent but DS-conformant.

---

## A. VISUAL FIDELITY

Composition/order/spacing re-confirmed via screenshots (see assets above) against the
already-passed baseline: eyebrow → heading → subcopy → email field(+Change in step 2) →
[OTP block in step 2] → primary CTA → OR/LinkedIn (step 1 only) → footer link — no drift, on
both flows.

### P1 (major)
None.

### P2 (noticeable)
- **OTP slot height/width are set via a hardcoded Tailwind literal (`h-12 w-12`), not via the
  same `--button-height-md` token `Input`/`Button` reference, even though today's numeric
  value (48px) matches.** File: `projects/ken-auth-redesign/builds/src/components/screens/
  EmailOtpStep.tsx` (`InputOTPSlot` className, e.g. line ~337). This is precisely the
  anti-pattern the project's own prior geometry spec explicitly warned against for the
  Input/Button pairing ("`signup-email.spec.md`": *"reuse the existing `--button-height-lg`
  value directly so the input and the two buttons are locked to the same numeric source, not
  two independently-chosen numbers that happen to match today"*) — the same reasoning applies
  here: `h-12`/`w-12` and `--button-height-md` are two independently-chosen values that
  happen to both equal 48px today; if the token is ever retuned, the OTP row would silently
  re-diverge from the input/button row, reproducing the exact class of defect this fix cycle
  exists to close out. **Measurable correction:** change
  `className="h-12 w-12 !rounded-[...]"` to
  `className="h-[var(--button-height-md)] w-[var(--button-height-md)] !rounded-[...]"` (same
  pattern already used on the email `Input` two lines above it in the same file). No visible
  change expected — this is a token-sourcing/maintainability correction, not a visual one.

### P3 (finishing/detail — non-blocking, reported per policy)
- None beyond the above. (No distinct `Input` "filled" state, no resend-timer wording drift,
  etc. — all previously-flagged P3s from earlier cycles are unrelated to this fix and were not
  re-checked as part of this narrowly-scoped pass; see prior reports for those.)

## B. DESIGN SYSTEM COMPLIANCE — PASS
- **Actual components used** (verified via `data-component`/`data-slot` DOM attributes, not
  visual impression): `atoms/Button.tsx` (`data-component="Button"`, confirmed on every
  primary/secondary/success CTA, all steps, both flows), `ui/input.tsx`
  (`data-slot="input"`, the email field, both editable and disabled/masked states),
  `ui/input-otp.tsx` (`InputOTPSlot`, `data-slot="input-otp-slot"`, per-slot separated-box
  override preserved), `atoms/InlineLink.tsx` (`data-component="InlineLink"`, confirmed on
  every link — "Create account"/"Change"/"Didn't receive it?"/"Back to sign in"/"Browse
  reports" — each with the correct `data-variant` — `solid` or `muted` — matching the
  already-passed baseline exactly).
- **Actual tokens used**: `--radius-card` (10px), `--radius-button` (5px),
  `--button-height-md` (48px, `Input`+`Button` both), `--color-brand-red`/`--brand-red`,
  `--semantic-status-success-text` (green "Verified sign-in" value, confirmed live
  `rgb(22,101,52)`), `--semantic-ink-subtle`, `--color-ramp-black-50`.
- **Custom CSS exceptions**: the OTP per-slot separation override (disclosed, previously
  accepted, unchanged this pass).
- **Any mapped DS component approximated with custom CSS instead of used directly**: none.
- One token-sourcing note carried as the P2 above (OTP slot height/width literal vs. token) —
  not a "component approximated with custom CSS" violation (the real `InputOTPSlot` component
  is still used), so it does not fail this section on its own, but is tracked as a P2 in
  Section A per the mandatory severity table.

## C. INTERACTION / UX — PASS
All states exercised live via Playwright (`getComputedStyle`), not inferred from the
reference:
- **Input states**: default `oklab(0 0 0/0.1)` → hover `oklab(0 0 0/0.25)` → focus
  `oklab(0 0 0/0.895)` → invalid (malformed email + submit) `aria-invalid="true"`, border
  tinted red (`oklab(0.49,0.16,0.08)`) → disabled/masked (verifying phase) `disabled=true`,
  `readOnly=true`, `cursor:not-allowed`, `bg:oklab(0/0/0.03)`, `border:oklab(0/0/0.06)` —
  matches `ui/input.tsx`'s documented 6-state system exactly, height stays 48px in every
  state (no distortion). **Pass.**
- **OTP slot states**: default (black border, 48×48) → active/focus (`data-active="true"`,
  border `rgb(175,31,36)` brand red, still 48×48) → error (`aria-invalid="true"` on
  incomplete submit, border `rgb(176,31,36)` on all 6 slots simultaneously, still 48×48,
  error text "Enter all 6 digits to continue." shown) — confirmed on **both** flows
  independently; the fix from the earlier OTP-error-state cycle
  (`otp-inline-refinement-signup.report.iter2.md`) remains intact and is correctly inherited
  by sign-in via the shared `EmailOtpStep.tsx`. **Pass.**
- **Button states**: primary CTA focus-visible ring confirmed
  `rgba(176,31,36,0.25) 0px 12px 32px 0px` (brand-red-tinted, visible); LinkedIn secondary CTA
  default border `rgba(0,0,0,0.12)` → hover border `rgba(162,29,33,0.64)`/text
  `rgba(118,21,24,0.88)` (brand-red tint, DS's own documented hover behavior) — height stays
  48px in both states. **Pass.**
- **Keyboard/focus behaviour**: `Tab` from the focused email input moves to the primary CTA
  button (correct logical order); visible focus ring confirmed above. **Pass.**
- **Form hierarchy**: label → input → helper → CTA → divider → secondary CTA → footer, matches
  established baseline. **Pass.**
- **Accessibility (advisory, UI/UX Pro Max — non-blocking)**: no new advisory notes this pass
  beyond those already carried in the spec (OTP `inputmode="numeric"`/
  `autocomplete="one-time-code"`, confirmed present; `aria-live="polite"` announcement,
  unaffected by this fix).

## D. RUNTIME / LAYOUT SAFETY — PASS
- **Console errors**: **none** — confirmed via a Playwright session listening for both
  `console` `error`-type messages and uncaught `pageerror` events across the entire sign-in
  flow (collect → OTP default → OTP error → OTP valid → success) and the sign-up cross-flow
  spot check (collect → OTP default → OTP error). Zero in both.
- **Horizontal overflow**: none — `document.documentElement.scrollWidth === window.innerWidth
  === 1440` confirmed at every step, both flows.
- **Modal overflow (content exceeding modal bounds)**: none.
- **Child element overflow**: one auto-flagged, pre-accepted non-issue (unchanged from every
  prior cycle): the primary CTA's shimmer-sweep `div` (`w-[200%]`) reports a raw bounding rect
  wider than the card, but its nearest `overflow:hidden` ancestor is the `<button>` itself
  (confirmed via ancestor walk) — no actual visible overflow, 2 instances found (both CTAs on
  the success step), both correctly clipped.
- **Viewport clipping**: none.
- **Unexpected layout shift**: none beyond content-driven modal-height differences between
  steps (545.78 → 554.91/583.38 → 506.97px), which are expected and were present before this
  fix too — the height-consistency change itself introduced no shift (control heights, once
  settled, are static, not animated).

---

## Copy Lock — verified verbatim, sign-in's own strings, all 3 steps

Extracted via full modal `textContent` dump and cross-checked against `signin-flow.spec.md`'s
Copy Lock:
- **Step 1**: "WELCOME BACK" / "Sign in" / "Sign in to your Ken Research account using your
  registered work email." / "Work email" / "Use your registered professional email address."
  / "Continue with work email" / "OR" / "Continue with LinkedIn" / "New to Ken Research?
  Create account" — all verbatim.
- **Step 2**: "SECURITY CHECK" / "Verify your sign in" / "We sent a 6-digit verification code
  to {masked email}." (masking confirmed correct: `jane.doe@...` → `jan***@...`) / "Change" /
  "Enter 6-digit code" / "Resend code in 00:30" (RESEND_SECONDS=30 constant; spec's "00:28" is
  an explicitly-flagged non-literal countdown snapshot, not locked copy) / "Didn't receive
  it?" / "Verify & sign in" / "Back to sign in" — all verbatim, correctly sign-in's own strings
  (not sign-up's "VERIFY YOUR EMAIL"/"Enter verification code"/"Verify & continue"/"Back to
  sign up" — confirmed no cross-flow copy leakage in either direction).
- **Step 3**: "Welcome back" (no eyebrow, confirmed absent) / "You're successfully signed in
  to your Ken Research account." / "Signed in as" + real typed email (not a hardcoded demo
  string) / "Status" + "Verified sign-in" (green, `rgb(22,101,52)` =
  `--semantic-status-success-text`) / "Continue browsing" / "Browse reports" — all verbatim.

**No missing, reordered, invented, or meaning-changed copy anywhere in the sign-in flow.**

---

## Verdict

| Check | Result |
|---|---|
| P1 issues | **0** |
| P2 issues | **1** (OTP slot height/width hardcoded literal vs. `--button-height-md` token — numerically correct today, not sourced from the same token as Input/Button) |
| P3 issues | 0 new this pass |
| Section B — DS Compliance | PASS |
| Section C — Interaction/UX | PASS |
| Section D — Runtime/Layout Safety | PASS |
| Copy Lock | Match, verbatim, all 3 steps, no cross-flow leakage |
| Modal/Card geometry | Match (464px/400px/32.2% ratio), unchanged by this fix, consistent all 3 steps |
| Form control geometry — the core ask of this pass | **Confirmed live: every CTA button, every input, and every OTP slot = 48px height, 400px shared content width (or 48×48 for OTP slots), 5px radius, identical within every step, across all 3 sign-in steps, AND identical to the sign-up flow's equivalent controls (byte-for-byte, since both consume the same `EmailOtpStep.tsx`)** |

**OVERALL: FAIL** — blocked solely by the 1 P2 above. To be unambiguous: the actual,
live-rendered height consistency the builder set out to fix **is genuinely achieved and
independently confirmed** — every measured control (Input, primary CTA, secondary CTA, and
all 6 OTP slots) renders at exactly 48px today, uniformly, across every step of both flows,
with zero console errors, zero overflow, zero DS-component-approximation, and zero copy
drift. The blocking item is a durability/token-sourcing gap, not a currently-visible
regression: the OTP slot's 48px comes from a hardcoded Tailwind literal (`h-12 w-12`) rather
than the same `--button-height-md` token the Input and Button already reference, which is the
exact "two independently-chosen numbers that happen to match today" pattern this project's
own geometry spec previously identified and ruled out for the Input/Button pairing. Per the
hard PASS gate (0 P1 **and** 0 P2 required), this alone is enough to withhold PASS. Fix is a
one-line, mechanical change (swap the literal for `h-[var(--button-height-md)]
w-[var(--button-height-md)]`, mirroring the Input override two lines above it in the same
file) with no expected visual change.

## Self-check
- Model used: Sonnet
- Production code touched: no (read-only measurement)
- Creative suggestions given: no (fidelity/measurement only — the one correction offered is a
  mechanical token-substitution matching an already-established pattern in the same file, not
  a redesign)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes — no new advisory notes
  this pass beyond those already carried in the spec
- Confidence in measurements: high — every number was captured live via
  `getBoundingClientRect`/`getComputedStyle`/DOM-attribute reads at a controlled 1440×900
  viewport, using **two independent tools** (the session's MCP browser pane, and a standalone
  Playwright script) that agreed on every geometry number where the MCP pane's session was not
  itself mid-stall (see methodology note); the Playwright pass additionally confirmed zero
  console/page errors across the complete flow on both sign-in and sign-up, and confirmed the
  OTP error-state fix (a previously-passed baseline) is intact and correctly inherited by
  sign-in from the shared `EmailOtpStep.tsx`.
