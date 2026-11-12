Reference Source: Figma
Reference Type: Frame (contains 4 stacked flat raster images, one per step)
Figma File URL: https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login
Figma Frame/Node URL: https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=550-67 (frame "SignUp")
Step node URLs:
- Step 1 "Create your account": node 554:94 ("image 23") — https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=554-94
- Step 2 "OTP verification": node 554:97 ("image 24") — https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=554-97
- Step 3 "Complete profile": node 554:100 ("image 25") — https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=554-100
- Step 4 "Success": node 554:103 ("image 26") — https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=554-103

---

## Supersedes note

This spec supersedes `projects/ken-auth-redesign/specs/signup-email.spec.md` (node `559:105`, analyzed as a standalone screen). That file is left in place for history/traceability but is no longer the authoritative source for Step 1 — Step 1's Copy Lock, DS Mapping Gate, and Geometry Target below are re-verified against this flow pass and are authoritative going forward. The old spec's pixel-measurement work (modal 480px / content ≈400px / control height 48px) is confirmed correct and carried forward unchanged; the built `AuthModal.tsx` shell (480px max-width, `p-10`, `--radius-card`) already reflects it and is re-confirmed below against all 4 steps, not just step 1.

## Reference type note

All 4 step nodes are flat raster images (1122×1402px each, `object-cover`, no Auto Layout, no component instances, no text nodes) stacked vertically inside frame `550:67` at y-offsets 0 / 1402 / 2804 / 4206. Each is visual-reference-only per Loop Mode rules — proportions/spacing are read from the image, not from editable Figma structure. All 4 screenshots were fetched individually at `maxDimension=2200` (native 1122×1402, no upscale needed) and visually inspected in full.

---

# COMMON AUTH SHELL (all 4 steps)

**What's identical across all 4 steps** (confirmed by comparing all 4 screenshots side by side):
- Same dimmed marketing page behind the modal in every step: navbar (Solutions / Industries / Insights / Reports / About Us / Careers, Login, red "Request Demo" button), dark hero panel with "Discover. Decide. Deliver." headline + red subhead + globe/network graphic, "How We Help" icon row, stat counters (10,000+ Reports / 15+ Years of Excellence), "Insights That Drive Growth" card row. This is backdrop context only, not part of the build target.
- Same modal chrome: white rounded card, centered over a dark scrim, positioned in the same horizontal location across all 4 steps (card left/right edges land at consistent x-position in every screenshot).
- Same close control: `×` icon, top-right inset, isolated from the text column, present on steps 1–3 (step 4 also shows it).
- Same left-aligned text rhythm: eyebrow (red, uppercase, small) → bold heading → gray subcopy, when an eyebrow is present (steps 1–3; step 4 has no eyebrow, see below).
- Same footer pattern where present: "Already have an account? Sign in" (steps 1 and 3; not present on step 2 or step 4).
- Same primary-CTA treatment: full-width red button, bold white label, at the bottom of the form stack (steps 1, 2, 3). Step 4 also has a full-width red button but with different label/purpose (see step 4 below).

**What changes per step:**
- Eyebrow text, heading text, subcopy text (steps 1–3; step 4 has no eyebrow/subcopy, only a heading).
- Form field composition and count (0 fields on step 4, 1 field on step 1, 1 OTP field-group + 1 read-only field on step 2, 3 fields + 1 checkbox on step 3).
- Modal height (grows with content — step 3 is visibly the tallest card, step 2 the shortest — while width stays constant; this is expected and does not violate the "modal must not widen" rule, only height is content-driven).
- Presence/absence of a secondary CTA link below the primary button (step 1: "Continue with LinkedIn" social button; step 2: "Back to sign up" plain link; step 3: none beyond the footer; step 4: "Browse reports" plain link).

**Existing built shell — `projects/ken-auth-redesign/builds/src/components/AuthModal.tsx`:**
Re-checked against all 4 steps, not just step 1. Its structure (`fixed inset-0` scrim wrapper using `--semantic-scrim`, white card `rounded-[var(--radius-card)] max-w-[480px] w-full p-10`, close button `absolute top-4 right-4 w-11 h-11`, `max-h-[calc(100vh-4rem)] overflow-y-auto` for tall content) is confirmed structurally correct and reusable unmodified for all 4 steps — the modal-frame-level chrome does not need to change per step, only `children` swaps. The existing `max-h-[calc(100vh-4rem)] overflow-y-auto` on the card is exactly the internal-scroll behavior the prior spec flagged as Uncertainty #I ("neither candidate shell declares max-height/overflow") — **this is now resolved**, `AuthModal.tsx` already has it built in.

