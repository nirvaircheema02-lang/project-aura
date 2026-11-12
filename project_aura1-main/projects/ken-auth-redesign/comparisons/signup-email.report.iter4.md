# Visual QA Report — Signup — Email (`signup-email`) · Iteration 4 (FINAL)

**Reference:** Figma frame, file `PJtPivOzEkiTjSkGnZ2YtH`, node `559:105` (flat raster image, 1122×1402px native)
**Implementation:** http://localhost:3091/ (Next.js, `projects/ken-auth-redesign/builds/`), captured at 1280×720 viewport
**Spec:** `projects/ken-auth-redesign/specs/signup-email.spec.md`
**Prior report:** `signup-email.report.iter3.md` (FAIL — 1 P2: LinkedIn shimmer override dead due to unspaced attribute-selector substring vs. the DS's space-serialized inline style)
**Note:** This is iteration 4, the final allowed visual iteration per the Loop workflow's 4-iteration cap.

## Method
- Read `projects/ken-auth-redesign/builds/src/components/screens/SignupEmail.tsx` (the claimed fix) and the shared DS `design-system/core-v2/src/atoms/Button.tsx` (lines ~300-425) to verify the new structural selector's premise against the actual component source, not just runtime output.
- Live browser session against the running build (Browser tooling, real DOM), not screenshots-only comparison.
- Hover triggered via synthetic `mouseenter` dispatch (to fire the DS's React `isHovering` state, which drives the shimmer's inline-style color) plus a physical cursor hover, then re-queried computed styles on the shimmer `<div>`.
- Reference re-confirmed via Figma `get_screenshot` (node `559:105`) at 1400px max dimension, compared against a fresh 800×450 implementation screenshot.

## Verification of loop-builder's iteration-4 claimed fix

**Claim:** dropped the iter3 attribute-selector approach entirely; now targets the shimmer `<div>` structurally via `:global(.linkedin-neutral-shimmer div.absolute.inset-0.pointer-events-none)`, reasoning that for `variant="secondary"` the DS's `shimmerLayer` value is `''` (empty — only `brand`/`primary`/`ghost` get a `shimmerLayer` class), so the *only* child div matching `.absolute.inset-0.pointer-events-none` inside a secondary-variant button is the secondary-shimmer div at `Button.tsx` L406-425, not the (non-existent, for this variant) shimmerLayer div at L391-401.

**Source-level check (`Button.tsx`):**
- L323-337 (`shimmerLayer` computation): confirmed `variant === 'secondary'` falls through to `return ''` — no shimmerLayer class assigned, so the L391 conditional div (`{shimmerLayer && (...)}`) does not render for this button. This is the load-bearing premise of the iter4 fix and it holds.
- L406-425 (secondary-shimmer div): renders unconditionally for `variant === 'secondary'`, with classes `absolute inset-0 w-[200%] pointer-events-none transition-transform ease-out motion-reduce:transition-none` — matches the selector's `div.absolute.inset-0.pointer-events-none` requirement.
- L324-325 (brand-variant shimmerLayer div, used by the primary CTA): also carries `absolute inset-0 ... pointer-events-none` classes, so the selector *would* match it too if it were in scope — but the CSS rule is ancestor-scoped to `.linkedin-neutral-shimmer`, a class applied only to the LinkedIn button's own `className`, not the primary CTA's. No cross-contamination path exists.

**Live confirmation, LinkedIn button hovered (`isHovering` state forced via dispatched `mouseenter`):**
```
div.className   = "absolute inset-0 w-[200%] pointer-events-none transition-transform ease-out motion-reduce:transition-none -translate-x-1/2"
div inline style = "transition-duration: 700ms; background-image: linear-gradient(to right, transparent, rgba(176, 31, 36, 0.08), transparent);"
getComputedStyle(div).backgroundImage
  = "linear-gradient(90deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0))"
```
The DS still writes the red `rgba(176,31,36,0.08)` value into the inline `style` attribute (unchanged, out of Loop scope), but the scoped `!important` CSS override now actually fires and wins — the **computed** background is the neutral `rgba(0,0,0,0.05)` gray the fix intended, not Ken red. This is the correct outcome: fidelity is judged by rendered/computed state, and it now matches "brand-neutral" intent.

**Live confirmation, primary CTA hovered (regression guard):**
```
div.className = "absolute inset-0 w-[200%] transition-transform ease-out pointer-events-none motion-reduce:transition-none motion-reduce:transform-none bg-[image:var(--composition-gradient-brand-red-shimmer)] translate-x-0"
getComputedStyle(div).backgroundImage
  = "linear-gradient(90deg, rgb(176, 31, 36) 0%, rgb(235, 72, 78) 50%, rgb(176, 31, 36) 100%)"
```
Unchanged, still brand-red, matches reference intent. **No regression** — confirms the ancestor-scoping reasoning above held in practice, not just in theory.

**Result: FIXED.** Both the structural premise (source-level) and the rendered computed style (runtime) confirm the LinkedIn hover shimmer no longer bleeds Ken-red, and the primary CTA is unaffected.

## Full comparison checklist (final pass)

| Property | Reference | Implementation | Status |
|---|---|---|---|
| Composition (modal centered over dimmed page bg, LinkedIn logo left of label) | match | match | Match |
| Modal width | ~642px | 640px | Match (unchanged since iter1) |
| Modal padding | ~32px | 32px | Match |
| Modal radius | ~10px | 10px | Match |
| Modal shadow | soft elevated | `rgba(0,0,0,.25) 0 25px 50px -12px` | Match |
| Backdrop | dim only, no blur | `backdropFilter: none`, `rgba(0,0,0,0.5)` scrim | Match |
| Heading font/weight | bold sans | DM Sans, 700 | Match |
| Heading line-height | tight, single-line | 39.06px font / 62.49px line-height (~1.6 ratio) | Still loose (P3, unchanged, not in scope of iter4's fix) |
| Hierarchy (eyebrow → heading → subcopy → label → input → helper → CTA → divider → LinkedIn → footer) | this order | this order | Match |
| Input height/radius/border | ~62–64px, 5px, hairline | 64px, 5px, border present | Match |
| Input sizing (width) | full modal content width | 576px (640 − 2×32 padding) | Match |
| Primary button height/radius/fill | ~75–80px, 5px, flat red (static ref image) | 78px, 5px, red→light-red→red brand shimmer (pre-existing/accepted per iter1) | Match (non-issue) |
| LinkedIn button height/radius/default state | ~75–80px, 5px, neutral border/text/bg | 78px, 5px, neutral border (`1.5px solid rgba(0,0,0,0.2)`)/text/bg | Match |
| LinkedIn button hover state | brand-neutral intent (third-party CTA, not Ken-branded) | neutral gray shimmer, `rgba(0,0,0,0.05)` — **fixed this iteration** | **Match — resolved** |
| Icons — LinkedIn glyph | solid blue rounded-square, white "in" | solid blue rounded-square, white "in" | Match |
| Icons — close (×) | top-right, isolated | top-right, isolated | Match |
| Borders | hairline dividers, input border | present, unchanged | Match |
| Spacing (label→input, input→helper, helper→CTA, divider gaps) | proportional | proportional, unchanged since iter2 | Match |
| Alignment | left-aligned column | left | Match |
| Opacity/backdrop states | dim scrim only | scrim only, no blur | Match |
| Responsive behaviour | not called out as in-scope this pass | not re-tested (no viewport-size change requested this iteration) | N/A, unchanged scope |
| Component states (rest/hover/focus) | rest + hover shown in flat ref; focus not depicted | rest/hover both correct now; focus ring present via DS (`focus-visible:ring-2`) | Match |

## Discrepancy report

### P1 (major)
(none)

### P2 (noticeable)
(none — the sole carried-over P2 from iter2/iter3 is resolved this iteration)

### P3 (finishing/detail)
- **Heading line-height still loose**: 39.06px font / 62.49px line-height (~1.6 ratio), unchanged since iteration 1. Reference reads as a tight single-line heading (~1.1–1.2 ratio). Not part of any fix request in iterations 2-4; carried forward as a known, unresolved finishing item.
- **Copy length differs from reference**: implementation's subcopy/helper text ("Use your work email to get started. We'll verify your account and set up your workspace in a few seconds." / "Use your professional email address to verify your organization.") is longer than the reference's shorter strings ("Use your work email to create your Ken Research account." / "Use your professional email address."). Content difference, not a rendering defect; carried over from iteration 1, out of scope for a shimmer-selector fix.

## Non-findings (verified matches, no action needed)
- Modal width/height/padding/radius/shadow/backdrop — all match reference, no drift since iter3.
- Heading font family/weight, input sizing, both button heights/radii/borders — all match, no drift since iter3.
- LinkedIn hover shimmer — confirmed fixed both at the source level (`Button.tsx` shimmerLayer/secondary-shimmer structure) and at the live computed-style level.
- Primary CTA shimmer — confirmed still brand-red and structurally isolated from the LinkedIn-scoped override (ancestor-class scoping prevents cross-contamination even though both shimmer divs share the same utility classes).
- No new spacing/alignment/typography/icon regressions introduced by this iteration's change.

## Verdict
**PASS.** All P1 and P2 items are resolved. The iteration-4 fix works: dropping the fragile inline-style substring match in favor of a structurally-scoped selector (`.linkedin-neutral-shimmer div.absolute.inset-0.pointer-events-none`) correctly targets the DS's secondary-variant shimmer div — verified both by reading `Button.tsx`'s `shimmerLayer`/secondary-shimmer logic and by live computed-style inspection under real hover state. The primary CTA's brand-red shimmer is confirmed unaffected (no regression). Two P3 finishing items remain (heading line-height, subcopy length) — both pre-existing since iteration 1, neither part of the P1/P2 bug chain this loop was tracking, and neither blocks PASS at the final iteration. No other property has drifted since iteration 3.
