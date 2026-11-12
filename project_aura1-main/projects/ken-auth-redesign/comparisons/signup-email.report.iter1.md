# Loop QA Report — Signup — Email (`signup-email`)

**Iteration:** 1 (restarted numbering under strengthened Loop rules — this file replaces the prior iter1 that existed under the old rules; overwritten per task instruction)
**Date:** 2026-08-21
**Viewport tested:** 1440×900
**Render URL:** http://localhost:3091 (Next.js dev, `projects/ken-auth-redesign/builds/`)
**Reference:** Figma `PJtPivOzEkiTjSkGnZ2YtH`, node `559:105` (flat raster, 1122×1402px), re-fetched live via Figma MCP this cycle at `maxDimension:1400` (1121×1400px returned) — matches spec's transcription.
**Spec:** `projects/ken-auth-redesign/specs/signup-email.spec.md` (Copy Lock + DS Mapping Gate revision)

---

## 1. Render safety checks

- **Console:** clean. Only React DevTools banner + `[HMR] connected` info logs. No errors/warnings.
- **Page-level horizontal overflow:** none at 1440×900 (`document.documentElement.scrollWidth === window.innerWidth === 1440`).
- **Element-level overflow — CONFIRMED, contradicts builder's claim.** Builder's note said the DS `Button`'s internal shimmer-sweep divs (`w-[200%]`) are "clipped by `overflow-hidden`". This was checked directly, not taken on faith, and **the claim is false**:
  - Both CTA buttons ("Continue with work email" and "Continue with LinkedIn") render a shimmer `<div>` at `w-[200%]` of the button. Measured via `getBoundingClientRect()`: button right edge = 1008px, shimmer div right edge = **1584px/1580px** — extending ~540–576px past the button and ~544–568px past the modal card's right edge (card right = 1040px).
  - `getComputedStyle(button).overflow` = **`"visible"`**, not `"hidden"`, despite `overflow-hidden` being present in the button's `className` string.
  - Root cause confirmed by inspecting the compiled CSS: `overflow-hidden` does not exist anywhere in the project's generated stylesheet (`grep` across all `.next` chunks and `design-system/core-v2/src/styles/_safelist.generated.css` returns zero matches). The utility was never generated for this consumer project.
  - Visually confirmed in the rendered screenshot: a red bleed past the primary button's right edge and a lighter shimmer bleed past the LinkedIn button's right edge, both spilling from the white card onto the gray scrim.
  - **Classification: P1** (render-safety default per instructions — "any element overflowing its parent/container" / "any overflow = automatic P1").

