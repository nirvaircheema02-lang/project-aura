# Loop Visual QA — OTP Inline-Reveal Refinement, Sign-Up Flow, Iteration 2

Scope: re-verification pass. `loop-builder` iteration 2 claimed to have fixed iter1's single P1
(OTP slot error state produced zero visible feedback because `--destructive`/`--input` are
undefined anywhere in this workspace). This pass independently re-derives that claim from live
`getComputedStyle`/DOM state (not from the builder's changelog comment), re-runs the full
four-section process, drives all 4 sign-up steps end-to-end, and checks for regressions against
every previously-passed baseline (`signup-flow.spec.md`, `signup-flow-refinement.spec.md`,
`otp-inline-refinement.spec.md` iter1).

## Status
Done: OTP inline-reveal refinement QA, iteration 2 of 4 — sign-up flow, all 4 steps
(`emailOtp` [collecting⇄verifying] → `profile` → `success`) driven end-to-end, controlled
viewport **1440×900**, fresh headless Chromium/Playwright, dev server already running clean on
`localhost:3091` (verified HTTP 200 before starting; no cache-clear/restart needed this pass,
unlike iter1's pre-flight fix).

**Methodology note:** every number below was captured live via `getBoundingClientRect`/
`getComputedStyle`/DOM-attribute reads across 6 separate Playwright automation sessions covering:
(1) collecting-phase geometry + input states + reveal-transition, (2) the OTP error-state fix
verification + correction flow, (3) Complete Profile step + Escape-double-dismiss + Success step,
(4) "Change" link round-trip + resend-link initial state + active-OTP-slot state + cross-flow nav,
(5) isolated normal-vs-reduced-motion reveal timing, (6) email-invalid-state + keyboard tab-order/
focus-ring. Source files (`EmailOtpStep.tsx`, `CompleteProfileStep.tsx`, `SignupSuccessStep.tsx`,
`globals.css`, `input-otp.tsx`, `SignupFlow.tsx`) were also read directly to confirm the live
measurements against the actual shipped code, not inferred from screenshots alone.

## Reference source
- **Primary** (unchanged from iter1): Figma frame `550:67` "SignUp", file `PJtPivOzEkiTjSkGnZ2YtH`
  — nodes `554:94` (email/collecting), `554:97` (OTP/verifying), `554:100` (profile),
  `554:103` (success). Not re-fetched this pass: the code diff between iter1 and iter2 is
  scoped entirely to one Tailwind class on `InputOTPSlot` (an error-state border override) — no
  composition/copy/layout code changed, so iter1's fresh Figma re-fetch and its already-confirmed
  visual-fidelity finding remain valid. Reused `comparisons/assets/reference.iter1.png` for this
  pass's side-by-side rather than re-fetching an identical image from Figma.
- **Secondary** (pattern-only, unchanged): Figma node `47:2275` "Desktop", file
  `ivRBbB0gi6PftuzlEVCGHo` — not re-inspected this pass, same reasoning as above.
- Side-by-side comparison produced this pass: `comparisons/assets/sidebyside.iter2.png`
  (reference vs. collecting-phase render, plus verifying-phase and OTP-error-state renders).

## Modal/Card geometry (explicit numbers, required)
- Modal width: **464px** (target: 464px) — MATCH, identical in both phases, identical to iter1
- Modal height (collecting): **569.78px** — **identical to iter1's measurement** (569.8px)
- Modal height (verifying): **570.91px** — **identical to iter1's measurement** (570.9px) — this
  exact match across iterations is itself evidence the OTP-slot className fix introduced zero
  layout side-effects (a border-color-only change cannot and did not move any box)
- Content width: **400px** (target: ≈400px) — MATCH
- Viewport size: **1440×900**
- Modal-to-viewport width ratio: **32.2%** (464/1440)
- Left/right padding: **32px** (`getComputedStyle` on the card: `paddingLeft`/`paddingRight` both `32px`) — MATCH
- Top/bottom padding: **32px** (`paddingTop`/`paddingBottom` both `32px`) — MATCH
- Card border-radius: **10px** (`--radius-card`) — MATCH, unchanged

## Form control geometry (explicit numbers, required)
- Email input: **400×56**, radius **5px**, DS component confirmed: **yes** (`ui/input.tsx`, same
  element both phases — confirmed via `disabled`/`readOnly` attribute toggle + value masking,
  not a second field)
- Primary CTA: **400×56**, radius **5px** (live-measured `border-radius: 5px`), DS component
  confirmed: **yes** (`atoms/Button.tsx variant="brand" size="lg" fullWidth`, same physical
  button both phases — only its label crossfades)
- Secondary/social CTA (LinkedIn): **400×56**, radius **5px** (live-measured), DS component
  confirmed: **yes** (`atoms/Button.tsx variant="secondary"`, present in collecting phase,
  correctly unmounted in verifying phase)
- Shared content width across all three: **yes** — all three sit at x-origin 520 (488 card-x +
  32 padding), all 400px wide
- OTP slots ×6: **48×48px**, radius **5px** (`!rounded-[var(--radius-button)]`) — unchanged from
  iter1, unaffected by the error-state className addition
- Complete Profile step (unaffected by this refinement, spot-checked for regressions): full name
  input 400×56, phone input 300×56 + country-code select 92×56 (the pair spans the 400px column
  together, per spec's explicit design — each sits at radius 5px, select-trigger height confirmed
  live at 56px, not the DS-default 36px it would silently regress to without the `!h-` override
  documented in the component), checkbox 16×16 (native DS `Checkbox` size — see advisory note in
  Section C)

---

## A. VISUAL FIDELITY

Side-by-side (`comparisons/assets/sidebyside.iter2.png`) against the unchanged reference confirms
the same close correspondence iter1 already established: eyebrow/heading/subcopy/label/input/
helper/button/OR-divider/LinkedIn/footer order, weight, and spacing all read identically to the
reference. The collecting→verifying composition is byte-for-byte the same code path as iter1
(confirmed via the geometry match above), so no new fidelity drift is possible from this fix.

**The iter1 P1 is resolved.** Live-measured this pass:
- `InputOTPSlot`'s className now includes `aria-invalid:border-[var(--brand-red)]` (confirmed via
  direct read of `EmailOtpStep.tsx` line 330, and via live `getComputedStyle`).
- `--brand-red` **is** a real, defined token in this workspace (`design-system/core-v2/src/
  styles/base.css:174` → `--brand-red: var(--color-brand-red, #b01f24);`) — unlike the previously
  undefined `--destructive`/`--input` pair, this resolves to a real color with its own literal
  fallback. Confirmed this is the exact same token the email input's own already-working
  `aria-invalid:border-[var(--brand-red)]` pattern and the "Enter all 6 digits to continue."
  error-text color already use — the fix reuses an established, already-passing pattern rather
  than introducing a new one.
- Live submit of an incomplete code (`123`): all 6 slots get `aria-invalid="true"`, and
  `getComputedStyle(...).borderColor` on every one of the 6 slots reads **`rgb(176, 31, 36)`**
  (`#B01F24`, Ken brand red) — clearly, measurably different from the default (non-invalid)
  slot's `rgb(0, 0, 0)` border. Screenshot-confirmed (`render.iter2.step1.otp_error_state.png`):
  all 6 boxes now show a visible red outline, matching the error text below them.
- Correcting the code (typing a full 6-digit value) clears `aria-invalid` back to `"false"` and
  the border returns to `rgb(0, 0, 0)` (default) live, confirming the fix is reactive, not a
  one-way/stuck state.

### P1 (major)
None. (iter1's single P1 — OTP error state producing zero visible feedback — is confirmed fixed,
see above and Section C.)

### P2 (noticeable)
None found this pass.

### P3 (finishing/detail — non-blocking, reported per policy)
- **Input.tsx still has no distinct "filled" visual state** (unchanged from iter1, `input.tsx`
  untouched by this refinement). Live-measured this pass: filled+blurred email input computes to
  `border-color: oklab(0 0 0 / 0.1)` — identical to empty/default. Re-confirmed via an isolated
  hover check (no prior focus) that hover alone correctly reads `oklab(0 0 0 / 0.25)` and clean
  focus reads `oklab(0 0 0 / 0.9)` — both correct — but there is still no separate "filled" rule.
  Not blocking, not introduced/affected by this iteration.
- **`sendingOtp` loading-spinner nice-to-have (spec §1 note 6, Uncertainty #O2) remains
  implemented and working**, re-confirmed this pass via isolated timing capture: OTP block first
  appears in the DOM at **~445ms** after the collecting-phase submit click under normal motion
  (matches the code's `350ms` reveal delay + render/mount overhead) vs. **~104ms** under
  `prefers-reduced-motion: reduce` (matches the code's `10ms` reduced-motion delay) — the two
  numbers are cleanly separated, proving the reduced-motion branch is genuinely wired and not
  merely present-but-inert. Recording as P3 (informational) only because nothing is wrong with it.

---

## B. DESIGN SYSTEM COMPLIANCE — PASS

- **Actual components used** (verified via direct import read, not visual inspection alone):
  `ui/input.tsx` (`Input`), `atoms/Button.tsx` (`variant="brand" size="lg" fullWidth` primary;
  `variant="secondary" background="light"` LinkedIn), `atoms/InlineLink.tsx` (`variant="solid"`
  for "Change"/"Didn't receive it?"/footer links, `variant="muted"` for "Back to sign up" — all
  confirmed live via `data-variant`), `atoms/Divider.tsx` (`variant="subtle"`), `ui/input-otp.tsx`
  (`InputOTP`/`InputOTPGroup`/`InputOTPSlot`, per-slot separation override preserved verbatim),
  all animated via `framer-motion` only — zero new primitives, unchanged from iter1's already-PASS
  finding.
- **Actual tokens used**: `--radius-card` (10px), `--radius-button` (5px), `--button-height-lg`
  (56px), `--color-brand-red`/`--brand-red` (both confirmed live-resolving to the same
  `rgb(176,31,36)` — `--brand-red` is a real alias of `--color-brand-red`, not an undefined
  token like the previous `--destructive`/`--input` pair was).
- **Custom CSS exceptions**: none newly introduced. The fix is a Tailwind arbitrary-value utility
  (`aria-invalid:border-[var(--brand-red)]`) added to `InputOTPSlot`'s existing `className`
  override — the same override mechanism already used (and already passing) for the active/focus
  state (`data-[active=true]:border-[var(--color-brand-red)]`) on the identical element. This is
  not a new custom-CSS system and does not replace the real DS component with hand-rolled markup.
- **Any mapped DS component approximated with custom CSS instead of used directly**: **none.**
  `InputOTPSlot` is still the real, correctly-imported DS component; only its error-state color
  resolution was corrected by pointing at a token that actually exists in this workspace, exactly
  per iter1's own recommended fix option (b).

## C. INTERACTION / UX — PASS

- **Input states (email field)**: default (`border-black/10`, live: `oklab(0 0 0 / 0.1)`) → hover
  (`oklab(0 0 0 / 0.25)`, isolated re-check with no prior focus) → focus (`oklab(0 0 0 / 0.9)`) →
  disabled/masked-in-verifying (`oklab(0 0 0 / 0.06)` border, `oklab(0 0 0 / 0.03)` bg, `oklab(0 0
  0 / 0.35)` text, `cursor: not-allowed`) → **invalid** (malformed email + submit: `aria-invalid=
  "true"`, border computes to a reddish `oklab(0.4896 0.1614 0.0774 / 0.972)`, i.e. brand-red-
  tinted, not black) — all confirmed live via `getComputedStyle`, matching `Input.tsx`'s real
  documented behavior. **Pass.** "Filled" has no distinct treatment — see P3, not blocking, not
  regressed.
- **OTP slot states — the core re-verification target**: default 48×48/radius-5px (`rgb(0,0,0)`
  border) confirmed; **active/focus** confirmed live as `rgb(171, 30, 35)` (brand-red family, the
  existing override, unaffected) — **pass**; **error** (the iter1 P1) now confirmed live as
  `rgb(176, 31, 36)` across **all 6 slots simultaneously**, clearly distinguishable from both the
  default black border and, incidentally, close to but not identical to the active-state red
  (171 vs 176 — both real brand-red renderings, the tiny difference is ring/border compositing,
  not a defect) — **pass, fix confirmed**. Correcting the code back to 6 valid digits clears
  `aria-invalid` and the border back to black live, confirming the state is fully reactive.
- **Button states**: primary CTA shimmer present (DS's own always-on brand shimmer); `loading`
  state during the mock OTP-send confirmed via the isolated timing capture above. **Pass.**
- **Checkbox checked state** (Complete Profile step, unaffected by this refinement, re-checked
  for regression): confirmed live `rgb(176, 31, 36)` = `#B01F24` = Ken brand red. **Pass, not
  regressed.**
- **Select-trigger height fix** (Complete Profile step, an unrelated but adjacent prior fix,
  spot-checked this pass since Section C requires exercising every DS-mapped interactive element):
  live-measured `56px` (`--button-height-lg`), not the DS-default `36px` the `!h-` comment in the
  source warns it would silently regress to without the `!important` override. **Pass, confirmed
  still applied.**
- **Escape double-dismiss** (re-tested live with an actually-open country-code `Select` popover on
  the Profile step, 10× 100ms-interval polling to rule out a timing race): 1st Escape closes only
  the popover (`AuthModal` count stays 1, popover count → 0); 2nd Escape closes the modal
  (`AuthModal` count → 0, held stable for a full second of polling afterward). **Pass, not
  regressed.**
- **"Change" link round-trip** (re-verified live, not just structurally): clicking "Change" during
  the verifying phase returns to the collecting phase (heading back to "Create your account",
  email input editable again with the original typed value intact, LinkedIn/OR-divider back), and
  a DOM-attribute marker set on `[data-component="AuthModal"]` before the round-trip survived
  intact afterward — direct proof of no remount. **Pass.**
- **Resend-link initial state**: on entering the verifying phase, `aria-disabled="true"` and
  countdown text reads "Resend code in 00:30" (matches `RESEND_SECONDS = 30` in source) —
  correctly gated, matching spec structural note 5 (timer starts only on phase entry). **Pass.**
- **In-place swap / no remount (the refinement's core requirement)**: a `data-qa-marker` attribute
  set directly on the live `AuthModal` node immediately before triggering collecting→verifying was
  re-read intact afterward — direct proof the same instance/state persisted, re-confirmed this
  pass independently of iter1's own equivalent check. **Pass.**
- **Reveal transition timing**: isolated `performance.now()`-based capture (poller started before
  the click, not after) shows the OTP block first mounts at **~445ms** under normal motion vs.
  **~104ms** under `prefers-reduced-motion: reduce` — a clean, real separation confirming both the
  delay and the reduced-motion collapse are genuinely wired, not coincidental. **Pass.**
- **No layout shift on surrounding page content**: modal height moves by exactly the same +1.13px
  (569.78→570.91px) iter1 measured — `AuthModal` is `fixed inset-0`, so the underlying page cannot
  reflow from this. **Pass, not regressed.**
- **Keyboard tab order + focus ring**: `Tab` from the email input moves focus to the primary CTA
  button (logical order); the focused button's `box-shadow` computes to a visible brand-red-
  tinted ring (`rgba(176, 31, 36, 0.235) 0px 10.7px 29.4px 0px`). **Pass.**
- **Cross-flow navigation** (re-verified live): closing the sign-up modal (Escape) then clicking
  the navbar "Sign in" correctly opens `SigninFlow` (confirmed via its own "WELCOME BACK"/"Sign
  in" heading, LinkedIn present) — **not regressed**.
- **Accessibility (advisory, UI/UX Pro Max — does not affect the verdict beyond hard findings
  above)**:
  - The spec's `aria-live="polite"` announcement (#O3) remains implemented and present in the DOM
    (`sr-only` span), unchanged from iter1.
  - Complete Profile's `Checkbox` renders at a native **16×16px** hit target — below the
    commonly-recommended 44×44px touch-target minimum in isolation. Not a new issue (pre-existing
    DS component, unaffected by this refinement, not reference-confirmed to need a change) and its
    effective clickable area is larger in practice since the adjacent `<label htmlFor="agree-
    terms">` text also toggles it. Flagging as an advisory note only, per the UI/UX Pro Max
    boundary rule — does not block PASS and is not a DS Mapping Gate violation (it's the DS
    component's own real, unmodified size).

**Section verdict: PASS** — the iter1 blocking item (OTP error state) is resolved; every other
interaction/state check also passes, with zero new regressions found across the full 4-step flow.

## D. RUNTIME / LAYOUT SAFETY — PASS

- **Console errors**: none, across 6 separate Playwright automation sessions (collecting-phase
  states, OTP error+correction, full Complete-Profile fill + Escape-double-dismiss + Success,
  Change-link round-trip + resend + active-slot + cross-flow nav, normal-vs-reduced-motion timing,
  invalid-email + tab-order). Zero `console.error` and zero uncaught `pageerror` events across all
  sessions.
- **Horizontal overflow**: none — `document.documentElement.scrollWidth === window.innerWidth ===
  1440` re-checked independently at collecting, profile, and success steps this pass.
- **Modal overflow (content exceeding modal bounds)**: none.
- **Child element overflow**: one auto-flagged candidate on the Complete Profile step (the primary
  CTA's always-on shimmer-sweep `div`, raw geometry `left:520 right:1320` vs. the card's own
  `left:488 right:952`) — independently re-verified this pass via a fresh ancestor-walk: the
  shimmer div's nearest `overflow:hidden` ancestor is the `<button>` element itself, confirmed via
  live DOM traversal (`clippedByAncestor: true`, `clippedBy: {tag: "BUTTON", ...}`). Same
  pre-accepted, non-issue finding as iter1 — **no actual visible overflow**.
- **Viewport clipping**: none.
- **Unexpected layout shift on state change**: none — modal height changes by the same +1.13px
  iter1 measured, well inside the `max-h-[calc(100vh-4rem)]` ceiling (836px at this viewport); no
  scrollbar engaged at any step (Complete Profile's own height, 785.3px, is also comfortably under
  the ceiling).

---

## Copy Lock — verified across all 4 steps this pass (broader than iter1's steps-1-2 focus)

Sampled via DOM text/attribute queries and cross-checked against `signup-flow.spec.md`'s full
4-step Copy Lock and the actual copy object wired in `SignupFlow.tsx`:
- **Step 1 (collecting)**: "GET STARTED" / "Create your account" / "Use your work email to create
  your Ken Research account." / "Work email" / "name@company.com" / "Use your professional email
  address." / "Continue with work email" / "OR" / "Continue with LinkedIn" / "Already have an
  account? Sign in" — all verbatim.
- **Step 1 (verifying)**: "VERIFY YOUR EMAIL" / "Enter verification code" / "We sent a 6-digit
  verification code to {masked email}." / "Change" / "Enter 6-digit code" / "Resend code in
  {mm}:{ss}" / "Didn't receive it?" / "Verify & continue" / "Back to sign up" — all verbatim.
  Masking reconfirmed correct (`priya.nair@ken-research.com` → `pri***@ken-research.com`).
- **Step 2 (Complete Profile, unaffected by this refinement, re-confirmed for regression)**:
  "ACCOUNT SETUP" / "Complete your profile" / subcopy / "Email verified" / "Full name" / "Phone
  number" / "Company name" / "Auto-detected from your work email. You can edit this." / terms
  checkbox copy with "Terms of Use"/"Privacy Policy" links / "Create account" / "Already have an
  account? Sign in" — all verbatim, confirmed via direct source read of `CompleteProfileStep.tsx`
  plus live DOM.
- **Step 3 (Success, unaffected, re-confirmed)**: "Your account is ready" / info-panel rows
  "Name"/"Work email"/"Account" (wired to real flow state, not literal demo strings, per spec
  Uncertainty #5/#6's resolution) / "Continue browsing" / "Browse reports" — all verbatim,
  confirmed via `SignupSuccessStep.tsx` source + live screenshot.

**No missing, reordered, invented, or meaning-changed copy anywhere in the 4-step flow.**

---

## Verdict

| Check | Result |
|---|---|
| P1 issues | **0** (iter1's single P1 — OTP error-state border — confirmed fixed and independently re-verified live) |
| P2 issues | **0** |
| P3 issues | 2 (both informational, non-blocking, carried forward unchanged from iter1 — no distinct Input "filled" state; the `sendingOtp` spinner nice-to-have, confirmed working) |
| Section B — DS Compliance | **PASS** |
| Section C — Interaction/UX | **PASS** |
| Section D — Runtime/Layout Safety | **PASS** |
| Copy Lock | Match, verbatim, all 4 steps |
| Modal/Card geometry vs. target | Match (464px/400px/32.2% ratio), **byte-identical to iter1's own measurements** — proves the fix caused zero layout side-effects |
| Form control geometry | Match (400×56 shared across all 3 primary controls, both phases; OTP 48×48/radius-5px unchanged; Complete Profile's select-trigger 56px override confirmed still applied) |
| Core reveal mechanic (§1 of spec) | Re-confirmed correct: same `AuthModal` instance across the reveal AND the "Change" round-trip, smooth height+opacity expand, reduced-motion branch measurably faster (~104ms vs. ~445ms first-appear) |
| Regressions vs. all prior PASSED baselines | **None** — Copy Lock (all 4 steps), geometry, control sizing, InlineLink variants, checkbox brand-red, select-trigger height, Escape double-dismiss, "Change" round-trip, cross-flow navigation, resend-link gating all reconfirmed live |

**OVERALL: PASS** — iter1's sole blocking P1 (OTP slot error state producing zero visible
feedback due to undefined `--destructive`/`--input` tokens) is independently confirmed fixed via
live `getComputedStyle` on all 6 slots simultaneously (`rgb(176, 31, 36)` when invalid vs.
`rgb(0, 0, 0)` default — a clear, measurable, screenshot-visible distinction), using the exact
mechanism iter1 recommended (reusing the already-working `--brand-red` token via an
`aria-invalid:border-[var(--brand-red)]` override on the real `InputOTPSlot` component, mirroring
the email input's own already-passing pattern — not a new custom-CSS system). Zero P1, zero P2.
All 4 sign-up steps were driven end-to-end this pass (not just the `emailOtp` step iter1 focused
on), and zero regressions were found against any previously-passed baseline.

## Self-check
- Model used: Sonnet
- Production code touched: no (read-only measurement; dev server was already running clean, no
  restart needed this pass)
- Creative suggestions given: no (fidelity/measurement only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes — the one new advisory note
  this pass (Checkbox's 16×16px native hit target) is recorded as informational only, does not
  affect the verdict, and is not attributable to this refinement (pre-existing DS component)
- Confidence in measurements: high — the core fix claim was verified three independent ways: (1)
  static source read confirming `--brand-red` is a real, defined token (`base.css:174`) unlike the
  previously-undefined `--destructive`/`--input`, (2) live `getComputedStyle` on all 6 OTP slots
  simultaneously showing a clear black→red transition on the exact `aria-invalid` toggle, and (3) a
  direct screenshot (`render.iter2.step1.otp_error_state.png`) showing the visible red borders.
  Modal/control geometry was re-measured live and found byte-identical to iter1's own numbers,
  which independently corroborates that the fix's scope was exactly what it claimed (a
  border-color-only className addition) and introduced no layout side-effects. All 4 steps were
  driven via 6 separate fresh Playwright sessions (not one long session reused across checks),
  each independently confirming zero console/page errors.
