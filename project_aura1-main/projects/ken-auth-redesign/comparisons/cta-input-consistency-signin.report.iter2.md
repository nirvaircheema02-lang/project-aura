# Loop Visual QA — CTA/Input Height Consistency, Sign-In Flow, Iteration 2

Scope: independent re-verification of the fix iteration applied after
`cta-input-consistency-signin.report.iter1.md` (which FAILED solely on 1 P2: the OTP slot's
48px height/width was set via a hardcoded Tailwind literal `h-12 w-12` instead of the same
`--button-height-md` token the `Input`/`Button` already reference). This pass confirms,
live, that the fix (a) actually landed in source, (b) actually renders correctly, and (c)
introduced no regression — across all 3 sign-in steps and cross-checked against sign-up.

## Status
Done: full 3-step sign-in flow driven end-to-end (email collect → OTP verify [default +
error state] → success), controlled viewport **1440×900**, dev server running clean on
`localhost:3091` (confirmed `200` on `/`). Cross-flow spot check of sign-up Step 1 + Step 2
driven end-to-end for comparison. Iteration 2 of 4.

**Tooling:** driven via a standalone headless-Chromium Playwright script (`node` + the
repo's already-installed `playwright@1.60.0` in `builds/node_modules`), not the interactive
MCP browser pane — consistent with the tooling-caveat precedent already disclosed in iter1
(the MCP pane's `document.visibilityState` stall does not affect this project; Playwright
reports `visible`/`hasFocus:true` throughout with zero stalls). Three short-lived measurement
scripts were run from `builds/` (to resolve the local `playwright` package) and deleted
immediately after each run — no script files were left in the build tree.

## Reference source
Figma frame `550:73` "SignIn", file `PJtPivOzEkiTjSkGnZ2YtH` (step nodes `554:85`/`554:88`/
`554:91`), per `signin-flow.spec.md`. Same as iter1 — this pass is a targeted fix-verification,
not a new visual-composition comparison; the diff under test is scoped to one line
(`EmailOtpStep.tsx`'s `InputOTPSlot` className).

**Fix verified in source first:** read
`projects/ken-auth-redesign/builds/src/components/screens/EmailOtpStep.tsx` line 337 —
confirmed changed from `h-12 w-12` to
`className="h-[var(--button-height-md)] w-[var(--button-height-md)] !rounded-[var(--radius-button)] ..."`,
now token-sourced identically to the email `Input`'s own override two lines above it
(line 281: `h-[var(--button-height-md)] px-4`). Both `size="md"` on every `<Button>` in
`EmailOtpStep.tsx` (lines 374, 410) and `SigninSuccessStep.tsx` (line 91) were re-confirmed
unchanged from iter1 — grep-verified, no `size="lg"` remaining anywhere in the sign-in code
path.

Screenshots captured this pass (Playwright, 1440×900):
`comparisons/assets/render.signin.iter2.step1.png`,
`comparisons/assets/render.signin.iter2.step2.png`,
`comparisons/assets/render.signin.iter2.step2_error.png`,
`comparisons/assets/render.signin.iter2.step3.png`,
`comparisons/assets/render.signup.iter2.step1.png` (cross-flow),
`comparisons/assets/render.signup.iter2.step2.png` (cross-flow),
`comparisons/assets/sidebyside.signin.iter2.png` (4-panel side-by-side: step1 / step2 /
step2-error / step3, scaled 50%).

## Modal/Card geometry (explicit numbers, required)
- Modal width: **464px** (target: 464px, `signup-flow-refinement.spec.md` baseline) — MATCH,
  identical across all 3 sign-in steps and both sign-up steps checked
- Modal height: step 1 (collecting) **545.78px** · step 2 (verifying, default) **554.91px** ·
  step 2 (verifying, error state) **583.38px** (re-confirmed live this pass) · step 3
  (success) **506.97px** — byte-identical to iter1's numbers; the OTP-slot token fix produced
  zero height change (as predicted — no visible change was expected from a numerically
  equal, token-sourced substitution)
- Content width: **400px** (464 − 2×32) — MATCH
- Viewport size: **1440×900**
- Modal-to-viewport width ratio: **32.2%** (464/1440)
- Left/right padding: **32px** — MATCH
- Top/bottom padding: **32px** — MATCH
- Card border-radius: **10px** (`--radius-card`) — MATCH
- Modal max-height cap `calc(100vh-4rem)` = 836px; tallest observed card (583.38px, step2
  error) stays well under this — no internal scroll ever triggers, no clipping

## Form control geometry (explicit numbers, required)
Measured live on **every** control, every step, both flows.

| Control | Step | Width×Height | Radius | DS component confirmed |
|---|---|---|---|---|
| Email input (editable) | Signin Step 1 | 400×48 | 5px | yes (`ui/input.tsx`, `data-slot="input"`) |
| Primary CTA "Continue with work email" | Signin Step 1 | 400×48 | 5px | yes (`atoms/Button.tsx`, `data-component="Button"`, `size="md"`) |
| Secondary/social CTA "Continue with LinkedIn" | Signin Step 1 | 400×48 | 5px | yes (`atoms/Button.tsx`, `size="md"`) |
| Email input (masked, disabled) | Signin Step 2 | 400×48 | 5px | yes (same element, `disabled`/`readOnly`) |
| OTP slot ×6 (default) | Signin Step 2 | 48×48 each | 5px | yes (`ui/input-otp.tsx` `InputOTPSlot`, `data-slot="input-otp-slot"`) — **now token-sourced (`h-[var(--button-height-md)] w-[var(--button-height-md)]`), the fix under test** |
| OTP slot ×6 (error, `aria-invalid="true"` all 6) | Signin Step 2 | 48×48 each (unchanged) | 5px | yes — border `rgb(176,31,36)`, geometry undistorted |
| Primary CTA "Verify & sign in" | Signin Step 2 | 400×48 | 5px | yes |
| Primary CTA "Continue browsing" | Signin Step 3 | 400×48 | 5px | yes |
| Email input (editable) | Signup Step 1 (cross-flow) | 400×48 | 5px | yes |
| Primary/secondary CTA | Signup Step 1 (cross-flow) | 400×48 both | 5px | yes |
| Email input (masked) | Signup Step 2 (cross-flow) | 400×48 | 5px | yes |
| OTP slot ×6 | Signup Step 2 (cross-flow) | 48×48 each | 5px | yes |
| Primary CTA "Verify & continue" | Signup Step 2 (cross-flow) | 400×48 | 5px | yes |

- **Shared content width across all three controls, every step, both flows: yes** — every
  input/button x-origin 520, right edge 920 at 1440-wide viewport.
- **Every CTA button, every input, and every OTP slot resolves to the same 48px control
  height** — confirmed identical (a) within each step, (b) across all 3 sign-in steps, (c)
  across sign-in vs. sign-up, **and (d) now sourced from the same `--button-height-md` token
  on every one of Input/Button/OTP-slot** — closing the durability gap iter1 flagged. No
  "two independently-chosen numbers that happen to match today" pattern remains anywhere in
  this control set.
- OTP slot pitch: 56px center-to-center (48px box + 8px gap) — unchanged, identical both flows.
- Non-DS-mapped reference-only control: modal `×` close button, 44×44px, radius 4px — out of
  Form-Control-Geometry scope (no DS `Button`/`Input` involved), unchanged.

---

## A. VISUAL FIDELITY

Composition/order/spacing re-confirmed via screenshots against the already-passed baseline —
no drift, both flows. The iter1 P2 (OTP slot hardcoded literal) is the only open item from
the prior pass and is addressed below.

### P1 (major)
None.

### P2 (noticeable)
None. The iter1 P2 (`h-12 w-12` hardcoded literal on `InputOTPSlot` vs. `--button-height-md`
token) is **resolved** — verified by direct source read (line 337 now reads
`h-[var(--button-height-md)] w-[var(--button-height-md)]`) and confirmed live (48×48px
rendered, byte-identical to before, zero visual change, as expected for a pure
token-substitution fix).

### P3 (finishing/detail — non-blocking, reported per policy)
None newly observed this pass. (Carried note: no distinct `Input` "filled" state variant, no
resend-timer copy drift — unrelated to this fix, unchanged from prior cycles.)

## B. DESIGN SYSTEM COMPLIANCE — PASS
- **Actual components used** (verified via `data-component`/`data-slot` DOM attributes):
  `atoms/Button.tsx` (`data-component="Button"`, every CTA, all steps, both flows, all
  `size="md"` — grep-confirmed, zero `size="lg"` remaining), `ui/input.tsx`
  (`data-slot="input"`, email field, both phases), `ui/input-otp.tsx` (`data-slot="input-otp"`
  group / `data-slot="input-otp-slot"` per-slot), `atoms/InlineLink.tsx` (confirmed on every
  link, all copy verbatim per Copy Lock check below).
- **Actual tokens used**: `--radius-card` (10px), `--radius-button` (5px),
  `--button-height-md` (48px) — **now the single shared source for Input, Button, AND
  `InputOTPSlot` geometry**, `--color-brand-red`, `--semantic-status-success-text`,
  `--semantic-ink-subtle`.
- **Custom CSS exceptions**: OTP per-slot separation override (disclosed, previously
  accepted, unchanged).
- **Any mapped DS component approximated with custom CSS instead of used directly**: none.
- **Token-sourcing status**: the iter1-flagged gap (OTP slot literal vs. token) is closed —
  every one of Input/Button/OTP-slot now reads its height from `--button-height-md` directly,
  no independently-chosen literal remains in this control set.

## C. INTERACTION / UX — PASS
Re-exercised live via Playwright (`getComputedStyle`), spot-checked against iter1's
exhaustive baseline (unaffected by a geometry-only fix, but independently re-confirmed
rather than assumed):
- **Input states** (Signin Step 1, editable): default border `oklab(0 0 0/0.1)` → hover
  `oklab(0 0 0/0.25)` → focus `oklab(0 0 0/0.895)` — height stays 48px in all three states.
  **Pass.**
- **Input state** (Signin Step 2, masked/disabled): border `oklab(0 0 0/0.06)`,
  `disabled`/`readOnly` — height stays 48px. **Pass.**
- **OTP slot states**: default (48×48, black border) → error (`aria-invalid="true"` on all 6
  slots simultaneously after empty-submit, border `rgb(176,31,36)`, still 48×48, error text
  "Enter all 6 digits to continue." shown) — geometry undistorted by error styling in either
  the old or new (token-sourced) implementation. **Pass.**
- **Button states**: primary CTA `Tab`-focus-visible ring confirmed
  `rgba(176,31,36,0.15) 0px 4px 16px 0px` (brand-red-tinted); LinkedIn secondary CTA default
  border `rgba(0,0,0,0.12)` → hover border `rgba(162,29,33,0.64)` — height stays 48px in
  every state, both buttons. **Pass.**
- **Keyboard/focus behaviour**: `Tab` from the focused email input moves focus to "Continue
  with work email" (correct logical order); focus-visible ring confirmed present. **Pass.**
- **Form hierarchy**: label → input → helper → CTA → divider → secondary CTA → footer,
  matches established baseline. **Pass.**
- **Accessibility (advisory, UI/UX Pro Max — non-blocking)**: no new advisory notes this
  pass; OTP `aria-invalid` correctly reflects the error state on all 6 slots, focus-visible
  rings present on both input and buttons.

## D. RUNTIME / LAYOUT SAFETY — PASS
- **Console errors**: **none** — a Playwright session listening for `console` `error`-type
  messages and uncaught `pageerror` events across the complete sign-in flow (collect → OTP
  default → OTP error → OTP valid → success) plus the sign-up cross-flow spot check (collect
  → OTP default) recorded **zero** in both categories, across 3 separate script runs this
  iteration.
- **Horizontal overflow**: none — `document.documentElement.scrollWidth === window.innerWidth
  === 1440` confirmed at every step, both flows, re-checked at the error state specifically
  (the one step where an extra error-text line grows the card) — still no horizontal
  overflow.
- **Modal overflow (content exceeding modal bounds)**: none — tallest card (583.38px, step2
  error) is well under the modal's own `max-h-[calc(100vh-4rem)]` (836px) cap; no
  internal scroll triggers, no content clipping.
- **Child element overflow**: none newly introduced by this fix. The OTP slot's className
  change (`h-12 w-12` → `h-[var(--button-height-md)] w-[var(--button-height-md)]`) is a
  pure value-equivalent substitution (both resolve to 48px today) — no new overflow surface
  was created; the previously-accepted, unrelated shimmer-sweep non-issue (button's own
  `overflow:hidden` ancestor correctly clips its `w-[200%]` sweep div) is unchanged.
- **Viewport clipping**: none.
- **Unexpected layout shift**: none. Card-height differences between steps (545.78 →
  554.91/583.38 → 506.97px) are expected, content-driven, and byte-identical to iter1's
  numbers — the token-substitution fix itself introduced zero shift (48px was, and remains,
  the settled value both before and after).

---

## Copy Lock — verified verbatim, live `textContent` dump, all 3 sign-in steps + cross-flow

- **Step 1**: "WELCOME BACK" / "Sign in" / "Sign in to your Ken Research account using your
  registered work email." / "Work email" / "Use your registered professional email address."
  / "Continue with work email" / "OR" / "Continue with LinkedIn" / "New to Ken Research?
  Create account" — verbatim match.
- **Step 2 (default)**: "SECURITY CHECK" / "Verify your sign in" / "We sent a 6-digit
  verification code to jan***@kenresearch.com." (masking correct) / "Change" / "Enter
  6-digit code" / "Resend code in 00:30" / "Didn't receive it?" / "Verify & sign in" / "Back
  to sign in" — verbatim, confirmed distinct from sign-up's own Step 2 strings ("VERIFY YOUR
  EMAIL" / "Verify & continue" / "Back to sign up" — captured side-by-side this pass, zero
  cross-flow leakage in either direction).
- **Step 2 (error)**: adds "Enter all 6 digits to continue." — verbatim, all other strings
  unchanged.
- **Step 3**: "Welcome back" (no eyebrow) / "You're successfully signed in to your Ken
  Research account." / "Signed in as" + live-typed email (`jane.doe@kenresearch.com`, not a
  hardcoded demo string) / "Status" + "Verified sign-in" / "Continue browsing" / "Browse
  reports" — verbatim.
