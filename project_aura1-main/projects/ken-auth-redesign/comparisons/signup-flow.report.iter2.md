# Loop Visual QA — Sign-up Flow (4 steps) — Iteration 2

## Status
Done: Full 4-step interactive sign-up flow re-compared (Step 1 → 2 → 3 → 4) against the 6 items iteration-1 flagged plus a full fresh pass, iteration 2 of 4.

## Reference source
Figma frame `550:67` "SignUp", file key `PJtPivOzEkiTjSkGnZ2YtH`. Step nodes: 554:94 (Step 1), 554:97 (Step 2), 554:100 (Step 3), 554:103 (Step 4). All 4 re-fetched fresh this pass via `get_screenshot` and pixel-cropped/zoomed for link-style verification (not eyeballed from the earlier low-res view).

## Environment
- Rendered implementation: http://localhost:3091 (Next.js dev server)
- Viewport: **1440×900** (controlled, held constant across all 4 steps, same as iteration 1)
- Driven via live browser automation through the real flow: typed email → OTP → profile fields → account creation. Also used the page's own "Reopen signup modal" dev shortcut once to re-reach Step 3 directly for isolated geometry/interaction re-testing (Escape-key, Select) without re-typing the whole flow twice — the shortcut is a dev-only affordance already present in the build, not a QA-injected change.

---

## Cross-step link-style ground truth (re-verified per instructions — do not trust iteration 1's framing)

Pixel-cropped and zoomed every link instance in all 4 reference images. Result: **there are two legitimately different link treatments in the approved reference, not one "correct" and four "wrong."**

| Instance | Reference treatment (confirmed via pixel crop) | Live render (iteration 2) | Match? |
|---|---|---|---|
| Step 1 "Sign in" | Solid red `rgb(176,31,36)`, no underline | Black `rgb(0,0,0)`, **underline** | **NO — broken, unaddressed this iteration** |
| Step 2 "Change" | Solid red, no underline | Solid red `rgb(176,31,36)`, no underline | Yes (unchanged, still correct) |
| Step 2 "Didn't receive it?" | Solid red, no underline | Solid red `rgb(176,31,36)`, no underline | Yes (unchanged, still correct) |
| Step 2 "Back to sign up" | **Plain gray/black, no underline, NOT red** — a distinctly muted micro-action style, different from every other link in the flow | Solid red `rgb(176,31,36)`, no underline | **NO — new regression** (was black+underline in iter1, now red+no-underline; both wrong, in different ways) |
| Step 3 "Terms of Use" / "Privacy Policy" | Solid red, no underline | Solid red `rgb(176,31,36)`, no underline | Yes — correctly fixed this iteration (see DS compliance caveat below) |
| Step 3 footer "Sign in" | Solid red, no underline | Black `rgb(0,0,0)`, **underline** | **NO — broken, unaddressed this iteration** |
| Step 4 "Browse reports" | Solid red, no underline | Solid red `rgb(176,31,36)`, no underline | Yes — correctly fixed this iteration (see DS compliance caveat below) |

**Conclusion:** the reference intentionally has ONE outlier — "Back to sign up" is the only link styled as plain muted text, not red. All 5 other link instances ("Sign in" ×2, "Change", "Didn't receive it?", "Terms of Use", "Privacy Policy", "Browse reports") should be solid-red-no-underline. The builder's fix, applied uniformly to 4 sites, got 3 of them right (Terms of Use, Privacy Policy, Browse reports) and 1 wrong (Back to sign up, which needed the *opposite* treatment), while leaving the 2 bare-`InlineLink` "Sign in" instances (Step 1, Step 3) unfixed and still visibly wrong against the reference — contradicting iteration 1's report, which had incorrectly called Step 1 "Sign in" a clean match.

