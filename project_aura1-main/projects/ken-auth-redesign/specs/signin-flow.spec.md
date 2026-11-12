Reference Source: Figma
Reference Type: Frame (contains 3 stacked flat raster images, one per step)
Figma File URL: https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login
Figma Frame/Node URL: https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=550-73 (frame "SignIn")
Step node URLs:
- Step 1 "Sign in": node 554:85 ("image 20") — https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=554-85
- Step 2 "OTP verification": node 554:88 ("image 21") — https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=554-88
- Step 3 "Success": node 554:91 ("image 22") — https://www.figma.com/design/PJtPivOzEkiTjSkGnZ2YtH/Login?node-id=554-91

---

## Reuse note (why this pass is lighter than the sign-up cycle)

This spec is a companion to `projects/ken-auth-redesign/specs/signup-flow.spec.md`, which is already built and PASSED Loop QA at `projects/ken-auth-redesign/builds/`. All shared-shell decisions from that cycle — `AuthModal.tsx` (480px card, `p-10`, `--radius-card`, `max-h-[calc(100vh-4rem)] overflow-y-auto`), `InlineLink.tsx` (`variant="default"|"solid"|"muted"`), 48px form-control-height override pattern for `Input`/`Button`/`Select`, `InputOTP` per-slot separated-box override, `Badge.tsx` success pill pattern, token set (`--color-brand-red`, `--semantic-*`, `--radius-card`, `--radius-button`) — are re-confirmed unchanged below, not re-derived. This spec focuses effort on: (a) verbatim Copy Lock per step, since sign-in's copy is NOT identical to sign-up's equivalent steps in several places, and (b) confirming step-2/step-3 structural parity vs. sign-up's OTP and success steps.

All 3 step nodes are flat raster images (1122×1402px each, `object-cover`, no Auto Layout, no component instances, no text nodes) stacked vertically inside frame `550:73` at y-offsets 0 / 1548 / 3096. Visual-reference-only per Loop Mode rules. All 3 screenshots fetched individually at `maxDimension=2200` (native 1122×1402, no upscale needed) and visually inspected in full.

---

# COMMON AUTH SHELL (all 3 steps) — confirmed identical to sign-up's shell

- Same dimmed marketing-page backdrop behind the modal (navbar, dark hero, "How We Help" row, stat counters, "Insights That Drive Growth" cards) — backdrop context only, not part of the build target.
- Same modal chrome: white rounded card, centered over a dark scrim, same horizontal card position as sign-up's frame (same underlying background mockup, confirming the shared `AuthModal.tsx` shell applies unchanged).
- Same close control: `×` icon, top-right inset — present on all 3 steps (including step 3, "Success"), same as sign-up's step 4 also showing it.
- Same left-aligned text rhythm on steps 1–2 (eyebrow → bold heading → gray subcopy); step 3 is center-aligned (heading, subcopy, icon, panel all centered) — same layout-deviation pattern already established and accepted for sign-up's step 4, not a new decision.
- Same primary-CTA treatment: full-width red button, bold white label, bottom of the form stack, all 3 steps.
- **No password field anywhere in the flow.** Confirmed by direct inspection of step 1 — sign-in is the same passwordless email + OTP pattern as sign-up, not a separate credential-entry mechanism. This matters because it means step 1 → step 2 → step 3 is structurally the same shape as sign-up's step 1 → step 2, just without a profile-completion step in between (per the task brief's stated requirement, now visually confirmed — the reference shows no 4th "complete details" screen anywhere in this frame).

**Existing built shell reused unmodified:** `projects/ken-auth-redesign/builds/src/components/AuthModal.tsx` — no shell-level changes required for sign-in; only step-content children differ.

**Step-runner requirement:** a parent component (e.g. `SigninFlow.tsx`, analogous to the existing `SignupFlow.tsx`) must own `currentStep` state and render `<AuthModal>{stepContent}</AuthModal>`, same pattern as sign-up.

---

# STEP-TRANSITION / INTERACTION LOGIC

