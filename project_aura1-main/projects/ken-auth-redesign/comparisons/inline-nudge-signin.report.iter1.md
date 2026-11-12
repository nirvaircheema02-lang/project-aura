## Status
Done: Loop QA — independent live verification of the NEW inline wrong-flow nudge (replacing the prior alert-panel `wrongFlow` phase) + lifted/shared email state (email-preservation across flow switches), **sign-in side only**, across both V1 and V2 preview variants. Iteration 1 of 4. Controlled viewport **1440×900**, dev server confirmed running clean on `localhost:3091`.

## Reference source
No dedicated Figma frame/node or `loop-analyzer` spec section exists yet for this specific change (same gap already flagged in the prior wrong-flow QA pass, `v1-v2-variants-wrongflow.report.iter1.md`) — this is a build-brief-driven refinement (ken-auth-redesign Part B "lift email to shared Context" + Part C revision "replace the alert-panel wrongFlow phase with an inline nudge"), not a fresh Figma pull. Authoritative sources checked directly, not assumed:
- `src/lib/mockAccountCheck.ts` — read directly. Seeded "existing account" emails, confirmed by source inspection: **`demo@kenresearch.com`** and **`existing@kenresearch.com`** (exact-identity `Set` lookup, no longer substring/pattern-based — this itself is a change from the prior `mockAccountExists` and was verified, not assumed).
- `src/lib/authEmail.tsx` (new `AuthEmailProvider`/`useAuthEmail()` Context) + `src/app/page.tsx` (mounts it once, wrapping both flows) — read directly to confirm the lifted-state mechanism.
- `src/components/screens/EmailOtpStep.tsx` — read directly for the new inline-nudge implementation (`accountMismatch` state, `mismatchCopy`, helper-text-slot swap).
- Task-brief-supplied exact copy ("No account found for this email." / "Create account") used as the authority for verbatim comparison, same treatment as the prior wrong-flow pass. **Gap flagged again for `loop-analyzer`:** a formal spec addendum with Copy Lock / DS Mapping Gate for this nudge+email-preservation revision still doesn't exist; this report and the task-brief string remain the only record.
- Baseline geometry/DS-mapping continuity checked against `signin-flow.spec.md`, `otp-inline-refinement.spec.md`, and the already-**PASSED** `v1-v2-variants-wrongflow.report.iter1.md` (which established the current 400/360/20px shell geometry this pass must not regress — note this supersedes the original `signin-flow.spec.md`'s older 480/400/40 target through several explicit user-directed compacting passes documented in `AuthModal.tsx`'s own history comments; treated here as the correct current baseline, not the stale original spec number).

## Modal/Card geometry (explicit numbers, measured live at 1440×900)
- Modal/card width: **400px**, both variants, all phases tested — **MATCH** (target: 400px = 360 content + 2×20px padding, current shipped `AuthModal.tsx` geometry)
- Modal height (content-driven): V1 collecting/nudge state **388.84px** (longer 2-line subcopy) · V2 collecting/nudge state **367.25px** (shorter 1-line subcopy, no eyebrow) — **no height jump between the plain-helper-text state and the nudge-shown state within either variant** (measured identical before/after the mismatch fires — confirmed no unexpected layout shift)
- Content width (email input / button / nudge-paragraph column): **360px** — **MATCH**
- Viewport size: **1440×900**
- Modal-to-viewport width ratio: **27.8%** (400/1440) — compact, reads as a focused dialog
- Left/right padding: **20px** each side (`p-5`, card `padding: 20px` computed)
- Top/bottom padding: **20px** each side (same)
- Close button: **44×44px** hit area, positioned `-50px`/`-50px` outside the card's top-right corner (live rect: x=926, y≈204–206, matching `AuthModal.tsx`'s documented `-top-[50px] -right-[50px]` — unchanged, no regression)

## Form control geometry (2 controls present — see note)
This build's `collecting` phase has exactly 2 controls (email input + primary CTA) — the LinkedIn secondary/social CTA + "OR" divider were removed in an earlier, already-established pass (`ken-auth-redesign Part B item 5`, confirmed present in code comments and confirmed absent live in every screenshot below); this is a pre-existing baseline, not a new regression introduced by this iteration.
- Email input: **360×48px**, radius **5px**, DS component confirmed: **yes** — `ui/input.tsx`, height resolves to 48px live (see P3 note below on the token source)
- Primary CTA: **360×48px**, radius **5px**, DS component confirmed: **yes** — `atoms/Button.tsx` `variant="brand" size="md" fullWidth`
- Secondary/social CTA: **not present** in this phase (established prior baseline, both variants — not a defect)
- Shared content width across the 2 present controls (and the nudge paragraph itself): **yes** — input, button, and the nudge `<p>` all measured exactly **360px** wide, flush to the same left/right edges (540px/900px live, both variants)

