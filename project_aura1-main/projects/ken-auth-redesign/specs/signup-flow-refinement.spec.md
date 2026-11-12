Reference Source: Figma
Reference Type: Frame (contains 4 stacked flat raster images, one per step) — same reference as baseline, re-confirmed for proportions only where relevant to compactness in this pass
Figma File URL: https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login
Figma Frame/Node URL: https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=550-67 (frame "SignUp")
Step node URLs: 554:94 / 554:97 / 554:100 / 554:103 (unchanged from baseline)

---

## Delta/refinement note

This is a **refinement spec, not a fresh analysis**. The sign-up flow already PASSED Loop QA against `projects/ken-auth-redesign/specs/signup-flow.spec.md`. That spec remains authoritative for everything not explicitly revised below: **Copy Lock (all 4 steps), full DS Mapping Gate tables, uncertainties #1–#14, UI/UX Pro Max notes, and all component identities.** This file covers only the 3 new requirements the user added on top of the passed baseline:

1. Slightly more compact modal on desktop (padding/inner-spacing, DS-token-stepped).
2. Confirmation that input/primary-CTA/LinkedIn-CTA geometry consistency survives the above.
3. Backdrop/overlay treatment recommendation.
4. Step-transition motion spec (Framer Motion only, subtle, same-card content swap).

Nothing in this delta touches Copy Lock, component identity, or reference-approved layout — it is geometry/motion refinement only, per the task brief's explicit instruction not to redesign the approved screens/copy.

---

## 1. Revised Modal/Card Geometry Target

**DS spacing scale actually defined** (`design-system/tokens/build/tokens.css:254-266`) — confirmed real tokens, note the scale has gaps (no `--spacing-7`/`--spacing-9`):

```
--spacing-1: 4px   --spacing-2: 8px   --spacing-3: 12px  --spacing-4: 16px
--spacing-5: 20px  --spacing-6: 24px  --spacing-8: 32px  --spacing-10: 40px
--spacing-12: 48px --spacing-16: 64px
```

**Current built state** (`AuthModal.tsx:107`): `max-w-[480px] w-full p-10` → outer padding is `--spacing-10` (40px) on all sides. Baseline spec confirms 480px modal / ≈400px content column / 40px padding were pixel-measured against the reference and already PASSED — this baseline is real but was, per the task brief's own framing, "already slightly looser than max-compact," so stepping padding down one real token is compacting from a validated-but-loose baseline, not violating the measured reference.

**One-step-down token, applied consistently:**
- Outer modal padding: `--spacing-10` (40px) → **`--spacing-8` (32px)**. This is the DS's actual next-smaller token (there is no `--spacing-9`), applied uniformly on all 4 sides (`p-10` → `p-8`).

