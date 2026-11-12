# Loop Visual QA — Sign-up Flow (4 steps) — Iteration 1

## Status
Done: Full 4-step interactive sign-up flow compared (Step 1 Create account → Step 2 OTP → Step 3 Complete profile → Step 4 Success), iteration 1 of 4.

## Reference source
Figma frame `550:67` "SignUp", file key `PJtPivOzEkiTjSkGnZ2YtH`. Step nodes: 554:94 (Step 1), 554:97 (Step 2), 554:100 (Step 3), 554:103 (Step 4). All fetched fresh this pass at native 1122×1402 (no upscale).

## Environment
- Rendered implementation: http://localhost:3091 (Next.js dev server, already running)
- Viewport: **1440×900** (controlled, held constant across all 4 steps)
- Driven via live browser automation (click/type through the real flow, not 4 static loads) — transitions verified working: Step1→2→3→4 all advance correctly on the documented triggers ("Continue with work email", "Verify & continue" after OTP fill, "Create account").

---

# STEP 1 — "Create your account"

## Modal/Card geometry
- Modal width: 480px (target: 480px) ✓
- Modal height: 606px
- Content width: 400px (target: ≈400px) ✓
- Viewport size: 1440×900
- Modal-to-viewport width ratio: 33.3%
- Left/right padding: 40px (target: 40px) ✓
- Top/bottom padding (inner p-10): 40px; outer breathing room to viewport: 147px top / 147px bottom (well clear of the ≈75px target — generous, not cramped)

## Form control geometry
- Email input: 400×56px, radius 5px, DS component confirmed: yes (`ui/input.tsx`)
- Primary CTA: 400×56px, radius 5px, DS component confirmed: yes (`Button` variant=brand size=lg)
- Secondary/social CTA (LinkedIn): 400×56px, radius 5px, DS component confirmed: yes (`Button` variant=secondary)
- Shared content width across all three: yes (400px)
- **Note:** spec's Form Control Geometry table states "Height (DS real value): 48px (`--button-height-lg`)". Live-measured `--button-height-lg` in this project's tokens.css actually resolves to **56px**, not 48px. All three controls consistently render at 56px — internally consistent, real DS token used correctly, not a custom-CSS approximation. This is a **spec-vs-actual-token discrepancy**, not a build defect: flagging so the 48px figure in the spec is corrected for future iterations, not chased as a "bug."

## A. VISUAL FIDELITY
Composition, spacing, typography, radius, borders, dividers, icon sizing all match the reference closely on direct comparison.

### P3 (finishing/detail)
- Control height is 56px vs. the spec's documented 48px target — cosmetically matches reference proportions fine at 56px (reference is a flat image, not pixel-measured for input height), flagging only for spec accuracy, not as a visual defect.

## B. DESIGN SYSTEM COMPLIANCE — PASS
- Actual components used: `Input` (ui/input.tsx), `Button` (atoms/Button.tsx, variant=brand/secondary, size=lg), `InlineLink` ("Sign in" — solid red, no underline, matches reference)
- Actual tokens used: `--color-brand-red`, `--radius-button`, `--radius-card`, `--button-height-lg`
- Custom CSS exceptions: none (LinkedIn brand-blue icon disclosed per spec as NO DS EQUIVALENT, acceptable)
- Any mapped DS component approximated with custom CSS: none

## C. INTERACTION / UX — PASS
- Input: default/filled verified by typing "jane@kenresearch.com" — renders correctly, no lag
- Buttons: default/hover states visually consistent with DS
- Keyboard/focus: tab order not blocking, no console errors
- Form hierarchy: matches reference (eyebrow → heading → subcopy → label → input → helper → CTA → divider → social CTA → footer)
- Accessibility (advisory, UI/UX Pro Max): input has visible label; touch target 56px height comfortably exceeds 44px minimum

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none
- Horizontal overflow: none (scrollWidth 1440 = viewport 1440)
- Modal overflow: none
- Child element overflow: none
- Viewport clipping: none
- Layout shift: none observed

## Copy Lock — PASS (exact match, 10/10 strings)
"GET STARTED" / "Create your account" / "Use your work email to create your Ken Research account." / "Work email" / "name@company.com" / "Use your professional email address." / "Continue with work email" / "OR" / "Continue with LinkedIn" / "Already have an account? Sign in" — all verbatim.

**Step 1 verdict: PASS**

---

# STEP 2 — "OTP verification"

