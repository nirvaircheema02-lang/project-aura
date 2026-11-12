# Loop Visual QA — OTP Inline-Reveal Refinement, Sign-Up Flow, Iteration 1

Scope: `otp-inline-refinement.spec.md` (email⇄OTP merge into one mounted `EmailOtpStep` with an
internal `phase` state, replacing the prior two-step hard cross-fade) applied on top of the
already-PASSED `signup-flow.spec.md` + `signup-flow-refinement.spec.md` baselines. Covers the
sign-up flow's 3 externally-visible steps (`emailOtp` [collecting⇄verifying] → `profile` →
`success`), with primary focus on the merged `emailOtp` step per this pass's scope.

## Status
Done: OTP inline-reveal refinement QA, iteration 1 of 4 — sign-up flow, controlled viewport
**1440×900**, fresh headless Chromium/Playwright.

**Pre-flight note (render safety, resolved before comparison began):** the dev server at
`localhost:3091` was initially serving HTTP 500 — Turbopack's CSS pipeline had a corrupted
generated stylesheet (garbled Unicode-escape sequences in several arbitrary-value/attribute
selectors, e.g. `.text-\[var\(-\18 \1a <22>\5 or-brand-red\)\]`), unrelated to any source file
(the project's real `globals.css` is 66 lines; the 4000+/7000+-line generated CSS was a stale
Turbopack dev-cache artifact). Killed the stale process, cleared `projects/ken-auth-redesign/
builds/.next`, and restarted (`npm run dev`) — server came up clean on the fresh cache. Every
comparison below was run against that clean, freshly-compiled server; zero console/page errors
were observed across 6 separate automation passes (dozens of interactions) after the restart.
Flagging for transparency per the render-safety-first mandate, not counted as a finding against
the current build since the underlying source was never at fault.

## Reference source
- **Primary** (unchanged, re-fetched fresh this pass): Figma frame `550:67` "SignUp", file
  `PJtPivOzEkiTjSkGnZ2YtH` — nodes `554:94` (email/collecting) and `554:97` (OTP/verifying),
  screenshotted fresh via `get_screenshot` (not reused from a prior iteration).
- **Secondary** (pattern-only, per spec): Figma node `47:2275` "Desktop", file
  `ivRBbB0gi6PftuzlEVCGHo` — trusted via the spec's own direct-inspection citations
  (`get_metadata`/`get_screenshot`/`get_design_context` on 47:2276/47:2373/47:2420/47:2445/
  47:2453/47:2297); not re-fetched this pass since this refinement's own resolved interaction
  mechanic (§1 of the spec) is the thing under test, not the secondary reference itself.

## Modal/Card geometry (explicit numbers, required)
- Modal width: **464px** (target: 464px, unchanged) — MATCH, identical in both phases
- Modal height (collecting): **569.8px** — identical to the already-passed baseline's Step 1 height (569.8px)
- Modal height (verifying): **570.9px** — identical to the already-passed baseline's old separate Step 2 height (570.9px) — the merged reveal reproduces the exact same total content height as the prior two-step design, just inline
- Content width: **400px** (target: ≈400px) — MATCH
- Viewport size: **1440×900**
- Modal-to-viewport width ratio: **32.2%** (464/1440)
- Left/right padding: **32px** — MATCH
- Top/bottom padding: **32px** — MATCH

