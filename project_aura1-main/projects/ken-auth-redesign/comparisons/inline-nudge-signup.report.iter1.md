# Inline Nudge + Email Preservation — Sign-Up Side — Loop Visual QA

## Status
Done: sign-up side of `EmailOtpStep` (inline wrong-flow nudge replacing the old `wrongFlow` alert panel + cross-flow email preservation), V1 and V2, iteration 1.

## Reference source
No new Figma frame exists for this change — it is a code/interaction-behavior addition described in `projects/ken-auth-redesign/specs/otp-inline-refinement.spec.md` (§ inline wrong-flow nudge note) and `src/lib/mockAccountCheck.ts`'s own header comment. Geometry/close-button/heading baselines are checked against the most recently-confirmed-PASSING targets on record (`comparisons/v1-v2-variants-v1.report.iter1.md` / `v1-v2-variants-v2.report.iter1.md`: 400px modal / 360px content / 20px padding) rather than the older, now-superseded 464px/400px/32px figure still written in `signup-flow-refinement.spec.md` / `otp-inline-refinement.spec.md` (those spec docs were not updated across several subsequent user-directed padding passes documented inline in `AuthModal.tsx`'s own comments; live measurement below confirms the code matches the newer, already-approved 400/360/20 baseline, not the stale spec text).

Live-rendered against `http://localhost:3091` via headless Playwright (per `webapp-testing` skill), not a static screenshot — every interaction below was actually driven in a real browser, not assumed from source reading.

## Modal/Card geometry (explicit numbers, required)
- Modal width: **400px** (target: 400px = 360 content + 2×20 padding) — MATCH
- Modal height: **388.8px** (signup, collecting phase, V1) — unchanged whether the normal helper text or the nudge is shown (same slot, no layout shift)
- Content width: **360px** (target: 360px) — MATCH, measured on email input and primary CTA
- Viewport size: **1440×900** (explicit, controlled, held constant across every test below)
- Modal-to-viewport width ratio: **27.8%** (400/1440)
- Left/right padding: **20px**
- Top/bottom padding: **20px**

## Form control geometry (explicit numbers, required when 2+ controls present)
- Email input: **360×48**, radius **5px**, DS component confirmed: **yes** (`vendor/ds/ui/input.tsx`)
- Primary CTA: **360×48**, radius **5px**, DS component confirmed: **yes** (`vendor/ds/atoms/Button.tsx`, `variant="brand"` `size="md"` `fullWidth`)
- Secondary/social CTA: **N/A — removed**. The LinkedIn alt-method + "OR" divider were deliberately removed from the `collecting` phase in an earlier pass (`ken-auth-redesign` Part B item 5, confirmed still absent on both V1 and V2 renders) — not a gap in this build, a prior intentional removal. No custom-sized approximation exists in its place.
- Shared content width across all controls: **yes** (360px on email input and primary CTA, identical on the sign-in side after switching, confirmed live)

---

## A. VISUAL FIDELITY
No P1/P2/P3 findings.

### P1 (major)
(none)

### P2 (noticeable)
(none)

### P3 (finishing/detail — non-blocking, must still be explicitly reported even on PASS)
- Combined latency for the fresh-email happy path (sign-up with a new address) is now **~750–1050ms** from click to the OTP block being fully settled: 400ms simulated `checkAccountExists()` + 350ms reveal delay + up to 300ms sequential heading crossfade (150ms exit + 150ms enter). This chain is a real, if modest, latency increase introduced specifically by this pass's async account-check gate (the pre-existing reveal-delay/crossfade chain used to run immediately, with no check in front of it). Not asked about in the QA brief and not disqualifying, but flagged as a finishing-detail note since a user on a fresh signup now waits noticeably longer before seeing the OTP fields than before this pass.

## B. DESIGN SYSTEM COMPLIANCE — PASS
- Actual components used: `vendor/ds/atoms/Button.tsx` (`variant="brand"`, loading spinner via `Loader2`), `vendor/ds/atoms/InlineLink.tsx` (`variant="solid"` — confirmed live via `data-component="InlineLink" data-variant="solid"` on both the nudge's "Sign in instead" link and the footer's "Sign in" link), `vendor/ds/ui/input.tsx` (email field, `aria-invalid` states), `vendor/ds/ui/input-otp.tsx` (OTP slots, unchanged by this pass)
- Actual tokens used: `--radius-button` (5px, confirmed on both email input and CTA), `--radius-card` (10px, modal), `--semantic-ink-subtle` (nudge/helper text color, confirmed `rgb(115,115,115)` computed), `--color-brand-red` (CTA/link/error-border), `--button-height-md` (48px)
- Custom CSS exceptions: none
- Any mapped DS component approximated with custom CSS instead of used directly: **none**. The nudge is a plain `<p>` + one `InlineLink` in the exact same DOM slot/classes the normal helper text already used — confirmed live: the nudge's parent is the bare `<form>` element, with `backgroundColor: rgba(0,0,0,0)`, `borderWidth: 0px`, `boxShadow: none` — there is no wrapping panel/box of any kind, matching the build's own claim of "no separate panel, no color/border/icon-box treatment."