- **Step 1 → Step 2:** "Continue with work email" advances to OTP verification. Confirmed by copy continuation: step 2's subcopy reads "We sent a 6-digit verification code to use***@company.com," directly following from step 1's email submission — identical causal pattern to sign-up. No inline validation/error state shown (same Uncertainty as sign-up's #1, carried forward, not re-numbered).
- **Step 2 → Step 3:** valid OTP entry + "Verify & sign in" advances directly to the Success step ("Welcome back"). **Confirmed: no profile-completion step in between** — the reference frame contains exactly 3 stacked images for this flow (554:85, 554:88, 554:91), nothing else at any other y-offset in frame `550:73`. This matches the user's stated requirement exactly; not an assumption.
- **Step 2 also has the same two distinct back-style controls as sign-up:** a red "Change" link inline with the masked email field (email-specific), and a separate plain-text "Back to sign in" link at the bottom of the card (full step-back to step 1). Do not conflate them.
- **Step 3 (Success):** exact final-state content, transcribed verbatim below. Two CTAs present ("Continue browsing" + "Browse reports"), same as sign-up's step 4 — the "no CTA unless explicitly shown" default does not suppress them here either.

---

# STEP 1 — "Sign in"

## Copy Lock
- Eyebrow/label: "WELCOME BACK"
- Heading: "Sign in"
- Subcopy/body: "Sign in to your Ken Research account using your registered work email."
- Input label: "Work email"
- Input placeholder: "name@company.com"
- Helper/hint text: "Use your registered professional email address."
- Primary button label: "Continue with work email"
- Divider text: "OR"
- Secondary/social button label: "Continue with LinkedIn"
- Footer line (plain text): "New to Ken Research?"
- Footer link text: "Create account"

**Differences vs. sign-up Step 1 (do not assume identical — verified):**
| Slot | Sign-up Step 1 | Sign-in Step 1 |
|---|---|---|
| Eyebrow | "GET STARTED" | "WELCOME BACK" |
| Heading | "Create your account" | "Sign in" |
| Subcopy | "Use your work email to create your Ken Research account." | "Sign in to your Ken Research account using your registered work email." |
| Helper text | "Use your professional email address." | "Use your registered professional email address." (word "registered" added) |
| Primary CTA | "Continue with work email" | "Continue with work email" — **identical** |
| Footer | "Already have an account?" / "Sign in" | "New to Ken Research?" / "Create account" — flipped direction, as expected for the reverse flow |

Placeholder, divider text, and secondary CTA label ("Continue with LinkedIn") are identical to sign-up.

## DS Mapping Gate
| Element | DS component/token (actual path) | Status |
|---|---|---|
| Modal/dialog container | `projects/ken-auth-redesign/builds/src/components/AuthModal.tsx` (shared shell, unmodified) | mapped |
| Input | `design-system/core-v2/src/ui/input.tsx` (`Input`) | mapped — 48px height override, same as sign-up |
| Primary button | `design-system/core-v2/src/atoms/Button.tsx` `variant="brand" size="lg" fullWidth` | mapped |
| Secondary/social button | `atoms/Button.tsx` `variant="secondary" background="light" size="lg" icon={<Linkedin/>} iconPosition="left" fullWidth` | mapped — same LinkedIn glyph reused from sign-up build (`icons/LinkedInGlyph.tsx`) |
| Typography (eyebrow/heading/body/helper) | same token set as sign-up: `--typography-size-xs` / `-xl` / `-sm` / `-xs`, `--color-brand-red` for eyebrow | mapped |
| Links | `atoms/InlineLink.tsx` ("Create account") | mapped |
| Colors | `--color-brand-red`, `--semantic-ink-strong/-muted/-subtle` | mapped; LinkedIn brand blue — already flagged NO DS EQUIVALENT in sign-up spec, same asset reused, not re-flagged as new |
| Radius | `--radius-card` (modal), `--radius-button` (input/buttons) | mapped |
| Spacing | `--spacing-10` (40px modal padding) | mapped |
| Focus state | `Input.tsx` `focus:border-black/90`; `Button.tsx` `focus-visible:ring-2 ring-[var(--color-brand-red)]` | mapped (from DS) |
| Hover state | `Input.tsx` `hover:border-black/25`; `Button.tsx` shimmer/lift | mapped (from DS) |
| Filled/active state | `Input.tsx` `border-black/15` when filled | mapped (from DS) |
| Error state | `Input.tsx` `aria-invalid:border-[var(--brand-red)]` | mapped (from DS) |
| Disabled state | `Input.tsx`/`Button.tsx` disabled styling | mapped (from DS) |

## Modal/Card Geometry Target
- DS width token/precedent found: yes — already built, reused unmodified from sign-up cycle.
- Target modal max-width: **480px** (confirmed — same underlying background mockup frame, same card x-position as sign-up's screenshots).
- Target content width (inner column): **≈400px**.
- Top/bottom breathing room at ~900px viewport height: **≈75px each side**, same as sign-up Step 1 (shortest-content step in this flow, comparable field count to sign-up's Step 1).
- Rule: modal width must not increase to fit text; text wraps within the controlled content width.

## Form Control Geometry
| Control | DS component | DS size variant | Height (DS real value) | Radius (DS token) | Shared content width? |
|---|---|---|---|---|---|
| Email input | `ui/input.tsx` | override to 48px | 36px default → 48px override | `--radius-button` | yes |
| Primary CTA | `atoms/Button.tsx` `size="lg"` | lg | 48px | `--radius-button` | yes |
| Secondary/social CTA | `atoms/Button.tsx` `size="lg"` | lg | 48px | `--radius-button` | yes |

No new mismatch vs. sign-up — identical 3-control geometry shape (input + primary CTA + social CTA), same 400px shared content width, same 48px override requirement.

## Remaining detail
- Alignment/icons/states: identical pattern to sign-up Step 1, not re-derived.
- Responsive: no mobile reference — same open Uncertainty as sign-up, carried forward.

---

# STEP 2 — "Verify your sign in" (OTP)

## Copy Lock
- Eyebrow/label: "SECURITY CHECK"
- Heading: "Verify your sign in"
- Subcopy/body: "We sent a 6-digit verification code to use***@company.com."
- Input label: "Work email"
- Input value (masked, read-only): "use***@company.com"
- Inline action link (beside the email field): "Change"
- Field-group label: "Enter 6-digit code"
- OTP demo state shown: digits "1", "7", "3", "9" filled, 5th slot active/focused (empty, red-bordered caret box), 6th slot empty — a **state demonstration**, not literal copy to lock (same treatment as sign-up; note the digit sequence differs from sign-up's demo "2749" — both are non-literal example values, not a discrepancy to reconcile)
- Helper/status line: "Resend code in 00:28"
- Link: "Didn't receive it?"
- Primary button label: "Verify & sign in"
- Link: "Back to sign in"

No footer "New to Ken Research?" line on this step (confirmed absent, same pattern as sign-up's step 2 having no footer).

**Differences vs. sign-up Step 2 (verified, not assumed identical):**
| Slot | Sign-up Step 2 | Sign-in Step 2 |
|---|---|---|
| Eyebrow | "VERIFY YOUR EMAIL" | "SECURITY CHECK" |
| Heading | "Enter verification code" | "Verify your sign in" |
| Subcopy | "We sent a 6-digit verification code to use***@company.com." | **identical** |
| "Work email" field + "Change" link | identical | **identical** |
| "Enter 6-digit code" label | identical | **identical** |
| "Resend code in 00:28" / "Didn't receive it?" | identical | **identical** |
| Primary CTA | "Verify & continue" | "Verify & sign in" |
| Bottom link | "Back to sign up" | "Back to sign in" |

So step 2 is **not** a verbatim reuse of sign-up's OTP screen — the eyebrow, heading, primary CTA label, and bottom link all differ, even though the field/link/helper-text structure is identical. Build must not hardcode sign-up's step-2 copy for this step.

## DS Mapping Gate
Identical to sign-up Step 2's DS Mapping Gate, same components, same 1 build-time customization (OTP per-slot separated-box override) and same token substitution (active-slot border → `--color-brand-red` instead of DS default ring color). Not re-tabulated in full; see `signup-flow.spec.md` Step 2 DS Mapping Gate for the authoritative row-by-row mapping — every row applies unchanged here (same components: `AuthModal.tsx`, `ui/input.tsx` read-only email, `atoms/InlineLink.tsx` for "Change"/"Didn't receive it?"/"Back to sign in", `ui/input-otp.tsx`, `atoms/Button.tsx`).

One addition specific to this step: the active OTP slot in the reference is the **5th** box (vs. sign-up's reference also showing an active box mid-sequence) — same visual treatment (red border), no new decision needed.

## Modal/Card Geometry Target
Same shell/token targets as Step 1 and as sign-up's Step 2 (480px / ≈400px content / 40px padding). This step's card is visibly the shortest of the 3, same as it was the shortest of sign-up's 4 — no new geometry decision.

## Form Control Geometry
Identical to sign-up Step 2's table: read-only email field (48px override), OTP slots ×6 (36px default → 48px rhythm-consistency recommendation, same open Uncertainty, not independently pixel-measured this pass either), primary CTA (48px). No new mismatch introduced by sign-in's version of this step.

## Remaining detail
- Layout/alignment identical to sign-up Step 2 (OTP row left-aligned to the label above it, "Resend code"/"Didn't receive it?" on the same row at opposite ends).
- Responsive: no mobile reference, same open Uncertainty.

---

# STEP 3 — "Welcome back" (Success)

## Copy Lock
- Heading: "Welcome back" (no eyebrow above it — confirmed absent)
- Subcopy/body: "You're successfully signed in to your Ken Research account." — **note: this step DOES have a subcopy line**, unlike sign-up's equivalent success step (step 4), which had no subcopy at all. Confirmed by direct inspection, not an oversight.
- Info panel row 1 — label: "Signed in as", value: "nirvair@company.com"
- Info panel row 2 — label: "Status", value: "Verified sign-in" — **shown in green text** (semantic-success color), not plain black
- Primary button label: "Continue browsing"
- Link text: "Browse reports"

No footer "New to Ken Research?" line on this step — confirmed absent (same pattern as sign-up's success step).

**Differences vs. sign-up Step 4 (verified, not assumed identical):**
| Slot | Sign-up Step 4 | Sign-in Step 3 |
|---|---|---|
| Heading | "Your account is ready" | "Welcome back" |
| Subcopy | none (absent) | **present**: "You're successfully signed in to your Ken Research account." |
| Info panel row count | 3 rows (Name / Work email / Account) | **2 rows** (Signed in as / Status) |
| Info panel row 1 | "Name: Nirvair Singh" | "Signed in as: nirvair@company.com" |
| Info panel row 2 | "Work email: nirvair@company.com" | "Status: Verified sign-in" (green value text) |
| Info panel row 3 | "Account: Ken Research account" | — (not present) |
| Primary CTA | "Continue browsing" | "Continue browsing" — **identical** |
| Secondary link | "Browse reports" | "Browse reports" — **identical** |
| Icon (check-in-circle + sparkle accents) | present | present, same visual treatment |

Sign-in's success panel is genuinely shorter (2 rows vs. 3) and introduces a new visual detail not present in sign-up's version: a **colored (green) value** inside the info panel row, tied to a semantic status. Do not build this panel as a copy-paste of sign-up's 3-row version with rows deleted — the row content and the colored-value treatment are both new.

## DS Mapping Gate
Same base components as sign-up Step 4 (`AuthModal.tsx`, check-in-circle icon, info panel composed from primitives, `atoms/Button.tsx`, `InlineLink.tsx`/`CTALink.tsx` open choice for "Browse reports" — same unresolved choice, not re-decided here). One addition:

| Element | DS component/token (actual path) | Status |
|---|---|---|
| Info panel row 2 value ("Verified sign-in", green) | compose using `--semantic-status-success-text` (same token already identified for the "Email verified" pill in sign-up Step 3) applied directly to the value text span, not a pill/badge this time — reference shows plain colored text, no pill chrome around it | mapped — token reuse, no new token needed, just a different application (text color vs. pill background) than sign-up's Badge usage |
| Info panel container | same as sign-up Step 4: **NO DS EQUIVALENT** for a dedicated key-value/summary-panel component — compose from `--color-ramp-black-50` background + `--radius-button`/`--radius-card` + `atoms/Divider.tsx` (`variant="subtle"`) between the 2 rows + typography tokens, same recipe as sign-up, now with 2 rows instead of 3 | NO DS EQUIVALENT — flag to user (same flag carried from sign-up, not a new gap) |
| Success checkmark + sparkle accents | same as sign-up: checkmark maps to `lucide-react CheckCircle2` / equivalent via `--semantic-status-success-*`; sparkle accents have no DS equivalent | partially mapped — sparkle accents: NO DS EQUIVALENT — flag to user (same as sign-up, not new) |

## Modal/Card Geometry Target
Same shell/token targets as Steps 1–2 (480px / ≈400px content / 40px padding). This step's content is shorter than sign-up's equivalent (2-row panel + subcopy line vs. 3-row panel, no subcopy) — comfortably within the same breathing-room target, no new scroll-engagement concern.

## Form Control Geometry
No form inputs (informational/confirmation only), same as sign-up Step 4.
| Control | DS component | DS size variant | Height (DS real value) | Radius (DS token) | Shared content width? |
|---|---|---|---|---|---|
| Primary CTA "Continue browsing" | `atoms/Button.tsx` `size="lg"` | lg | 48px | `--radius-button` | yes (400px column) |

## Remaining detail
- Center-aligned layout (heading, subcopy, icon, panel, CTA) — same confirmed intentional deviation from steps 1–2's left-aligned rhythm, matching sign-up's step 4 pattern.
- Two CTAs present, both confirmed, do not drop either.
- Responsive: no mobile reference, same open Uncertainty as prior steps.

---

## UI/UX Pro Max Notes (advisory only — applies across all 3 steps, never overrides reference/DS/geometry above)

- **Step indicator**: same advisory as sign-up — no step-progress indicator ("Step 2 of 3") shown in the reference; advisory only, do not add unless the user explicitly requests a deviation.
- **OTP field accessibility**: same recommendation as sign-up — `inputmode="numeric"` + `autocomplete="one-time-code"` on the OTP slots, attribute-level only, no component/token change.
- **"Verified sign-in" status color as sole differentiator**: the green text on Step 3's "Status" row conveys success by color alone; recommend confirming the existing `--semantic-status-success-text` token carries sufficient contrast (already validated in sign-up's success-pill usage) and consider whether a small check icon beside the text would reinforce the state non-color-dependently — advisory only, reference shows text-only, do not add an icon unless the user requests the deviation.
- **Reused OTP entry point discoverability**: since step 2 here is visually near-identical in structure to sign-up's OTP step but reached from a different entry point, recommend the two `OtpVerificationStep`-style components (if built as separate files) share the same underlying component with copy passed as props, rather than being duplicated — this is a code-reuse suggestion for `loop-builder`, not a design/token change, and is consistent with "existing implementation patterns" priority (lowest tier) rather than overriding anything above it.
- **Responsive breakpoint testing**: same general recommendation as sign-up (320/375/414/768/1024/1440), no mobile reference exists for any of the 3 steps.

None of the above changes colors, typography, spacing tokens, radius, or component identity already fixed by the DS Mapping Gates above — advisory only.

---

## Consolidated uncertainties requiring visual convergence

- **#1** — Step 1→2 email validation before transition: no error state shown, sensible default recommended (carried from sign-up's #1).
- **#2** — Step 2 OTP resend countdown start value / zero-state behavior: not shown, sensible default recommended (carried from sign-up's #2).
- **#3** — Step 2 wrong-OTP error state: not shown, use DS component's own error state (carried from sign-up's #3).
- **#4** — Step 2 "Change" link exact destination/behavior: control exists, behavior not shown (carried from sign-up's #4).
- **#7** — Step 2 OTP slot grouping: DS default renders connected/shared-border boxes; reference shows fully separated boxes — build-time per-slot override required, same as sign-up's #7, not a new gap.
- **#8** — Step 2 OTP slot height: not independently pixel-measured this pass either; 48px rhythm-consistency recommendation carried from sign-up's #8.
- **#11** — Step 3 decorative sparkle accents around the checkmark: NO DS EQUIVALENT (carried from sign-up's #11).
- **#12** — Step 3 info panel: no existing DS component for a key-value summary list; compose from primitives (carried from sign-up's #12, now 2 rows instead of 3).
- **#13** — Step 3 "Browse reports" link: open choice between `InlineLink` and `CTALink` (carried from sign-up's #13, unresolved).
- **#14** — Step 3 center-alignment vs. steps 1–2's left-alignment: confirmed intentional by the reference (carried from sign-up's #14 pattern).
- **#15 (new)** — Step 3's "Verified sign-in" green value text: confirm `--semantic-status-success-text` token provides sufficient contrast when applied directly to inline text (not inside a pill background, unlike sign-up's "Email verified" badge usage) — visually plausible from the reference but not independently contrast-checked this pass.
- **#F (carried)** — no mobile/responsive reference exists for any of the 3 steps.