**Root-cause finding (new this pass):** per live DOM inspection, the 4 "fixed" call sites (`Back to sign up`, `Terms of Use`, `Privacy Policy`, `Browse reports`) are no longer instances of the DS `InlineLink.tsx` atom at all — they are hand-rolled `<button>`/plain elements with inline Tailwind classes (confirmed for "Browse reports": `className="text-[var(--color-brand-red)] font-medium hover:underline ..."`, `tagName: BUTTON`, no `href`). Meanwhile Step 1 and Step 3's "Sign in" are still real `<a href="/login">` elements matching `InlineLink`'s known default (black + underline). This confirms the actual defect across all 3 iterations has been the same one: **`InlineLink.tsx` has no variant prop for "solid red, no underline,"** so every call site needing that look has had to either accept the wrong default or get bypassed with custom markup. The DS-compliant fix is to add a real variant/prop to `InlineLink.tsx` itself (e.g. `tone="solid"` removing the underline) and use it at all 5 correct call sites — not hand-roll a one-off element per site, and not blanket-apply red to "Back to sign up" which needs the *muted* look instead.

---

# STEP 1 — "Create your account"

## Modal/Card geometry
- Modal width: 480px (target: 480px) ✓
- Modal height: 606px
- Content width: 400px (target: ≈400px) ✓
- Viewport size: 1440×900
- Modal-to-viewport width ratio: 33.3%
- Left/right padding: 40px ✓
- Top/bottom breathing room: 147px / 147px — unchanged from iteration 1, generous

## Form control geometry
- Email input: 400×56px, radius 5px, DS component confirmed: yes
- Primary CTA: 400×56px, radius 5px, DS component confirmed: yes
- Secondary/social CTA (LinkedIn): 400×56px, radius 5px, DS component confirmed: yes
- Shared content width: yes (400px)

## A. VISUAL FIDELITY

### P2 (noticeable)
- **"Sign in" footer link renders black + underlined** (`rgb(0,0,0)`, `text-decoration: underline`), confirmed via live `getComputedStyle` at rect `x:794,y:689` inside the modal. Reference shows solid red, no underline (confirmed via pixel crop). This is unaddressed this iteration and directly contradicts iteration 1's report, which called this element a clean match — re-verified now via zoomed reference crop, iteration 1 was wrong on this specific point. **Correction: apply solid-`--color-brand-red`, no-underline treatment to this link** (see root-cause finding above — needs a real `InlineLink` variant, not another one-off override).

### P3
- None beyond the above.

## B. DESIGN SYSTEM COMPLIANCE — PASS
- Actual components used: `Input`, `Button` (variant=brand/secondary, size=lg), `InlineLink` ("Sign in" — real component, wrong default variant per above, not a mapping violation)
- Actual tokens used: `--color-brand-red`, `--radius-button`, `--radius-card`, `--button-height-lg`
- Custom CSS exceptions: none
- Any mapped DS component approximated with custom CSS: none

## C. INTERACTION / UX — PASS
- Input default/filled verified by typing "jane@kenresearch.com"
- Buttons default/hover consistent with DS
- Keyboard/focus: no blocking issues, no console errors
- Form hierarchy matches reference

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none
- Horizontal overflow: none (`document.documentElement.scrollWidth` = 1440 = viewport)
- Modal/child overflow: none
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (10/10 strings verbatim, unchanged from iteration 1)

**Step 1 verdict: FAIL** (1 P2 — "Sign in" link style, newly surfaced/re-confirmed this pass)

---

# STEP 2 — "OTP verification"

## Modal/Card geometry
- Modal width: 480px ✓
- Modal height: 603px (unchanged from iteration 1)
- Content width: 400px ✓
- Viewport: 1440×900, ratio 33.3%
- Padding: 40px ✓
- Breathing room: 149px / ~148px

## Form control geometry
- Read-only email field: 400×56px, radius 5px ✓
- OTP slots ×6: **48×48px, radius 5px** — confirmed FIXED (was 15px in iteration 1; live `getComputedStyle` shows `border-radius: 5px` via `!rounded-[var(--radius-button)]` override)
- Primary CTA: 400×56px, radius 5px ✓
- Shared content width: yes

## A. VISUAL FIDELITY

