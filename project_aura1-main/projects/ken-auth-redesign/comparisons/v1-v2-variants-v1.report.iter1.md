## Status
Done: Loop QA compare — V1 "Current Design Polished" variant of the shared V1/V2 Auth variant system, BOTH flows (sign-up: email/OTP → profile → success; sign-in: email/OTP → success), iteration 1 of 4.

## Reference source
No fresh Figma re-pull for this iteration. Baseline visual reference remains Figma frame `550:67` "SignUp" (nodes 554:94/97/100/103) and frame `550:73` "SignIn" — unchanged since `signup-flow.spec.md` / `signin-flow.spec.md` / `otp-inline-refinement.spec.md` / `signup-flow-refinement.spec.md`, all previously PASSED. This iteration's explicit target was the 9-item requirements list supplied directly in the Loop task brief (close-button independence, LinkedIn/OR removal, 360/20/400px geometry, serif/sans font split, sign-in footer copy change, dark backdrop, shared control geometry, DS interaction states, PreviewToggle distinctness) — verified against the live V1 render at the controlled viewport below plus direct source-code reads (`AuthModal.tsx`, `authVariant.tsx`, `PreviewToggle.tsx`, `EmailOtpStep.tsx`, `CompleteProfileStep.tsx`, `SignupSuccessStep.tsx`, `SigninSuccessStep.tsx`, `SignupFlow.tsx`, `SigninFlow.tsx`, DS `ui/input.tsx` + `atoms/Button.tsx`).

