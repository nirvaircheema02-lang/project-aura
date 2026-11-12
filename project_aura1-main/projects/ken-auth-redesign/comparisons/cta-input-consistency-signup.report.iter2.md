## Status
Done: CTA/input/OTP-slot/select-trigger height-consistency re-verification, sign-up flow, all 4 steps (email → OTP → profile → success), iteration 2. This pass re-verifies the exactly one blocking item carried forward from `cta-input-consistency-signup.report.iter1.md` (OTP slot hardcoded `h-12 w-12` instead of the shared `--button-height-md` token) plus an additional fix discovered in the source during this pass's own inspection (Select trigger height was silently losing the cascade to a higher-specificity DS-default class). Every number below was captured fresh, live, via Playwright (headless Chromium, `getBoundingClientRect`/`getComputedStyle`), driving the real end-to-end flow twice (once for geometry, once for interaction-state/containment checks) — nothing here is taken from the builder's self-report or from source-reading alone.

## Reference source
Same as iter1 — this is a targeted numeric-consistency re-check, not a fresh visual-fidelity pass. Figma file `PJtPivOzEkiTjSkGnZ2YtH`, frame `550:67` "SignUp" (`projects/ken-auth-redesign/specs/signup-flow.spec.md`), 48px control-height target and 464px modal / ≈400px content-width targets carried forward from the already-approved, previously-passed geometry baseline (`signup-flow.report.iter3.md`, re-confirmed by `cta-input-consistency-signup.report.iter1.md`). No new Figma re-fetch performed for this iteration.

## Modal/Card geometry (explicit numbers, measured live)
- Viewport: **1440×900** (controlled, Playwright headless Chromium)
- Modal width: **464px** on all 4 steps (target: 464px) — MATCH, unchanged from iter1
- Modal height: Step 1 = 545.78px · Step 2 = 554.91px · Step 3 = 753.31px (tallest) · Step 4 = 490.38px (shortest) — content-driven, matches iter1's figures within sub-pixel rounding (no regression)
- Content width: **400px** on every step (target: ≈400px) — MATCH, confirmed directly on every full-width control's own rendered width
- Modal-to-viewport width ratio: 464/1440 = **32.2%** — unchanged
- Left/right padding: **32px** each side (computed style, confirmed live) — unchanged
- Top/bottom padding (breathing room to viewport edge, modal vertically centered): Step 1 ≈177.1/177.1px · Step 2 ≈172.5/172.5px · Step 3 ≈73.3/73.3px (tightest, tallest step, still zero overflow) · Step 4 ≈204.8/204.8px

## Form control geometry (explicit numbers, required — 2+ controls present on every step)

**Step 1 — Create account:**
| Control | Size | Radius | DS component confirmed |
|---|---|---|---|
| Email input | 400×**48** | 5px | yes (`data-slot="input"`, `ui/input.tsx`, confirmed via import `from '@kenresearch/design-system/ui/input'`) |
| Primary CTA "Continue with work email" | 400×**48** | 5px | yes (`data-component="Button"`, `atoms/Button.tsx`) |
| Secondary/social CTA "Continue with LinkedIn" | 400×**48** | 5px | yes (`atoms/Button.tsx`) |
Shared content width: **yes**. Shared height across all three: **yes — 48px identical**, held across default/hover/focus/filled states (see Section C).

**Step 2 — OTP verification:**
| Control | Size | Radius | DS component confirmed |
|---|---|---|---|
| Work-email input (masked, `disabled`+`readOnly`) | 400×**48** | 5px | yes (same `ui/input.tsx` element as Step 1) |
| OTP slot ×6 | 48×**48** each | 5px | yes (`data-slot="input-otp-slot"`, `ui/input-otp.tsx`, imported as `InputOTP`/`InputOTPGroup`/`InputOTPSlot`) |
| Primary CTA "Verify & continue" | 400×**48** | 5px | yes (same physical `Button` node as Step 1) |
Shared height across email input / OTP slots / CTA: **yes — 48px identical**, confirmed both pre-fill (empty slots) and post-fill (digits "1"–"6" entered) — zero shift. **This is the specific fix under re-verification: `EmailOtpStep.tsx:337` now reads `className="h-[var(--button-height-md)] w-[var(--button-height-md)] !rounded-[var(--radius-button)] ..."` (previously hardcoded `h-12 w-12`) — confirmed live: OTP slots render at exactly 48×48, sourced from the same `--button-height-md` token as every other control, no longer a coincidentally-matching hardcoded value. FIX CONFIRMED.**