**Step-runner requirement (new, not covered by the single-screen shell alone):** the shell itself has no concept of steps — a parent component (e.g. `SignupFlow.tsx`, out of scope for this spec to name definitively since it doesn't exist yet — flag as a build-time naming decision for `loop-builder`) must own `currentStep` state and render `<AuthModal>{stepContent}</AuthModal>` with the appropriate step's children, so the shell truly is shared across one continuous interactive flow rather than 4 independent modals.

---

# STEP-TRANSITION / INTERACTION LOGIC

Per the task brief's requirements, checked against what each reference screen actually shows:

- **Step 1 → Step 2:** clicking "Continue with work email" advances to OTP verification. Confirmed directly by copy: step 2's subcopy explicitly reads "We sent a 6-digit verification code to use***@company.com" — a direct causal continuation of step 1's email submission. Not shown in the reference: any inline validation state on the email input before advancing (no error copy visible anywhere in Copy Lock) — sensible default (not shown, flagged as Uncertainty #1 below) is to validate a well-formed work email client-side before triggering the transition.
- **Step 2 → Step 3:** step 2 does show a "change email" affordance — **exactly one**, a red "Change" link inline with the masked "Work email" field (see Step 2 Copy Lock/DS Mapping below). This is NOT a full "go back" nav, it's scoped to editing the email specifically (presumably returns to step 1 or opens the email field for edit — the reference doesn't show what "Change" does after the click, only that the control exists). Step 2 also has a separate plain-text link "Back to sign up" at the very bottom of the card — this IS the back-to-step-1 affordance. So there are two distinct back-style controls on step 2: "Change" (email-specific, next to the masked email) and "Back to sign up" (full step-back, bottom of card). Do not conflate them or invent a third. Advancing to Step 3 happens on successful OTP validation (heading/subcopy of step 3 — "Your work email is verified" — confirms this causality) via the "Verify & continue" button.
- **Step 3 → Step 4:** primary CTA "Create account" on Complete Profile advances to Success. Exact required fields shown in the reference, transcribed verbatim (do not assume any additional fields beyond these three, and do not drop any):
  - **Full name** (text input, example/placeholder value "Nirvair Singh")
  - **Phone number** (compound control: country-code select showing "+91" + phone text input, example/placeholder value "98765 43210")
  - **Company name** (text input, example/placeholder value "Ken Research", with helper text "Auto-detected from your work email. You can edit this.")
  - Plus a required **checkbox**: "By creating your account, you agree to our Terms of Use and Privacy Policy." (with "Terms of Use" and "Privacy Policy" as separate inline links)
  - No other fields (no password field, no confirm-password, no job title, no team size, etc. — the reference does not show these; do not add them).
- **Step 4 (Success):** exact final-state content, transcribed verbatim — this step DOES show a CTA (in fact two), so the "no CTA unless explicitly shown" default does not silently suppress them here:
  - Heading "Your account is ready" (no eyebrow above it, unlike steps 1–3 — confirmed absent, not an oversight)
  - A green circular checkmark icon with small decorative "+"/dot sparkle accents scattered around it
  - A light-gray info panel showing 3 rows: `Name: Nirvair Singh` / `Work email: nirvair@company.com` / `Account: Ken Research account`
  - Primary button: **"Continue browsing"** (full-width red button, same treatment as other steps' primary CTA)
  - Secondary link below it: **"Browse reports"** (red text link, centered)
  - No footer "Already have an account?" line on this step — confirmed absent (makes sense post-signup).

**Uncertainties flagged, not silently invented (per instructions):**
- **#1 — Email format validation before Step 1→2 transition:** reference shows no error state; sensible default (client-side well-formed-email check) recommended but not reference-confirmed.
- **#2 — OTP resend countdown behavior:** step 2 shows "Resend code in 00:28" as a static snapshot of a live countdown, plus a separate "Didn't receive it?" link. The reference cannot show the countdown's start value, tick behavior, or what happens at 00:00 (does the countdown just hit zero and reset, does the "Resend code in ..." text swap to an enabled "Resend code" action?). Sensible default: countdown starts at a reasonable value (e.g. 30s) and at 0 swaps to an enabled resend action — but this exact mechanic is NOT reference-confirmed, flag for `loop-visual-qa` / user decision.
- **#3 — Wrong-OTP error state:** not shown anywhere in the reference (only the default/mid-entry state is visible). `Input`/OTP error styling must come from the DS component's own error state (see DS Mapping Gate), not invented visually.
- **#4 — "Change" link exact behavior:** confirmed the control exists (red "Change" text next to the masked email in step 2) but the reference doesn't show its destination/behavior — most sensible default is "return to Step 1 with the email field editable," but this is inferred, not shown.
- **#5 — Full name / phone / company name shown values:** ambiguous whether "Nirvair Singh" / "98765 43210" / "Ken Research" are literal filled-in values (i.e., the design shows a mid-flow example/demo state) or placeholder text. The text renders as full-opacity dark text in the reference (not the lighter placeholder gray used for step 1's "name@company.com" placeholder) — this suggests these are meant to represent **actual field values** (a filled/example demo state) rather than placeholder copy. Recommend building these three fields with empty placeholders appropriate to each field type (e.g. "Jane Doe" / phone format hint / company name) for the real production default state, while noting the reference's exact strings are demo content, not literal placeholder copy to lock verbatim. Flag to user/QA to confirm this reading.
- **#6 — Success panel field values continuity:** step 4's info panel echoes the same name ("Nirvair Singh") and derives "nirvair@company.com" / "Ken Research account" — consistent with #5's reading that these are demo/example data flowing through the mocked steps, reinforcing that the flow should be wired to real state (whatever the user actually typed) rather than these literal strings.

---

# STEP 1 — "Create your account"

## Copy Lock
- Eyebrow/label: "GET STARTED"
- Heading: "Create your account"
- Subcopy/body: "Use your work email to create your Ken Research account."
- Input label: "Work email"
- Input placeholder: "name@company.com"
- Helper/hint text: "Use your professional email address."
- Primary button label: "Continue with work email"
- Divider text: "OR"
- Secondary/social button label: "Continue with LinkedIn"
- Footer line (plain text): "Already have an account?"
- Footer link text: "Sign in"

## DS Mapping Gate
| Element | DS component/token (actual path) | Status |
|---|---|---|
| Modal/dialog container | `projects/ken-auth-redesign/builds/src/components/AuthModal.tsx` (already built shared shell, modeled on `design-system/core-v2/src/atoms/ContactModal.tsx` structural classes) | mapped |
| Input | `design-system/core-v2/src/ui/input.tsx` (`Input`) | mapped — default `h-9` (36px) must be overridden to 48px, see Form Control Geometry |
| Primary button | `design-system/core-v2/src/atoms/Button.tsx` `variant="brand" size="lg" fullWidth` | mapped |
| Secondary/social button | `design-system/core-v2/src/atoms/Button.tsx` `variant="secondary" background="light" size="lg" icon={<Linkedin/>} iconPosition="left" fullWidth` | mapped |
| Typography (eyebrow/heading/body/helper) | `--typography-size-xs` / `-xl` / `-sm` / `-xs`, `--color-brand-red` for eyebrow | mapped |
| Links | `design-system/core-v2/src/atoms/InlineLink.tsx` ("Sign in") | mapped |
| Colors | `--color-brand-red`, `--semantic-ink-strong/-muted/-subtle` | mapped; LinkedIn brand blue → **NO DS EQUIVALENT — flag to user** |
| Radius | `--radius-card` (modal, 10px), `--radius-button` (5px, input/buttons) | mapped |
| Spacing | `--spacing-10` (40px modal padding), see Geometry Target | mapped |
| Focus state | `Input.tsx` `focus:border-black/90`; `Button.tsx` `focus-visible:ring-2 ring-[var(--color-brand-red)]` | mapped (from DS) |
| Hover state | `Input.tsx` `hover:border-black/25`; `Button.tsx` shimmer/lift | mapped (from DS) |
| Filled/active state | `Input.tsx` `border-black/15` when filled | mapped (from DS) |
| Error state | `Input.tsx` `aria-invalid:border-[var(--brand-red)]` | mapped (from DS) |
| Disabled state | `Input.tsx` `disabled:border-black/6 bg-black/[0.03] text-black/35`; `Button.tsx` `disabled:opacity-50` | mapped (from DS) |

## Modal/Card Geometry Target
- DS width token/precedent found: yes — already resolved and built in `AuthModal.tsx`
- Target modal max-width: **480px**
- Target content width (inner column): **≈400px**
- Top/bottom breathing room at ~900px viewport height: **≈75px each side** (at ≈600px estimated content height)
- Rule: modal width must not increase to fit text; text wraps within the controlled content width.

## Form Control Geometry
| Control | DS component | DS size variant | Height (DS real value) | Radius (DS token) | Shared content width? |
|---|---|---|---|---|---|
| Email input | `ui/input.tsx` | override to 48px (`h-[var(--button-height-lg)]`) | 36px default → **48px override required** | `--radius-button` (5px) | yes |
| Primary CTA | `atoms/Button.tsx` `size="lg"` | lg | 48px (`--button-height-lg`) | `--radius-button` | yes |
| Secondary/social CTA | `atoms/Button.tsx` `size="lg"` | lg | 48px (`--button-height-lg`) | `--radius-button` | yes |

All 3 share the 400px content column via `fullWidth`/`w-full`. The Input's default height is the one confirmed mismatch — non-optional override, see prior spec's detailed pixel-measurement rationale (carried forward unchanged).

## Remaining detail
- Alignment: all text left-aligned; buttons/input full-width; "OR" divider centered between two `Divider` hairlines.
- Icons: close `×` = `lucide-react X`; LinkedIn glyph = NO DS EQUIVALENT (third-party brand mark, flag to user).
- States: sourced from DS component source per table above, not from the flat reference (which shows default state only).
- Responsive: no mobile reference exists — Uncertainty carried from prior spec, unchanged.

*(Full spacing table, typography detail, borders/shadows, and UI/UX Pro Max notes for Step 1 are unchanged from `signup-email.spec.md` and are not re-duplicated verbatim here — that file remains the detailed backing reference for Step 1 specifically; this section summarizes what's authoritative going forward.)*

---

# STEP 2 — "OTP verification"

## Copy Lock
- Eyebrow/label: "VERIFY YOUR EMAIL"
- Heading: "Enter verification code"
- Subcopy/body: "We sent a 6-digit verification code to use***@company.com."
- Input label: "Work email"
- Input value (masked, read-only): "use***@company.com"
- Inline action link (beside the email field): "Change"
- Field-group label: "Enter 6-digit code"
- OTP demo state shown: digits "2", "7", "4", "9" filled, 5th slot active/focused (empty, caret visible), 6th slot empty — this is a **state demonstration**, not literal copy to lock (see DS Mapping Gate note on states)
- Helper/status line: "Resend code in 00:28"
- Link: "Didn't receive it?"
- Primary button label: "Verify & continue"
- Link: "Back to sign up"

No footer "Already have an account?" line on this step (confirmed absent).

## DS Mapping Gate
| Element | DS component/token (actual path) | Status |
|---|---|---|
| Modal/dialog container | `AuthModal.tsx` (same shared shell as Step 1) | mapped |
| Read-only email field | `design-system/core-v2/src/ui/input.tsx` (`Input`, `disabled` or `readOnly` prop) | mapped |
| Inline "Change" action | `design-system/core-v2/src/atoms/InlineLink.tsx`, positioned at the field's right edge (build note: absolutely/flex-positioned inside or beside the input row, not a native input feature) | mapped — positioning is a build-time layout decision, not a new DS primitive |
| OTP field group | `design-system/core-v2/src/ui/input-otp.tsx` (`InputOTP` / `InputOTPGroup` / `InputOTPSlot`) | mapped — **default slot styling renders a connected/shared-border group (only first/last slot corners rounded); reference shows 6 fully separate, individually-bordered/rounded boxes with visible gaps between all 6. Build note: wrap each `InputOTPSlot` in its own `InputOTPGroup` (6 separate single-slot groups) or override each slot's className to add its own full border + full radius, rather than the DS default's shared-border 4-corner rounding.** |
| Primary button | `atoms/Button.tsx` `variant="brand" size="lg" fullWidth` | mapped |
| Typography (eyebrow/heading/subcopy/labels/helper) | same token set as Step 1 | mapped |
| Links ("Change", "Didn't receive it?", "Back to sign up") | `atoms/InlineLink.tsx` | mapped |
| Colors | `--color-brand-red` (eyebrow, links, active OTP slot per reference's red-bordered 5th box), `--semantic-ink-*` | mapped |
| Radius | `--radius-card` (modal); OTP slot radius — reference shows a small rounded corner (~4-5px) per box, closest to `--radius-button` (5px), reused per-slot after the grouping override above | mapped |
| Spacing | modal padding `--spacing-10`; OTP slot gap ≈8px, closest to `--spacing-2` | mapped, gap value is a visual estimate not pixel-measured |
| Focus state | OTP: `data-[active=true]:border-ring` in DS source — reference's active-slot red border must reuse `--color-brand-red` here instead of the DS default `ring` color, since the rest of this flow's focus treatment is brand-red-keyed (see Step 1); this is a token substitution, not a new state | mapped, 1 token-substitution flag |
| Hover state | `Input.tsx`/`Button.tsx`/`InlineLink.tsx` own hover states, unchanged from Step 1 | mapped (from DS) |
| Filled/active state | OTP slot `char` rendering (filled digit) — from DS source | mapped (from DS) |
| Error state | OTP: `aria-invalid:border-destructive` in DS source — no error state shown in reference (Uncertainty #3 above), use DS default for wrong-code state | mapped (from DS), reference doesn't confirm it |
| Disabled state | `InputOTP` `has-disabled:opacity-50`; `Input.tsx` disabled styling for the read-only email field | mapped (from DS) |

**1 build-time customization required** (OTP slot grouping/border override) — not a "NO DS EQUIVALENT" gap, the primitive exists and is correct, its default *visual grouping* just needs a per-slot override to match the reference's fully-separated box treatment.

## Modal/Card Geometry Target
Same shell/token targets as Step 1 (480px / ≈400px content / 40px padding) — confirmed consistent, this step's card is visibly the shortest of the 4 (fewest form elements), well within the internal-scroll safety margin already built into `AuthModal.tsx`.

## Form Control Geometry
| Control | DS component | DS size variant | Height (DS real value) | Radius (DS token) | Shared content width? |
|---|---|---|---|---|---|
| Read-only email field | `ui/input.tsx` (disabled/readOnly) | override to 48px, matching Step 1's input | 36px default → 48px override | `--radius-button` | yes (400px column) |
| OTP slot ×6 | `ui/input-otp.tsx` `InputOTPSlot` | default is `h-9 w-9` (36×36px) — recommend keeping close to this (e.g. `h-12 w-12` / 48×48px) to match this flow's established 48px control-height rhythm, rather than the DS default 36px | 36px default → **recommend 48px override** to match rhythm with the other controls on this step | closest existing token `--radius-button` (5px) after per-slot override | the 6-slot row as a whole should span the shared 400px content width via even gaps, not stretch each individual box arbitrarily — flag as build-time layout decision |
| Primary CTA | `atoms/Button.tsx` `size="lg"` | lg | 48px | `--radius-button` | yes |

Flag: unlike Step 1 (where the height mismatch was a confirmed regression), the OTP-slot height recommendation here is a **rhythm-consistency suggestion**, not a reference-measured hard requirement — the reference's own OTP boxes were not independently pixel-measured this pass (no raw px numbers taken for this step); treat as Uncertainty for `loop-visual-qa` first-pass convergence rather than a locked number.

## Remaining detail
- Alignment: same left-aligned text rhythm as Step 1; OTP row is a horizontal group of 6 boxes with even gaps, roughly centered within (or left-aligned to, per reference) the content column — reference shows the OTP group left-aligned to the same left edge as the label above it, not centered.
- The "Resend code in 00:28" and "Didn't receive it?" sit on the same row, opposite ends (resend-status left, link right) — mirrors the label/link pairing pattern already used for "Work email" / "Change" above it.
- Icons: none beyond the close `×`.
- Responsive: no mobile reference; same Uncertainty as Step 1.

---

# STEP 3 — "Complete profile"

## Copy Lock
- Eyebrow/label: "ACCOUNT SETUP"
- Heading: "Complete your profile"
- Subcopy/body: "Your work email is verified. Add a few details to finish creating your account."
- Status pill: "Email verified"
- Input label: "Full name" — shown value: "Nirvair Singh"
- Input label: "Phone number" — country code shown: "+91"; phone value shown: "98765 43210"
- Input label: "Company name" — shown value: "Ken Research"
- Helper/hint text: "Auto-detected from your work email. You can edit this."
- Checkbox label (with embedded links): "By creating your account, you agree to our Terms of Use and Privacy Policy." — link text "Terms of Use", link text "Privacy Policy"
- Primary button label: "Create account"
- Footer line (plain text): "Already have an account?"
- Footer link text: "Sign in"

## DS Mapping Gate
| Element | DS component/token (actual path) | Status |
|---|---|---|
| Modal/dialog container | `AuthModal.tsx` (same shared shell) | mapped |
| Status pill "Email verified" | `design-system/core-v2/src/atoms/Badge.tsx` `variant="pill" size="sm" theme="success"` with a check icon (`lucide-react CheckCircle2` or `Check`) via the `icon` prop | mapped |
| Full name input | `ui/input.tsx` | mapped — 48px override, same as Step 1/2 |
| Phone: country-code select | `design-system/core-v2/src/ui/select.tsx` (`Select`/`SelectTrigger`/`SelectContent`/`SelectItem`) | mapped — default trigger height `data-[size=default]:h-9` (36px) needs the same 48px override applied to keep row-height parity with the adjacent phone-number input |
| Phone: number input | `ui/input.tsx` | mapped — 48px override |
| Company name input | `ui/input.tsx` | mapped — 48px override, pre-fillable/auto-detected value per helper copy |
| Checkbox | `design-system/core-v2/src/ui/checkbox.tsx` (`Checkbox`, Radix-based, `size-4` / 16px, `rounded-[4px]`) | mapped |
| Checkbox label links ("Terms of Use", "Privacy Policy") | `atoms/InlineLink.tsx` ×2, inline within the checkbox's label text | mapped |
| Primary button | `atoms/Button.tsx` `variant="brand" size="lg" fullWidth` | mapped |
| "Sign in" footer link | `atoms/InlineLink.tsx` | mapped |
| Typography | same token set as Steps 1–2 | mapped |
| Colors | `--color-brand-red`; success pill uses `--semantic-status-success-text` (#166534) / `-bg` (#f0fdf4) / `-border` (#bbf7d0) — all real tokens, already defined | mapped |
| Radius | `--radius-card` (modal); `--radius-button` (inputs/select/button, 5px); checkbox `rounded-[4px]` (DS-native, slightly tighter than `--radius-button` but this is the Checkbox component's own built-in radius, not overridden) | mapped |
| Spacing | modal padding `--spacing-10`; field-to-field gaps — visual estimate, not pixel-measured this pass | mapped, spacing values flagged as estimates |
| Focus state | `Input.tsx`/`Select.tsx`/`Checkbox.tsx` own focus states — Select and Checkbox default to a generic `ring-ring`/`focus-visible:ring-ring/50` token rather than brand-red; **this is a token-consistency gap** relative to Step 1/2's brand-red focus ring pattern — flag as Uncertainty for `loop-visual-qa`/user decision on whether to override Select/Checkbox focus color to brand-red for flow consistency, or accept the DS's neutral default here as an intentional "quieter" secondary-field treatment | mapped, 1 open flag |
| Hover state | `Input.tsx`/`Button.tsx`/`InlineLink.tsx`/`Checkbox` own hover states | mapped (from DS) |
| Filled/active state | `Input.tsx` `border-black/15`; `Checkbox` `data-[state=checked]:bg-primary` | mapped (from DS) — note `Checkbox`'s checked state uses `--primary` token, confirm this resolves to brand-red in this project's token mapping, not a generic blue/black primary; flag if it doesn't |
| Error state | `Input.tsx` `aria-invalid:border-[var(--brand-red)]`; `Checkbox`/`Select` `aria-invalid:ring-destructive/*` | mapped (from DS), not shown in reference |
| Disabled state | `Input.tsx`/`Select.tsx`/`Checkbox` `disabled:opacity-50` patterns | mapped (from DS) |

## Modal/Card Geometry Target
Same shell/token targets as Steps 1–2 (480px / ≈400px content / 40px padding). This step's card is visibly the **tallest** of the 4 (3 fields + checkbox + button + footer) — confirm `AuthModal.tsx`'s existing `max-h-[calc(100vh-4rem)] overflow-y-auto` actually engages at common laptop heights (~800–900px) for this step specifically, since it's the one most likely to need the internal scroll Uncertainty #I originally flagged.

## Form Control Geometry
| Control | DS component | DS size variant | Height (DS real value) | Radius (DS token) | Shared content width? |
|---|---|---|---|---|---|
| Full name input | `ui/input.tsx` | override to 48px | 36px → 48px override | `--radius-button` | yes (400px column) |
| Phone country-code select | `ui/select.tsx` `SelectTrigger` | override to 48px (default `data-[size=default]:h-9`) | 36px → 48px override | `--radius-button` (select uses `rounded-[5px]` already, matches) | **no — this control is intentionally narrower than the full 400px column** (fixed width sized to fit "+91 ⌄", e.g. ~90–100px), paired inline with the phone number input which takes the remaining width; flag: the *pair together* should span 400px, not each individually |
| Phone number input | `ui/input.tsx` | override to 48px | 36px → 48px override | `--radius-button` | paired with select above to jointly fill 400px |
| Company name input | `ui/input.tsx` | override to 48px | 36px → 48px override | `--radius-button` | yes (400px column) |
| Primary CTA | `atoms/Button.tsx` `size="lg"` | lg | 48px | `--radius-button` | yes (400px column) |

Every full-width control on this step needs the same 48px height override already established as mandatory in Step 1 — this is the same confirmed regression mechanism (Input/Select default to 36px vs. Button's 48px `lg`), now also affecting `Select`, not just `Input`.

## Remaining detail
- Checkbox row: checkbox + label text with 2 embedded links, likely `items-start` alignment (checkbox top-aligned to first line of a potentially 2-line label) rather than `items-center` — reference shows the label wrapping to 2 lines ("By creating your account, you agree to our / Terms of Use and Privacy Policy.").
- Icons: check icon inside the "Email verified" pill; no other icons besides the close `×`.
- Company name field: helper text "Auto-detected from your work email. You can edit this." implies this field should be pre-populated by build-time logic (parsed from the verified work-email domain), not left blank — a real behavior requirement, not just visual copy.
- Responsive: no mobile reference; same Uncertainty as prior steps — this step's 3-field-plus-checkbox layout is the most likely to need real mobile-breakpoint testing given its height.

---

# STEP 4 — "Success"

## Copy Lock
- Heading: "Your account is ready" (no eyebrow above it — confirmed absent, unlike steps 1–3)
- Info panel row 1 — label: "Name", value: "Nirvair Singh"
- Info panel row 2 — label: "Work email", value: "nirvair@company.com"
- Info panel row 3 — label: "Account", value: "Ken Research account"
- Primary button label: "Continue browsing"
- Link text: "Browse reports"

No subcopy line, no footer "Already have an account?" line, no eyebrow — all confirmed absent by direct inspection, not omitted by assumption.

## DS Mapping Gate
| Element | DS component/token (actual path) | Status |
|---|---|---|
| Modal/dialog container | `AuthModal.tsx` (same shared shell) | mapped |
| Heading | same typography token as other steps' heading (`--typography-size-xl`) — this step's heading also appears center-aligned rather than left-aligned like steps 1–3 (reference shows "Your account is ready" and the checkmark graphic centered in the card) — flag as a layout deviation from the shared left-aligned rhythm, confirmed by the reference itself, not an inconsistency to "fix" | mapped, 1 alignment-deviation flag (intentional per reference) |
| Success checkmark graphic (circle + check + sparkle accents) | the check-in-circle base could reasonably map to `lucide-react CheckCircle2`, colored via `--semantic-status-success-*` tokens; **the small decorative "+" / dot sparkle marks scattered around the circle have no DS icon or component equivalent** | **partially mapped — decorative sparkle accents: NO DS EQUIVALENT — flag to user** (bespoke illustration detail, do not silently fabricate an SVG; either omit the sparkle accents or ask the user/designer for the actual asset) |
| Info panel container | no dedicated "key-value list" / "summary panel" component exists anywhere in `design-system/core-v2/src/` (searched `Detail*`, `Summary*`, `KeyValue*`, `InfoPanel*` — none found) | **NO DS EQUIVALENT — flag to user.** Recommend composing from existing primitives only: a plain container using `--color-ramp-black-50` (#fafafa) background + `--radius-button` or `--radius-card` corner + internal `atoms/Divider.tsx` (`variant="subtle"`) between the 3 rows + standard typography tokens for label/value pairs — this is assembling existing tokens/atoms, not inventing a new named DS component, so it does not violate the "never invent new primitives" rule, but it has no single existing component to point to as-is. |
| Primary button ("Continue browsing") | `atoms/Button.tsx` `variant="brand" size="lg" fullWidth` | mapped |
| Secondary link ("Browse reports") | `atoms/InlineLink.tsx` OR `atoms/CTALink.tsx` — reference shows plain centered red text with no visible underline and no button affordance, closer to a bare `InlineLink` without its always-on underline (see Step 1's Uncertainty #D-equivalent) or `CTALink`'s "text + arrow" pattern minus the arrow; flag which is the better fit as an open question, both are real DS components, neither is an exact reference match | mapped, open choice between 2 real candidates |
| Colors | `--semantic-status-success-text/-bg/-border` for the green checkmark; `--color-brand-red` for button/link | mapped |
| Radius | `--radius-card` (modal); info panel container radius per composition above | mapped |
| Spacing | modal padding `--spacing-10`; internal panel row spacing — visual estimate | mapped, estimate |
| Focus state | `Button.tsx`/`InlineLink.tsx` own focus states, unchanged from other steps | mapped (from DS) |
| Hover state | `Button.tsx`/`InlineLink.tsx` own hover states | mapped (from DS) |
| Filled/active state | not applicable — no form fields on this step | n/a |
| Error state | not applicable — no form fields on this step | n/a |
| Disabled state | `Button.tsx` `disabled:opacity-50` (e.g. while a post-signup redirect is in flight) | mapped (from DS), not shown in reference |

## Modal/Card Geometry Target
Same shell/token targets as Steps 1–3 (480px / ≈400px content / 40px padding). This step's content is short (heading + icon + 3-row panel + button + link) — should sit comfortably within the same breathing-room target as Step 2, well clear of the internal-scroll threshold.

## Form Control Geometry
No form inputs on this step (informational/confirmation only). Only geometry-relevant control:
| Control | DS component | DS size variant | Height (DS real value) | Radius (DS token) | Shared content width? |
|---|---|---|---|---|---|
| Primary CTA "Continue browsing" | `atoms/Button.tsx` `size="lg"` | lg | 48px | `--radius-button` | yes (400px column) |

The info panel and "Browse reports" link are not form controls, so the mandatory geometry-consistency table doesn't strictly apply to them, but both should still align to the same 400px content column width for visual consistency with the rest of the flow.

## Remaining detail
- Layout deviation (confirmed by reference, not a build error): this step's heading + icon + panel are center-aligned, unlike the left-aligned text rhythm on steps 1–3. Reproduce this centering faithfully — it is what the reference shows, not a fidelity mistake.
- Two CTAs present: primary button "Continue browsing" and a secondary link "Browse reports" beneath it — both confirmed, do not drop either.
- Icons: green checkmark circle (see DS Mapping Gate — partial gap on the sparkle accents).
- Responsive: no mobile reference; same open Uncertainty as prior steps.

---

## UI/UX Pro Max Notes (advisory only — applies across all 4 steps, never overrides reference/DS/geometry above)

- **Step transitions / progress disclosure**: general usability guidance recommends a visible step indicator (e.g. "Step 2 of 3") for multi-step flows so users know how much is left — the reference shows no such indicator on any of the 4 screens. This is advisory only; the reference is the source of truth and doesn't include one, so none should be added unless the user explicitly requests it as a deviation from the reference.
- **OTP field accessibility**: recommend `inputmode="numeric"` and `autocomplete="one-time-code"` on the OTP slots for mobile numeric keypad + SMS autofill — advisory, doesn't change any DS token/component identity, purely an attribute-level accessibility improvement layered onto the existing `input-otp.tsx`.
- **Checkbox required-field messaging**: Step 3's terms checkbox has no visible error/required-state treatment in the reference (default-only); recommend surfacing a validation message if the user tries to submit unchecked, using the DS's existing `aria-invalid` pattern already documented in the DS Mapping Gate above — advisory, no new component needed.
- **Success-step redirect timing**: if "Continue browsing" or an automatic redirect is intended after account creation, recommend giving the user control (no auto-redirect without an explicit, visible CTA) — the reference already satisfies this by showing 2 explicit CTAs and no auto-redirect countdown, so this is confirmation, not a change.
- **Masked email + "Change" link discoverability**: general guidance suggests the "Change" affordance should be clearly distinguishable as interactive (already red/link-styled per the reference) — no change recommended, confirming existing treatment.
- **Responsive breakpoint testing**: same general recommendation as the single-step spec (test at 320/375/414/768/1024/1440) — flagged as a `loop-visual-qa` action item across all 4 steps, no mobile reference exists for any of them.

None of the above changes colors, typography, spacing tokens, radius, or component identity already fixed by the DS Mapping Gates above — advisory only.

---

## Consolidated uncertainties requiring visual convergence (all steps)

- **#1** — Step 1→2 email validation before transition: no error state shown, sensible default recommended.
- **#2** — Step 2 OTP resend countdown start value / zero-state behavior: not shown, sensible default recommended.
- **#3** — Step 2 wrong-OTP error state: not shown, use DS component's own error state.
- **#4** — Step 2 "Change" link exact destination/behavior: control exists, behavior not shown.
- **#5** — Step 3 field values ("Nirvair Singh" etc.): read as demo/example content, not literal placeholder copy to lock; recommend field-appropriate placeholders for production default state.
- **#6** — Step 4 panel values continuity with #5's reading — reinforces wiring to real form state, not literal reference strings.
- **#7** — Step 2 OTP slot grouping: DS default renders connected/shared-border boxes; reference shows fully separated boxes — build-time per-slot override required (not a missing primitive).
- **#8** — Step 2 OTP slot height: reference not independently pixel-measured this pass; 48px recommended for rhythm consistency, flagged (not a hard measured target like Step 1's input height).
- **#9** — Step 3 Select/Checkbox focus-ring color: DS defaults to a neutral `ring` token, not brand-red like Input/Button on other steps — decide whether to override for flow consistency.
- **#10** — Step 3 Checkbox checked-state `--primary` token: confirm it resolves to brand-red in this project, not a generic default.
- **#11** — Step 4 decorative sparkle accents around the checkmark: NO DS EQUIVALENT, bespoke illustration detail — omit or source the real asset, do not fabricate.
- **#12** — Step 4 info panel: no existing DS component for a key-value summary list; must be composed from existing primitives (Divider + typography + a plain container), not invented as a new named component.
- **#13** — Step 4 "Browse reports" link: open choice between `InlineLink` (minus its always-on underline) and `CTALink`, neither is an exact match.
- **#14** — Step 4 heading/panel center-alignment vs. steps 1–3's left-alignment: confirmed intentional by the reference, not a bug — flagged only so `loop-builder`/`loop-visual-qa` don't "fix" it to match the other steps.
- **#H (carried from Step 1's prior spec)** — non-padding spacing values across all steps remain visual estimates, not independently pixel-measured this pass, except where explicitly noted as measured (Step 1's 480/400/40px/48px figures, carried from the prior geometry-focused re-analysis).
- **#F (carried)** — no mobile/responsive reference exists for any of the 4 steps.
