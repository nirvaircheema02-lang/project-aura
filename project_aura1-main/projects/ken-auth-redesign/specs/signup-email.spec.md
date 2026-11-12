Reference Source: Figma
Reference Type: Frame
Figma File URL: https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login
Figma Frame/Node URL: https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=559-105

---

## Re-analysis note (this revision — geometry regression fix)

Same reference as prior spec (`node 559:105`, "SignUp"). This re-analysis exists because the previous build **passed Loop QA but failed user review**: the modal read as "too wide and stretched" and the email input / primary CTA / LinkedIn CTA had inconsistent widths/heights instead of sharing one content column. Root cause: the Loop system itself had no mandatory Modal/Card Geometry Target or Form Control Geometry gate, so the prior spec left modal width and control-height as soft "uncertain, estimated" notes instead of hard numeric targets. Both are now mandatory sections below, backed by **pixel-level measurement** of a freshly re-fetched 2200px screenshot (downloaded and analyzed programmatically, not eyeballed), not guesswork.

Copy Lock and DS Mapping Gate are re-verified against the same fresh screenshot; they carry over unchanged from the prior spec (the previous QA pass already validated them and no copy or component identity changed).

## Important note on reference type

`get_design_context` on node `559:105` returns a frame containing a single full-bleed raster image (`image 23`, 1122×1402px, `object-cover`, no editable Auto Layout, no component instances, no text nodes). **This reference is a flat image, not editable Figma components.** Per Loop Mode rules it is treated as visual-reference-only. Unlike the prior revision, this pass measured the raster pixel-by-pixel (via a downloaded copy + programmatic edge detection) rather than estimating by eye, so the geometry numbers below are precise pixel measurements of the reference image, not visual guesses — flagged where interpretation (not measurement) is still required.

---

## Copy Lock

Re-verified against a fresh 2200px-max-dimension screenshot of node `559:105` (unchanged from prior spec — identical strings, order, and punctuation).

| Order | Role | Verbatim string |
|---|---|---|
| 1 | Eyebrow/label | `GET STARTED` |
| 2 | Heading | `Create your account` |
| 3 | Subcopy | `Use your work email to create your Ken Research account.` |
| 4 | Input label | `Work email` |
| 5 | Input placeholder | `name@company.com` |
| 6 | Helper/hint text | `Use your professional email address.` |
| 7 | Primary button label | `Continue with work email` |
| 8 | Divider text | `OR` |
| 9 | Secondary/social button label | `Continue with LinkedIn` |
| 10 | Footer line (plain text) | `Already have an account?` |
| 11 | Footer link text | `Sign in` |
| — | Footer/legal copy | None visible — no separate legal/terms line in this modal. |

`loop-builder` MUST reproduce these byte-for-byte (capitalization, punctuation, trailing period on subcopy/helper text included). `loop-visual-qa` treats any copy deviation as P1, not P2/P3.

---

## DS Mapping Gate

Every row verified against real component source in `design-system/core-v2/src/` (re-read this pass, not carried over from memory).