---

## A. VISUAL FIDELITY

### P1 (major)
(none)

### P2 (noticeable)
(none)

### P3 (finishing/detail — non-blocking, must still be explicitly reported even on PASS)
- **Duplicate/conflicting `--button-height-md` token definition found in the vendored DS**, unrelated to this iteration's own changes: `src/vendor/tokens/tokens.css:273` defines `--button-height-md: 40px` while `src/vendor/ds/styles/base.css:104` defines `--button-height-md: 48px` (comment: "OG 3rem · touch-target compliant"). Live `getComputedStyle` confirms `base.css`'s value (48px) is what actually wins in cascade and renders (verified: email input + primary CTA both measure 48px live, matching what this flow needs) — so there is **no visible defect**, but the duplicate source-of-truth is a latent authoring inconsistency in the DS token files themselves, pre-dating and unrelated to this pass's inline-nudge/email-preservation work. Worth flagging to `tech`/DS maintainers to reconcile the two files so a future edit to one doesn't silently diverge from the other; not a finding against this build.
- No dedicated DS Alert/Banner atom exists in this project (unchanged fact, carried from the prior wrong-flow report) — moot for this pass anyway, since the new inline-nudge implementation deliberately does **not** use a panel/box at all (plain text + inline link, replacing the old alert-panel approach that would have needed one) — actually a DS-compliance *improvement* over the prior iteration, not a gap.

**Composition / dimensions / position / spacing / typography / radius / borders / shadows / dividers / backdrop / icons / link styling / responsive / compact-rhythm:** all unchanged from the already-PASSED baseline shell (`v1-v2-variants-wrongflow.report.iter1.md`) for everything outside the nudge mechanism itself — confirmed via live geometry match above, plus:
- The nudge replaces **only** the one-line helper-text slot directly below the email field — same position, same size, same font (`--typography-size-xs`), same color token (`--semantic-ink-subtle`, live-resolved `#737373`) as the plain helper copy it swaps with. No panel, no icon, no box — a strictly lighter-weight, more DS-integrated treatment than the prior amber alert-panel approach (confirmed via direct code read of `EmailOtpStep.tsx` + live computed style, see Section B below).
- Crossfade mechanic (150ms, same easing as every other transition in this component) confirmed working via screenshots at each phase — heading block, email-field/CTA, and the helper-text↔nudge swap all transition cleanly, no abrupt cuts, no separate popup.
- Headings transition correctly and match Copy Lock exactly at each stage: **"Sign in"** (collecting) → **"Verify your sign in"** (verifying, seeded-email path) → **"Create your account"** (after switching to sign-up via either the nudge action or the old footer link) — all confirmed live, both variants.
- V1/V2 difference in modal height (388.84px vs 367.25px) is the same pre-existing, already-approved V1-shorter-subcopy difference documented in the flow's own copy objects — not new, not variant-conditional for the nudge itself (the nudge copy/behavior is identical in both variants, only the surrounding collecting-phase subcopy differs, as already established).

## B. DESIGN SYSTEM COMPLIANCE — **PASS**
- Actual components used: `ui/input.tsx` (email field, unchanged), `atoms/Button.tsx` (`variant="brand" size="md" fullWidth`, unchanged, same primary CTA used for both submit paths), `atoms/InlineLink.tsx` (`variant="solid"`) for the nudge's **"Create account"** action link — confirmed live via computed style: `color: rgb(176, 31, 36)` (`--color-brand-red`), `background-color: rgba(0,0,0,0)` (fully transparent), `text-decoration-line: none` — exactly matches `InlineLink`'s documented `solid` variant classes (`text-[var(--color-brand-red)] no-underline`), not a hand-rolled link.
- Actual tokens used: `--semantic-ink-subtle` (nudge message text color, live-resolved `#737373`, same token/color as the ordinary helper text it replaces — confirmed by comparing computed styles of both states), `--color-brand-red` (action link), `--radius-button` (5px, inputs/buttons), `--radius-card` (10px, card) — all real tokens, none hardcoded in the component (verified against source: `EmailOtpStep.tsx` reads `var(--semantic-ink-subtle)` via inline `style`, not a literal hex).
- Custom CSS exceptions: **none.** The nudge is plain composition (a `<p>` + an `<InlineLink>`) with zero custom container — no `<div>` panel, no border/background/shadow classes applied anywhere in its markup. Live computed style on the nudge `<p>` confirms: `background-color: rgba(0,0,0,0)`, `border-width: 0px`, `box-shadow: none`, `padding: 0px` — genuinely neutral, not just visually similar.
- Any mapped DS component approximated with custom CSS instead of used directly: **none.**