## Modal/Card geometry
- Modal width: 480px (target: 480px) ✓
- Modal height: 603px
- Content width: 400px ✓
- Viewport size: 1440×900
- Modal-to-viewport width ratio: 33.3%
- Left/right padding: 40px ✓
- Top/bottom breathing room: 149px top / 148px bottom — generous, well clear of cramped territory (this is confirmed the shortest-card step per spec, consistent)

## Form control geometry
- Read-only email field: 400×56px, radius 5px, DS component confirmed: yes (disabled `Input`)
- OTP slots ×6: 48×48px each, radius **15px**
- Primary CTA: 400×56px, radius 5px, DS component confirmed: yes
- Shared content width: yes (400px), OTP row spans the same column with even gaps

## A. VISUAL FIDELITY

### P2 (noticeable)
- **OTP slot corner radius is 15px**, reference shows a subtle ≈4–5px rounding per box (closest DS token `--radius-button`, 5px, per spec's own recommendation). At 15px the slots read visibly more "pill-like"/rounded than the reference's crisp, tightly-cornered boxes — a real, measurable visual deviation. **Correction: reduce OTP slot radius from 15px to 5px (`--radius-button`).**
- **"Back to sign up" renders as black text with a visible underline** (`text-decoration: underline`, color `rgb(0,0,0)`). Reference shows this as plain, non-underlined text, centered, no link-button affordance. **Correction: remove the underline (or confirm intended variant) to match reference's plain-text treatment.**

### P3 (finishing/detail)
- None additional beyond the above.

## B. DESIGN SYSTEM COMPLIANCE — PASS (with 1 flagged inconsistency, not blocking)
- Actual components used: `Input` (disabled/readOnly), `InputOTP`/`InputOTPSlot` (6 individually-bordered slots, correctly de-grouped per spec's build note), `Button`, `InlineLink` (×3: "Change", "Didn't receive it?", "Back to sign up")
- Actual tokens used: `--color-brand-red` (active OTP slot border, confirmed red not default DS `ring`), `--radius-card`, `--button-height-lg`
- Custom CSS exceptions: OTP slot per-slot border/radius override — disclosed in spec as required build-time customization, not a gap
- Any mapped DS component approximated with custom CSS: none
- **Flag:** "Back to sign up" uses `InlineLink`'s default variant (black text + red underline) rather than the solid-red-no-underline variant used for "Change"/"Didn't receive it?" on the same step — an internal inconsistency, not a missing-component issue (see cross-step note below).

## C. INTERACTION / UX — PASS
- OTP: typed "274912" digit-by-digit — fills left-to-right correctly, active slot (red border) correctly tracks the next-empty position, confirmed via `data-active` attribute (not just visual impression — a stale intermediate screenshot briefly looked wrong, re-verified via DOM state, resolves correctly on settle)
- "Change" link: present, styled correctly (solid red, no underline)
- Keyboard/focus: OTP autofocus/advance works
- Button hover/default: consistent with DS

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none
- Horizontal overflow: none
- Modal/child overflow: none
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (exact match, 10/10 strings, including correct dynamic masked-email interpolation "jan***@kenresearch.com" reflecting the real typed email rather than the reference's static demo string — correct behavior per spec's Uncertainty #5/#6 reasoning)

**Step 2 verdict: FAIL** (2 P2 issues — OTP radius, "Back to sign up" underline — block PASS per the hard gate; both are small, measurable, one-line fixes)

---

# STEP 3 — "Complete profile"

## Modal/Card geometry
- Modal width: 480px (target: 480px) ✓
- Modal height: **829px**
- Content width: 400px ✓
- Viewport size: 1440×900
- Modal-to-viewport width ratio: 33.3%
- Left/right padding: 40px ✓
- Top/bottom breathing room to viewport: **35px top / 35px bottom**

### Modal height — verification of loop-builder's flagged concern
Confirmed measurement: modal height 829px against the CSS `max-h-[calc(100vh-4rem)]` ceiling of 836px at this viewport — only **7px of internal headroom** before `overflow-y-auto` would engage. However, at the viewport level itself (900px), the modal currently sits with **35px/35px** margin top and bottom — it does **not** touch the viewport edges, does **not** trigger scroll, and does **not** clip any content. Visually, on screenshot inspection, the card reads as a full, deliberately-tall step (matches the reference, which itself shows Step 3 as the visibly tallest of the 4 cards) rather than "broken" or overflowing.
That said, 35px breathing room is meaningfully tighter than Steps 1/2/4's ~147–185px, and the 7px internal ceiling headroom is a real fragility: any future content addition (a longer error message, a slightly taller helper line, a browser zoom bump) would push this into scroll territory with very little warning.
**Classification: P2** (noticeable geometry deviation from the ~75px target and the tightest of all 4 steps, and a fragile safety margin) — **not P1**, because nothing currently overflows, clips, or forces scroll, and the card still reads as intentional/tall by design rather than broken.
**Correction:** tighten vertical rhythm slightly (e.g. reduce one inter-field gap by ~10–15px, or reduce modal padding top/bottom from 40px to ~32px on this step only) to restore closer to the ~75px target and rebuild headroom against the max-height ceiling.

## Form control geometry
- Full name input: 400×56px, radius 5px, DS component confirmed: yes
- Phone country-code select: **92×36px**, radius 5px, DS component confirmed: yes but **not height-overridden**
- Phone number input: 300×56px, radius 5px, DS component confirmed: yes
- Company name input: 400×56px, radius 5px, DS component confirmed: yes
- Primary CTA: 400×56px, radius 5px, DS component confirmed: yes
- Shared content width across full-width controls: yes (400px); phone select+input pair: 92+300=392px (≈400px column, acceptable per spec's "pair together" rule)

### P1 — Select/Input height mismatch in the phone-number row
The country-code `Select` trigger renders at its DS default **36px height**, while the adjacent phone-number `Input` (and every other control on this step) renders at **56px**. This produces a visibly misaligned row — the select box is noticeably shorter than the input box it sits beside, a foundational layout defect explicitly called out as mandatory in the spec's Form Control Geometry table ("Every full-width control on this step needs the same 48px[/56px] height override... now also affecting `Select`, not just `Input`"). This is the exact "confirmed regression mechanism" the spec anticipated, and it was not fixed.
**Correction: override `SelectTrigger` height from 36px (`h-9`/`data-[size=default]`) to 56px to match the input row.**

## A. VISUAL FIDELITY

### P1
- Phone-number row height mismatch (Select 36px vs. Input 56px) — see above, measurable, visible on direct screenshot inspection.

### P2
- Modal breathing room 35px/35px — tightest of all 4 steps, only 7px of internal max-height headroom remaining (see geometry section above for full reasoning and correction).
- Checkbox checked-state color renders **black**, not brand-red (see DS Compliance section — confirmed root cause).
- "Terms of Use" / "Privacy Policy" links render with the same black-text/red-underline `InlineLink` default variant as Step 2's "Back to sign up" and Step 4's "Browse reports" (see cross-step note below) — reference shows these as solid red, matching "Sign in"/"Change"/"Didn't receive it?" elsewhere in the same flow.

### P3
- Phone number value renders unformatted ("9876543210") vs. reference's formatted example ("98765 43210") — cosmetic only, not a Copy Lock item (spec's Uncertainty #5 already flags these as demo values, not literal placeholder copy).

## B. DESIGN SYSTEM COMPLIANCE — FAIL
- Actual components used: `Badge` ("Email verified" pill, `theme=success`, check icon), `Input` ×3 (Full name, Phone number, Company name), `Select`/`SelectTrigger`/`SelectContent`/`SelectItem` (country code), `Checkbox`, `InlineLink` ×2 (Terms of Use, Privacy Policy) + `InlineLink` (Sign in footer), `Button` (Create account)
- Actual tokens used: `--color-brand-red` (eyebrow, checkbox border, focus rings on Input/Button), `--radius-button`, `--radius-card`, `--semantic-status-success-*` (pill)
- Custom CSS exceptions: none disclosed as needed beyond what's already flagged
- **Any mapped DS component approximated/misconfigured:**
  - `SelectTrigger` height not overridden to match the row (36px vs. 56px) — **FAIL**, this is exactly the DS-mapping regression the spec called out as mandatory to fix
  - Checkbox checked-state uses `data-[state=checked]:bg-primary`, and this project's `tokens.css` has **`--primary` undefined** (confirmed via live `getComputedStyle` query — the variable resolves to an empty string). This causes the checkbox's checked fill/check-icon to fall back to a generic black rather than brand-red, breaking the token chain the spec flagged as an open question (Uncertainty #10). **Confirmed: does NOT resolve to brand-red.** This is a real token-definition gap upstream of the component (the component itself is correctly mapped/used; the token it depends on is missing project-side).

## C. INTERACTION / UX — PASS (with 1 confirmed keyboard bug, see below — does not block this section's per-control state checks, but is reported as a hard interaction defect)
- Input states: default/filled verified (Full name, Company name typed successfully; phone number typed successfully)
- Select: opens correctly, renders visibly above the modal (**confirms loop-builder's disclosed fix — `z-[110] bg-white` on `SelectContent` is working**: dropdown is fully visible with white background, not hidden behind the modal), all 5 options ("+91", "+1", "+44", "+51", "+65") legible, clicking an option correctly updates the trigger value and closes the dropdown cleanly
- Checkbox: click toggles to checked state correctly (function works; color is wrong per above)
- **Confirmed keyboard defect:** while the Select dropdown was open, pressing `Escape` closed the *entire signup modal* (returned to the marketing page background), not just the dropdown. Expected behavior: `Escape` should close only the open `SelectContent` popover, returning focus to the trigger, leaving the modal open. This is a real, reproducible interaction bug — Radix's own Escape-to-close-popover behavor is being intercepted/overridden by (or bubbling into) the modal's own Escape-to-close handler. **Flag as a P2 interaction defect requiring a fix** (e.g. stop propagation on the Select's Escape handling, or have the modal ignore Escape while a nested popover is open).

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none across the full step-3 interaction sequence (typing, opening/closing Select, checking checkbox)
- Horizontal overflow: none
- Modal overflow: none (see geometry discussion — no clipping currently, but fragile headroom noted above)
- Child element overflow: none
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (exact match, 12/12 strings: "ACCOUNT SETUP" / "Complete your profile" / subcopy / "Email verified" / "Full name" / "Phone number" / "Company name" / helper text / checkbox label incl. both embedded link texts / "Create account" / footer line / "Sign in")

**Step 3 verdict: FAIL** (1 P1 — Select/Input height mismatch — plus multiple P2s: checkbox color token gap, link-variant inconsistency, tight geometry margin, and a confirmed Escape-key interaction bug)

---

# STEP 4 — "Success"

## Modal/Card geometry
- Modal width: 480px (target: 480px) ✓
- Modal height: 530px
- Content width: 400px ✓
- Viewport size: 1440×900
- Modal-to-viewport width ratio: 33.3%
- Left/right padding: 40px ✓
- Top/bottom breathing room: 185px top / 185px bottom — generous, comfortably matches (exceeds) target

## Form control geometry
No form inputs on this step, per spec.
- Primary CTA "Continue browsing": 400×56px, radius 5px, DS component confirmed: yes
- Info panel: 400×159px, radius 5px, background `rgb(250,250,250)` ≈ `--color-ramp-black-50` (#fafafa) — matches spec's recommended composition (plain container + tokens, no invented component)

## A. VISUAL FIDELITY

### P2
- **"Browse reports" link renders as black text with a red underline** (`InlineLink` default variant), not the solid red, no-underline treatment the reference shows (matching "Sign in"/"Change"/"Didn't receive it?" elsewhere in this same build). This is the most visible instance of the cross-step link-variant inconsistency (see note below) since "Browse reports" is a prominent, standalone secondary CTA directly under the primary button — the color mismatch is immediately noticeable against the reference. **Correction: switch this `InlineLink` instance to the solid-red-no-underline variant (or `CTALink` per spec's open choice #13) to match the reference and the flow's own established red-link pattern.**
- Decorative sparkle "+"/dot accents around the green checkmark are correctly omitted (spec explicitly permits omission over fabricating an asset — not a discrepancy, confirming correct handling of Uncertainty #11).

### P3
- None beyond the above.

## B. DESIGN SYSTEM COMPLIANCE — PASS (with the 1 P2 link-variant flag above, not a hard FAIL since the component IS a real mapped `InlineLink`, just the wrong variant)
- Actual components used: `Button` (Continue browsing, variant=brand size=lg), `InlineLink` (Browse reports), plain composed container (info panel, per spec's "compose from primitives" guidance — no invented component), `CheckCircle2`-equivalent icon in `--semantic-status-success-*` green
- Actual tokens used: `--semantic-status-success-text/-bg/-border`, `--color-ramp-black-50` (panel bg), `--radius-button`, `--radius-card`
- Custom CSS exceptions: none beyond disclosed (sparkle omission)
- Any mapped DS component approximated with custom CSS: none

## C. INTERACTION / UX — PASS
- Info panel correctly wired to real state: Name "Nirvair Singh", Work email "jane@kenresearch.com" (the actual typed email, not the reference's static "nirvair@company.com"), Account "Kenresearch account" (correctly derived from the typed email's domain) — confirms spec's Uncertainty #5/#6 resolution: the flow uses real form state, not hardcoded reference strings, exactly as recommended
- Heading + icon + panel correctly center-aligned, matching the reference's confirmed intentional deviation from steps 1–3's left-alignment (Uncertainty #14 handled correctly, not "fixed" to match other steps)
- Both CTAs present and functional ("Continue browsing", "Browse reports")

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none
- Horizontal overflow: none
- Modal/child overflow: none
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (exact match, 6/6 strings: "Your account is ready" / "Name" / "Work email" / "Account" / "Continue browsing" / "Browse reports"; panel values correctly reflect real flow state rather than literal reference strings, consistent with spec's guidance)

**Step 4 verdict: FAIL** (1 P2 — "Browse reports" link-variant/color mismatch)

---

# Cross-step note: InlineLink variant inconsistency (appears in Steps 2, 3, 4)

A single root cause spans three of the four steps: this build has (at least) two different `InlineLink` treatments in use —
1. **Solid red, no underline** — used correctly for Step 1 "Sign in", Step 2 "Change" and "Didn't receive it?", Step 3 footer "Sign in". This matches the reference exactly everywhere it's used.
2. **Black text + red underline (default variant)** — used for Step 2 "Back to sign up", Step 3 "Terms of Use"/"Privacy Policy", Step 4 "Browse reports". The reference shows all of these as solid red, no underline, matching treatment #1.

This reads as an inconsistent prop/variant choice at each of these 4 call sites rather than a missing DS capability — the correctly-styled variant already exists and is already used elsewhere in the same build. Recommended single fix: audit all `InlineLink` usages across `SignupEmail.tsx` / `OtpVerificationStep.tsx` / `CompleteProfileStep.tsx` / `SignupSuccessStep.tsx` and standardize on the solid-red-no-underline variant throughout, unless a specific reference detail calls for the underlined treatment (none currently do).

---

## Confirmed items from loop-builder's iteration-1 report

1. **Step 3 modal height (829px vs. 836px max-height ceiling):** Confirmed via live measurement. Does not currently overflow or clip (35px/35px margin to the 900px viewport), but is the tightest of all 4 steps and has only 7px of internal headroom — classified **P2**, not P1, with a concrete correction offered above.
2. **Checkbox checked-state color (missing `--primary` token):** Confirmed via live `getComputedStyle` — `--primary` resolves to an empty string in this project's tokens.css. Checkbox checked-state renders black/generic instead of brand-red. Classified **P2** (component correctly mapped; the token it depends on needs to be defined, or the component needs a brand-red override at the checkbox call site).
3. **`SelectContent` z-index/background fix (`z-[110] bg-white`):** Confirmed working — the country-code dropdown renders fully visible above the modal with a white background, all 5 options legible, opens and closes correctly via mouse click. (Separately, a **new** issue was found: pressing Escape while the dropdown is open closes the entire modal rather than just the dropdown — see Step 3 Section C.)

---

## Overall Verdict

| Step | Verdict | Blocking issues |
|---|---|---|
| Step 1 — Create account | **PASS** | none |
| Step 2 — OTP verification | **FAIL** | P2: OTP slot radius (15px vs. 5px target); P2: "Back to sign up" wrong link variant |
| Step 3 — Complete profile | **FAIL** | P1: Select/Input height mismatch (36px vs. 56px) in phone row; P2: checkbox checked-color token gap; P2: Terms/Privacy link variant; P2: tight modal geometry margin; P2: Escape-key closes whole modal instead of just the Select popover |
| Step 4 — Success | **FAIL** | P2: "Browse reports" wrong link variant |

**OVERALL: FAIL** — 3 of 4 steps have at least one P1/P2 finding blocking PASS. Step 1 alone is clean. All findings are concrete and independently small/fast fixes (no re-architecture needed): one height override (Select), one radius value (OTP slots), one token definition (`--primary` → brand red, or a direct override on the Checkbox call site), one Escape-key propagation fix, and a variant standardization pass on 4 `InlineLink` call sites.

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/measurement only — all corrections are stated as measurable deltas against the reference/spec, not redesign opinions)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes (no advisory notes altered any finding's severity)
- Confidence in measurements: high — all geometry, color, and token values were pulled via live `getComputedStyle`/`getBoundingClientRect` queries against the running app, not visual estimation; copy was verified against actual rendered DOM text at each step of a real, driven interactive flow (not 4 isolated static loads)