**Modal max-width — derived, not eyeballed:** Modal width = content column + 2× outer padding. Content column stays at the already-validated **400px** (see §2 — must not change, that's what preserves Form Control Geometry). With padding stepping 40px → 32px, modal max-width falls out arithmetically:
- Old: 400 + 2(40) = 480px
- **New: 400 + 2(32) = 464px**

This is the DS-natural approach the brief asked for: outer max-width steps down *because* padding stepped down, while content width is held fixed — not "widen content to fill the same 480px shell" (which would silently change Form Control Geometry) and not an arbitrary independent width pick.

**Inter-element gap tokens — one step down each, from the actual built values** (grepped from `CompleteProfileStep.tsx`, `OtpVerificationStep.tsx`, `SigninOtpStep.tsx`, `SignupEmail.tsx`, `SigninEmail.tsx`):

| Rhythm point | Current built value | Current token | One-step-down token | New value |
|---|---|---|---|---|
| Eyebrow → heading | `mb-2` | `--spacing-2` (8px) | already near floor — **no change recommended** (stepping to `--spacing-1`/4px risks eyebrow/heading collision, not requested) | 8px (unchanged) |
| Heading → subcopy | `mb-2` | `--spacing-2` (8px) | same as above — unchanged | 8px (unchanged) |
| Subcopy → field / field-group separation | `mb-6` | `--spacing-6` (24px) | **`--spacing-5`** | 20px |
| Field-to-field (Step 3: name/phone/company, checkbox row) | `mb-6` | `--spacing-6` (24px) | **`--spacing-5`** | 20px |
| "OR" divider spacing (`SignupEmail.tsx:116`) | `my-5` | `--spacing-5` (20px) | **`--spacing-4`** | 16px |
| Secondary-CTA (LinkedIn) separation | inherits the `mb-6`/field-gap pattern above | `--spacing-6` (24px) | **`--spacing-5`** | 20px |
| Footer/bottom account-switch-link spacing (`mt-6`) | `mt-6` | `--spacing-6` (24px) | **`--spacing-5`** | 20px |

Rationale for leaving eyebrow→heading→subcopy untouched: those are already the tightest gaps in the built flow (8px), and the user's ask was specifically about "outer card padding and inner spacing/margins" reducing **slightly** — stepping the already-tight 8px gaps down to 4px risks a cramped, un-legible eyebrow/heading cluster that the reference doesn't show tighter than this. The larger, more visually "loose" gaps (24px/20px categories) are where the real compacting lever is, consistent with "reduce slightly, stay DS-aligned."

**Confirmation against reference proportions:** the reference's own measured proportions locked content width at ≈400px and padding at 40px in the baseline pass. This refinement does not touch the 400px content-column measurement (unchanged, reference-confirmed) — it only compacts the padding *around* that column and the *gaps within* it, both by exactly one real DS token step. Nothing here shrinks below what the reference showed; it tightens toward the DS's own next-smaller rhythm.

- Target modal max-width: **464px** (derived: 400px content + 2× 32px padding)
- Target content width (inner column): **≈400px — unchanged from baseline, confirmed preserved**
- Top/bottom breathing room at ~900px viewport height: previously ≈75px each side at 40px padding / 480px shell; with padding and internal gaps both stepping down, overall card height drops modestly (estimate: 16–24px shorter across a typical step, more on Step 3 which has the most gap instances) — **breathing room increases to roughly ≈85–95px each side**, a visual estimate not independently re-measured this pass, flagged for `loop-visual-qa` to confirm at 900px on each of the 4 steps (Step 3 tallest, Step 2 shortest, same ordering as baseline).
- Rule (unchanged from baseline): modal width must not increase to fit text; text wraps within the controlled content width.

---

## 2. Form Control Geometry — confirmed preserved

Per the baseline spec's Form Control Geometry tables (Step 1/2/3/4, unchanged — not reproduced here), all form controls (email input, OTP slots, Full name / Phone / Company inputs, phone country-code select, primary CTA, secondary/social CTA) are built at **48px height** (`--button-height-lg` override) and share the **400px content column**.

This refinement's padding/gap changes are **structurally incapable of breaking that**, because:
- Control heights (48px) are untouched — nothing in this delta modifies `Input`/`Button`/`Select`/`InputOTPSlot` sizing.
- Content column width (400px) is explicitly held fixed in §1 above — the modal shrinks *around* it, the column itself does not narrow or widen.
- Only the vertical margin/gap classes between controls (`mb-6`→`mb-5`, `my-5`→`my-4`, outer `p-10`→`p-8`) change; none of those are horizontal-width or height properties.

**Confirmed: same 48px height, same shared 400px content width, same alignment across email input / primary CTA / LinkedIn CTA — no regression introduced by the compacting change.** This is the "more DS-natural" resolution the brief asked for: both outer max-width and content-adjacent padding step down together (derived arithmetically in §1), rather than widening the content column to fill a now-mismatched fixed modal width.

---

## 3. Backdrop/Overlay Treatment

**Current built state** (`AuthModal.tsx:100`): `bg-[var(--semantic-scrim)]` — no blur. `--semantic-scrim: rgba(0, 0, 0, 0.5)` (`tokens.css:114`, documented "Modal / sheet backdrop overlay").

**Existing DS precedent checked** — `design-system/core-v2/src/atoms/ContactModal.tsx:79`: `bg-black/50 backdrop-blur-sm`. This is the one other modal-pattern precedent in the DS, and it pairs the ~50%-opacity scrim with a `backdrop-blur-sm` (Tailwind, ~4px) blur — a more "considered"/focused treatment than `AuthModal.tsx`'s current flat scrim-only approach. Note `ContactModal.tsx` uses a **hardcoded** `bg-black/50` rather than the semantic token — that's a regression relative to `AuthModal.tsx`'s already-correct tokenized `--semantic-scrim`, not something to copy.

**No dedicated "modal-scrim-blur" token exists.** The only blur token in `tokens.css` is `--composition-blur-glass: 12px` (`tokens.css:217`), documented specifically for the `.glass` utility (sticky bars w/ `backdrop-filter`), a different use case (frosted sticky nav, not modal scrim) — using it here would be misapplying a differently-scoped token, not reusing a real precedent correctly.

**Recommendation:** keep `AuthModal.tsx`'s current tokenized scrim color (`bg-[var(--semantic-scrim)]` — correct, don't regress to `ContactModal.tsx`'s hardcoded `black/50`) and **add `backdrop-blur-sm`** (Tailwind utility, ~4px blur) alongside it, matching `ContactModal.tsx`'s real existing pairing of scrim + subtle blur — this is the DS's own established "balanced and focused" modal-backdrop convention, applied via the correct (tokenized) color rather than duplicating the hardcoded one.

**Final recommended className:** `bg-[var(--semantic-scrim)] backdrop-blur-sm` (replacing the current `bg-[var(--semantic-scrim)]` alone on `AuthModal.tsx:100`).

**UI/UX Pro Max advisory note (subordinate, does not change the above):** general backdrop-blur guidance favors a light blur (4–8px) for auth/dialog contexts specifically because it visually separates the modal from a busy marketing page behind it (this flow's dimmed hero/navbar/stat-counter background) without fully obscuring context — consistent with, not overriding, the DS-grounded `backdrop-blur-sm` recommendation above.

---

## 4. Step-Transition Motion Spec (Framer Motion only)

**Stack rule (per CLAUDE.md / project conventions):** Framer Motion ONLY for all motion — `AnimatePresence` for mount/unmount, `useReducedMotion()` mandatory. No GSAP, no Lenis, no CSS-only transition libraries.

**Scope check — confirmed architecturally already correct, no structural change needed** (per requirement #5): step state (`currentStep`) lives inside `SignupFlow.tsx` / `SigninFlow.tsx` (confirmed present at `projects/ken-auth-redesign/builds/src/components/flows/SignupFlow.tsx` and `SigninFlow.tsx`), which renders a single `<AuthModal>` instance and swaps its `children` per step — the modal never remounts/reopens between steps today. **The "feels like the same card, not a new popup" requirement is a motion-polish requirement, not a structural fix** — the structure already satisfies it; what's currently missing is only the transition treatment on the inner content swap itself (no `AnimatePresence` wrapping currently confirmed around the step content in the grepped files — none of `motion.`/`AnimatePresence` appeared in the grep of `flows/`/`screens/`, so this is a genuine gap to add, not a regression to fix).

**What needs `AnimatePresence` (inner content only):**
```
<AnimatePresence mode="wait" initial={false}>
  <motion.div
    key={currentStep}                 // step id, e.g. "email" | "otp" | "profile" | "success"
    initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 12 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -8 }}
    transition={{ duration: prefersReducedMotion ? 0.01 : 0.2, ease: [0.4, 0, 0.2, 1] }}
  >
    {stepContent}
  </motion.div>
</AnimatePresence>
```

**Concrete values, grounded in "subtle, not heavy":**
- **Duration:** 200ms (within the 150–250ms subtle range; not a snappy 150ms micro-tap feel, not a slow 250ms that reads as heavy).
- **Slide distance:** 12px on enter (mid-point of the 8–16px range), 8px on exit — asymmetric on purpose so the outgoing step recedes slightly faster/shorter than the incoming step arrives, avoiding a "bouncy" symmetric feel.
- **Easing:** standard Tailwind/Material-style `ease-out`-leaning cubic-bezier `[0.4, 0, 0.2, 1]` — decelerating, reads as settling into place rather than sliding/popping.
- **`mode="wait"`** on `AnimatePresence` — old step content fully exits before the new one enters, so they never overlap/cross-fade into each other (which would read as busier/heavier than a clean sequential swap).
- **`useReducedMotion()` (mandatory):** when true, collapse `y` offsets to `0` (opacity-only cross-fade) and shorten duration to ~10ms (effectively instant) — never fully skip the hook per project convention.

**What this explicitly does NOT touch:** `AuthModal.tsx`'s own open/close behavior (`animate-in fade-in duration-200` / `zoom-in-95 duration-200`, `tailwindcss-animate` classes at `AuthModal.tsx:100,107`) is existing, already-shipped, out-of-scope behavior for this refinement — it does not use Framer Motion today and this spec does not ask to convert it. Only the **internal step-content swap** (inside `SignupFlow.tsx`/`SigninFlow.tsx`, wrapping whatever they currently render as `children` into `AuthModal`) gets the `AnimatePresence` treatment above.

**Confirms requirement #5 directly:** no structural fix is needed for "next step should update inside the same card, not feel like a new separate popup/page" — the single persistent `AuthModal` instance already satisfies this structurally; the `AnimatePresence` fade+slide above is what makes the *transition itself* feel continuous rather than an abrupt content swap, which is the actual gap.

---

## Uncertainties requiring visual convergence (this refinement only)

- **#R1** — New breathing-room estimate (≈85–95px at 900px viewport) is arithmetic-derived from the padding/gap deltas, not independently re-measured on a live render; `loop-visual-qa` should confirm actual rendered breathing room per step, especially Step 3 (tallest, most gap instances affected).
- **#R2** — `backdrop-blur-sm` (4px) is a Tailwind utility value matched to `ContactModal.tsx`'s existing precedent, not a dedicated DS "scrim-blur" token (none exists) — flagged in case the user wants a dedicated token added to `tokens.css` for future modal consistency (out of scope for this refinement to create).
- **#R3** — Step-transition `key` value in the `AnimatePresence` example above (`currentStep`) assumes `SignupFlow.tsx`/`SigninFlow.tsx` already track a step identifier suitable as a stable React key; `loop-builder` should confirm the actual state shape when wiring this in, rather than assuming the exact variable name.

---

## Mandatory return format

## Status
Done: Refinement/delta spec for ken-auth-redesign sign-up flow (3 new requirements: compact geometry, backdrop treatment, step-transition motion) written against the already-PASSED baseline `signup-flow.spec.md`.

## Reference source
Figma frame 550:67 "SignUp" (nodes 554:94/97/100/103), file PJtPivOzEkiTjSkGnZ2YtH — re-confirmed proportions only where relevant to compactness (content-column width unchanged from baseline's pixel-measured 400px).

## Spec file
projects/ken-auth-redesign/specs/signup-flow-refinement.spec.md

## Copy Lock summary
Not re-derived — unchanged, refer to baseline `signup-flow.spec.md` (this is a geometry/motion-only delta, no copy touched).

## DS Mapping Gate summary
Not re-derived — unchanged, refer to baseline (all component identities already mapped/PASSED). This delta adds one new mapping: backdrop `backdrop-blur-sm` (Tailwind utility, matched to `ContactModal.tsx` precedent) alongside the existing `--semantic-scrim` token — not a new component, a class addition to the existing `AuthModal.tsx` scrim div.

## Modal/Card Geometry Target
New target: **464px max-width** (derived: 400px content column, unchanged, + 2× 32px padding, stepped down from 40px). Source: DS token step-down (`--spacing-10`→`--spacing-8`) applied arithmetically, content width held fixed per reference-measured baseline.

## Form Control Geometry
Confirmed preserved: yes — 48px control height and 400px shared content width both unchanged by this refinement; only outer padding and inter-element vertical gaps step down one DS token each. No height mismatches introduced.

## Component mapping summary
| Element | Change |
|---|---|
| `AuthModal.tsx` outer card padding | `p-10` → `p-8` (`--spacing-10`→`--spacing-8`) |
| `AuthModal.tsx` max-width | `max-w-[480px]` → `max-w-[464px]` |
| Step-internal `mb-6`/`my-5` gaps (across `SignupEmail.tsx`, `OtpVerificationStep.tsx`, `CompleteProfileStep.tsx`, `SigninEmail.tsx`, `SigninOtpStep.tsx`) | step down one token each (`--spacing-6`→`--spacing-5`, `--spacing-5`→`--spacing-4`) |
| `AuthModal.tsx` scrim div | `bg-[var(--semantic-scrim)]` → `bg-[var(--semantic-scrim)] backdrop-blur-sm` |
| `SignupFlow.tsx`/`SigninFlow.tsx` step content | wrap in `AnimatePresence mode="wait"` + `motion.div` per §4 spec above |

## Uncertainties flagged
- #R1: breathing-room estimate is arithmetic, not re-measured on a live render — flag for `loop-visual-qa`.
- #R2: no dedicated DS scrim-blur token exists; `backdrop-blur-sm` matched to `ContactModal.tsx` precedent, not a token — flag for future DS token addition if desired.
- #R3: `AnimatePresence` `key` assumes a stable step-id in `SignupFlow.tsx`/`SigninFlow.tsx` state; confirm actual shape at build time.

## Self-check
- Model used: Sonnet
- Production code touched: no (read-only analysis; recommendations only, code paths cited but not edited)
- New DS primitives invented: no
- Copy transcribed verbatim (not paraphrased): n/a — no copy in scope for this delta, baseline Copy Lock unchanged
- DS Mapping Gate complete (no approximations, no invented paths): yes — all values traced to real token/file line numbers (`tokens.css:254-266`, `tokens.css:114`, `tokens.css:217`, `AuthModal.tsx:100/107`, `ContactModal.tsx:79`)
- Confidence in spec: high for geometry (arithmetic derivation from real tokens + grepped actual built values) and motion (concrete Framer values within the requested subtle range); medium for the exact breathing-room px estimate (§R1, flagged for QA measurement)