### P1 (major)
- **DS Mapping Gate violation:** "Back to sign up" no longer renders through the DS `InlineLink.tsx` atom — it is now a hand-rolled `<button>` with inline red Tailwind classes. The spec explicitly maps this control to `atoms/InlineLink.tsx`. Bypassing a mapped DS component with custom markup is an automatic P1 per the QA gate, independent of the color question below.
- **"Back to sign up" is now the wrong color.** Reference shows this specific link as plain gray/black text, no underline — a deliberately muted "back" affordance distinct from every other (red) link in the flow. It now renders solid brand-red `rgb(176,31,36)`, no underline. This is a new regression, not the same bug as iteration 1's (which was black+underline) — it swapped one mismatch for another. **Correction: revert color to a muted ink token (e.g. `--semantic-ink-muted`/gray-black), keep no-underline, and do this via a real `InlineLink` variant rather than a custom element.**

### P2
- None additional this step (OTP radius fix confirmed correct; "Change"/"Didn't receive it?" unchanged and still correctly red/no-underline).

## B. DESIGN SYSTEM COMPLIANCE — FAIL
- Actual components used: `Input` (disabled/readOnly), `InputOTP`/`InputOTPSlot` (6 individually-bordered, radius-overridden slots — confirmed correct), `Button`, `InlineLink` (×2: "Change", "Didn't receive it?" — still real component)
- Actual tokens used: `--color-brand-red` (active OTP slot border), `--radius-button` (OTP slots + email field), `--radius-card`, `--button-height-lg`
- Custom CSS exceptions: OTP per-slot border/radius override (disclosed, acceptable per spec)
- **Any mapped DS component approximated with custom CSS: YES — "Back to sign up" (see P1 above). FAIL.**

## C. INTERACTION / UX — PASS
- OTP: typed "274912" digit-by-digit, fills correctly, active-slot red border tracks correctly
- "Change"/"Didn't receive it?": present, correctly styled, functional
- Keyboard/focus: OTP autofocus/advance works
- Buttons: default/hover consistent

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none
- Horizontal overflow: none
- Modal/child overflow: none
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (10/10 strings verbatim, including correct dynamic masked-email interpolation)

**Step 2 verdict: FAIL** (1 P1 — DS Mapping Gate violation on "Back to sign up"; same item also wrong color)

---

# STEP 3 — "Complete profile"

## Modal/Card geometry
- Modal width: 480px ✓
- Modal height: **817px** (was 829px in iteration 1 — confirmed 12px trim as claimed)
- Content width: 400px ✓
- Viewport: 1440×900, ratio 33.3%
- Padding: 40px ✓
- Top/bottom breathing room: **41px / 42px** (was 35px/35px — confirmed improvement, though still below the ~75px target)
- Internal headroom to `max-h-[calc(100vh-4rem)]` ceiling (836px): **19px** (was 7px — meaningfully safer, though still the tightest of the 4 steps)

