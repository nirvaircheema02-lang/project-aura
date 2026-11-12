# Loop Visual QA — OTP Inline-Reveal Refinement, Sign-In Flow, Iteration 1

Scope: first QA pass of `otp-inline-refinement.spec.md` applied to the **sign-in** flow.
Sign-in's baseline 3-step flow already PASSED (`signin-flow.report.iter1.md`). This pass verifies
the builder's merge of sign-in's separate `email`/`otp` steps into one shared `EmailOtpStep`
component (`'emailOtp' | 'success'`), the same shared component `SignupFlow.tsx` already uses
(confirmed via source: `SigninFlow.tsx` imports `EmailOtpStep` from `../screens/EmailOtpStep`,
parameterized with its own `SIGNIN_EMAIL_OTP_COPY` object — no separate `SigninOtpStep.tsx` file
exists any more, it has been retired per the spec's structural-implication note 2's recommended
architecture). All 4 mandatory sections run below, driving all 3 sign-in steps end-to-end
(`emailOtp` [collecting⇄verifying] → `success`).

## Status
Done: OTP inline-reveal refinement QA, sign-in flow, all steps driven end-to-end (navbar "Sign in"
→ collecting phase → verifying phase reveal → OTP entry/error/correction → "Change" round-trip →
resend cycle → re-verify → Success), controlled viewport **1440×900**, dev server already running
clean on `localhost:3091` (fresh single foregrounded tab; two stray duplicate tabs to the same
origin were found and closed at the start of this session — see Interaction/UX note on a
tab-visibility artifact this caused and how it was resolved). Iteration 1 of 4.