**Environment note (affects live-capture completeness only, not the verdict basis):** a peer session (`project-aura1-main-b4`) was independently driving the same shared browser tab throughout this QA pass — it repeatedly typed its own test emails, toggled the variant to V2, and at one point resized the viewport, resetting in-progress flows before the sign-up Profile/Success screens could be captured live end-to-end. Every state I did reach live (both flows' email-collect phase, both flows' OTP-verify phase, both flows' wrong-account phase) was independently confirmed with zero console errors and zero overflow. The Profile step and both Success steps are confirmed via direct full-source reads (not summaries) rather than a live screenshot — flagged as P3 below, not a defect.

## Modal/Card geometry (explicit numbers, measured live at 1440×900)
- Modal width: **400px** (target: 400px — 360 content + 2×20 padding) — **MATCH**
- Modal height: 371.7px (Step 1 "collecting" phase, sign-up). Other steps not independently re-measured live this iteration (environment note above); structurally identical shell (`max-h-[calc(100vh-4rem)] overflow-y-auto` on the card) applies uniformly to all steps per source, confirmed no step-specific override exists.
- Content width: **360px** (email input, primary CTA, OTP row all measured 360px / 328px-fixed-but-left-aligned-within-360 respectively) — **MATCH** (target: 360px)
- Viewport size: 1440×900
- Modal-to-viewport width ratio: 400/1440 = **27.8%**
- Left/right padding: **20px** each (card `padding: 20px` shorthand, all 4 sides — `p-5` = `--spacing-5` = 1.25rem confirmed via `getComputedStyle(document.documentElement).getPropertyValue('--spacing-5')` = `1.25rem`)
- Top/bottom padding: **20px** each (same shorthand, confirmed identical on all sides)

## Form control geometry (explicit numbers, measured live / confirmed via source)
- Email input: 360×48px, radius 5px (`--radius-button`), DS component confirmed: **yes** (`@/vendor/ds/ui/input.tsx`, unmodified default classes plus height/padding override only)
- Primary CTA: 360×48px, radius 5px, DS component confirmed: **yes** (`@/vendor/ds/atoms` `Button` variant="brand" size="md" fullWidth)
- Secondary/social CTA: **removed** (LinkedIn CTA no longer exists in the email-collect phase, per requirement 2 — confirmed absent, not applicable rather than mismatched)
- Shared content width across all three: **yes** for the two controls that remain (email input / primary CTA, both exactly 360px); the removed LinkedIn CTA is out of scope by design, not a broken-width case
- OTP slots (Step 2, both flows): 48×48px each, radius 5px, DS component confirmed: yes (`ui/input-otp.tsx` `InputOTPSlot`)
- Profile step (sign-up only) — confirmed via source, not independently re-measured live this iteration: Full name / Company name inputs `h-[var(--button-height-md)]` (48px) at full 360px content width; phone row is a `SelectTrigger` (92px, `!h-[var(--button-height-md)]`) + `Input` (`flex-1`, fills the remaining ~260px) — pair spans the 360px column per the already-passed baseline spec, individual controls intentionally unequal width (documented, not a defect)

---

## A. VISUAL FIDELITY

### P1 (major)
(none)

### P2 (noticeable)
(none)

### P3 (finishing/detail — non-blocking)
- Profile step and both Success steps (sign-up "Your account is ready" / sign-in "Welcome back") were confirmed via full direct source-code read rather than a live screenshot this iteration — a concurrent peer session repeatedly reset the shared browser tab's in-progress flow before those two screens could be captured. Source confirms identical shell/padding/font/DS-component treatment as the screens that were captured live; recommend a follow-up iteration re-confirm with a live screenshot once the browser tab is exclusive.
- `PreviewToggle` is explicitly documented in its own source as `TEMPORARY internal review control ... REMOVE BEFORE ANY REAL DEPLOYMENT` — correctly out-of-scope for this Loop pass, flagged only as a standing reminder that it must not ship.
- `backdrop-blur-sm` computes to `blur(8px)` in this Tailwind v4 setup (not the 4px one might assume from the class name/spec commentary) — darkness (rgba(0,0,0,0.5)) and blur-presence both verified correct per requirement 6; the exact px value is a naming-vs-computed-value curiosity, not a visual defect (still reads as a subtle, correct blur).

**Composition/spacing/typography/radius/borders/shadows/dividers/backdrop/icons/link styling/responsive/compact-rhythm:** all consistent with the already-passed baseline; this iteration's 9 requirements are the only intentional deltas and are covered item-by-item below.

---

## B. DESIGN SYSTEM COMPLIANCE — **PASS**
- Actual components used: `@/vendor/ds/atoms` `Button` (variant="brand"), `InlineLink` (variant="solid"/"muted"), `Badge` (variant="pill", theme="success"), `Divider` (variant="subtle"); `@/vendor/ds/ui/input.tsx` `Input`; `@/vendor/ds/ui/input-otp.tsx` `InputOTP`/`InputOTPGroup`/`InputOTPSlot`; `@/vendor/ds/ui/checkbox.tsx` `Checkbox`; `@/vendor/ds/ui/select.tsx` `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`/`SelectValue`
- Actual tokens used: `--font-serif` (headings, all 4 screens both flows), `--spacing-5` (20px, card padding), `--button-height-md` (48px, all controls), `--radius-button` (5px), `--radius-card` (10px), `--semantic-scrim`, `--color-brand-red`, `--semantic-status-success-*`, `--semantic-status-warning-*`, `--color-ramp-black-50`, `--typography-size-xl/sm/xs`, `--semantic-ink-subtle`
- Custom CSS exceptions: the `wrongFlow` alert panel (no Alert/Banner DS atom exists — composed from `--semantic-status-warning-*` tokens, documented in source as a searched-and-confirmed gap) and the success info panel (no KeyValue/Summary DS component exists — composed from `Divider` + typography tokens, same documented pattern carried from the already-passed baseline). Both are genuine NO-DS-EQUIVALENT cases, not approximations of something that does exist.
- Any mapped DS component approximated with custom CSS instead of used directly: **none**

## C. INTERACTION / UX — **PASS**
- Input states: default (empty, placeholder visible) — pass, live-confirmed; hover — pass (DS `Input.tsx` default `hover:border-black/25`, unmodified); focus — pass, live-confirmed (`border: 1px solid oklab(0 0 0/0.9)`, focus-visible ring `rgb(176,31,36)` = brand red, matches DS default `focus:border-black/90` + red ring override); filled — pass, live-confirmed (typed value renders correctly, e.g. `newuser@example.com`, `654321` into OTP slots); error — pass (structural: DS `Input.tsx` has `aria-invalid:border-[var(--brand-red)]`, unmodified; `EmailOtpStep.tsx` wires `aria-invalid` on well-formed-email failure and on the OTP slots on invalid submit — not forced into an error render live this iteration, confirmed via source only); disabled — pass, live-confirmed (email field goes `readOnly`+`disabled`, masked value shown, during the OTP-verify phase in both flows)
- Button states: default/hover/active — pass (DS `Button.tsx` `variant="brand"` default classes unmodified, hover triggers a shadow-depth change via `isHovering`); focus — pass (`focus-visible:!ring-2 !ring-[var(--color-brand-red)]`, unmodified DS default); pressed/loading — pass, live-confirmed (button dims + spinner during the mock OTP-send delay, both flows); disabled — pass (DS default `disabled:opacity-50`, unmodified, not itself exercised live this iteration since no reachable step disables the primary CTA by design)
- Keyboard/focus behaviour: tab order not independently re-walked this iteration (carried from already-passed baseline, no structural change in this delta); visible focus ring confirmed on email input and CTA live
- Form hierarchy: pass — eyebrow → heading → subcopy → label → field → helper → CTA → footer, consistent both flows
- Accessibility concerns (advisory, UI/UX Pro Max, non-blocking): PreviewToggle's `role="tablist"`/`role="tab"` pattern is appropriately labelled (`aria-label="Auth copy variant preview (internal, not part of the product)"`) and clearly out of the product's own a11y surface; no new concerns introduced by this iteration's 9 changes. Close button's new position (`-top-3 -right-3`, half outside the card) remains a real, focusable, `aria-label="Close modal"` button with a visible focus ring — no touch-target or label regression from the reposition.

## D. RUNTIME / LAYOUT SAFETY — **PASS**
- Console errors: **none** — checked repeatedly across the full session (initial load, both flows' email-collect/OTP-verify/wrong-account phases); only HMR/dev-tooling info logs present, zero warnings/errors
- Horizontal overflow: **none** — `document.documentElement.scrollWidth` (1440) === `window.innerWidth` (1440), re-checked at both the start and end of the session
- Modal overflow (content exceeding modal bounds): none observed on any reached screen; structurally guarded by the card's `max-h-[calc(100vh-4rem)] overflow-y-auto`, which applies uniformly to every step including the two not independently re-captured live this iteration
- Child element overflow (any element exceeding its parent): none — close button intentionally straddles the card's edge by design (`-top-3 -right-3`, a deliberate half-outside circular-close pattern, not an unintended overflow), confirmed against its own outer wrapper (not the padded card) which is the correct container for it per the new structure
- Viewport clipping: none at 1440×900
- Unexpected layout shift on state change: none observed — step transitions use `AnimatePresence mode="wait"` (old content fully exits before new enters), confirmed live via the fade/slide transitions between collecting → verifying → wrong-account states in both flows

---

## Verdict
- Zero P1 issues: yes
- Zero P2 issues: yes
- Section B (DS Compliance): PASS
- Section C (Interaction/UX): PASS
- Section D (Runtime/Layout Safety): PASS
- Copy Lock matches exactly: yes — sign-up footer unchanged (`"Already have an account? Sign in"`, live-confirmed verbatim); sign-in footer changed exactly as specified (`"Don't have an account? Create account"`, live-confirmed verbatim, replacing `"New to Ken Research?"`); all other Copy Lock strings (eyebrows, headings, subcopy, helper text, CTAs) confirmed unchanged from the already-passed baseline, both live-confirmed (Step 1/2 both flows) and source-confirmed (Step 3/4)
- Modal proportions match target closely: yes — 400px modal / 360px content / 20px padding, exact match, no stretched/page-sized feel (27.8% of a 1440px viewport)
- Form control geometry consistent: yes — 48px height shared everywhere, 360px shared content width on the two remaining Step-1 controls, real DS component sizing throughout, no custom-CSS-approximated control found

**PASS**

Items verified against the 9-point checklist:
1. Close button outside/independent of card padding — **PASS** (sibling of the padded card, anchored to the outer wrapper, confirmed via DOM structure + position math)
2. LinkedIn CTA + OR divider gone from email-collection, both flows — **PASS** (live `textContent` check confirms `hasLinkedIn:false, hasOR:false`; both flows share the one `EmailOtpStep.tsx` component so the removal is structurally guaranteed identical)
3. Modal geometry 360/20/400 — **PASS** (exact live measurement match)
4. Headings Noto Serif, supporting text DM Sans — **PASS** (live-confirmed on both reached headings per flow; source-confirmed identical on Profile/Success headings; eyebrow/subcopy/label/link all confirmed DM Sans, no accidental serif bleed)
5. Footer nudges — **PASS** (sign-up unchanged, sign-in changed exactly as specified, both live-confirmed verbatim)
6. Backdrop dark/dimmed — **PASS** (`rgba(0,0,0,0.5)` + `blur(8px)`, not a light neutral gray)
7. Shared input/CTA width/height/alignment — **PASS** (48px height, 360px shared width, confirmed live + source)
8. Hover/focus/filled/error/disabled states — **PASS** (live-confirmed where reachable; DS-default source confirms the rest, none stripped/overridden)
9. PreviewToggle distinct + instant, no-reload switch — **PASS** (visually distinct muted-gray dashed pill vs. the navbar's real black Sign in/Sign up controls; confirmed switching V1↔V2 with no page reload, same DOM/state, live)

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/requirements verification only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes
- Confidence in measurements: high for geometry/fonts/copy/DS-mapping/render-safety (direct live measurement via `getComputedStyle`/`getBoundingClientRect` plus full literal source reads, not summaries); medium-high specifically for the sign-up Profile step and both Success steps' live rendering — confirmed via direct source-code read rather than a live screenshot this iteration, due to a concurrent peer session repeatedly resetting the shared browser tab's in-progress state before those two screens could be captured (see Environment note above and P3 list)
