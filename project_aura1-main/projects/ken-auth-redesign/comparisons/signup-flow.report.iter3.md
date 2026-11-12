# Loop Visual QA — Sign-up Flow (4 steps) — Iteration 3

## Status
Done: Full 4-step interactive sign-up flow (Step 1 → 2 → 3 → 4) re-compared against iteration 3's builder claim (real `variant` prop added to `InlineLink.tsx`, applied to 8 call sites). Iteration 3 of 4, likely final.

## Reference source
Figma frame `550:67` "SignUp", file key `PJtPivOzEkiTjSkGnZ2YtH`. Step nodes: 554:94 (Step 1), 554:97 (Step 2), 554:100 (Step 3), 554:103 (Step 4). All 4 re-fetched fresh this pass via `get_screenshot` at `maxDimension=2200` and pixel-cropped around each of the 8 link instances for independent ground-truth verification (not reused from a prior pass's framing).

## Environment
- Rendered implementation: http://localhost:3091 (Next.js dev server)
- Viewport: **1440×900** (controlled, held constant across all 4 steps)
- Driven via live browser automation through the real flow: email → OTP → profile → success. Confirmed the task brief's noted quirk — standard `type`/`left_click` automation does not reliably register on this flow's controlled inputs/Radix components (React state updates lag a synchronous read). Worked around via native-setter (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set` + `dispatchEvent('input')`) for text/OTP fields, and `element.click()` / dispatched `pointerdown`+`pointerup` sequences followed by an async delay (~200ms) for Radix `Checkbox`/`Select` before reading `data-state`/`aria-expanded` back — reading synchronously immediately after the event produced false negatives (state hadn't flushed yet), not an actual interaction failure.

---

## Independent verification of the builder's claim

### 1. Component identity — verified live via `data-component`/`data-variant`, not just color

Queried the live DOM for each of the 8 instances (`tagName`, `getAttribute('data-component')`, `getAttribute('data-variant')`, `href`, `getComputedStyle().color`, `getComputedStyle().textDecorationLine`):

| # | Instance | Step | Tag | `data-component` | `data-variant` | `href` | Color | Underline |
|---|---|---|---|---|---|---|---|---|
| 1 | "Sign in" | 1 | `A` | `InlineLink` | `solid` | `/login` | `rgb(176,31,36)` | none |
| 2 | "Change" | 2 | `A` | `InlineLink` | `solid` | `#` | `rgb(176,31,36)` | none |
| 3 | "Didn't receive it?" | 2 | `A` | `InlineLink` | `solid` | `#` | `rgb(176,31,36)` | none |
| 4 | "Back to sign up" | 2 | `A` | `InlineLink` | `muted` | `#` | `rgb(82,82,82)` | none |
| 5 | "Terms of Use" | 3 | `A` | `InlineLink` | `solid` | `/terms` | `rgb(176,31,36)` | none |
| 6 | "Privacy Policy" | 3 | `A` | `InlineLink` | `solid` | `/privacy` | `rgb(176,31,36)` | none |
| 7 | footer "Sign in" | 3 | `A` | `InlineLink` | `solid` | `/login` | `rgb(176,31,36)` | none |
| 8 | "Browse reports" | 4 | `A` | `InlineLink` | `solid` | `#` | `rgb(176,31,36)` | none |

All 8 carry `data-component="InlineLink"` — this is the real DS atom rendering, not a lingering hand-rolled `<button>`/custom element (the `data-component`/`data-variant` attributes only exist on `design-system/core-v2/src/atoms/InlineLink.tsx`'s own JSX, confirmed by reading that file directly — no other component in this build sets those attributes, so their presence is proof of provenance, not just a visual coincidence). Note: a background-page nav "Sign in" `BUTTON` also matches the text query on Steps 1/3 but is `offsetParent: null` (not visible, not part of the modal) — confirmed via `closest()`/visibility check to be the marketing navbar behind the scrim, out of scope, and correctly excluded from the count above.

Read `InlineLink.tsx` source directly: the `variant` prop is additive (`'default' | 'solid' | 'muted'`, defaults to `'default'`), and `solid`/`muted` are new class branches that don't touch the `default` branch's classes — confirmed non-regressive for any other consumer, consistent with the builder's claim.

### 2. Reference ground truth — re-verified via fresh pixel crops, not reused from iteration 2's framing

Cropped and visually inspected all 8 positions from freshly-fetched reference screenshots (2200px max dimension):

| Instance | Reference (fresh crop, this pass) | Match to live render |
|---|---|---|
| Step 1 "Sign in" | Solid red, no underline | Yes |
| Step 2 "Change" | Solid red, no underline | Yes |
| Step 2 "Didn't receive it?" | Solid red, no underline | Yes |
| Step 2 "Back to sign up" | Muted gray, no underline (confirmed the one outlier) | Yes |
| Step 3 "Terms of Use" / "Privacy Policy" | Solid red, no underline | Yes |
| Step 3 footer "Sign in" | Solid red, no underline | Yes |
| Step 4 "Browse reports" | Solid red, no underline | Yes |

All 8 assignments are correct per-step, not merely internally consistent — the fresh crops match iteration 2's documented reference readings exactly, and the live render now matches all 8.

**Conclusion: the root-cause fix is confirmed correct and complete.** All 3 iteration-2 P1s (DS Mapping Gate violations) and all 3 iteration-2 P2s (2 wrong-variant "Sign in" instances + 1 over-corrected "Back to sign up") are resolved.

---

# STEP 1 — "Create your account"

## Modal/Card geometry
- Modal width: 480px (target: 480px)
- Modal height: 606px
- Content width: 400px (target: ≈400px)
- Viewport size: 1440×900
- Modal-to-viewport width ratio: 33.3%
- Left/right padding: 40px
- Top/bottom padding (breathing room): 147px / 147px

## Form control geometry
- Email input: 400×56px, radius 5px, DS component confirmed: yes
- Primary CTA: 400×56px, radius 5px, DS component confirmed: yes
- Secondary/social CTA (LinkedIn): 400×56px, radius 5px, DS component confirmed: yes
- Shared content width across all three: yes

## A. VISUAL FIDELITY
No P1/P2/P3 findings. "Sign in" now solid red, no underline, matching reference — confirmed via live `getComputedStyle` + `data-component="InlineLink"` + `data-variant="solid"`.

## B. DESIGN SYSTEM COMPLIANCE — PASS
- Actual components used: `Input`, `Button` (variant=brand/secondary, size=lg), `InlineLink` (variant=solid, real component, real variant)
- Actual tokens used: `--color-brand-red`, `--radius-button`, `--radius-card`, `--button-height-lg`
- Custom CSS exceptions: none
- Any mapped DS component approximated with custom CSS instead of used directly: none

## C. INTERACTION / UX — PASS
- Input default/filled verified (native-setter typed "jane@kenresearch.com")
- Buttons default/hover consistent with DS
- Keyboard/focus: no blocking issues
- Form hierarchy matches reference

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none
- Horizontal overflow: none (`scrollWidth` 1440 = viewport)
- Modal/child overflow: none
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (10/10 strings verbatim)

**Step 1 verdict: PASS**

---

# STEP 2 — "OTP verification"

## Modal/Card geometry
- Modal width: 480px
- Modal height: 603px
- Content width: 400px
- Viewport: 1440×900, ratio 33.3%
- Padding: 40px
- Breathing room: 149px / 148px

## Form control geometry
- Read-only email field: 400×56px, radius 5px
- OTP slots ×6: 48×48px, radius 5px (verified against the actual `InputOTPSlot` element specifically — a decorative flex wrapper div incidentally shares the 48×48 box size with `border-radius: 10px`, but is not the bordered slot itself; the real slot element, identified by its `!rounded-[var(--radius-button)]` class and 1px border, measures 5px radius as required)
- Primary CTA: 400×56px, radius 5px
- Shared content width: yes

## A. VISUAL FIDELITY
No P1/P2/P3 findings. "Change" and "Didn't receive it?" solid red/no-underline (unchanged, still correct). "Back to sign up" now muted gray `rgb(82,82,82)`, no underline — matches the reference's one deliberate outlier — and renders through the real `InlineLink` atom with `data-variant="muted"`, not a custom element.

## B. DESIGN SYSTEM COMPLIANCE — PASS
- Actual components used: `Input` (disabled/readOnly), `InputOTP`/`InputOTPGroup`/`InputOTPSlot` (6 individually-bordered, radius-overridden slots), `Button`, `InlineLink` (×3: "Change" solid, "Didn't receive it?" solid, "Back to sign up" muted — all real component, real variants)
- Actual tokens used: `--color-brand-red` (active OTP slot border, solid-variant links), `--semantic-ink-muted` (muted-variant link), `--radius-button`, `--radius-card`, `--button-height-lg`
- Custom CSS exceptions: OTP per-slot border/radius override (disclosed, acceptable per spec)
- Any mapped DS component approximated with custom CSS: none

## C. INTERACTION / UX — PASS
- OTP: filled "274912" via native-setter, digit-by-digit fill confirmed, active-slot red border tracks correctly
- "Change"/"Didn't receive it?"/"Back to sign up": present, correctly styled, functional
- "Didn't receive it?" correctly shows `aria-disabled="true"` + reduced opacity during the active countdown (disabled-state layering on top of the `solid` variant, not a separate defect)
- Keyboard/focus: no blocking issues

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none
- Horizontal overflow: none
- Modal/child overflow: none
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (10/10 strings verbatim, including correct dynamic masked-email interpolation)

**Step 2 verdict: PASS**

---

# STEP 3 — "Complete profile"

## Modal/Card geometry
- Modal width: 480px
- Modal height: 817px (unchanged from iteration 2, confirmed stable — no regression from the link fix)
- Content width: 400px
- Viewport: 1440×900, ratio 33.3%
- Padding: 40px
- Top/bottom breathing room: 41px / 42px (unchanged from iteration 2 — still below the ~75px target but non-blocking; no overflow/clipping observed, internal scroll headroom ~19px to the `max-h-[calc(100vh-4rem)]` ceiling)

## Form control geometry
- Full name input: 400×56px, radius 5px
- Phone country-code select: 92×56px, radius 5px
- Phone number input: 300×56px, radius 5px (paired with select, 92+300=392px ≈ 400px column per spec's "pair together" allowance)
- Company name input: 400×56px, radius 5px
- Primary CTA: 400×56px, radius 5px
- Shared content width across all full-width controls: yes

## A. VISUAL FIDELITY

### P3 (finishing/detail — non-blocking)
- Modal breathing room (41px/42px) remains below the ≈75px geometry target, unchanged from iteration 2. No overflow/clipping observed; this is a further optional trim, not a defect blocking PASS.

No P1/P2 findings. "Terms of Use"/"Privacy Policy" and footer "Sign in" all solid red, no underline, matching reference, all rendering through the real `InlineLink` atom with `data-variant="solid"`.

## B. DESIGN SYSTEM COMPLIANCE — PASS
- Actual components used: `Badge` ("Email verified" pill), `Input` ×3, `Select`/`SelectTrigger`/`SelectContent`/`SelectItem` (country code, 56px), `Checkbox`, `Button`, `InlineLink` ×3 (all solid variant, real component)
- Actual tokens used: `--color-brand-red` (checkbox checked state, solid-variant links), `--radius-button`, `--radius-card`, success-pill tokens
- Checkbox checked-state color: confirmed still correct via live interaction — `background-color: rgb(176,31,36)`, `border-color: rgb(176,31,36)` after toggling from unchecked → checked
- Custom CSS exceptions: none needed here
- Any mapped DS component approximated with custom CSS: none

## C. INTERACTION / UX — PASS
- Full name / Phone / Company inputs: filled and confirmed via native-setter
- Checkbox: toggled unchecked → checked live, confirmed brand-red on checked state
- Select: opens correctly (`aria-expanded` flips true), all 5 options visible, white background, closes on selection
- **Escape-key behavior: re-confirmed working exactly as designed, reproduced live this iteration.** With the Select dropdown open, first `Escape` closed only the dropdown (`aria-expanded` → `false`) while the modal, the checked checkbox state, and the typed "Test User" full-name value all remained intact (verified via live DOM query, not just visual impression). A second `Escape` (dropdown already closed) then closed the entire modal (confirmed via screenshot — modal gone, background page fully interactive).

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none across the full interaction sequence (typing, checkbox toggle, Select open/close, Escape ×2)
- Horizontal overflow: none
- Modal/child overflow: none (19px headroom remains, no clipping observed)
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (12/12 strings verbatim)

**Step 3 verdict: PASS** (1 P3, non-blocking, explicitly reported per the PASS-with-P3 allowance)

---

# STEP 4 — "Success"

## Modal/Card geometry
- Modal width: 480px
- Modal height: 530px (unchanged from iteration 2)
- Content width: 400px
- Viewport: 1440×900, ratio 33.3%
- Padding: 40px
- Breathing room: 185px / 185px

## Form control geometry
No form inputs. Primary CTA "Continue browsing": 400×56px, radius 5px, DS component confirmed: yes.

## A. VISUAL FIDELITY
No P1/P2/P3 findings. "Browse reports" now solid red, no underline, matching reference, rendering through the real `InlineLink` atom with `data-variant="solid"`. Center-alignment, info panel, sparkle-accent omission all correctly handled, consistent with prior iterations.

## B. DESIGN SYSTEM COMPLIANCE — PASS
- Actual components used: `Button` (Continue browsing), `InlineLink` (Browse reports, solid variant, real component), plain composed info-panel container (per spec's compose-from-primitives guidance)
- Actual tokens used: success-status tokens, `--color-ramp-black-50`, `--radius-button`, `--radius-card`
- Any mapped DS component approximated with custom CSS: none

## C. INTERACTION / UX — PASS
- Info panel correctly wired to real typed state (Name "Nirvair Singh", Work email "jane@kenresearch.com", Account "Kenresearch account") — reproduced live end-to-end this iteration, not just visually inspected
- Both CTAs present and functional

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none
- Horizontal overflow: none
- Modal/child overflow: none
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (6/6 strings verbatim, confirmed via full-page text extraction after live flow completion)

**Step 4 verdict: PASS**

---

## Full step-transition flow (1→2→3→4) — confirmed working end-to-end

Reproduced live, in one continuous session, this iteration: Step 1 email submit → Step 2 OTP entry + verify → Step 3 profile fields + checkbox + Create account → Step 4 success screen with correctly-interpolated real typed values. No console errors, no layout shift, no overflow at any transition. Screenshots captured at each step confirm visual continuity.

---

## Confirmed fixed from iteration 2 (do not re-flag)

1. **3 P1s — DS Mapping Gate violations** ("Back to sign up" Step 2, "Terms of Use"/"Privacy Policy" Step 3, "Browse reports" Step 4 bypassing `InlineLink`): confirmed fixed — all 8 link instances across all 4 steps now render through the real `InlineLink.tsx` atom (`data-component="InlineLink"` present on all 8), using a real additive `variant` prop, not hand-rolled markup.
2. **2 P2s — wrong-variant "Sign in" instances** (Step 1, Step 3 footer): confirmed fixed — both now `variant="solid"`, solid red, no underline.
3. **1 P2 — "Back to sign up" over-corrected to red in iteration 2**: confirmed fixed — now `variant="muted"`, `rgb(82,82,82)`, matching the reference's one deliberate muted outlier.

No regressions introduced: Step 3 Select/Input height, OTP slot radius, checkbox checked-color, Step 3 geometry margin, and the Escape-key fix (all previously confirmed fixed in iteration 2) were re-verified live this pass and remain correct and untouched.

---

## Overall Verdict

| Step | Verdict | Notes |
|---|---|---|
| Step 1 — Create account | **PASS** | 0 P1/P2/P3 |
| Step 2 — OTP verification | **PASS** | 0 P1/P2/P3 |
| Step 3 — Complete profile | **PASS** | 1 P3 (geometry margin still tight vs. ~75px target, non-blocking, explicitly reported) |
| Step 4 — Success | **PASS** | 0 P1/P2/P3 |

**OVERALL: PASS** — 0 P1 and 0 P2 across all 4 steps simultaneously. Copy Lock matches exactly on all 4 steps (10+10+12+6 = 38 Copy Lock strings verified verbatim across the flow, plus dynamic interpolations — masked email, success-panel values — correctly wired to real typed state). DS component mapping passes on all 8 previously-flagged link instances plus every other mapped control. Form geometry consistent (shared content width, real DS component sizing) on all 4 steps. Modal proportions match the approved reference on all 4 steps (480px width / 400px content / 33.3% viewport ratio held constant). Required interaction states (Input, Button, OTP, Select, Checkbox, InlineLink ×3 variants) all match DS behavior, including the Escape-key double-dismiss and checkbox checked-color fixes carried forward from iteration 2 without regression.

One non-blocking P3 remains (Step 3 breathing-room margin, 41px/42px vs. ~75px target) — explicitly reported per the PASS-with-P3 allowance; it does not block PASS.

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/measurement only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes (no new advisory notes altered any finding's severity this pass; UI/UX Pro Max notes from the original spec remain unchanged and are not re-litigated here since no new interaction pattern was introduced)
- Confidence in measurements: high — all 8 link instances' component identity was verified via `data-component`/`data-variant` DOM attributes (proof of real-component provenance, not just visual color matching) cross-referenced against the `InlineLink.tsx` source file directly; all geometry was pulled via live `getBoundingClientRect`/`getComputedStyle` at a controlled 1440×900 viewport; reference ground truth was re-fetched fresh this pass (not reused from iteration 2) and independently pixel-cropped per instance; the full 1→2→3→4 flow was reproduced live in one continuous session with real DOM-state verification at each step, not just visual inspection.