- `aria-labelledby` correctly repoints: `signin-email-heading` (steps 1 & 2, shared per
  design) → `signin-success-heading` (step 3).

**No missing, reordered, invented, or meaning-changed copy anywhere in the sign-in flow;
no cross-flow copy leakage.**

---

## Verdict

| Check | Result |
|---|---|
| P1 issues | **0** |
| P2 issues | **0** (iter1's sole P2 — OTP slot hardcoded literal vs. token — resolved and verified) |
| P3 issues | 0 |
| Section B — DS Compliance | PASS |
| Section C — Interaction/UX | PASS |
| Section D — Runtime/Layout Safety | PASS |
| Copy Lock | Match, verbatim, all 3 steps, no cross-flow leakage |
| Modal/Card geometry | Match (464px/400px/32.2% ratio), byte-identical to iter1, consistent all 3 steps |
| Form control geometry | Confirmed live: every CTA button, every input, and every OTP slot = 48px height, 400px shared content width (48×48 for OTP slots), 5px radius, identical within every step, across all 3 sign-in steps, AND identical to sign-up's equivalent controls — **now additionally confirmed all three control types share the literal same `--button-height-md` token source**, closing the durability gap from iter1 |

**OVERALL: PASS**

All hard-gate criteria met: 0 P1, 0 P2, Section B/C/D all PASS, Copy Lock verbatim, modal
proportions match the geometry target exactly (unchanged from the already-accepted
baseline), form control geometry consistent with shared content width and real DS component
sizing — and now with a single shared token source for every control's height, which is
what specifically differentiates this iteration's PASS from iter1's FAIL.

## Self-check
- Model used: Sonnet
- Production code touched: no (read-only measurement; 3 short-lived Playwright measurement
  scripts were copied into `builds/` to resolve the local `node_modules/playwright`
  dependency, run, and deleted immediately after — no lasting change to the build tree,
  confirmed via directory listing)
- Creative suggestions given: no (fidelity/measurement only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes — no new advisory
  notes this pass
- Confidence in measurements: high — every number captured live via
  `getBoundingClientRect`/`getComputedStyle`/DOM-attribute reads at a controlled 1440×900
  viewport via a standalone Playwright script (3 separate runs, zero console/page errors in
  any), cross-checked against the sign-up flow's equivalent controls and against iter1's
  independently-captured numbers (byte-identical everywhere except the one fixed line).