## Form control geometry (explicit numbers, required)
- Email input: **400×56**, radius **5px**, DS component confirmed: **yes** (`ui/input.tsx`, same element in both phases — confirmed via `readOnly`/`disabled` toggle, not a second field)
- Primary CTA: **400×56**, radius **5px**, DS component confirmed: **yes** (`atoms/Button.tsx variant="brand" size="lg" fullWidth`, same physical button in both phases — only its label crossfades)
- Secondary/social CTA (LinkedIn): **400×56**, radius **5px**, DS component confirmed: **yes** (`atoms/Button.tsx variant="secondary"`, present in collecting phase, correctly unmounted in verifying phase)
- Shared content width across all three: **yes** (x-origin = 520 on all three controls, both phases)
- OTP slots ×6: **48×48px**, radius **5px** (`var(--radius-button)`), 8px gap between slots (`InputOTP`'s own default `gap-2`, unmodified) — geometry matches the already-passed build's OTP sizing exactly, unaffected by the reveal mechanic change.

---

## A. VISUAL FIDELITY

Side-by-side against fresh reference screenshots (554:94, 554:97) shows very close correspondence: eyebrow/heading/subcopy/label/input/helper/OTP-block/resend-row/button/footer order, weight, and spacing all read the same as the reference in both the collecting and verifying phases. The OR-divider + LinkedIn CTA correctly disappear once verifying begins, matching the reference (neither appears on 554:97).

### P1 (major)
- **OTP slot error state produces zero visible feedback — relies on two undefined DS tokens.** `design-system/core-v2/src/ui/input-otp.tsx`'s `InputOTPSlot` renders its default border via Tailwind's `border-input` utility (`var(--input)`) and its error border via `aria-invalid:border-destructive` (`var(--destructive)`). Neither `--input` nor `--destructive` is defined anywhere in the design system (`design-system/core-v2/src/styles/*.css`, `design-system/tokens/build/*.css`) or in this project's `globals.css` (confirmed via `grep -rn` across both trees — zero hits). Per CSS's guaranteed-invalid-value behavior, both utilities silently fail at computed-value time and fall back to `currentColor` (black) for **every** state that isn't the hand-overridden active/focus state (which correctly overrides to `var(--color-brand-red)` in `EmailOtpStep.tsx` and does work). Live-measured: submitting an incomplete code (`123`) sets `aria-invalid="true"` on all 6 slots, but the measured `borderColor` is `rgb(0, 0, 0)` — **identical** to the default (non-error) slot border, also `rgb(0, 0, 0)`. Screenshot-confirmed (`07_otp_error_state.png`): all 6 boxes look plain black/gray whether or not they're flagged invalid; the only error signal a user gets is the text line below ("Enter all 6 digits to continue."), not the DS's own intended per-slot destructive-red border. This is broken/missing DS behavior, not a visual judgment call — the component genuinely fails to render its documented error affordance. **Not introduced by this refinement's code** (`ui/input-otp.tsx` is untouched, and no prior QA pass ever exercised the OTP error state to catch this — `signup-flow.report.iter3.md`/`refinement.report.iter1.md` both checked only the active/focus slot), but squarely in scope for this pass since the task explicitly asked to verify OTP component states including error, and the inline reveal is what puts this component under fresh scrutiny. **Measurable correction:** either (a) define `--destructive`/`--input` project-locally in `globals.css` (same precedent as the existing `--primary`/`--primary-foreground` fix already documented there for `Checkbox`), or (b) add an explicit override in `EmailOtpStep.tsx`'s `InputOTPSlot` className — `aria-invalid:border-[var(--brand-red)]` — mirroring the email input's own already-correct `aria-invalid:border-[var(--brand-red)]` pattern, which does work today.

### P2 (noticeable)
None found this pass beyond the P1 above.

### P3 (finishing/detail — non-blocking, reported per policy)
- **Input.tsx has no distinct "filled" visual state**, despite the component's own doc comment listing one (`Filled → border-black/15`). Live-measured: an input with real typed content, blurred and not hovered, computes to `border-color: oklab(0 0 0 / 0.1)` — identical to the empty/default state (confirmed via source read of `ui/input.tsx`: only `default`/`hover`/`focus`/`aria-invalid`/`disabled` selectors actually exist in the compiled className list; no `:not(:placeholder-shown)` or value-based rule is present anywhere). Pre-existing (`Input.tsx` is unchanged by this refinement), and judged against the DS component's own real behavior per the state-QA rule — not a deviation, just a documented-but-unimplemented state. Noting because this pass's explicit ask was to verify "filled" as one of the OTP-adjacent input states; a prior report's claim that "filled" measured at `/0.9` opacity appears to have actually captured the still-focused state (my measurement, taken after an explicit blur + mouse-move-away + 400ms settle, shows `/0.1`, i.e., no distinct filled treatment exists). Not blocking.
- **`sendingOtp` loading-spinner nice-to-have (spec §1 note 6, Uncertainty #O2) is implemented and working**: confirmed live via RAF sampling — the primary CTA's `disabled`/spinner state engages ~100ms after the collecting-phase submit click and holds through the ~350ms mock "send" delay before the OTP block begins expanding. Flagging as a P3 only because it's worth recording that this optional item was, in fact, built (not because anything is wrong with it).

---

## B. DESIGN SYSTEM COMPLIANCE — PASS
*(with the P1 above understood as a token-resolution gap in an already-used real component, not a custom-CSS substitution — see note below)*

- **Actual components used** (verified via direct import read of `EmailOtpStep.tsx`, not visual inspection alone): `ui/input.tsx` (`Input`, same element toggled `readOnly`/`disabled` across phases), `atoms/Button.tsx` (`variant="brand" size="lg" fullWidth`, primary CTA — same physical button, label crossfades inside it; `variant="secondary" background="light"`, LinkedIn CTA), `atoms/InlineLink.tsx` (`variant="solid"` for "Change" and "Didn't receive it?", `variant="muted"` for "Back to sign up" — all three confirmed live via `data-variant` DOM attribute, matching the spec exactly), `atoms/Divider.tsx` (`variant="subtle"`, OR-divider), `ui/input-otp.tsx` (`InputOTP`/`InputOTPGroup`/`InputOTPSlot`, already-passed per-slot separation override preserved verbatim), all animated via `framer-motion` (`AnimatePresence`/`motion.div`/`motion.span`) only — zero new primitives, matching the spec's DS Mapping Gate (§4) exactly.
- **Actual tokens used**: `--radius-card` (10px, modal), `--radius-button` (5px, inputs/CTAs/OTP slots), `--button-height-lg` (56px, resolved via the pre-existing, already-disclosed `core-v2` base.css redefinition — not a new drift), `--spacing-8`/`--typography-size-*` (heading/eyebrow/subcopy), `--color-brand-red`/`--brand-red` (active OTP slot override, email input error state, checkbox checked-state, primary CTA) — all confirmed live via `getComputedStyle`.
- **Custom CSS exceptions**: none newly introduced. The one pre-flagged `NO DS EQUIVALENT` row from the spec (secondary reference's tinted-pink inline "Send OTP" micro-button) is correctly **not** adopted, as the spec explicitly says it shouldn't be (nothing in the approved primary reference calls for it) — confirmed absent from the render.
- **Any mapped DS component approximated with custom CSS instead of used directly**: **none.** The P1 above is a real, correctly-imported DS component (`InputOTPSlot`) whose own upstream token dependency (`--destructive`/`--input`) was never defined anywhere in this workspace — that is a token-completeness gap, not a case of the builder reaching for custom CSS instead of the real component. Recording Section B as PASS on that basis (the component identity/import is correct), while the P1 above independently blocks the overall verdict regardless.

## C. INTERACTION / UX — FAIL
*(blocking item: OTP error state — see P1)*

- **Input states (email field)**: default (`border-black/10`) → hover (`border-black/25`) → focus (`border-black/90`) → disabled/masked-in-verifying (`border-black/6`, `bg-black/[0.03]`, `text-black/35`, `cursor: not-allowed`) all confirmed live via `getComputedStyle`, matching `Input.tsx`'s real documented behavior exactly. **Pass.** "Filled" has no distinct treatment — see P3, not blocking.
- **OTP slot states**: default 48×48/radius-5px confirmed; **active/focus** confirmed live as brand-red (`rgb(162, 29, 33)` = `#A21D21`≈brand-red family, the explicit override) — **pass**; **error** confirmed live as **identical to default** (`rgb(0,0,0)` both) — **fail**, see P1.
- **Button states**: primary CTA hover/shimmer present (DS's own always-on brand shimmer, `Button.tsx`'s "DO NOT disable" design); `loading` state during the mock OTP-send confirmed live (disabled + spinner for ~280–350ms) — matches spec's optional nice-to-have. **Pass.**
- **Checkbox checked state**: confirmed live `rgb(176, 31, 36)` = `#B01F24` = Ken brand red — unchanged, no regression. **Pass.**
- **Keyboard/focus behaviour — Escape double-dismiss** (re-tested live with an actually-open country-code `Select` popover on the Profile step): first Escape closes only the popover (`AuthModal` count stays 1), second Escape closes the modal (`AuthModal` count → 0) — the prior fix is intact, **not regressed** by this refinement's phase/reveal changes. **Pass.**
- **In-place swap / no remount (the refinement's core requirement)**: a DOM expando property + a `data-qa-marker` attribute were set directly on the live `[data-component="AuthModal"]` node immediately before triggering the collecting→verifying transition. Both were re-read intact on the same node after the reveal completed — direct proof the same `AuthModal` instance (and, since `SignupFlow` itself was never unmounted either, the same React state) persisted across the phase change; nothing remounted, no page navigation occurred. **Pass.**
- **Reveal transition quality**: live RAF-sampled the OTP block's `height`/`opacity` during a real click-triggered reveal — smooth co-animated growth from `0px/0` to `~135px/~1.0` over roughly 220–280ms, consistent with the spec's 280ms/`ease [0.4,0,0.2,1]` target; no jump, no overshoot, no jank. Gap between the email field's bottom edge and the OTP block's own label: **20px** — a modest, deliberate gap, not an oversized one. Reduced-motion emulation (`reduced_motion="reduce"`, confirmed live via `matchMedia`) collapses the same reveal to effectively a single frame (~2–40ms), consistent with the spec's `duration: 0.01` collapse — the branch is genuinely wired, not just present-but-inert. **Pass** on both counts (subtlety + reduced-motion correctness).
- **No layout shift on surrounding page content**: nav/hero bounding-box positions identical before and after the reveal (`AuthModal` is a `fixed inset-0` overlay, so the underlying page literally cannot reflow from an internal card-height change) — confirmed via direct before/after measurement, not just structural assumption. **Pass.**
- **Cross-flow navigation** (re-verified live): navbar "Sign in" → correctly opens `SigninFlow` (confirmed via its own "WELCOME BACK"/"Sign in" heading, its own merged `EmailOtpStep` copy set, OR-divider + LinkedIn present) — **not regressed**.
- **Accessibility (advisory, UI/UX Pro Max — does not affect the verdict beyond the hard findings above)**: the spec's `aria-live="polite"` announcement (#O3) is implemented (`"Verification code sent to {maskedEmail}."`, confirmed present in the DOM as a `sr-only` span) — good coverage for the "same card, not a new page" continuity goal for screen-reader users. No new advisory items beyond what the spec already flagged as non-blocking.

**Section verdict: FAIL** — driven entirely by the OTP error-state finding (P1); every other interaction/state check passed.

## D. RUNTIME / LAYOUT SAFETY — PASS

- **Console errors**: none, across 6 separate automation passes (dozens of interactions: fill/submit/reveal/OTP-entry/error-submit/resend/change-link/profile-fill/checkbox/create-account/success/cross-flow-nav/reduced-motion), all run against the fresh post-cache-clear server.
- **Horizontal overflow**: none — `document.documentElement.scrollWidth === window.innerWidth === 1440` at every phase/step checked (collecting, verifying, profile, success).
- **Modal overflow (content exceeding modal bounds)**: none.
- **Child element overflow**: one auto-flagged hit (the primary CTA's always-on shimmer-sweep `div`, `w-[200%] absolute inset-0`, extends past the card's right edge) — verified **not** a real defect: `Button.tsx` gives the button its own `overflow-hidden`, and an ancestor-walk confirms the shimmer div is clipped by that exact ancestor before ever reaching the card boundary (`clippedByAncestor: true`). Same pre-accepted finding as the prior refinement pass, unaffected by this one. **No actual overflow.**
- **Viewport clipping**: none.
- **Unexpected layout shift on state change**: none — modal height moves by +1.1px (569.8→570.9px) between collecting and verifying, well inside the `max-h-[calc(100vh-4rem)]` ceiling (836px at this viewport), no scrollbar engaged, no jump.

---

## Copy Lock — verified against `signup-flow.spec.md`'s Step 1 + Step 2 locks, plus fresh reference re-fetch

Sampled via DOM text-locator queries and cross-checked against freshly-refetched Figma nodes `554:94`/`554:97`: "GET STARTED" / "Create your account" / "Use your work email to create your Ken Research account." / "Work email" / "Use your professional email address." / "Continue with work email" / "OR" / "Continue with LinkedIn" / "Already have an account? Sign in" (collecting phase) and "VERIFY YOUR EMAIL" / "Enter verification code" / "We sent a 6-digit verification code to {masked email}." / "Change" / "Enter 6-digit code" / "Resend code in {mm}:{ss}" / "Didn't receive it?" / "Verify & continue" / "Back to sign up" (verifying phase) — every string matches verbatim, both which DOM slot each renders into and its wording. Masking logic reconfirmed correct (`priya.nair@ken-research.com` → `pri***@ken-research.com`). Both approved primary-CTA labels ("Continue with work email" / "Verify & continue") appear in sequence on the same physical button, neither renamed nor dropped. **No missing, reordered, or meaning-changed copy.**

---

## Verdict

| Check | Result |
|---|---|
| P1 issues | **1** (OTP error-state border doesn't resolve — undefined `--destructive`/`--input` tokens) |
| P2 issues | 0 |
| P3 issues | 2 (both informational, non-blocking — see above) |
| Section B — DS Compliance | PASS |
| Section C — Interaction/UX | **FAIL** (OTP error state) |
| Section D — Runtime/Layout Safety | PASS |
| Copy Lock | Match, verbatim |
| Modal/Card geometry vs. target | Match (464px/400px/32.2% ratio, identical to already-passed baseline) |
| Form control geometry | Match (400×56 shared across all 3 controls, both phases; OTP 48×48/radius-5px unchanged) |
| Core reveal mechanic (§1 of spec) | Confirmed correct: same `AuthModal` instance, no remount, smooth height+opacity expand directly below the email field, no surrounding-page layout shift, reduced-motion branch genuinely collapses the transition |
| Regressions vs. prior PASSED baselines | **None** — Copy Lock, geometry, control sizing, InlineLink variants (solid/solid/muted), checkbox brand-red, Escape double-dismiss, cross-flow navigation all reconfirmed live, unaffected by this pass |

**OVERALL: FAIL** — driven by exactly one P1 (Section A/C): the OTP slot's error state (`aria-invalid`) produces no visible border-color change because the DS component's own dependencies (`--destructive`, `--input`) were never defined anywhere in this workspace, so users get zero per-slot visual feedback on an incomplete/wrong code — only the text line beneath the boxes signals the error. This is not something this refinement's own code changed (`ui/input-otp.tsx` is untouched, and no earlier QA pass exercised this specific state to catch it), but it is squarely responsive to this pass's explicit instruction to verify OTP component states, and it blocks PASS under the hard gate (0 P1 required).

Everything this refinement pass was actually meant to change — the reveal mechanic itself (in-place expansion, no remount, subtlety, reduced-motion correctness, DOM persistence, no layout shift on the surrounding page) — is confirmed working correctly with strong live evidence, and zero regressions were found against any previously-passed baseline (Copy Lock, geometry, control sizing, InlineLink variants, checkbox color, Escape-key behavior, cross-flow navigation all reconfirmed intact).

**Recommended fix for `loop-builder`** (not performed here — read/measure only): define `--destructive` and `--input` project-locally in `projects/ken-auth-redesign/builds/src/app/globals.css`, following the exact precedent already documented there for the `--primary`/`--primary-foreground` Checkbox fix; or, more narrowly, add `aria-invalid:border-[var(--brand-red)]` to the `InputOTPSlot` className override in `EmailOtpStep.tsx`, mirroring the email input's own already-working error-state pattern.

## Self-check
- Model used: Sonnet
- Production code touched: no (read-only measurement; one dev-server cache-clear + restart to resolve a pre-existing stale-Turbopack-cache HTTP 500, no source file edited)
- Creative suggestions given: no (fidelity/measurement only; the one recommended fix is stated as a measurable token/override correction, not a redesign)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes — the one advisory note (aria-live announcement) was confirmed already implemented, not used to alter any finding's severity
- Confidence in measurements: high — modal/control geometry and all input/button/OTP states measured live via `getBoundingClientRect`/`getComputedStyle` at a controlled 1440×900 viewport in a fresh headless Playwright context (confirmed zero console errors post-cache-clear); DOM-persistence of the `AuthModal` instance proven via a tagged-node check surviving a real triggered transition; reveal timing captured via in-page `requestAnimationFrame` sampling during an actual click-triggered transition and independently again under `reduced_motion: "reduce"` emulation; the OTP error-state finding was cross-verified three ways (live `getComputedStyle` on the invalid slot, a direct screenshot showing no visual difference from the default slot, and a source-level `grep` across the entire design-system + project tree confirming `--destructive`/`--input` are defined nowhere) before being reported; references re-fetched fresh this pass (nodes 554:94/554:97) rather than reused from a prior iteration.