## C. INTERACTION / UX — PASS
- Input states: default (pass) · hover (pass, `hover:border-black/25`) · focus (pass, border darkens; note: while `aria-invalid` is also true the red error border correctly takes precedence, expected) · filled (pass) · error (pass — malformed email → `aria-invalid="true"`, border `rgb(176,31,36)` brand-red) · disabled — N/A, email field is never disabled in the `collecting` phase (by design; only becomes `readOnly`/`disabled` once masked in `verifying`, confirmed unaffected by this pass)
- Button states, primary CTA: default (pass) · hover (pass — box-shadow deepens to `rgba(176,31,36,0.25) 0 12px 32px`) · focus (pass — `focus-visible` ring class present) · pressed — not independently distinguished from hover (pre-existing Button atom behavior, out of this pass's scope) · disabled/loading (pass — confirmed live: `disabled=""` attribute set, background lightens, label opacity drops to 0.7, `Loader2` spinner with `animate-spin` renders to the right of the label, during **both** the account-existence check and the pre-existing OTP-send delay, exactly as the build report claims)
- Keyboard/focus behaviour: `aria-invalid` correctly toggles the input's error border; the nudge's `InlineLink` and the footer's `InlineLink` both carry the same `focus-visible:ring-2` treatment as every other `InlineLink` in the flow — not independently re-verified via literal Tab-key traversal this iteration, but the DOM/class evidence is consistent with the rest of the already-passed flow
- Form hierarchy: pass — label → input → helper/nudge slot → CTA → footer, same order/spacing whether the nudge is showing or not (confirmed identical modal height, 388.8px, in both states)
- Accessibility concerns: nudge text color `rgb(115,115,115)` on white — comfortably AA for this size text; no new touch-target concerns (the nudge only adds an inline `InlineLink`, same treatment as the pre-existing footer link). UI/UX Pro Max advisory note (non-blocking, does not override the passing DS/reference result): the ~750–1050ms pre-OTP latency noted in §A P3 above is worth a brief "checking..." affordance beyond the bare spinner if user testing shows people re-clicking during that window — a UX polish suggestion only, not a fidelity defect.

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: **none** (checked across every test: fresh-email path, seeded-email nudge path, flow-switch path, footer-link path, V1 and V2)
- Horizontal overflow: **none** (`document.documentElement.scrollWidth` = `window.innerWidth` = 1440 in every state checked)
- Modal overflow (content exceeding modal bounds): **none** — email input rect (540–900px) sits fully inside the card rect (520–920px) with the expected 20px margin on both sides
- Child element overflow: **none** observed on email input, CTA, close button, or nudge link in any state
- Viewport clipping: **none**
- Unexpected layout shift: **none** — modal height is byte-identical (388.8px) whether the normal helper text or the inline nudge is showing; switching flows re-mounts the other flow's own already-passed layout, no shift artifacts observed

---

## Detailed findings by numbered check (task brief)

**1. Fresh/unseeded email → proceeds normally, no nudge.**
PASS. `freshuser@kenresearch.com` (V1) and `freshv2settled@kenresearch.com` (V2) both advance cleanly to "Enter verification code" with the OTP block, "Verify & continue" CTA, and "Back to sign up" footer — no nudge text anywhere in the dialog, on both variants.

**2. Seeded existing-account email → inline nudge, neutral styling, form stays visible.**
PASS. Tested both seeded emails (`existing@kenresearch.com` on V1, `demo@kenresearch.com` on V2). Live-measured:
- Email input: `readOnly: false`, `disabled: false`, `type: email`, still showing the full unmasked typed value — never hidden or masked.
- Primary CTA: still visible, still reads "Continue with work email" (not swapped to a dead-end state).
- Nudge paragraph computed style: `backgroundColor: rgba(0,0,0,0)` (fully transparent), `borderWidth: 0px`, `color: rgb(115,115,115)` (neutral gray, the same `--semantic-ink-subtle` tone as ordinary helper text) — confirmed **not** warning/error-toned: no colored border, no tinted background, no red/amber/yellow anywhere on this element.
- Copy verbatim match: "You already have an account with this email." + "Sign in instead" — exact match to the required string, in both V1 and V2.

**3. Click "Sign in instead" → switches to sign-in, email preserved.**
PASS. After clicking, the dialog heading settles to "Sign in" within 100ms, and the sign-in flow's own email input is live-measured to contain `existing@kenresearch.com` (V1) / `demo@kenresearch.com` (V2) — the exact string typed on the sign-up side, not empty, not stale. Confirmed by reading the actual DOM value, not assumed.

**4. Old footer link ("Already have an account? Sign in") also preserves email.**
PASS. Typed `footerlink@kenresearch.com` into the sign-up collecting-phase field (without submitting, so no account-check ran), clicked the footer's "Sign in" link directly — the sign-in flow's email field is live-measured to contain `footerlink@kenresearch.com`. Preservation applies at every switch point, not only the new nudge's action link, confirming the lifted `AuthEmailProvider` context genuinely covers both call sites (both call the same `onSwitchFlow` prop into the same shared `useAuthEmail()` state — verified by reading `authEmail.tsx` and by this live behavioral test).

**5. Brief loading indication on the CTA during the ~400ms account check.**
PASS (present). Captured mid-flight: `disabled=""` attribute set on the button, background lightens, label text opacity drops to 0.7, and a `Loader2` `animate-spin` SVG renders — the DS Button's own pre-existing `loading` treatment, applied to `sendingOtp || checkingAccount` per source. Confirmed on the fresh-email path too (same loading treatment fires before the "no mismatch" branch proceeds).

**6. No regressions — modal geometry, close button, headings, transitions.**
PASS on every sub-item:
- Modal geometry: 400px/360px/20px, 27.8% viewport ratio — matches the most recently confirmed-passing target (see Reference source note above re: stale spec text).
- Close button: translucent circle confirmed (`background-color` `rgba(255,255,255,0.15)` default → `0.25` on hover, live-measured via `getComputedStyle` before/after a real `.hover()`), white icon (`color` `rgba(255,255,255,0.8)` default → solid white on hover), **90° hover rotation confirmed** — Tailwind v4's standalone CSS `rotate` property reads `none` before hover and `90deg` after, live-measured (checking `transform` alone would have falsely read "no rotation" — this project uses the newer standalone `rotate` property, not `transform: rotate()`).
- Headings: no eyebrow on either V1 or V2 (`p.uppercase` query returns none in the dialog on both variants — both variants' copy objects set `eyebrow: ''`, and `EmailOtpStep` conditionally omits the element entirely, confirmed no stray empty `<p>`); heading font-weight computed as `500` (font-medium) on both variants.
- Transitions: confirmed smooth by design (Framer Motion `AnimatePresence`, 150ms heading/footer/nudge crossfades, 280ms height+opacity OTP expand, 120ms CTA label fade, all with defined easing and a `useReducedMotion()` fallback) and by direct observation — a screenshot taken ~150ms into the fresh-email submit correctly caught a genuine mid-crossfade frame (masked email already showing, CTA still finishing its color transition), not a hard cut.

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/regression only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes (one advisory note in §C, does not affect the PASS verdict)
- Confidence in measurements: **high** — every finding above was produced by live Playwright automation against the actual running dev server (not screenshot-guessing or source-reading alone), with explicit polling/settle-checks used to rule out transitional-animation-frame false positives (two were caught and corrected during this QA pass itself: an apparent "nudge still showing after fresh email" and an apparent "nudge not clearing on edit" both turned out to be either an insufficient wait or a selector accidentally matching the unrelated footer text, not real defects — resolved via longer settle-polling and more specific selectors before being recorded here)

---

## Verdict
**PASS.**
- Zero P1 issues (section A)
- Zero P2 issues (section A)
- Section B (DS Compliance): **PASS**
- Section C (Interaction/UX): **PASS**
- Section D (Runtime/Layout Safety): **PASS**
- Copy Lock matches exactly (nudge message + action label, verbatim, both variants)
- Modal proportions match the approved/confirmed reference closely (400/360/20, unchanged by this pass)
- Form control geometry is consistent (360×48 shared across email input and primary CTA, both flows; secondary/social CTA correctly N/A — already removed in a prior pass, not a gap introduced here)

One P3 (non-blocking, listed above): the combined pre-OTP latency on the fresh-email happy path grew to ~750–1050ms due to the new account-check gate running in front of the pre-existing reveal/crossfade chain.