| Element | DS component/token (actual path) | Status |
|---|---|---|
| Modal/dialog container | Two real candidates — `design-system/core-v2/src/atoms/ContactModal.tsx` (hand-rolled: `bg-black/50 backdrop-blur-sm` overlay, `bg-white rounded-[10px] max-w-[500px] w-full p-6 md:p-8 shadow-2xl`) OR `design-system/core-v2/src/ui/dialog.tsx` (Radix: overlay `bg-black/50` no blur, `DialogContent rounded-[10px] max-w-[calc(100%-2rem)] sm:max-w-lg p-6 shadow-lg`) | mapped (pick one — see Geometry Target below, resolves this in favor of a concrete width) |
| Input | `design-system/core-v2/src/ui/input.tsx` (`Input`) | mapped — **default height h-9 (36px) does NOT match the geometry target below; must be overridden, see Form Control Geometry** |
| Primary button | `design-system/core-v2/src/atoms/Button.tsx` `variant="brand" size="lg" fullWidth` | mapped — size variant confirmed real (`lg` → `--button-height-lg` 48px, tokens.css) |
| Secondary/social button | `design-system/core-v2/src/atoms/Button.tsx` `variant="secondary" background="light" size="lg" icon={<Linkedin/>} iconPosition="left" fullWidth` | mapped — same `lg` size token as primary, confirmed real |
| Typography — eyebrow | `--typography-size-xs` (12.8px), `--color-brand-red` | mapped |
| Typography — heading | `--typography-size-xl` (31.25px); family uncertain, see Uncertainty #B (unchanged from prior spec) | mapped, 1 open flag |
| Typography — subcopy/helper | `--typography-size-sm` / `--typography-size-xs`, `--semantic-ink-muted` / `--semantic-ink-subtle` | mapped |
| Typography — input label | `--typography-size-sm`, `--typography-weight-medium` | mapped |
| Links | `design-system/core-v2/src/atoms/InlineLink.tsx` | mapped — real always-on underline conflicts with reference's apparent no-underline rest state, see Uncertainty #D (unchanged) |
| Colors — brand red | `--color-brand-red` (#b01f24) | mapped |
| Colors — ink strong/muted/subtle | `--semantic-ink-strong` / `-muted` / `-subtle` | mapped |
| Colors — LinkedIn brand blue | none in `tokens.css` (no blue ramp) | **NO DS EQUIVALENT — flag to user** (third-party brand-mark exception) |
| Radius — modal | `--radius-card` (10px) | mapped |
| Radius — input/buttons | `--radius-button` (5px) | mapped |
| Spacing — container padding | `--spacing-8`/`--spacing-10` region, see Geometry Target (measured, not estimated, this pass) | mapped |
| Focus state | `Input.tsx`: `focus:border-black/90`, no ring; `Button.tsx`: `focus-visible:ring-2 focus-visible:ring-[var(--color-brand-red)]` | mapped (from DS source) |
| Hover state | `Input.tsx`: `hover:border-black/25`; `Button.tsx` brand: shimmer + shadow lift; secondary/light: text+border → `var(--brand-red)` | mapped (from DS source) — flag Uncertainty #C, LinkedIn hover-to-red may not be desired on a third-party mark |
| Filled/active state | `Input.tsx`: `border-black/15` when filled | mapped (from DS source) |
| Error state | `Input.tsx`: `aria-invalid:border-[var(--brand-red)]` | mapped (from DS source) |
| Disabled state | `Input.tsx`: `disabled:border-black/6 bg-black/[0.03] text-black/35`; `Button.tsx`: `disabled:opacity-50` | mapped (from DS source) |

**1 genuine gap** (LinkedIn brand-blue glyph — no token, no DS icon match for the solid filled square mark). Everything else maps to real, already-implemented components.

---

## Modal/Card Geometry Target (mandatory — measured, not estimated)

**Method:** downloaded the reference PNG (`get_screenshot`, nodeId `559:106`, 1122×1402px raster, this is the frame's native pixel size — not a re-scaled screenshot) and ran pixel-level edge detection (Python/PIL) to find the modal's white-card boundary and each control's border boundary, rather than reading proportions by eye. Numbers below are the direct measurement output.

**Measured (raw reference pixels, 1122×1402 frame):**
- Modal white card: left edge x≈238–242, right edge x≈878–882 → **width ≈ 640px**, i.e. **57% of the 1122px frame width**.
- Modal top edge y≈263–266, bottom edge y≈1140–1143 → **height ≈ 880px**, i.e. **63% of the 1402px frame height**.
- Content column (measured from the primary button and input's own left/right borders, which align within a few px of each other — see Form Control Geometry): left ≈294–299, right ≈818–822 → **content width ≈ 520–529px**.
- Modal inner padding, derived (modal edge → content edge): **≈56–61px on the left, ≈60–64px on the right** — i.e. **content column ≈ 82–83% of modal width**, padding ≈ 9% of modal width per side.

**Existing DS precedent for modal max-width** (checked, both real, both already in the codebase):
- `atoms/ContactModal.tsx`: `max-w-[500px]`, `p-6 md:p-8` (24px/32px)
- `ui/dialog.tsx`: `sm:max-w-lg` (512px Tailwind `lg` breakpoint value), flat `p-6` (24px)

Neither DS precedent is expressed as a design token (both are literal Tailwind classes hard-coded in the component), so there is no single canonical "modal width token" to defer to — the spec must set an explicit number.

**Interpretation flag:** the raw 57%-of-frame ratio must NOT be applied literally to a real desktop viewport — the 1122px frame is a compact preview crop (marketing hero + nav + card row visible around it), not evidence that the modal should occupy 57% of an actual ~1280–1440px browser viewport; doing so would reproduce exactly the "too wide/stretched" regression this re-analysis exists to fix. The right way to use the measurement is via the **internal ratios** (content-column : modal-width ≈ 83%, control-height : modal-width ≈ 10.6%), applied to a sane fixed modal width, not the raw frame-relative percentage.

**Target (recommended, reconciling measurement + existing DS precedent):**
- **Modal max-width: `480px`** — between the two existing DS precedents (500px / 512px), close enough to both that either candidate shell needs only a minor width-prop change, not a new component. Do not exceed ~512px (`ui/dialog.tsx`'s own ceiling) — width beyond that is the direct mechanism of the "too wide" complaint.
- **Content column width: modal width minus padding — target ≈ `400px` effective content width at 480px modal width** (matches the measured ≈83% content:modal ratio: 480 × 0.83 ≈ 398px).
- **Modal inner padding: `--spacing-10` (40px) each side** — matches the measured ≈9% per-side ratio at 480px width (480 × 0.09 ≈ 43px, `--spacing-10` is the nearest DS token) and sits between the two existing shells' `p-6`/`p-6 md:p-8` options; use `p-10` (40px) rather than defaulting to either shell's stock padding unmodified.
- **Top/bottom breathing room at a 900px-tall viewport:** with modal content height realistically ≈560–620px (eyebrow + heading + subcopy + label + input + helper + primary button + divider + secondary button + footer, at the control heights specified below plus the spacing table), a vertically-centered 480px-wide modal at ~600px content height leaves **≈150px combined top+bottom margin (≈75px each side)** at a 900px viewport — comfortable, no edge-to-edge crowding. If content height exceeds ~836px (900 − 2×32px minimum margin), the modal must scroll internally rather than clip or force the viewport to grow; neither candidate shell currently declares `max-h`/internal scroll — flag as Uncertainty #I (new).

---

## Form Control Geometry (mandatory — measured, not estimated)

**Method:** same pixel-edge-detection pass located each control's own border rectangle independently (not inferred from the modal's overall proportions).

**Measured (raw reference pixels):**

| Control | Left edge | Right edge | Width | Top edge | Bottom edge | Height |
|---|---|---|---|---|---|---|
| Email input | 299 | 818 | 519px | 609 | 675 | 66px |
| Primary CTA ("Continue with work email") | 294 | 822 | 528px | 746 | 817 | 71px |
| Secondary/LinkedIn CTA | 298 | 819 | 521px | 930 | 999 | 69px |

**Finding: the reference itself is internally consistent.** All three controls share the same left/right edges (519–528px wide, ±9px = anti-aliasing/measurement noise, not a real design difference) and a near-identical height band (66–71px, ±5px noise). This is the opposite of "inconsistent geometry" — the reference clearly intends one shared content column and one shared control height. The regression the user flagged is a **build/DS-default problem, not a reference-ambiguity problem.**

**DS component reality check (this is the actual gap):**
- `atoms/Button.tsx` `size="lg"` → `--button-height-lg` = **48px** (tokens.css). Scaling the measured control height (66–71px reference) down by the same ratio used for modal width (480/640 ≈ 0.75) gives 66×0.75 ≈ 50px and 71×0.75 ≈ 53px — both land close to the DS's own `lg` token (48px). **`size="lg"` is the correct, already-existing size variant for both buttons** — no new size needed.
- `ui/input.tsx` has **no size variant at all** — it is hard-coded to `h-9` (36px), `px-3 py-1`. 36px is **12px shorter than the target 48px control height** derived above. This is the real, confirmed mechanism behind "the email input, primary CTA, and LinkedIn CTA have inconsistent geometry": if `Input` is dropped in at its literal default while both buttons use `size="lg"` (48px), the three controls will visibly disagree in height even though they correctly share width — reproducing exactly the reported defect.

**Target:**
- **All three controls share content width ≈ `400px`** (the modal's inner content column, per Geometry Target above) via `fullWidth` on both buttons and a `w-full` on the input — do not size any control independently of the others.
- **All three controls target height ≈ `48px`** (`--button-height-lg`, the real, already-existing DS token both buttons already resolve to at `size="lg"`).
- **`ui/input.tsx` must be given an explicit height override to reach 48px** (e.g. `h-12` / `h-[var(--button-height-lg)]` alongside adjusted `px-4`), since `Input` has no built-in size prop to opt into. This is a **confirmed, non-optional build instruction**, not a cosmetic nice-to-have — the prior regression is otherwise guaranteed to recur. Do not invent a new input size *token*; reuse the existing `--button-height-lg` value directly so the input and the two buttons are locked to the same numeric source, not two independently-chosen numbers that happen to match today.
- Flag this override explicitly to `loop-visual-qa` as a first-pass convergence check: confirm rendered input height == rendered button height (both computed styles), not just "looks about right."

---

## Viewport / reference size

- Native frame: 1122 × 1402 px (raster, `object-cover`, no Auto Layout).
- Content shown: full marketing page (navbar + hero "Discover. Decide. Deliver.") dimmed behind a centered modal dialog. **The modal is the build target** ("Signup — Email"); the dimmed page behind it is backdrop context only.

## Container / modal size

- Centered card modal, `--radius-card` (10px), white background, drop shadow, over a `--semantic-scrim` backdrop.
- See Modal/Card Geometry Target above for the authoritative width/padding numbers (480px / 40px padding) — supersedes the prior spec's "~430px, estimated" figure.
- Close (×) control top-right, ~16px inset — matches both candidate shells' `top-4 right-4` (16px) exactly; unaffected by the width change.

## Alignment

- All modal text content left-aligned (eyebrow, heading, subcopy, label, helper text, footer line).
- Buttons and input full-width within the modal's content column (confirmed by measurement above — not merely visual impression).
- Divider ("OR"): centered, flanked by two hairlines splitting the remaining width evenly.
- Close icon: top-right, isolated from the text column.

## Spacing

| Element gap | Target | DS token |
|---|---|---|
| Eyebrow → Heading | ~8px | `--spacing-2` |
| Heading → subcopy | ~12px | `--spacing-3` |
| Subcopy → "Work email" label | ~24px | `--spacing-6` |
| Label → input | ~8px | `--spacing-2` |
| Input → helper text | ~8px | `--spacing-2` |
| Helper text → primary button | ~24px | `--spacing-6` |
| Primary button → OR divider | ~20px | `--spacing-5` |
| OR divider → LinkedIn button | ~20px | `--spacing-5` |
| LinkedIn button → footer line | ~20px | `--spacing-5` |
| Modal edge → content (padding) | **40px** | `--spacing-10` (measured this pass — supersedes prior spec's ~32px estimate) |

Row-gaps other than the modal padding remain visual estimates (not independently pixel-measured this pass); flagged for `loop-visual-qa` first-pass convergence.

## Typography hierarchy

See DS Mapping Gate above for confirmed per-element token mapping. Heading font-family remains Uncertainty #B (sans-serif read vs. `ContactModal.tsx`'s serif h3 precedent) — unchanged from prior spec, not resolved by this geometry-focused pass.

## Colors / tokens

Unchanged from prior spec — see DS Mapping Gate above. Only unmapped color: LinkedIn brand blue (no DS token, genuine gap, third-party mark exception).

## Radius

- Modal: `--radius-card` (10px).
- Input/buttons: `--radius-button` (5px) — unaffected by the height-override target above (radius is independent of height).

## Borders

- Input: 1px, `border-black/10` default (6-state system per `Input.tsx`, unchanged by height override).
- LinkedIn button: `border-[1.5px]`, rest `rgba(0,0,0,0.12)`, hover → `var(--brand-red)` (Uncertainty #C, unchanged).
- Divider hairlines: 1px, `--border-soft` via `Divider`.

## Shadows

- Modal: shell-dependent (`shadow-2xl` vs `shadow-lg`) — see Uncertainty #A, unchanged from prior spec; orthogonal to the width fix.

## Backdrop / overlay

- Full-viewport `--semantic-scrim` (rgba(0,0,0,0.5)). Blur presence is shell-dependent (Uncertainty #A) — orthogonal to this pass's geometry fix.

## Inputs

- Single "Work email" `type="email"` input, full width of the (now 400px) content column.
- Placeholder: `name@company.com` (Copy Lock #5).
- **Height: 48px, explicit override — see Form Control Geometry above. This is the headline fix of this re-analysis.**
- All 6 states (Default/Hover/Focus/Filled/Error/Disabled) sourced from `Input.tsx` — only the height number changes, not the color/border logic.

## Buttons

- Both buttons: `atoms/Button.tsx`, `size="lg"` (48px, already the correct DS token — no override needed here, only on the input).
- Primary: `variant="brand" fullWidth`. Secondary: `variant="secondary" background="light" icon={<Linkedin/>} iconPosition="left" fullWidth`.
- "Sign in": `atoms/InlineLink.tsx` — Uncertainty #D unchanged (underline conflict).

## Icons

- Close (×): `lucide-react` `X`/`XIcon`, per whichever modal shell is chosen.
- LinkedIn glyph: **NO DS EQUIVALENT** — flag to user, not approximated silently (unchanged gap).

## OTP controls

- Not present in this screen (email-entry step only). `design-system/core-v2/src/ui/input-otp.tsx` exists for a future step, out of scope here.

## States (sourced from DS, not reference)

- Reference (flat image) shows only the default state for every element.
- Input: Default/Hover/Focus/Filled/Error/Disabled — from `Input.tsx` source; height (48px) is now explicit, all other state styling (border colors/opacities) unchanged from source.
- Primary button: Rest/Hover/Disabled/Loading — from `Button.tsx` source, `size="lg"`.
- Secondary/LinkedIn button: Rest/Hover(→brand-red text+border)/Disabled — from `Button.tsx` source; Uncertainty #C unchanged.
- "Sign in" InlineLink: Rest(underlined)/Hover — from `InlineLink.tsx` source; Uncertainty #D unchanged.
- Close control: Rest/Hover, per shell choice.

## Responsive behaviour

- Reference shows only a single desktop-scale rendering.
- `ui/dialog.tsx`'s real responsive class (`w-full max-w-[calc(100%-2rem)] sm:max-w-lg`) is the only DS-real responsive modal pattern found; if this shell is used, cap the `sm:` breakpoint value at the new 480px target instead of the stock 512px (`sm:max-w-[480px]`), keeping the same `calc(100%-2rem)` mobile-clamp behavior below `sm`.
- `ContactModal.tsx` has no responsive breakpoint classes beyond `p-6 md:p-8`; if chosen, its literal `max-w-[500px]` should be changed to `max-w-[480px]` and its padding to `p-10` (40px) per the Geometry Target, dropping the `md:p-8` step-up since 40px is now the single target at all sizes.
- Buttons/input remain full-width at all breakpoints (already full-width in reference and per this pass's measurement).
- No mobile reference exists to confirm modal padding/width behavior below ~640px — Uncertainty #F, unchanged.
- **New this pass — Uncertainty #I:** neither candidate shell declares an internal max-height/scroll behavior; confirm modal scrolls internally rather than overflowing the viewport at short viewport heights (see Geometry Target breathing-room note).

---

## Component mapping (summary table)

| Reference element | DS component/token to reuse |
|---|---|
| Modal shell | `ui/dialog.tsx` OR `atoms/ContactModal.tsx` — pick one, **width capped at 480px, padding set to 40px (`--spacing-10`) either way** (Uncertainty #A on shell choice; width/padding is no longer uncertain) |
| Eyebrow "GET STARTED" | Typography tokens (`--typography-size-xs`, `--color-brand-red`) |
| Heading "Create your account" | Typography tokens (`--typography-size-xl`, family TBD — Uncertainty #B) |
| Subcopy | Typography tokens (`--typography-size-sm`, `--semantic-ink-muted`) |
| "Work email" label | Typography tokens (`--typography-size-sm`, `--typography-weight-medium`) |
| Email input | `ui/input.tsx` — **`w-full`, height override to 48px (`h-[var(--button-height-lg)]`), `fullWidth`-equivalent** |
| Helper text | Typography tokens (`--typography-size-xs`, `--semantic-ink-subtle`) |
| "Continue with work email" button | `atoms/Button.tsx` `variant="brand" size="lg" fullWidth` |
| "OR" divider | `atoms/Divider.tsx` `variant="subtle"` ×2 + centered `<span>` |
| "Continue with LinkedIn" button | `atoms/Button.tsx` `variant="secondary" background="light" size="lg" icon={<Linkedin/>} iconPosition="left" fullWidth` |
| "Sign in" link | `atoms/InlineLink.tsx` — Uncertainty #D |
| Close (×) control | `lucide-react` `X`/`XIcon`, per shell choice |
| LinkedIn glyph | **NO DS EQUIVALENT** — flag to user |

## Reuse opportunities

- `atoms/ContactModal.tsx` and `ui/dialog.tsx` both cover the full modal shell — only a width/padding parameter change needed on either, not a new primitive.
- `atoms/Button.tsx` `size="lg"` already covers both CTAs at the correct target height — no new button size needed.
- `ui/input.tsx` covers the email field's border/color/state logic entirely — only its height needs an explicit override to match the buttons, not a rewrite.
- `atoms/InlineLink.tsx` and `atoms/Divider.tsx` cover the "Sign in" link and "OR" separator.

## UI/UX Pro Max Notes (advisory only — never overrides reference/DS/geometry above)

Consulted `skills/_external/ui-ux-pro-max-skill` (domain `ux`) for sanity checks on this auth-modal pattern. All notes below are advisory; none change any target set above.

- **Form labels**: reference already shows a visible "Work email" label above the input (not placeholder-only) — matches the guideline "inputs must have associated labels," confirmed already satisfied.
- **Visible focus indicators**: `Button.tsx`'s `focus-visible:ring-2 ring-[var(--brand-red)]` already satisfies "keyboard users need visible focus indicators." `Input.tsx`'s focus state is a border-color change with no ring (by DS design, see DS Mapping Gate) — this is a DS-level decision already in place, not a gap this spec should second-guess; noted only as an advisory data point, not a required change.
- **Submit feedback**: reference shows only a static default state; recommend the primary button's existing `loading` prop (spinner swap, `Button.tsx` source) be wired to the real submit action so the user gets loading→success/error feedback — advisory, since the flat reference can't show this state itself.
- **Error announcement**: if/when an inline email-validation error is added, use `role="alert"`/`aria-live` alongside `Input.tsx`'s `aria-invalid` border change rather than a border-color-only signal — advisory, no error copy exists in Copy Lock today so this is forward-looking only.
- **Container width for readability**: general guidance suggests capping text content width for readability (65–75ch) — the 400px content column recommended above is well under any readability ceiling for this short-copy modal, no conflict.
- **Responsive breakpoint testing**: general guidance recommends testing at 320/375/414/768/1024/1440 — flagged as a `loop-visual-qa` action item given Uncertainty #F/#I above (no mobile reference exists).

None of the above changes colors, typography, spacing tokens, radius, or component identity already fixed by the DS Mapping Gate — advisory only, per this skill's scope rules.

## Uncertainties requiring visual convergence

- **#A — Modal shell choice**: `ContactModal.tsx` vs. `ui/dialog.tsx` — changes blur/shadow together; width/padding now fixed regardless of choice (see Geometry Target). Decide before first render.
- **#B — Heading font family**: sans-serif read vs. `ContactModal.tsx`'s serif h3 precedent. Unchanged from prior spec.
- **#C — LinkedIn button hover-to-red**: `Button variant="secondary"`'s only light-mode behavior hovers text/border to brand-red; reference shows a static, brand-neutral button. Confirm acceptability on a third-party-branded control.
- **#D — "Sign in" InlineLink underline**: always-on underline vs. reference's apparent no-underline rest state. Unchanged from prior spec.
- **#E — Input height (superseded)**: prior spec flagged this as an open question ("compact `h-9` vs. taller reference input"); **this pass resolves it** — target is 48px via explicit height override, see Form Control Geometry. No longer open, kept here only as a pointer for anyone reading the prior spec's #E.
- **#F — Responsive/mobile behavior**: no mobile reference exists. Unchanged.
- **#G — LinkedIn glyph fidelity**: `lucide-react Linkedin` (outline) vs. reference's solid-blue-square mark — NO DS EQUIVALENT, flag to user. Unchanged.
- **#H — Non-padding spacing values** (label→input, button→divider, etc.) remain visual estimates, not independently pixel-measured this pass — first-pass QA convergence targets.
- **#I — Modal internal scroll (new this pass)**: neither candidate shell declares max-height/overflow behavior for short viewports; confirm the modal scrolls internally rather than clipping content below ~836px available height (900px viewport − 2×32px margin).
