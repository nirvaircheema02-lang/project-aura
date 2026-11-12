# Loop QA Report — Signup — Email (`signup-email`)

**Iteration:** 2
**Date:** 2026-08-21
**Viewport tested:** 1440×900
**Render URL:** http://localhost:3091 (Next.js dev, `projects/ken-auth-redesign/builds/`)
**Reference:** Figma `PJtPivOzEkiTjSkGnZ2YtH`, node `559:105` (flat raster, 1122×1402px), re-fetched live this cycle via `get_screenshot` at `maxDimension:1400` (1121×1400px returned).
**Spec:** `projects/ken-auth-redesign/specs/signup-email.spec.md`
**Prior report:** `signup-email.report.iter1.md` (FAIL — 2 P1: button shimmer overflow bleed, email input zero border in every state).

> Note on file provenance: this report file already contained unrelated stale content (describing a completely different set of claimed fixes — modal resize 460→640px, heading serif→sans, etc. — that do not match this cycle's actual claim from `loop-builder` about `overflow-hidden`/`@source` and input borders). That content was **not** produced by this QA pass, is inconsistent with the actual iter1 report and actual rendered DOM, and was discarded rather than trusted. Everything below is from live, independent verification against the current render.

---

## 1. Verification of `loop-builder`'s iteration-2 claim

Claim: added an `@source` directive in this project's `globals.css` pointing Tailwind's real content scanner at the DS source (`design-system/core-v2/src/**`), replacing the incomplete regex-generated safelist. Claims both P1s from iter1 are fixed, and a sample spot-check of other DS classes found no further gaps.

### 1a. Button `overflow: hidden` + shimmer clipping

- `getComputedStyle(button).overflow` = **`"hidden"`** on both CTA buttons (confirmed live, not inferred from className string). `overflowX` also `"hidden"`.
- Shimmer child `<div>` still has its own unclipped bounding rect (`w-[200%]`, e.g. primary button shimmer `rectRight: 1584` vs. button `rectRight: 1008`) — this is **expected and correct**: `getBoundingClientRect()` on a child reports its own box regardless of a parent's `overflow:hidden`; clipping is a paint-time effect, not a geometry change. Verified the actual paint result instead of relying on the rect number:
  - Full-page screenshot at rest: clean button/card edges, no red or white shimmer bleed onto the gray scrim.
  - Full-page screenshot with mouse hovered over the primary button (shimmer sweep actively animating): shimmer highlight visibly stays contained inside the button's rounded-rect boundary, no bleed past button or card edge.
  - `document.documentElement.scrollWidth` / `window.innerWidth` both `1440` at rest and during hover — no horizontal overflow introduced anywhere on the page.
- **Confirmed fixed.** Not taken on faith — verified via computed style + two live screenshots (rest and hover-animating).

### 1b. Email input border

- Live computed style on `#work-email` at rest: `border-width: 1px`, `border-style: solid`, `border-color: oklab(0 0 0 / 0.1)` (i.e. real `border-black/10`, resolved to oklab by the browser — non-zero, visually a light gray hairline, matches source and matches the reference screenshot). Visually confirmed in screenshot: a clear thin border around the input.
- On focus (clicked into field, confirmed `document.activeElement === input`): `border-width: 1px`, `border-color: oklab(0 0 0 / 0.9)` — border darkens to near-black, exactly matching `Input.tsx`'s `focus:border-black/90` source. A `2px` red focus-visible outline is also present (separate from border, expected/pre-existing, not a new discrepancy).
- **Confirmed fixed** at rest and on focus. Hover/Filled/Error/Disabled not independently re-tested this cycle (out of the two states explicitly named in the task), but since the root cause (missing compiled utility class) is now demonstrated to generate correctly for both `border-black/10` and `border-black/90`, and the `@source` fix is a scanner-level fix (not per-class), there's no structural reason to expect the remaining border-opacity variants to still be missing — flagged as reasonable inference, not independently re-verified pixel-by-pixel.

### 1c. Independent wider spot-check for the same class-dropping bug (systemic check, not just the 2 sampled classes)

Checked several additional DS-sourced utility classes/behaviors across the screen that were not part of loop-builder's stated sample list:

| Element | Utility/behavior checked | Result |
|---|---|---|
| Modal card | `rounded-[10px]`, `shadow-2xl`-equivalent box-shadow | Computed `border-radius: 10px`, real multi-layer `box-shadow` present (`0 25px 50px -12px rgba(0,0,0,.25)`) — both compile correctly |
| "OR" divider hairlines | `Divider variant="subtle"` (1px line, `--border-soft`/hairline token) | Both hairlines render at `height: 1px`, `background-color: rgba(0,0,0,0.08)` — compiles and renders, no missing utility |
| Close icon | `lucide-react` `X`, `w-6 h-6` sizing inside a larger hit-target button | SVG renders at `24×24`, positioned top-right inset from card edge as expected — no missing-class symptom (e.g. icon collapsing to 0×0, which is the typical symptom of a dropped Tailwind size utility) |
| Input focus ring | `outline`/focus-visible ring color token | `outline: rgb(176, 31, 36) none 2px` present and applying the brand-red token correctly |
| LinkedIn button hover | `hover:border-[var(--brand-red)]`, `hover:text-[var(--brand-red)]` (arbitrary-value hover utilities — same general class of utility as the ones that broke) | Confirmed live via mouse hover + screenshot: border and text both transition to brand red, contained cleanly inside the button box, no bleed |
| Page-level scroll | any horizontal overflow at rest or during animated states | `scrollWidth === innerWidth === 1440px` in both rest and hover-animating states |

No further instances of the class-dropping bug were found in this spot-check. This is still a sample, not an exhaustive audit of every DS utility class used on the screen, but it specifically targeted arbitrary-value and opacity-modifier utilities (`border-[var(--brand-red)]`, `rounded-[10px]`, `w-6 h-6`, hairline background tokens) — the same *category* of class that broke originally — and all resolved correctly. Confidence that the `@source` fix is structural (not a second incomplete safelist) is medium-high based on this evidence.

---

## 2. Full re-run of comparison checklist

| Aspect | Reference | Render | Verdict |
|---|---|---|---|
| Composition | Centered white card modal over dimmed marketing page, no blur artifact | Same | Match |
| Modal width | ~630px of 1122px frame (estimated) | 640px (`max-w-[640px]`) | Close match, within estimation noise (unchanged from iter1) |
| Modal height (proportion) | Tall relative to width | 548px measured — still visibly more compact than reference's proportions | **Uncertainty #E-linked, carried, not new** (see §3) |
| Position | Centered horizontally + vertically in viewport | Same (card `left:400, right:1040` in a 1440px viewport — centered) | Match |
| Padding | ~32px top/sides | `padding: 32px` computed | Match |
| Vertical spacing (label→input, input→helper, button stack) | Estimated, proportional | Proportional, no new spacing regressions vs. iter1 | Match (unchanged) |
| Typography — eyebrow | ~12.8px, red, medium weight | `12.8px`, `rgb(176,31,36)`, `font-weight:500` | Match |
| Typography — heading | Bold sans, ~31px | `31.248px`, `DM Sans`, `weight:700` | Match |
| Typography — subcopy/label/helper | 16px body / token colors | `16px` across all three, correct tokenized colors | Match |
| Input dimensions | Visually taller (~48–54px estimated) | `height: 36px` (`h-9`, real `Input.tsx` default) | **Uncertainty #E — expected/tracked, not a new finding** (unchanged from iter1) |
| Button dimensions | Visually substantial CTA height | `height: 56px` (`--button-height-lg`) both buttons | Match, matches spec's `size="lg"` mapping |
| **Overflow** | N/A (reference is static) | **Both P1 overflow defects resolved** — `overflow:hidden` computes correctly, shimmer visually clipped at rest and mid-hover-animation, no page-level horizontal overflow | **Resolved** |
| Radius | Modal ~10px, input/buttons ~5px | Modal `10px`, input/buttons `5px` | Match |
| Divider ("OR") | Two hairlines flanking centered text | Same composition, hairlines render at `1px`/`rgba(0,0,0,0.08)`, no overflow past card | Match |
| Icon sizing | Close icon proportionate, LinkedIn glyph solid blue square | Close `24×24` lucide X; LinkedIn glyph `20×20`, solid blue square with white "in" | Match |
| Link styling ("Sign in") | Red text, reference shows no visible underline | Renders underlined red text (real `InlineLink.tsx` default) | **Uncertainty #D — pre-existing, disclosed in spec, not new** |
| Backdrop | Dimmed page, no blur | `rgba(0,0,0,0.5)` scrim, `backdrop-filter:none` | Match |
| DS states — Input hover/focus | Border color shifts on focus | Focus confirmed: border 1px → `black/90`; hover not independently re-tested this cycle (see §1b) | Match (focus), untested (hover) |
| DS states — Button hover (both) | N/A (reference static) | Primary: shimmer sweep animates, clipped correctly. LinkedIn: border+text → brand-red on hover, clipped correctly, no bleed | Match |
| DS states — InlineLink | N/A (reference static) | Real default underlined state renders per source | Match (matches source; conflicts with reference per Uncertainty #D, pre-existing) |

---

## 3. Uncertainty #E / modal-height proportion (carried, explicitly not a new finding per task instruction)

Per this cycle's explicit instruction, the input-height/button-sizing gap vs. the reference (input `36px` vs. reference's visually taller ~48–54px estimate, and the resulting shorter overall modal height/proportion) is tracked as spec **Uncertainty #E** — an open, disclosed spec question (compact reusable `ui/input.tsx` vs. a taller hand-rolled field), not attributable to this iteration's builder work and not to be force-matched via an override. Reported here for completeness, **not counted toward this iteration's P1/P2 pass/fail tally** per the task's framing — it is unchanged from iteration 1 and is a pending product/design decision, not a regression or a newly discovered defect.

---

## 4. Copy Lock re-verification

Re-checked all 11 Copy Lock strings against live `main` text content this cycle:

`GET STARTED` · `Create your account` · `Use your work email to create your Ken Research account.` · `Work email` · `name@company.com` (placeholder) · `Use your professional email address.` · `Continue with work email` · `OR` · `Continue with LinkedIn` · `Already have an account?` · `Sign in`

All 11 match byte-for-byte, no regressions. **Copy Lock: 0 discrepancies**, unchanged from iter1.

---

## 5. Discrepancy classification

### P1 (major)
(none — both P1s from iteration 1 confirmed fixed via live computed style + visual screenshot verification, at rest and during animated/hover states)

### P2 (noticeable)
(none newly identified this cycle; the modal-proportion/input-height gap is intentionally excluded from this tally as Uncertainty #E per task framing, §3)

### P3 (finishing/detail)
1. **Input hover/filled/error/disabled border states not independently re-verified this cycle** — only rest and focus were live-tested. Given the fix is scanner-level (`@source`) rather than per-class, low risk, but flagging as an open verification gap for a future pass rather than asserting a false "all states confirmed."
2. **"Sign in" InlineLink underline** and **LinkedIn hover-to-brand-red** both continue to render as real, unmodified DS default behavior, conflicting with the reference's apparent static/neutral look — both already tracked as spec Uncertainties #C/#D, not new, restated for completeness only.

---

## Overall

**0 Copy Lock violations. Both P1s from iteration 1 (button shimmer overflow, input zero-border) independently confirmed fixed** — verified live via `getComputedStyle` (not the className string) and via screenshots at rest and during active hover/shimmer animation, not just a static state. Root-cause fix (`@source` directive) spot-checked against 5 additional DS utility classes/behaviors outside loop-builder's own sample (modal radius/shadow, divider hairlines, icon sizing, focus ring, LinkedIn hover) — no further instances of the class-dropping bug found. No new P1/P2 introduced. The only remaining open item (modal-height/input-height proportion) is the pre-existing, explicitly-tracked Uncertainty #E, not counted against this iteration.

**Verdict: PASS** (0 P1, 0 P2 — Uncertainty #E tracked separately per task framing, not as a blocking P2).