**Step 3 — Complete profile:**
| Control | Size | Radius | DS component confirmed |
|---|---|---|---|
| Full name input | 400×**48** | 5px | yes (`ui/input.tsx`) |
| Phone country-code select trigger | 92×**48** | 5px | yes (`data-slot="select-trigger"`, `ui/select.tsx`, imported as `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`/`SelectValue`) |
| Phone number input | 300×**48** | 5px | yes (`ui/input.tsx`) |
| Company name input | 400×**48** | 5px | yes (`ui/input.tsx`) |
| Primary CTA "Create account" | 400×**48** | 5px | yes (`atoms/Button.tsx`) |
| Checkbox (terms) | 16×16 | 4px | yes (`data-slot="checkbox"`, `ui/checkbox.tsx`) — correctly excluded from the 48px rhythm, distinct DS control |
Shared content width: **yes** — full-width controls all 400px; phone select (92) + 8px gap + phone input (300) = 400px. Shared height across all non-checkbox controls: **yes — 48px identical.**
**Additional fix found and re-verified this pass (not in iter1's report, discovered live in source during this re-check):** `CompleteProfileStep.tsx:140` — the phone country-code `SelectTrigger` previously lost its height override to the DS component's own `data-[size=default]:h-9` base class (an attribute-selector class with higher cascade specificity than a plain arbitrary-value override), silently pinning it at 36px regardless of the className passed in. It now reads `className="!h-[var(--button-height-md)] w-[92px] shrink-0 rounded-[var(--radius-button)]"` — the `!important` forces the win. **Live-confirmed: select trigger renders 92×48 in default, open (dropdown visible), and closed states — no shift, no regression.**

**Step 4 — Success:**
| Control | Size | Radius | DS component confirmed |
|---|---|---|---|
| Primary CTA "Continue browsing" | 400×**48** | 5px | yes (`atoms/Button.tsx`) |
| "Browse reports" link | text link | — | yes (`InlineLink`, correctly excluded from height rhythm) |

**Cross-step consistency: every Button/Input/Select-trigger/OTP-slot across all 4 steps renders at exactly 48px height, live-measured, both before and after user interaction (typing, focus, hover, select-open/close). No control anywhere in the sign-up flow deviates from 48px. Checkbox (16×16) is the sole, correctly-excluded exception (distinct DS control, not a CTA/input).** Both the OTP-slot fix (iter1's blocking P2) and the select-trigger specificity fix are independently confirmed live.

---

## A. VISUAL FIDELITY

### P1 (major)
None.

### P2 (noticeable)
None. The single P2 blocking iter1 (`EmailOtpStep.tsx:337` OTP slot hardcoded `h-12 w-12`) is **resolved and confirmed live** — the element now sources its size from `h-[var(--button-height-md)] w-[var(--button-height-md)]`, the same token every other control in the flow uses.

### P3 (finishing/detail — non-blocking, must still be explicitly reported even on PASS)
- Step 3/Step 4's auto-detected company name still renders as "Kenresearch" (one word) rather than "Ken Research" (two words) for test email `jane@kenresearch.com`, and Step 4's success panel echoes it as "Kenresearch account". This is the same pre-existing `deriveCompanyName()` domain-label-splitting quirk already flagged in iter1 — untouched by either height-fix in this cycle, not a height/geometry/DS-mapping issue. Carried forward, still non-blocking.

## B. DESIGN SYSTEM COMPLIANCE — PASS
- Actual components used, confirmed via source imports (not just DOM similarity or visual impression):
  - `EmailOtpStep.tsx`: `import { Button, Divider, InlineLink } from '@kenresearch/design-system/atoms'`; `import { Input } from '@kenresearch/design-system/ui/input'`; `import { InputOTP, InputOTPGroup, InputOTPSlot } from '@kenresearch/design-system/ui/input-otp'`
  - `CompleteProfileStep.tsx`: `import { Badge, Button, InlineLink } from '@kenresearch/design-system/atoms'`; `import { Input } from '@kenresearch/design-system/ui/input'`; `import { Checkbox } from '@kenresearch/design-system/ui/checkbox'`; `import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kenresearch/design-system/ui/select'`
  - `SignupSuccessStep.tsx`: `import { Button, Divider, InlineLink } from '@kenresearch/design-system/atoms'`
- Actual tokens used: `--button-height-md` (48px, confirmed in `design-system/core-v2/src/styles/base.css:104`, `/* OG 3rem · touch-target compliant */`) for every Input/Select/OTP-slot height override; `--radius-button` (5px) for input/select/otp-slot/button radii; `--radius-card` (10px, via `--rc-radius-card: var(--radius-sm)`) for the modal
- Custom CSS exceptions: none — every mapped DS component is the real component; the `!important` on the Select trigger's height and the token-reference on the OTP slot are both cascade-specificity fixes to *use the real component's override correctly*, not custom-CSS approximations of the component itself
- Any mapped DS component approximated with custom CSS instead of used directly: **none**
- Verified the OTP slot's base DS class (`ui/input-otp.tsx:54`, `h-9 w-9`) is a plain utility class (not an attribute-selector-gated class), so the arbitrary-value override wins via standard class-merge precedence without needing `!important` — consistent with why that particular override didn't need the same `!` treatment the Select trigger did; both are correctly resolved on their own terms, not a copy-paste inconsistency.

## C. INTERACTION / UX — PASS
- Input states exercised live on the Step 1 email field: default (400×48) → hover (400×48, border darkens `oklab(0 0 0/0.1)→0.25`) → focus (400×48, border darkens further to `0.9`) → filled (400×48) — **height held at 400×48 across all four, zero shift**
- Read-only/disabled state (Step 2 masked email, `disabled=true readOnly=true`): 400×48, same as Step 1's editable state — no shrinkage from disabled styling
- Button states exercised live on the Step 1 primary CTA: default (400×48, `box-shadow: rgba(176,31,36,.15) 0 4px 16px`) → hover (400×48, shadow deepens to `.22`/larger blur — lift effect, expected DS behavior) → focus (400×48, shadow deepens further to `.25`) — **height/width held constant across all three, only the shadow token intensifies as designed**
- Select states exercised live on Step 3's phone country-code trigger: default (92×48) → open (92×48, dropdown/listbox confirmed rendered) → closed via Escape (92×48) — **zero shift across open/close**, confirming the `!important` specificity fix holds under real interaction, not just static inspection
- OTP slots exercised live: empty state (6× 48×48) → filled via real keystrokes "1"–"6" (6× 48×48) — zero shift
- Checkbox default → checked exercised live — 16×16 held in both states
- Keyboard/focus behaviour: tab-reachable, visible focus ring confirmed (outline width increases to 2px + brand-red-tinted shadow deepens on focus, per component above)
- Form hierarchy: unchanged from baseline; labels present on every field
- Accessibility concerns: none new from this pass. Advisory-only (UI/UX Pro Max, subordinate role, no override of any finding above): the disabled/read-only masked-email field in Step 2 relies on visual dimming plus native `readOnly`/`disabled` attributes for its non-editable state — already DS-sourced behavior, no additional note beyond what's in the baseline spec.

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: **none** across two independent full end-to-end runs (one for geometry capture, one for interaction-state/containment capture)
- Horizontal overflow: **none** — `document.documentElement.scrollWidth` (1440) === `window.innerWidth` (1440) at every step, both runs
- Modal overflow (content exceeding modal bounds): none — no clipping at any step
- Child element overflow: **explicitly checked this pass via bounding-rect containment** — every Button/Input/Select-trigger/OTP-slot/Checkbox/anchor inside the modal card was tested against the card's own bounding rect at all 4 steps; **overflowing-element count = 0 at every step** (Step 1: 0, Step 2: 0, Step 3: 0, Step 4: 0)
- Viewport clipping: none
- Unexpected layout shift on state change: **none** — verified via before/after geometry on hover/focus/filled (email + CTA), open/closed (select trigger), empty/filled (OTP), unchecked/checked (checkbox); also none across the 4 step-transitions themselves (modal width constant 464px throughout)

---

## Verdict

- Zero P1 issues (section A): **yes**
- Zero P2 issues (section A): **yes** — iter1's single blocking P2 (OTP slot hardcoded height) is resolved and live-confirmed; no new P2 introduced
- Section B (DS Compliance): PASS
- Section C (Interaction/UX): PASS
- Section D (Runtime/Layout Safety): PASS
- Copy Lock matches exactly: **yes** — all Step 1/2/3/4 Copy Lock strings (eyebrow, heading, subcopy, labels, placeholders, helper text, button labels, divider, links, footer) verified verbatim via live `innerText` extraction; the Step 2 masked-email format (`jan***@kenresearch.com`) correctly follows the spec's `use***@company.com` masking pattern for the entered test address; the live countdown value ("00:30") is expected per spec Uncertainty #2 (static reference snapshot showed "00:28", a live countdown's exact start value isn't reference-locked) — not a Copy Lock violation
- Modal proportions match target: **yes** — 464px/400px/32px all confirmed, consistent across all 4 steps, unchanged from iter1
- Form control geometry consistent: **yes** — every Button/Input/Select-trigger/OTP-slot renders at exactly 48px, shared content width (400px) confirmed on every full-width control, phone select+input pair correctly sums to 400px

**PASS | FAIL → PASS.** Both height-consistency fixes under test (OTP slot token-reference swap; Select trigger `!important` specificity fix) are independently confirmed live via `getBoundingClientRect`/`getComputedStyle` on the real running app — every Button, Input, Select-trigger, and OTP-slot across all 4 sign-up steps renders at exactly 48px, held through every interaction state (hover/focus/filled/open/closed/checked) with zero layout shift, zero overflow, zero console errors, Copy Lock intact, and DS Mapping Gate intact (all components are real, token-sourced, no custom-CSS approximation). One non-blocking P3 (pre-existing "Kenresearch" one-word company-name auto-detect quirk) is carried forward per the mandatory reporting rule — it does not affect the verdict.

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/measurement only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes (no advisory note altered any finding's severity)
- Confidence in measurements: **high** — every geometry/state number was captured via two independent Playwright (headless Chromium, controlled 1440×900 viewport) runs against the real running dev server (`localhost:3091`, confirmed serving the correct app via page `<title>` before measuring), using `getBoundingClientRect`/`getComputedStyle` directly on real DOM nodes (not source-reading alone) — the OTP hidden-input interaction target and Select trigger open/close behavior were both driven via real user-equivalent input (typed keystrokes, real clicks, Escape key), not simulated. DS component identity was confirmed via `data-slot` attributes cross-checked against each source file's actual `import` statements. Copy Lock was verified via full `document.body.innerText` extraction at each of the 4 steps, not spot-checked.