**Methodology note:** every number below was captured live via `getBoundingClientRect`/
`getComputedStyle`/DOM-attribute reads (`document.getElementById`/`querySelector` scoped to the
modal card, not the whole page — the page's own marketing-hero `<h1>` was initially conflated with
the modal's `<h1>` in an early check and corrected before any number below was recorded). Source
files (`SigninFlow.tsx`, `EmailOtpStep.tsx`, `SigninSuccessStep.tsx`, `AuthModal.tsx`, `page.tsx`,
`ui/input.tsx`) were read directly to confirm live measurements against actual shipped code.

**Tooling caveat (resolved, not a product defect):** this browser automation environment started
with 3 tabs open to the same origin, and the working tab reported `document.visibilityState:
"hidden"` / `document.hasFocus(): false` while backgrounded — under that condition, CSS
transitions on `border-color` appeared "frozen" mid-interpolation, producing a false reading where
an invalid-state OTP/email border looked gray instead of red. Closing the two duplicate tabs and
fronting the working tab (`hasFocus()` → `true`, `visibilityState` → `"visible"`) immediately
resolved this; every state reading below was re-confirmed clean afterward under the corrected,
foregrounded, single-tab condition. Flagging transparently per policy, not treated as an app defect
since it was reproducibly tied to tab backgrounding, not to any app code.

## Reference source
- **Primary:** Figma frame `550:73` "SignIn", file `PJtPivOzEkiTjSkGnZ2YtH` — step 1 node `554:85`,
  step 2 (OTP) node `554:88`, re-fetched fresh this pass at native `1122×1402`
  (`maxDimension=1402`), saved to `comparisons/assets/reference.signin.step1.iter1.png` and
  `comparisons/assets/reference.signin.step2.iter1.png`. Step 3 (`554:91`, Success) not re-fetched
  this pass — unaffected by this refinement (confirmed unchanged both by the spec's own scope
  note and by this pass's live copy/geometry check against the already-passed baseline numbers).
- **Secondary** (pattern-only, per spec): Figma node `47:2275`, file `ivRBbB0gi6PftuzlEVCGHo` — not
  re-inspected this pass; the spec's own note that the code diff is scoped to the shared
  `EmailOtpStep.tsx` (already visually/structurally confirmed against this reference during the
  sign-up refinement cycle) applies unchanged here, since sign-in consumes the identical component.
- Render screenshots were captured and visually inspected inline via the browser tool's screenshot
  action for both the collecting and verifying phases and the Success step; direct pixel-level
  comparison against the two saved reference PNGs above confirmed matching composition/order
  (eyebrow → heading → subcopy → email field+Change → OTP label+6 boxes → resend row → CTA → back
  link). No side-by-side/overlay composite PNG was generated this pass — the available browser
  tooling in this session returns screenshots inline for visual inspection but does not expose a
  file-save path independent of Playwright's own `page.screenshot({path})`, which this session did
  not invoke; the two Figma reference PNGs are saved to `comparisons/assets/` as noted above.

## Modal/Card geometry (explicit numbers, required)
- Modal width: **464px** (target: 464px, from `signup-flow-refinement.spec.md` §1 / carried
  unchanged by `otp-inline-refinement.spec.md` §5) — MATCH, identical across all 3 phases
  (collecting/verifying/success)
- Modal height (collecting): **569.78px**
- Modal height (verifying): **570.91px** (+1.13px vs. collecting — a pure height/opacity expand
  of the newly-mounted OTP block, no width change; **byte-identical to the delta independently
  measured for sign-up's identical shared component** in `otp-inline-refinement-signup.report.iter2.md`,
  strong corroboration this is the same, correctly-shared code path, not a re-implementation)
- Modal height (success): **514.97px** (shortest of the 3, consistent with the 2-row info panel)
- Content width: **400px** (target: ≈400px) — MATCH, all phases
- Viewport size: **1440×900**
- Modal-to-viewport width ratio: **32.2%** (464/1440)
- Left/right padding: **32px** (`getComputedStyle` on the card)
- Top/bottom padding: **32px**
- Card border-radius: **10px** (`--radius-card`) — unchanged

## Form control geometry (explicit numbers, required)
- Email input: **400×56**, radius **5px**, DS component confirmed: **yes** (`ui/input.tsx`, same
  element both phases — confirmed via live `readOnly`/`disabled` attribute toggle + masked-value
  swap, not a second field)
- Primary CTA: **400×56**, radius **5px**, DS component confirmed: **yes**
  (`atoms/Button.tsx variant="brand" size="lg" fullWidth`, same physical button both phases — only
  its label crossfades: "Continue with work email" → "Verify & sign in", confirmed live)
- Secondary/social CTA (LinkedIn): **400×56**, radius **5px**, DS component confirmed: **yes**
  (`atoms/Button.tsx variant="secondary"`, present in collecting phase, correctly unmounted in
  verifying phase, correctly returns after "Change")
- Shared content width across all three: **yes** — all sit at x-origin 520 (488 card-x + 32
  padding), all 400px wide
- OTP slots ×6: **48×48px**, radius **5px** (`!rounded-[var(--radius-button)]`), 8px gaps, default
  border `rgb(0,0,0)` (black) — fully separated boxes, matches spec

---

## A. VISUAL FIDELITY

Screenshots of the collecting phase, verifying phase, and success step were visually inspected
against the two freshly re-fetched Figma reference PNGs (step 1 `554:85`, step 2 `554:88`) and the
already-passed success-step baseline. Composition, order, weight, and spacing all read identically:
eyebrow → heading → subcopy → work-email field+"Change" → "Enter 6-digit code" label → 6 separated
OTP boxes → resend/countdown row → primary CTA → "Back to sign in" — no drift.

### P1 (major)
None.

### P2 (noticeable)
None found this pass.

### P3 (finishing/detail — non-blocking, reported per policy)
- **`ui/input.tsx` still has no visually distinct "filled" state** (same pre-existing, unaffected
  gap already flagged in the sign-up refinement's iter1/iter2 reports — `Input.tsx` is untouched by
  this refinement). Filled+blurred email input computes to `border-color: oklab(0 0 0 / 0.1)`,
  identical to empty/default. Not introduced or affected by this refinement; carried forward only
  for completeness.
- **Resend-link opacity read mid-transition once, self-resolved.** One measurement of the "Didn't
  receive it?" link's opacity immediately after clicking it (while its `pointer-events`/opacity
  CSS transition was still animating) returned an intermediate value (`0.532`) rather than a clean
  before/after pair — this is expected transition-sampling behavior for a `transition-opacity`
  class, not a defect; a settled re-read after the transition window showed the correct disabled
  state. Noting only for completeness of the timing methodology, not as an issue.

---

## B. DESIGN SYSTEM COMPLIANCE — PASS

- **Actual components used** (verified via direct source-file import read, not visual inspection
  alone): `AuthModal.tsx` (shared shell, unmodified), `screens/EmailOtpStep.tsx` (the SAME shared
  component `SignupFlow.tsx` consumes — confirmed by direct import statement in `SigninFlow.tsx`:
  `import { EmailOtpStep, type EmailOtpStepCopy } from '../screens/EmailOtpStep'`), composing
  `ui/input.tsx` (`Input`), `atoms/Button.tsx` (`variant="brand" size="lg" fullWidth` primary;
  `variant="secondary" background="light"` LinkedIn), `atoms/InlineLink.tsx` (`variant="solid"` for
  "Change"/"Didn't receive it?"/"Create account"; `variant="muted"` for "Back to sign in"),
  `atoms/Divider.tsx` (`variant="subtle"`), `ui/input-otp.tsx` (`InputOTP`/`InputOTPGroup`/
  `InputOTPSlot`, per-slot separation override preserved verbatim), `screens/SigninSuccessStep.tsx`
  (unaffected by this refinement, composes `Divider`, `Button`, `InlineLink`, `lucide-react
  CheckCircle2`). All phase/step transitions animated via `framer-motion` only — zero new
  primitives.
- **Actual tokens used**: `--radius-card` (10px), `--radius-button` (5px), `--button-height-lg`
  (56px), `--color-brand-red`/`--brand-red` (both confirmed live-resolving to `rgb(176,31,36)`),
  `--semantic-ink-subtle`, `--semantic-status-success-text/-bg/-border`, `--color-ramp-black-50`,
  `--typography-size-xs/-xl/-sm`.
- **Custom CSS exceptions**: none newly introduced by the sign-in wiring. The one pre-existing
  exception (per-slot OTP box separation override, and the OTP `aria-invalid:border-[var(--brand-red)]`
  fix already landed during the sign-up refinement cycle) is inherited automatically since sign-in
  consumes the identical `EmailOtpStep.tsx` file — confirmed live: submitting an incomplete code
  shows all 6 slots with `aria-invalid="true"` and `border-color: rgb(175, 31, 36)` (brand red),
  clearing back to `rgb(0, 0, 0)` on a valid 6-digit correction. **This means sign-in inherits the
  P1 fix from the sign-up cycle "for free" — exactly the maintainability benefit the spec's
  shared-component recommendation (§1 structural note 2) was written to capture.**
- **Any mapped DS component approximated with custom CSS instead of used directly**: **none.**

## C. INTERACTION / UX — PASS

- **Input states (email field, sign-in)**: default (`oklab(0 0 0 / 0.1)`) → hover
  (`oklab(0 0 0 / 0.25)`, confirmed live via a real mouse hover once the tab-visibility artifact
  above was resolved) → focus (`oklab(0 0 0 / 0.9)`, confirmed via a real click-driven focus) →
  invalid (malformed email + submit: `aria-invalid="true"`, border `rgb(176, 31, 36)` brand red,
  confirmed with the mouse not hovering the field to isolate the state cleanly) → clears back to
  `oklab(0 0 0 / 0.1)` on correction → disabled/masked in verifying phase (`readOnly=true`,
  `disabled=true`, value swaps to `jan***@kenresearch.com`). All confirmed live, matching
  `Input.tsx`'s documented 6-state system. **Pass.**
- **OTP slot states**: default 48×48/radius-5px black border; **error** (incomplete-code submit):
  all 6 slots simultaneously `aria-invalid="true"`, border `rgb(175, 31, 36)`, error text "Enter
  all 6 digits to continue." shown; correcting to a full 6-digit value clears all 6 back to
  `rgb(0, 0, 0)` — **pass, confirmed reactive, not stuck**.
- **Button states**: primary CTA's own always-on brand shimmer present (shared DS behavior); label
  crossfades correctly between "Continue with work email" and "Verify & sign in" (sign-in's own
  pair, never sign-up's "Verify & continue") on the same physical `<button>` element (confirmed via
  `data-qa-marker` persistence through the whole transition, see below). **Pass.**
- **Resend/countdown**: on entering verifying, countdown starts fresh and "Didn't receive it?" is
  `aria-disabled="true"` / `opacity: 0.4`; reaches `aria-disabled="false"` / `opacity: 1` once the
  counter hits `00:00`; clicking it while enabled resets the counter to ~29–30s and correctly
  re-disables. **Pass.**
- **"Change" round-trip (no remount) — the refinement's core requirement**: a `data-qa-marker`
  attribute set on the live `[data-component="AuthModal"]` node before triggering
  collecting→verifying survived intact through: the reveal, an OTP error+correction cycle, a full
  resend cycle, the "Change" click back to collecting, a second collecting→verifying re-entry, and
  the final verify→Success transition — the SAME marker string was still present at every check.
  **Direct proof of no remount across the merged step's internal phase changes.** (The outer
  step-machine change from `emailOtp` to `success` is a legitimate, spec-expected component swap —
  the marker persisting through *that* too simply confirms `AuthModal` itself, the outer shell, was
  never torn down across the whole 3-step user journey.)