## Form control geometry
- Full name input: 400×56px, radius 5px ✓
- Phone country-code select: **92×56px**, radius 5px — confirmed FIXED (was 92×36px in iteration 1; live measurement shows `SelectTrigger` now matches the row height)
- Phone number input: 300×56px, radius 5px ✓
- Company name input: 400×56px, radius 5px ✓
- Primary CTA: 400×56px, radius 5px ✓
- Phone select+input pair: 92+300=392px (≈400px column, consistent with spec's "pair together" allowance)

## A. VISUAL FIDELITY

### P1 (major)
- **DS Mapping Gate violation:** "Terms of Use" and "Privacy Policy" no longer render through `atoms/InlineLink.tsx` — both are now custom-styled elements per the builder's own disclosure and consistent with the "Browse reports" pattern confirmed via DOM inspection (see cross-step root-cause section above). Visually correct now, but violates the spec's explicit component mapping. **FAIL** per the "mapped DS component approximated with custom CSS" rule, regardless of visual correctness.

### P2
- **Footer "Sign in" still renders black + underlined** (`rgb(0,0,0)`, underline), confirmed via live query at the modal's footer position (`x:794,y:795`). Reference shows solid red, no underline. Unaddressed this iteration — same defect as Step 1's "Sign in," not touched by this pass's fix set.

### P3
- Modal breathing room (41/42px) and internal headroom (19px) meaningfully improved from iteration 1 (35px/7px) but still short of the ~75px target and the tightest of the 4 steps. Non-blocking — no overflow/clipping observed, correction is a further optional trim, not a defect.

## B. DESIGN SYSTEM COMPLIANCE — FAIL
- Actual components used: `Badge` ("Email verified" pill), `Input` ×3, `Select`/`SelectTrigger`/`SelectContent`/`SelectItem` (country code — now correctly 56px, confirmed fixed), `Checkbox`, `Button`
- Actual tokens used: `--color-brand-red` (checkbox checked state — confirmed fixed, see below), `--radius-button`, `--radius-card`, success-pill tokens
- **Checkbox checked-state color: confirmed FIXED.** Live query on click: `background-color: rgb(176,31,36)`, `border-color: rgb(176,31,36)` — brand-red, matching reference. Root cause (missing `--primary` token mapping) resolved as claimed.
- Custom CSS exceptions: OTP-equivalent none needed here
- **Any mapped DS component approximated with custom CSS: YES — "Terms of Use" / "Privacy Policy" (see P1 above). FAIL.**

## C. INTERACTION / UX — PASS
- Full name / Phone / Company inputs: typed and filled correctly
- Select: opens correctly, fully visible above modal content (white background, `z-[110]` fix confirmed still working), all 5 options legible, clicking updates trigger and closes cleanly
- Checkbox: click toggles to checked state correctly, color now brand-red (confirmed above)
- **Escape-key fix: confirmed working exactly as designed.** With the Select dropdown open, first `Escape` closed only the dropdown — modal remained open, checkbox state and typed field values were preserved. A second `Escape` (with dropdown already closed) then closed the whole modal. This matches the intended fix precisely — reproduced live, not just visually inspected.

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none across the full interaction sequence (typing, Select open/close, checkbox toggle, Escape ×2)
- Horizontal overflow: none
- Modal/child overflow: none (19px headroom remains, no clipping observed)
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (12/12 strings verbatim)

**Step 3 verdict: FAIL** (1 P1 — DS Mapping Gate violation on Terms of Use/Privacy Policy; 1 P2 — footer "Sign in" still wrong; 1 P3 — geometry margin still tight but much improved)

---

# STEP 4 — "Success"

## Modal/Card geometry
- Modal width: 480px ✓
- Modal height: 530px (unchanged from iteration 1)
- Content width: 400px ✓
- Viewport: 1440×900, ratio 33.3%
- Padding: 40px ✓
- Breathing room: 185px / 185px — generous, unchanged

## Form control geometry
No form inputs. Primary CTA "Continue browsing": 400×56px, radius 5px ✓, DS component confirmed: yes.

## A. VISUAL FIDELITY

### P1 (major)
- **DS Mapping Gate violation:** "Browse reports" no longer renders through `atoms/InlineLink.tsx`. Confirmed via live DOM inspection: `tagName: BUTTON`, `className: "text-[var(--color-brand-red)] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-red)] rounded"`, `href: null`. This is now visually correct (solid red, no underline, matches reference) but is a hand-rolled element, not the mapped DS component. **FAIL** per the DS Mapping Gate rule — component identity matters independent of visual outcome.

### P2 / P3
- None — visual match to reference is otherwise clean (center-alignment, info panel, sparkle-accent omission all correctly handled, consistent with iteration 1).

## B. DESIGN SYSTEM COMPLIANCE — FAIL
- Actual components used: `Button` (Continue browsing), plain composed info-panel container (per spec's compose-from-primitives guidance, unchanged/correct)
- Actual tokens used: success-status tokens, `--color-ramp-black-50`, `--radius-button`, `--radius-card`
- **Any mapped DS component approximated with custom CSS: YES — "Browse reports" (see P1 above). FAIL.**

## C. INTERACTION / UX — PASS
- Info panel correctly wired to real typed state (Name "Nirvair Singh", Work email "jane@kenresearch.com", Account "Kenresearch account")
- Both CTAs present and functional

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none
- Horizontal overflow: none
- Modal/child overflow: none
- Viewport clipping: none
- Layout shift: none

## Copy Lock — PASS (6/6 strings verbatim; panel values correctly reflect real flow state)

**Step 4 verdict: FAIL** (1 P1 — DS Mapping Gate violation on "Browse reports")

---

## Confirmed fixed from iteration 1 (do not re-flag)

1. **Step 3 Select/Input height mismatch (P1):** confirmed fixed — both now 56px.
2. **Step 2 OTP slot radius (P2):** confirmed fixed — now 5px, was 15px.
3. **Step 3 checkbox checked-color (P2):** confirmed fixed — now brand-red `rgb(176,31,36)`.
4. **Step 3 geometry margin (P2):** confirmed improved — 41px/42px breathing room (was 35px/35px), 19px internal headroom to max-height (was 7px). Still tighter than the ~75px target; downgraded to P3, non-blocking.
5. **Step 3 Escape-key bug (P2):** confirmed fixed — reproduced live: first Escape closes only the open Select, second Escape closes the modal.

## New / re-surfaced findings this iteration

1. **P1 — DS Mapping Gate violation, 4 sites:** "Back to sign up" (Step 2), "Terms of Use" / "Privacy Policy" (Step 3), "Browse reports" (Step 4) are no longer the real `InlineLink.tsx` DS component — they are hand-rolled custom elements. This is an automatic P1 regardless of visual correctness.
2. **P1/regression — "Back to sign up" wrong color:** the reference shows this control as plain gray/black text, not red — the one deliberate outlier among all the flow's links. It now renders solid brand-red, which is a new mismatch (previous mismatch was underline, not color).
3. **P2 — Step 1 "Sign in" still black + underlined**, unaddressed this iteration, contradicting iteration 1's report which incorrectly called this a clean match.
4. **P2 — Step 3 footer "Sign in" still black + underlined**, same defect, also unaddressed.

**Root cause behind #1–4:** `InlineLink.tsx` has no variant for "solid red, no underline." The correct, DS-compliant fix is to add a real variant/prop to the component itself and apply it uniformly to the 5 call sites that need it ("Sign in" ×2, "Change", "Didn't receive it?", "Terms of Use", "Privacy Policy", "Browse reports" — note "Change"/"Didn't receive it?" already render this way, worth checking how, since they were never reported as bypassing InlineLink), while giving "Back to sign up" a distinct muted variant instead of red.

---

## Overall Verdict

| Step | Verdict | Blocking issues |
|---|---|---|
| Step 1 — Create account | **FAIL** | P2: "Sign in" link wrong style (black+underline vs. reference red+no-underline) |
| Step 2 — OTP verification | **FAIL** | P1: "Back to sign up" bypasses DS `InlineLink` (custom element) + wrong color (red vs. reference's muted gray) |
| Step 3 — Complete profile | **FAIL** | P1: "Terms of Use"/"Privacy Policy" bypass DS `InlineLink`; P2: footer "Sign in" wrong style; P3: geometry margin still tight (non-blocking) |
| Step 4 — Success | **FAIL** | P1: "Browse reports" bypasses DS `InlineLink` |

**OVERALL: FAIL** — 0 P1/P2 remaining is required for PASS; this pass still has 3 P1s (DS Mapping Gate violations, all traceable to the same root cause) and 3 P2s (2 "Sign in" instances still wrong, "Back to sign up" now wrong in a new way).

**Real progress this iteration:** 5 of iteration 1's 6 flagged items are now fully and correctly resolved (Select/Input height, OTP radius, checkbox color, geometry trim, Escape-key bug) — confirmed via live measurement/interaction, not just visual impression. The remaining work is now narrowly scoped to a single root cause (`InlineLink.tsx` missing a real variant prop) rather than 4 unrelated one-off issues, which should make iteration 3 a smaller, more mechanical fix than iterations 1→2 required.

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/measurement only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes (not separately invoked this pass beyond what iteration 1 already covered; no new advisory notes altered any finding's severity)
- Confidence in measurements: high — all geometry, color, and DS-component-identity findings were pulled via live `getComputedStyle`/`getBoundingClientRect`/DOM `tagName`/`className` queries against the running app; reference link styles were confirmed via pixel-cropped, 4×-zoomed image crops (not eyeballed at thumbnail resolution), directly resolving the ambiguity flagged in this iteration's task brief.