- **New, more severe instance of the same root-cause category, not previously disclosed by `loop-builder`:** the email `Input`'s entire border system is non-functional.
  - `Input.tsx` source specifies `border border-black/10` (default), `hover:border-black/25`, `focus:border-black/90`, `aria-invalid:border-[var(--brand-red)]`, `disabled:border-black/6`.
  - Live computed style on `#work-email` at rest: **`border-width: 0px`**, `border-color: rgb(0,0,0)` (browser initial value, i.e. no border-color utility applied either).
  - Confirmed via source-level grep of the compiled CSS (`[root-of-the-server]__0w_vlg7._.css`, `globals_css...single.css`): none of `border-black/10`, `border-black/25`, `border-black/15`, `border-black/6`, `border-black/90`, or even the bare `.border{...}` utility exist anywhere in the compiled output. `overflow-hidden` fails for the identical reason.
  - Net effect: the input renders with **no visible border in any state** — Default/Hover/Focus/Filled/Error/Disabled are all silently broken, not merely "approximated." This is the same Tailwind v4 content-scan/safelist gap the builder already flagged for `ui/dialog.tsx` (files under `design-system/core-v2/src/` aren't reached by this project's content scan, and the generated safelist doesn't cover these specific arbitrary-opacity/border utilities) — except this instance is in the **shipped, active** implementation, not an abandoned attempt, and was not disclosed.
  - **Classification: P1.** The DS Mapping Gate is satisfied at the "correct component imported" level but fails at the "renders with real DS visual behavior" level for this element — a build-infra defect masquerading as a passing fidelity check.

---

## 2. Reference vs. render — visual comparison

Reference (Figma node `559:105`, saved to scratchpad as `reference.png`) vs. rendered build screenshot at 1440×900 (both captured this session).

| Aspect | Reference | Render | Verdict |
|---|---|---|---|
| Modal shape | White card, rounded corners, centered, drop shadow, dim scrim, no visible blur artifact | Same — `border-radius:10px`, `box-shadow` (shadow-2xl-equivalent), scrim `rgba(0,0,0,0.5)`, `backdrop-filter:none` | Match |
| Modal width | ~56% of a ~1122px-wide frame (≈630px estimated, scaling assumption) | 640px (`max-w-[640px]`) | Close match — within estimation noise |
| Modal height (proportion) | Tall relative to width — modal reads notably taller/roomier | 548px measured at card level — visually more compact/shorter than reference's proportions | **P2** — see below |
| Input border | Clearly visible ~1px gray-black border, full height ~50px+ | **No border rendered at all** (see §1) | **P1** (render defect, already counted above) |
| Input height | Visually taller than 36px (roughly matches a ~48–54px field) | 36px (`h-9`, real `Input.tsx` default — per spec Uncertainty #E, builder deliberately did not override) | **P2** — legitimate open spec question (Uncertainty #E), not a bug; still a measurable, reportable fidelity gap: input ~14–18px shorter than reference |
| Primary button fill | Flat solid red, no visible gradient (static image only shows default/no-motion state) | Real DS gradient shimmer background (`--composition-gradient-brand-red-shimmer`) — visibly has a lighter-to-darker red gradient left→right | **P3** — real, undisclosed-but-correct DS behavior; reference is a flat image that can't show the DS's always-on shimmer treatment, so this is not a fixable mismatch, just a noted difference |
| "Sign in" underline | No visible underline, red text | Underlined (red decoration), per `InlineLink.tsx`'s real default state | Already flagged in spec as **Uncertainty #D**, not new — no additional classification beyond spec's own flag |
| LinkedIn button hover | Not shown in reference (flat image, default-only) | Hover confirmed live: border + text transition to brand-red (`var(--color-brand-red)`), matching `Button.tsx` secondary/light source exactly, no override present | Confirmed correct per spec's Uncertainty #C — DS's real, unmodified behavior, as builder claimed |
| Divider ("OR") | Two thin hairlines flanking centered "OR" text, roughly even split | Same composition via `Divider variant="subtle"` ×2 + centered span; divider wrapper itself does NOT overflow the card (measured right edge 1008px vs. card 1040px) | Match |
| Corner radii | Modal ~10px-looking, input/buttons ~5px-looking | Modal 10px, input 5px (radius itself renders fine — only border-width failed), buttons `--radius-button` | Match |

---

## 3. Copy Lock verification

Every Copy Lock string checked against the live DOM text content, byte-for-byte:

| # | Spec (verbatim) | Rendered | Result |
|---|---|---|---|
| 1 | `GET STARTED` | `GET STARTED` | ✅ Match |
| 2 | `Create your account` | `Create your account` | ✅ Match |
| 3 | `Use your work email to create your Ken Research account.` | `Use your work email to create your Ken Research account.` | ✅ Match |
| 4 | `Work email` | `Work email` | ✅ Match |
| 5 | `name@company.com` | `name@company.com` (placeholder) | ✅ Match |
| 6 | `Use your professional email address.` | `Use your professional email address.` | ✅ Match |
| 7 | `Continue with work email` | `Continue with work email` | ✅ Match |
| 8 | `OR` | `OR` | ✅ Match |
| 9 | `Continue with LinkedIn` | `Continue with LinkedIn` | ✅ Match |
| 10 | `Already have an account?` | `Already have an account?` | ✅ Match |
| 11 | `Sign in` | `Sign in` | ✅ Match |

All of `loop-builder`'s claimed fixes (eyebrow casing, subcopy, helper text, "OR" casing) verified landed correctly. **Copy Lock: 0 discrepancies.**

---

## 4. DS Mapping Gate verification

Checked actual imports in `src/components/screens/SignupEmail.tsx` and `src/components/AuthModal.tsx` against the spec's mapping table, and read each cited DS source file directly (not doc comments only).

| Element | Spec mapping | Confirmed in source? |
|---|---|---|
| Modal shell | `ContactModal.tsx`-styled hand-rolled shell (Uncertainty #A) | ✅ `AuthModal.tsx` uses real class values matching `ContactModal.tsx`'s pattern (`rounded-[var(--radius-card)]`, `shadow-2xl`, close `top-4 right-4 w-11 h-11`). Deviates from both named candidates on **width** (`max-w-[640px]`, neither `ContactModal`'s `500px` nor `dialog.tsx`'s `512px`) and **blur** (no `backdrop-blur-sm`, unlike `ContactModal.tsx`). Documented in-file as a deliberate carry-over from a prior QA convergence measurement — flag as **P3** (undocumented-to-QA-until-now shell divergence, not a fabricated component). |
| Eyebrow/Heading/Subcopy/Label/Helper | Typography tokens only | ✅ Uses `var(--typography-size-xs/sm/xl)`, `var(--typography-family-body)`, `var(--semantic-ink-subtle)` — confirmed real token names exist in `tokens.css` (no invented `--text-*` fallbacks from prior revision). |
| Email input | `ui/input.tsx` `Input` | ✅ Imported from `@kenresearch/design-system/ui/input`, no wrapper `className` override, no height/padding override. Confirmed via source read. **However its border utilities fail to compile — see §1 P1.** |
| Primary button | `atoms/Button.tsx` `variant="brand" size="lg" fullWidth` | ✅ Exact props used, no override className. Shimmer overflow bug (§1) is a build-infra defect, not a mapping violation. |
| Secondary/LinkedIn button | `atoms/Button.tsx` `variant="secondary" background="light" icon iconPosition="left" fullWidth` | ✅ Exact props used, confirmed **no custom CSS override remains** — grep of `SignupEmail.tsx` shows zero `<style jsx>` blocks and zero override classNames on this button (prior iterations' hack is gone). Live hover test confirms real DS hover-to-brand-red behavior (text + border → `var(--color-brand-red)`), matching `Button.tsx` source lines ~281-320. Builder's claim verified true. |
| "OR" divider | `atoms/Divider.tsx` `variant="subtle"` ×2 + `<span>` | ✅ Confirmed real `Divider` import used twice, flanking a plain `<span>`. |
| "Sign in" link | `atoms/InlineLink.tsx` | ✅ Confirmed **zero className override** — `getComputedStyle` shows the link's own default classes verbatim (`underline decoration-[var(--color-brand-red)] decoration-1 underline-offset-2`, `hover:text-[var(--color-brand-red)] hover:bg-...`) with computed `text-decoration-line: underline`, `text-decoration-color: rgb(176,31,36)`. Builder's claim verified true — this is the DS's real, unmodified default state, exactly matching source. The underline-vs.-reference conflict is the pre-existing Uncertainty #D, not a new issue. |
| Close control | `lucide-react X` | ✅ `<X className="w-6 h-6" />` inside a real `<button>` with `top-4 right-4`. |
| LinkedIn glyph | No DS token, flagged gap | ✅ Custom `LinkedInGlyph.tsx` icon component used, consistent with spec's disclosed "no DS equivalent" gap — not silently approximated, matches spec's accepted resolution. |

**DS Mapping Gate: mapping itself is satisfied (real imports, no fabricated components), but two of the mapped components (`Input`, `Button`'s `overflow-hidden`) do not visually render their real DS behavior due to a Tailwind compilation gap — see §1. This is graded as failing the *spirit* of the Mapping Gate even though the *letter* (correct imports) is satisfied.**

---

## 5. DS state QA (exercised live via browser automation)

| Component | State | Result |
|---|---|---|
| Input | Default | Renders text/placeholder correctly; **border invisible** (0px width) — P1, see §1 |
| Input | Focus (clicked into field) | `document.activeElement` confirms focus; `outline: rgb(176,31,36) none 2px` present (focus-visible ring color token applied) but **no border-color change visible** since border-width is 0 — same root defect |
| Input | Hover/Filled/Error/Disabled | Not independently re-tested (all share the same broken `border-black/*` utility root cause already confirmed for Default/Focus) |
| Primary button | Rest | Renders with brand-red shimmer gradient fill, white text — correct per `Button.tsx` `variant="brand"` |
| Primary button | Shimmer overflow | **Overflows card boundary** — P1, see §1 |
| Secondary/LinkedIn button | Rest | Border `rgba(0,0,0,0.12)`-equivalent, text ~70% black — matches source |
| Secondary/LinkedIn button | Hover | Confirmed live: text + border transition to brand-red, exactly matching `Button.tsx` source — no override, correct |
| InlineLink ("Sign in") | Rest | Confirmed red underline present, matching real `InlineLink.tsx` default (no override) |

---

## 6. Discrepancy classification

### P1 (major)
1. **Button shimmer-sweep overflow (both CTAs).** `overflow-hidden` utility does not exist in the compiled CSS (confirmed via `getComputedStyle` = `visible` and zero matches across all `.next` CSS chunks + the DS safelist). The `w-[200%]` shimmer div visibly bleeds ~540–570px past the button/card edge onto the scrim. Builder's claim that this is "clipped" is **incorrect** — verified false, not taken on faith. **Fix direction:** either extend the project's Tailwind content-scan globs to include `design-system/core-v2/src/**/*.{ts,tsx}`, or add `overflow-hidden` (and the other missing utilities below) to `_safelist.generated.css`.
2. **Email input renders with zero border in every state.** `border-black/10`, `/25`, `/15`, `/6`, `/90`, and even the bare `.border{...}` utility are entirely absent from the compiled CSS. Computed `border-width: 0px` confirmed live at rest and on focus. This silently breaks the "real 6-state border system" the spec and DS Mapping Gate credit the build for — none of those states are actually visible to a user. Same root cause as Discrepancy #1 and the previously-disclosed `dialog.tsx` issue, but this instance is in the **active, shipped** component and was **not** disclosed by `loop-builder`. **Fix direction:** same as #1.

### P2 (noticeable)
1. **Input height ~14–18px shorter than reference.** Real `Input.tsx` default (`h-9`, 36px) vs. reference's visually taller field (~50–54px estimated). This is spec Uncertainty #E, explicitly not to be force-matched with an override per this cycle's instructions — reported as a legitimate open discrepancy, not attributed to builder error.
2. **Modal proportions read shorter/more compact than the reference's taller silhouette**, even accounting for the modal-width match — likely a compounding effect of the shorter input, smaller vertical spacing between blocks, and/or button padding vs. the reference's roomier vertical rhythm. All spacing values in the spec are explicitly flagged "estimated" (Uncertainty #H); this is the first-pass QA convergence read on that estimate, not a hard-blocking defect.
3. **Modal shell width (640px) and absence of `backdrop-blur-sm`** diverge from both named candidate shells in the spec (`ContactModal.tsx` 500px+blur, `dialog.tsx` 512px+no blur). The in-file comment discloses this was carried over from a prior iteration's convergence measurement, but it wasn't called out in this cycle's builder note to QA — flagging so the choice is made deliberately rather than by accretion.

### P3 (finishing/detail)
1. **Primary button shows the DS's real always-on gradient shimmer fill**, which the flat reference image (showing only a static default state) cannot depict. This is correct, undisclosed-but-real DS behavior — noting for awareness, not requesting a change.
2. **"Sign in" InlineLink underline** and **LinkedIn button hover-to-brand-red** both confirmed as real, unmodified DS behavior conflicting with the reference's apparent static/neutral look — both already tracked as spec Uncertainties #D/#C, not new findings; restated here only to confirm they render as claimed.

---

## Overall

**0 Copy Lock violations. DS Mapping Gate: imports correct, but 2 confirmed P1 render defects (Input border, Button overflow) caused by a Tailwind v4 content-scan/safelist gap between this project and `design-system/core-v2`, undisclosed for the Input case.** Under the strengthened rule (PASS requires 0 P1 AND 0 P2 simultaneously) this iteration fails on both counts.