## C. INTERACTION / UX — **PASS**
1. **Seeded existing-account email (both `demo@kenresearch.com` confirmed, sign-in side):** submitted email `demo@kenresearch.com` → proceeds normally straight to **"Verify your sign in"** (OTP entry, masked email `dem***@kenresearch.com` shown correctly) — confirmed live, both variants, **zero nudge/message shown at any point**, `nudge_text_present_after_seeded` confirmed `false` via full-body text scan (not just visual spot-check).
2. **Unseeded/unknown email (`randomunknown@somecompany.com`):** email field **stays visible and editable** (`is_visible`/`is_editable` both true, confirmed programmatically, not just by screenshot), primary CTA **stays visible** with its normal label ("Continue with work email" — not swapped for a different button/label), and a compact nudge appears directly below the email field reading exactly **"No account found for this email."** (verbatim string match, confirmed via `innerText` extraction: `"No account found for this email. Create account"`) with a **"Create account"** action link — confirmed live, both variants, both full test runs.
   - **Neutral/informational styling confirmed via computed styles** (not eyeballed, per the task's own requirement): no warning/error box, no tinted background/border anywhere on the nudge or its parent (`<form>` ancestor also transparent/borderless) — see Section B for the exact computed-style readout.
3. **Clicking "Create account" (the nudge's own action link):** switches the modal to the sign-up flow in place (heading changes to **"Create your account"**, confirmed live) **and** the previously-typed email (`randomunknown@somecompany.com`) is correctly **pre-filled** in the sign-up flow's own email field — confirmed via `input_value()` read directly on the sign-up form's `#work-email`, both variants, both runs. This is the new email-preservation behavior working as intended (shared `useAuthEmail()` Context, not a per-flow local `useState`).
4. **OLD footer link ("Don't have an account? Create account", collecting phase) — email-preservation confirmed:** typed a fresh email (`footertest@brandnewcompany.com`) into the sign-in collecting field, then clicked the plain footer link (verified it is the ordinary footer `<p>`, not the nudge — the nudge only renders when `accountMismatch` is set, which is `null` immediately after an edit) → switched to sign-up, and the sign-up email field was correctly pre-filled with `footertest@brandnewcompany.com` — confirmed live, both variants. Also incidentally confirmed the reverse direction (sign-up → sign-in via its own footer "Sign in" link) preserves the email too (`randomunknown@somecompany.com` still present after switching back), consistent with a single shared Context rather than a one-directional fix.
5. **Loading indication during the ~400ms simulated account-check:** confirmed **present** — a spinner (`svg.animate-spin`, the DS `Button`'s own `Loader2` component) renders inside the primary CTA and the button is `disabled` ~120ms after submit, for **both** the seeded-email path and the unseeded-email path, both variants. This is the DS's existing `loading` prop treatment, not a new/custom spinner.
6. **Stale-mismatch clearing (regression/correctness check, not explicitly asked but directly relevant to "confirm it actually works"):** after the nudge appears, editing the email field (even by one character) immediately clears the nudge and reverts the helper-text slot back to the normal copy ("Use your registered professional email address.") — confirmed via before/after body-text scan. Matches the documented intent exactly (a stale account-check result must not persist against edited input).
7. **No other regressions found:** modal geometry unchanged (see measurements above), close button position/size unchanged (44×44px, `-50px/-50px` offset), heading crossfades correct at every stage, primary-CTA/email-input geometry unchanged and still sharing the 360px content column, console clean throughout.
8. Accessibility notes (UI/UX Pro Max, advisory only — none of these override the reference/DS-conformant result above):
   - The nudge's action link inherits `InlineLink`'s existing focus-visible ring (`--color-brand-red`, 2px, offset 2px) — same as every other link in this flow, nothing stripped.
   - Consider (as already advised in the prior wrong-flow report, still applicable) moving focus or firing the existing `aria-live` announcement pattern when the nudge's action switches flows, so screen-reader users get the same "content changed in place" confirmation already provided elsewhere in this component. Additive suggestion, not a defect — the existing `aria-live="polite"` span in `EmailOtpStep.tsx` currently only announces the OTP-send event, not the flow-switch; low-cost extension if the user wants it, not required.
   - Contrast: nudge text (`#737373` on white) plus the brand-red action link both read comfortably at standard body-text sizes; no contrast concern observed.

## D. RUNTIME / LAYOUT SAFETY — **PASS**
- Console errors: **none** — checked across 2 full independent test runs × 2 variants (4 total variant-passes), zero `console.error`/`pageerror` events at any point.
- Horizontal overflow: **none** — `document.documentElement.scrollWidth === clientWidth === 1440` confirmed at every measured state.
- Modal overflow (content exceeding modal bounds): **none** — email input, primary CTA, and the nudge paragraph (incl. its inline link) all measured fully inside the card's own bounds (`withinCard: true` for every element, computed via bounding-rect containment check, not eyeballed).
- Child element overflow (any element exceeding its parent): **none** found.
- Viewport clipping: **none**.
- Unexpected layout shift (on state change): **none** — modal height measured **identical** between the plain-helper-text state and the nudge-shown state within each variant (388.84px both ways for V1, 367.25px both ways for V2) — the single-line-to-single-line text swap does not cause a height jump. The only height changes observed anywhere are the already-expected, content-driven ones (e.g. OTP block expanding after a valid seeded-email submit), unchanged from the prior baseline.

---

## Verdict
**PASS.**
- Zero P1 issues (section A)
- Zero P2 issues (section A)
- Section B (DS Compliance): **PASS**
- Section C (Interaction/UX): **PASS**
- Section D (Runtime/Layout Safety): **PASS**
- Copy Lock: no formal spec Copy Lock section exists yet for this nudge (flagged above, same gap as the prior wrong-flow pass) — verified instead against the task-brief-supplied string, which matches **verbatim**: *"No account found for this email."* / **"Create account"**. All pre-existing Copy Lock strings elsewhere in the flow (headings, subcopy, footer, OTP labels) remain unchanged and correct.
- Modal proportions match the current (already-PASSED) 400px/360px/20px baseline exactly — no stretched/page-sized regression, no geometry drift introduced by this pass
- Form control geometry consistent — both present controls (email input, primary CTA) share the 360px content column at 48px height / 5px radius, real DS components confirmed via source + computed style, not custom-sized approximations
- Required interaction states (loading spinner + disabled during the async check, focus-visible ring on the nudge's action link) all sourced from the real DS `Button`/`InlineLink` components, nothing stripped
- **Email-preservation confirmed working in both directions and both trigger points** (nudge action link, old footer link) — the core new behavior under test in this iteration

One non-blocking P3 recorded above (duplicate `--button-height-md` token definition across two DS files, pre-existing and not visibly defective) — carried forward per the mandatory reporting rule, does not affect the verdict.

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/regression-safety only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes
- Confidence in measurements: **high** — every claim above was captured via live Playwright automation (native `fill`/`type`/`click`, `getBoundingClientRect`/`getComputedStyle` reads, `innerText`/`input_value()` extraction) rather than visual inspection alone, cross-checked against direct source reads of `EmailOtpStep.tsx`, `authEmail.tsx`, `SigninFlow.tsx`, `SignupFlow.tsx`, `page.tsx`, `mockAccountCheck.ts`, `AuthModal.tsx`, `Button.tsx`, `Input.tsx`, `InlineLink.tsx`, and the two conflicting token files. Two full independent end-to-end runs (both variants each time) produced identical results, except one transient anomaly on the very first screenshot of one early run (a stale-looking pre-filled state on what should have been a fresh page load) that did **not** reproduce on a clean re-run with a dedicated diagnostic script confirming truly-fresh state — consistent with the kind of test-harness/dev-server timing flakiness already documented in the prior wrong-flow report (this dev server has previously been observed shared by multiple concurrent Claude sessions), not a reproducible product defect. All findings reported above are from states independently reproduced at least twice.