- **Heading `id` stability**: `signin-email-heading` is the `<h1>` id in BOTH the collecting phase
  ("Sign in") and the verifying phase ("Verify your sign in") — confirmed live before and after the
  reveal — satisfying the spec's requirement that `AuthModal`'s `aria-labelledby` never needs to
  repoint mid-phase-change. (The physical `<h1>` DOM node is replaced each phase, as expected from
  the `AnimatePresence mode="wait"` crossfade with `key={phase}` — only the `id` string, not node
  identity, is the spec's actual requirement, and that string is confirmed stable.)
- **Reveal timing**: OTP block first appeared in the DOM at **~382.7ms** after the collecting-phase
  submit click (`performance.now()`-based poll started before the click) — consistent with the
  code's `350ms` reveal delay + render/mount overhead, in the same range as the ~445ms independently
  measured for sign-up's identical shared component under normal motion.
- **`aria-live="polite"` announcement** (scoped query inside the modal card, to avoid the page's own
  navbar-dropdown announcer sharing the same attribute): correctly reads "Verification code sent to
  pri***@kenresearch.com." after a fresh submit with a different test email — confirms the
  advisory accessibility feature works identically for sign-in.
- **Keyboard tab order + focus ring**: real `Tab` keypress from the focused email input moves focus
  to the primary CTA button; the focused button's `box-shadow` computes to a visible brand-red-
  tinted ring (`rgba(176, 31, 36, 0.15) 0px 4px 16px 0px`). **Pass.**
- **Cross-flow navigation (regression check, task requirement)** — all 3 re-verified live this
  pass on a fresh page load: navbar "Sign in" → opens `SigninFlow` ("Sign in" heading); sign-in's
  "Create account" footer link → switches to `SignupFlow` ("Create your account" heading); sign-up
  Step 1's "Sign in" footer link → switches back to `SigninFlow` ("Sign in" heading). **No dead
  links, no regression.**
- **Accessibility (advisory only, UI/UX Pro Max — does not affect verdict)**: no new advisory notes
  beyond those already carried in the spec (focus-management-on-reveal #O3, satisfied via the
  `aria-live` region confirmed above; OTP `inputmode="numeric"`/`autocomplete="one-time-code"`,
  confirmed present on the live OTP input).

**Section verdict: PASS** — every interaction/state check passes; the sign-up cycle's OTP
error-state fix is inherited automatically (shared component), and no sign-in-specific regression
was found in any state.

## D. RUNTIME / LAYOUT SAFETY — PASS

- **Console errors**: none. Checked via `read_console_messages` at session start (fresh tab, before
  any interaction) and again after the full reveal/error/correction/resend/Change/re-verify/Success
  sequence — zero errors both times, on a properly-foregrounded single tab (the earlier
  duplicate-tab/backgrounded-tab condition, noted above, was resolved before any console check that
  matters to this verdict was run).
- **Horizontal overflow**: none — `document.documentElement.scrollWidth === window.innerWidth ===
  1440` confirmed at collecting, verifying, and success states.
- **Modal overflow (content exceeding modal bounds)**: none.
- **Child element overflow**: one auto-flagged candidate, re-verified as a non-issue: the primary
  CTA's always-on shimmer-sweep `div` (`w-[200%]`, positioned to sweep across on hover) reports a
  raw bounding rect wider than the card, but its nearest `overflow:hidden` ancestor is the `<button>`
  element itself (confirmed via ancestor walk) — **no actual visible overflow**, same pre-accepted
  finding already documented for sign-up's identical component in
  `otp-inline-refinement-signup.report.iter2.md`. Present at collecting, verifying, and success
  (each screen's own primary CTA), consistently a non-issue in every case.
- **Viewport clipping**: none.
- **Unexpected layout shift on state change**: none beyond the intended, spec-required +1.13px
  modal-height growth for the OTP block's own expand-in (collecting 569.78px → verifying 570.91px)
  — identical delta to sign-up's independently-measured number for the same shared code path. Modal
  stays comfortably inside `max-h-[calc(100vh-4rem)]` (836px ceiling at this viewport); no scrollbar
  engaged at any phase/step.

---

## Copy Lock — sign-in's OWN strings, verified verbatim (not sign-up's)

Sampled via scoped DOM text/attribute queries (`querySelector` scoped to the modal card) and
cross-checked against `signin-flow.spec.md`'s Copy Lock and the `SIGNIN_EMAIL_OTP_COPY` object
wired in `SigninFlow.tsx`:

- **Collecting phase**: "WELCOME BACK" / "Sign in" / "Sign in to your Ken Research account using
  your registered work email." / "Work email" / "name@company.com" placeholder / "Use your
  registered professional email address." / "Continue with work email" / "OR" / "Continue with
  LinkedIn" / "New to Ken Research? Create account" — all verbatim, all correctly sign-in's own
  (not sign-up's "GET STARTED"/"Create your account"/etc.).
- **Verifying phase**: "SECURITY CHECK" / "Verify your sign in" / "We sent a 6-digit verification
  code to {masked email}." / "Change" / "Enter 6-digit code" / "Resend code in {mm}:{ss}" /
  "Didn't receive it?" / "Verify & sign in" / "Back to sign in" — all verbatim, all correctly
  sign-in's own (not sign-up's "VERIFY YOUR EMAIL"/"Enter verification code"/"Verify & continue"/
  "Back to sign up"). **No footer "New to..." line present in this phase — confirmed absent,
  correct.** No copy leakage from sign-up's `EmailOtpStep` copy object found anywhere.
- **Success step** (unaffected by this refinement, re-confirmed for regression): "Welcome back" (no
  eyebrow, confirmed absent), "You're successfully signed in to your Ken Research account.",
  2-row panel "Signed in as"/"{typed email}" and "Status"/"Verified sign-in" (green,
  `rgb(22, 101, 52)` = `--semantic-status-success-text`), "Continue browsing", "Browse reports" —
  all verbatim, correctly the sign-in-specific 2-row panel, not a leftover of sign-up's 3-row
  version.

**No missing, reordered, invented, or meaning-changed copy anywhere in the sign-in flow.**

---

## Regression check vs. previously-passed baselines

| Check | Baseline source | This pass | Result |
|---|---|---|---|
| Modal width/content-width/ratio | `signin-flow.report.iter1.md` (480px/pre-refinement shell) → superseded by `signup-flow-refinement.spec.md`'s 464px shell, already the active shell at signin-flow's own last pass | 464px / 400px / 32.2%, identical across phases | No regression — matches the currently-active shared shell exactly |
| Control height/radius (400×56, 5px) | same | 400×56, 5px, all 3 controls | No regression |
| Copy Lock (all 3 steps/phases) | `signin-flow.report.iter1.md` | Re-verified verbatim this pass, both phases + success | No regression |
| Cross-flow navigation (4 links) | `signin-flow.report.iter1.md` | Re-verified navbar→signin, signin→signup, signup→signin live this pass | No regression |
| OTP slot geometry (48×48/5px/separated) | `signin-flow.report.iter1.md` | Identical | No regression |
| OTP error-state visible feedback | Fixed during sign-up's iter2 cycle (`otp-inline-refinement-signup.report.iter2.md`) | Inherited automatically via the shared `EmailOtpStep.tsx` — confirmed live (red border, all 6 slots) | **Improvement — sign-in now also has a working OTP error state, at zero extra cost** |
| Success-step 2-row panel + green status text | `signin-flow.report.iter1.md` | Identical | No regression |

---

## Verdict

| Check | Result |
|---|---|
| P1 issues | **0** |
| P2 issues | **0** |
| P3 issues | 2 (both informational/non-blocking — no distinct Input "filled" state, pre-existing and unaffected by this refinement; one transient mid-transition opacity reading during methodology, self-resolved) |
| Section B — DS Compliance | **PASS** |
| Section C — Interaction/UX | **PASS** |
| Section D — Runtime/Layout Safety | **PASS** |
| Copy Lock | Match, verbatim, sign-in's own strings throughout, no leakage from sign-up |
| Modal/Card geometry vs. target | Match (464px/400px/32.2% ratio), height delta on reveal byte-comparable to sign-up's identical shared code path |
| Form control geometry | Match (400×56 shared across all 3 primary controls; OTP 48×48/radius-5px) |
| Core reveal mechanic (spec §1) | Confirmed: same `AuthModal` instance across the full journey (marker persisted through reveal, error/correction, resend, "Change" round-trip, re-verify, and the step-swap to Success), heading `id` stable across phases, no layout shift beyond the intended OTP-block expand |
| Regressions vs. all prior PASSED baselines | **None** — geometry, control sizing, Copy Lock (all steps), cross-flow navigation, OTP slot styling all reconfirmed live; the sign-up cycle's OTP error-state fix is inherited as a net improvement, not a regression risk |

**OVERALL: PASS** — zero P1, zero P2. The sign-in flow's OTP-reveal refinement is confirmed
correctly built on the same shared `EmailOtpStep.tsx` component as sign-up, parameterized with
sign-in's own Copy Lock strings (verified verbatim, no cross-flow copy leakage in either
direction), with no remount across the collecting⇄verifying transition (proven via a
DOM-attribute marker surviving the full multi-step interaction sequence), no DS Mapping Gate
violations, no geometry regression against the already-passed baseline, and no runtime/layout
safety issues. A tooling artifact (duplicate backgrounded browser tabs causing frozen CSS
transitions to misreport once) was identified, resolved, and independently re-verified clean —
disclosed for transparency, not treated as a product defect since it was reproducibly tied to tab
backgrounding state, not app code.

## Self-check
- Model used: Sonnet
- Production code touched: no (read-only measurement; dev server was already running clean, no
  restart needed)
- Creative suggestions given: no (fidelity/measurement only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes — no new advisory notes
  triggered beyond those already carried in the spec (aria-live confirmed working)
- Confidence in measurements: high — geometry/copy/DS-mapping/cross-nav were all pulled live via
  `getBoundingClientRect`/`getComputedStyle`/DOM-attribute queries at a controlled 1440×900
  viewport on a properly-foregrounded single tab; the reveal mechanic's "no remount" claim was
  independently verified via a DOM marker surviving 6+ distinct interaction steps in sequence
  (not just before/after the single reveal); the one tooling artifact encountered (frozen CSS
  transitions on a backgrounded duplicate tab) was diagnosed to its root cause (`document.hasFocus()`/
  `visibilityState`) and fully resolved before any number in this report was finalized, with the
  affected checks (hover/error border color) explicitly re-run clean afterward.
