# Visual QA Report — Signup — Email (`signup-email`) · Iteration 3

**Reference:** Figma frame, file `PJtPivOzEkiTjSkGnZ2YtH`, node `559:105` (flat raster image, 1122×1402px native)
**Implementation:** http://localhost:3091/ (Next.js, `projects/ken-auth-redesign/builds/`), captured at 1280×720 viewport
**Spec:** `projects/ken-auth-redesign/specs/signup-email.spec.md`
**Prior report:** `signup-email.report.iter2.md` (FAIL — 1 P2: LinkedIn shimmer bled Ken-red)

## Method
- Live DOM computed-style inspection (via Browser tooling) of the running build, not eyeballing — component: `projects/ken-auth-redesign/builds/src/components/screens/SignupEmail.tsx`.
- Reference re-confirmed via Figma `get_screenshot` (node `559:105`).
- LinkedIn button and primary CTA both triggered via real mouse hover (not simulated), then re-queried for the shimmer child `<div>`'s `style` attribute and computed `background-image`, since iter2's bug lived specifically in that overlay.

## Verification of loop-builder's iteration-3 claimed fix

**Claim:** scoped CSS attribute-selector override on `SignupEmail.tsx` neutralizes the LinkedIn shimmer to gray, leaving the primary CTA's red shimmer untouched.

**Result: NOT FIXED — the override does not fire at all. Bug is unchanged from iteration 2.**

Root cause found in `SignupEmail.tsx` lines 140–147:

```css
:global(.linkedin-neutral-shimmer div[style*='176,31,36']) {
  background-image: linear-gradient(to right, transparent, rgba(0, 0, 0, 0.05), transparent) !important;
}
```

The attribute-selector substring `'176,31,36'` has **no spaces**. The DS shimmer component's actual inline style (confirmed live via `element.getAttribute('style')`) is:

```
transition-duration: 700ms; background-image: linear-gradient(to right, transparent, rgba(176, 31, 36, 0.08), transparent);
```

— i.e. `rgba(176, 31, 36, 0.08)` **with a space after each comma**. CSS attribute-selector substring matching (`*=`) is a literal string match, not a normalized/whitespace-insensitive one, so `div[style*='176,31,36']` never matches `rgba(176, 31, 36, 0.08)`. The selector silently matches zero elements; the whole override block is dead code.

Live confirmation, LinkedIn button hovered:
- `div.getAttribute('style')` → `"transition-duration: 700ms; background-image: linear-gradient(to right, transparent, rgba(176, 31, 36, 0.08), transparent);"`
- `getComputedStyle(div).backgroundImage` → `"linear-gradient(to right, rgba(0, 0, 0, 0), rgba(176, 31, 36, 0.08), rgba(0, 0, 0, 0))"` — **still Ken red, identical to iter2**, not the intended `rgba(0,0,0,0.05)` gray.
- Screenshot confirms a visible pink/red diagonal wash sweeping across the LinkedIn button on hover, same as iter2.
- `linkedin-neutral-shimmer` class **is** present on the button (`li.className` confirmed), so the class-application half of the fix is correct — only the attribute-selector's literal-string match is broken.

Primary CTA hover, re-checked as a regression guard: shimmer div computed `background-image` → `linear-gradient(90deg, rgb(176, 31, 36) 0%, rgb(235, 72, 78) 50%, rgb(176, 31, 36) 100%)` — unchanged, still brand-red, matches reference intent. **No regression on the primary button.**

**Correction:** change the selector to tolerate the space, e.g. `div[style*='176, 31, 36']` (matching the actual serialized string with spaces), or better, match on a whitespace-insensitive fragment like `div[style*='31, 36']`, or drop the string-matching approach entirely and target the shimmer div structurally (e.g. by its position/data-attribute) rather than by its color substring, which is fragile to any formatting change in the DS component's inline style serialization.

## Re-run of full comparison checklist

| Property | Reference | Implementation | Status |
|---|---|---|---|
| Modal width | ~642px | 640px | Match |
| Modal padding | ~32px | 32px | Match |
| Modal radius | ~10px | 10px | Match |
| Modal shadow | soft elevated | `0 25px 50px -12px rgba(0,0,0,.25)` | Match |
| Heading font/weight | bold sans | DM Sans, 700 | Match |
| Heading line-height | tight, single-line | 39.06px font / 62.49px line-height (1.6 ratio) | Still loose (P3, unchanged, not part of any claimed fix) |
| Input height/radius/border | ~62–64px, 5px, hairline | 64px, 5px, border present | Match |
| Primary button height/fill | ~75–80px, flat red (static image) | 78px, red→light-red→red shimmer (pre-existing, accepted) | Match (non-issue, unchanged) |
| LinkedIn button height/default state | ~75–80px, neutral | 78px, neutral border/text/bg | Match |
| LinkedIn button hover state | brand-neutral intent | **still red-tinted shimmer sweeps across — fix did not apply (dead CSS selector)** | **P2 — unresolved, unchanged from iter2** |
| Backdrop | dim only, no blur | `backdrop-filter: none` | Match |
| Alignment | left-aligned column | left | Match |
| Spacing (label→input, stacks) | proportional | proportional, unchanged from iter2 | Match, no regression |
| Close icon | top-right, isolated | top-right, isolated | Match |
| LinkedIn icon | solid blue rounded-square, white "in" | solid blue rounded-square, white "in" | Match |
| Responsive/other states | not in scope this pass | not re-tested (no viewport-size change requested) | N/A |

## Discrepancy report

### P1 (major)
(none)

### P2 (noticeable)
- **LinkedIn button hover still shows brand-red bleed via shimmer overlay — fix did not take effect.** The iteration-3 CSS override (`div[style*='176,31,36']`) never matches because the DS shimmer's real inline style serializes with spaces (`rgba(176, 31, 36, 0.08)`), so the selector's unspaced substring finds zero elements and the block is dead code. Confirmed live: computed `background-image` on the shimmer div is byte-identical to iteration 2's red gradient. Correction: fix the selector to match the actual serialized string (e.g. `div[style*='176, 31, 36']` or a shorter fragment like `31, 36`), or replace string-matching with a structural selector (nth-child/data-attribute) that isn't sensitive to inline-style formatting.

### P3 (finishing/detail)
- **Heading line-height still too loose**: unchanged since iteration 1 — 39.06px font / 62.49px line-height (1.6 ratio). Tighten to ~1.1–1.2 to match reference's tight single-line heading.
- **Copy length still differs from reference** (subcopy/helper text longer than reference's shorter strings) — content difference, not a rendering bug, carried over from iteration 1.

## Non-findings (verified matches, no action needed)
- Modal width/height/padding/radius/shadow — all match reference within a few px, no regression.
- Heading font family/weight, input sizing, both button heights/radii — all match, no regression.
- Backdrop blur removal — confirmed still in effect.
- Primary CTA shimmer — confirmed still brand-red and unaffected by the LinkedIn-scoped fix attempt (no cross-contamination).
- No new spacing/alignment/typography regressions introduced by this iteration's change.

## Verdict
**FAIL** — 1 P2 remaining, unchanged from iteration 2. The iteration-3 fix attempt did not work: the CSS attribute-selector's literal substring (`176,31,36`, no spaces) never matches the DS shimmer's actual inline style (`rgba(176, 31, 36, 0.08)`, with spaces), so the override is dead code and the LinkedIn hover shimmer still bleeds Ken-red exactly as before. No new discrepancies introduced; no regressions on the primary CTA or any other property. One measurable line-level fix (correct the selector's spacing, or match structurally instead of by color string) should resolve this before the 4-iteration cap.
