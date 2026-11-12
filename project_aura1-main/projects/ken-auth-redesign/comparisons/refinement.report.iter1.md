# Loop Visual QA — Refinement Pass, Iteration 1

Scope: `signup-flow-refinement.spec.md` (compact geometry, backdrop blur, Framer Motion step transitions) applied on top of the already-PASSED `signup-flow.spec.md` + `signin-flow.spec.md` baselines. Covers **both flows**: sign-up (4 steps) and sign-in (3 steps).

## Status
Done: Refinement QA, iteration 1 of 4 — both auth flows (sign-up 4 steps, sign-in 3 steps) compared against Figma references + baseline specs. Controlled viewport **1440×900** throughout, fresh headless Chromium/Playwright context (not the Chrome-extension preview pane — `document.visibilityState` confirmed `"visible"`, so `requestAnimationFrame` was never suspended and real motion timing could be captured directly, unlike the builder's noted tooling limitation).

## Reference source
- Figma file `PJtPivOzEkiTjSkGnZ2YtH`
- Sign-up frame `550:67`, nodes `554:94` (Step 1), `554:97` (Step 2), `554:100` (Step 3), `554:103` (Step 4)
- Sign-in frame `550:73`, nodes `554:85` (Step 1), `554:88` (Step 2), `554:91` (Step 3)
- All 7 fetched fresh this pass via Figma MCP `get_screenshot` (not reused from a prior iteration) and compared against fresh renders via side-by-side composites (saved at `/private/tmp/.../scratchpad/sidebyside/*_sbs.png`, viewed directly). A precise pixel-overlay was attempted but abandoned as unreliable: an automated white-pixel-bbox crop of the reference picked up other light-background page sections (the raster is a full-page mockup at a different native width, not just the modal), so side-by-side at matched heights is the accurate comparison method used here, consistent with prior iterations' approach.

## Modal/Card geometry (explicit numbers, both flows — identical shell, measured on every step)
- Modal width: **464px** (target: 464px, `signup-flow-refinement.spec.md` §1) — MATCH, held constant on all 7 steps
- Modal height: content-driven, measured per step below
- Content width: **400px** (target: ≈400px, unchanged from baseline) — MATCH
- Viewport size: **1440×900**
- Modal-to-viewport width ratio: **32.2%** (464/1440)
- Left/right padding: **32px** (target: 32px, `--spacing-8`) — MATCH
- Top/bottom padding: **32px** — MATCH

| Step | Card height | Breathing room (top=bottom, viewport-centered) |
|---|---|---|
| Sign-up Step 1 (Create account) | 569.8px | 165.1px |
| Sign-up Step 2 (OTP) | 570.9px | 164.5px |
| Sign-up Step 3 (Complete profile — tallest) | 785.3px | **57.3px** |
| Sign-up Step 4 (Success) | 498.4px | 200.8px |
| Sign-in Step 1 (Sign in) | 569.8px | 165.1px |
| Sign-in Step 2 (OTP) | 570.9px | 164.5px |
| Sign-in Step 3 (Welcome back) | 515.0px | 192.5px |

No step engages the `max-h-[calc(100vh-4rem)] overflow-y-auto` scroll ceiling (836px) at 900px viewport. Internal gap tokens independently re-measured live via `getBoundingClientRect` deltas (not just read from source comments): heading→subcopy 8px (unchanged, correct), subcopy→field 20px (`--spacing-5`, one-step-down, correct), OR-divider 16px each side (`--spacing-4`, one-step-down, correct), footer separation 20px (correct) — all exactly match the spec's target table.

## Form control geometry (explicit numbers, both flows)
- Email input: 400×56, radius 5px, DS component confirmed: yes (`ui/input.tsx`)
- Primary CTA: 400×56, radius 5px, DS component confirmed: yes (`atoms/Button.tsx size="lg"`)
- Secondary/social CTA (LinkedIn): 400×56, radius 5px, DS component confirmed: yes
- Shared content width across all three: **yes** (x-origin = 520 on every control, both flows, all steps)
- Step 3 additions: Full name 400×56, Company name 400×56, phone-pair (Select 92×56 + Input 300×56, gap 8px) = **exactly 400px jointly**, Checkbox 16×16 radius 4px, OTP slots ×6 = 48×48 radius 5px each.

**Height note (pre-existing, not introduced by this refinement):** all controls measure **56px**, not the 48px the original spec text names. Confirmed root cause: `design-system/tokens/build/tokens.css:274` defines `--button-height-lg: 48px`, but the project's `globals.css` imports `@kenresearch/design-system/styles/base.css`, which resolves (via the workspace symlink) to `design-system/core-v2/src/styles/base.css:105`, where the same token is redefined as `56px`. This is a real DS token-source drift between the canonical tokens build and the actually-consumed `core-v2` stylesheet — it pre-dates this refinement (neither file was touched by this pass's diff), and was already disclosed and accepted in the previously-PASSED `signin-flow.report.iter1.md` ("56px control height... held constant"). **Classification: P3, DS-infra note — not a regression of this refinement, and consistency (same 56px everywhere, all controls, both flows) is what actually matters for fidelity and is fully intact.**

---

## A. VISUAL FIDELITY

Side-by-side comparison against all 7 fresh reference screenshots (composition, spacing, hierarchy, typography, alignment, radius, backdrop) shows very close correspondence on every step — eyebrow/heading/subcopy/label/input/helper/button/divider/social-CTA/footer order, weight, and spacing all read the same as the reference on both left-aligned steps (1–3 both flows) and the center-aligned success steps.

### P1 (major)
None.

### P2 (noticeable)
None.

### P3 (finishing/detail — non-blocking, reported per policy)
- **Sign-up Step 3 breathing room (57.3px) is tighter than the refinement spec's own arithmetic estimate (≈85–95px)**, though clearly improved over the pre-refinement baseline's previously-flagged 41–42px. Root cause identified: several of Step 3's gaps (subcopy→pill `mb-6→mb-5`, company-helper→checkbox `mb-6→mb-4`) were **already** hand-tightened in an earlier fix cycle (iter2, predating this refinement spec) specifically to combat that same previously-flagged tight margin — so this refinement's "step every gap down one token from a full-`mb-6` baseline" arithmetic assumed a starting point Step 3 no longer had, over-predicting the resulting breathing room. Net effect is real and positive (+15px vs. pre-refinement), just short of the spec's own flagged-as-uncertain (§R1) estimate. No scroll is triggered (785.3px card vs. 836px ceiling), and the modal does not read as stretched/page-sized (32.2% viewport ratio, well within a focused-dialog feel). **Not blocking.**
- **`backdrop-blur-sm` computes to `blur(8px)`, not the spec's prose estimate of "~4px."** This is not a build error: Tailwind v4 (this project's confirmed stack) shifted its default blur scale from v3's 4px `blur-sm` to 8px — `ContactModal.tsx` uses the exact same unmodified `backdrop-blur-sm` class with no local override, so both compute to the identical value in this workspace. The refinement's actual instruction was "reuse the class matching `ContactModal.tsx`'s precedent," which is satisfied exactly; the spec's parenthetical px estimate was a generic-knowledge approximation that didn't account for this workspace's Tailwind version. Visually the backdrop reads as balanced/focused per every screenshot (background nav/hero legible in outline, clearly de-emphasized, not muddy). **Informational only, not a fidelity defect.**
- **DS component-height drift (56px vs. the originally-named 48px token)** — see Form Control Geometry section above. Confirmed pre-existing, confirmed consistent (not a new mismatch), classified P3/DS-infra.

---

## B. DESIGN SYSTEM COMPLIANCE — PASS

- Actual components used (verified via `data-component`/`data-slot` DOM attributes, not visual inspection alone): `AuthModal` (shared shell, same instance across steps — see Interaction section), `ui/input.tsx` (email, masked email, full name, phone, company name), `atoms/Button.tsx` (`variant="brand" size="lg"` primary CTAs, `variant="secondary"` LinkedIn CTA — both flows), `atoms/InlineLink.tsx` (all 8+ link instances, `data-variant="solid"|"muted"` confirmed correct per instance), `ui/input-otp.tsx` (`InputOTPSlot` ×6, per-slot separated-box override), `ui/select.tsx` (Step 3 country code), `ui/checkbox.tsx` (Step 3 terms), `atoms/Badge.tsx` (Email verified pill), `atoms/Divider.tsx` (OR divider, info-panel row dividers), `lucide-react CheckCircle2` (success icon).
- Actual tokens used: `--radius-card` (10px, modal), `--radius-button` (5px, all inputs/buttons/OTP-slots), `--spacing-8` (32px, modal padding — refinement target), `--spacing-5`/`--spacing-4` (20px/16px, refinement-stepped gaps), `--semantic-scrim` (backdrop color, unchanged), `--color-brand-red` (#B01F24, confirmed live on Checkbox checked-state background), `--semantic-status-success-text` (#166534, confirmed live on sign-in Step 3's "Verified sign-in" text color).
- Custom CSS exceptions: none newly introduced by this refinement. Pre-existing, already-accepted exceptions carried unchanged: info-panel container (NO DS EQUIVALENT, composed from primitives per spec Uncertainty #12), LinkedIn glyph (NO DS EQUIVALENT, third-party brand mark), decorative sparkle accents around the success checkmark (NO DS EQUIVALENT, correctly omitted rather than fabricated — confirmed absent in both success screens' renders, matching the pre-accepted Uncertainty #11).
- Any mapped DS component approximated with custom CSS instead of used directly: **none**.

## C. INTERACTION / UX — PASS

- **Input states**: default/hover/focus/filled progression confirmed live via `getComputedStyle` on the email input — border color steps `oklab(0 0 0/0.1)` → `/0.25` (hover) → `/0.9` (focus) → `/0.9` (filled), matching the DS's documented `Input.tsx` behavior exactly.
- **Button states**: primary CTA hover captured (background remains the token-driven brand gradient/shimmer layer — see below); shimmer overlay present and always-on per `Button.tsx`'s own "DO NOT disable" design (`--composition-gradient-brand-*-shimmer`).
- **Checkbox checked state**: background confirmed live as `rgb(176, 31, 36)` = `#B01F24` = Ken brand red — resolves correctly (spec Uncertainty #10 confirmed, not a generic default).
- **OTP active-slot state**: confirmed live — the actively-focused slot's border renders brand-red (token substitution per spec, working).
- **Keyboard/focus behaviour**: Tab moves focus into a real focusable element (confirmed `document.activeElement.tagName === 'BUTTON'`); Escape-key double-dismiss re-tested live with an actually-open Select popover on Step 3 (not just inferred from source): first Escape closes only the popover (modal remains mounted, count=1), second Escape closes the modal (count=0) — the prior iter2 fix is intact, **not regressed** by this refinement's padding/gap/motion changes.
- **Form hierarchy**: left-aligned rhythm (Steps 1–3, both flows) and center-aligned success steps both reproduced correctly, matching the reference's confirmed intentional deviation.
- **Cross-flow navigation** (re-verified live, not assumed unaffected by the refinement): navbar "Sign in" → opens `SigninFlow` (confirmed via heading text); Sign-in Step 1 "Create account" link → switches to `SignupFlow`; Signup Step 1 "Sign in" link → switches back to `SigninFlow`. All three paths function correctly post-refinement.
- **Accessibility concerns (advisory, UI/UX Pro Max — does not affect the verdict above)**: same items already carried from the baseline specs (no step-progress indicator; recommend `inputmode="numeric"`/`autocomplete="one-time-code"` on OTP — already present in source, confirmed via `autocomplete='one-time-code'` selector used successfully in this pass's own automation; Step 3 checkbox required-field messaging on submit-attempt). No new advisory items introduced by the refinement's geometry/blur/motion changes.

## D. RUNTIME / LAYOUT SAFETY — PASS

- **Console errors**: none, across all captures in a fresh headless context (both `console` and `pageerror` listeners empty on every run). This directly resolves the prior sign-in report's disclosed stale-log-buffer ambiguity — a clean tool context confirms no current errors exist.
- **Horizontal overflow**: none (`document.documentElement.scrollWidth` === `window.innerWidth` === 1440 on every step checked).
- **Modal overflow (content exceeding modal bounds)**: none.
- **Child element overflow**: one apparent hit auto-flagged by a naive bounding-box sweep (a `w-[200%] absolute inset-0` shimmer-sweep `div` inside both primary CTAs, extending well past the card's right edge) — verified this is **not** a real visible-overflow defect: `Button.tsx:363` gives the button itself `overflow-hidden` in its base classes, and a DOM ancestor-walk confirms the shimmer div is clipped by that exact ancestor before ever reaching the card boundary (`clippedByAncestor: true` on both instances found). This is the DS's own always-on shimmer sweep effect (`Button.tsx`'s explicit "DO NOT disable · brand signature" design), correctly contained. **No actual overflow.**
- **Viewport clipping**: none.
- **Unexpected layout shift**: none observed across any step transition in either flow; step swaps recenter within the same flex-centered overlay and height changes are content-driven (expected per spec, not a defect).

---

## Step-transition motion — verified live, not just source-inferred

Both `SignupFlow.tsx` and `SigninFlow.tsx` wrap step content in `AnimatePresence mode="wait" initial={false}` + `motion.div key={step}`, with `initial={{opacity:0, y: prm?0:12}}`, `exit={{opacity:0, y: prm?0:-8}}`, `transition={{duration: prm?0.01:0.2, ease:[0.4,0,0.2,1]}}` — read directly from source, matching the spec exactly.

**Live capture (normal motion, headless context confirmed `document.visibilityState === "visible"`, so `requestAnimationFrame` was never suspended)** — sampled `getComputedStyle` on the transitioning `motion.div` at ~30ms intervals during a real Step 1→2 click-triggered transition:

| Elapsed | Opacity | Transform (y) |
|---|---|---|
| 110ms | 0.997 | 0 → -0.16 (exit starting) |
| 142ms | 0.676 | -3.37 |
| 174ms | 0.458 | -5.57 |
| 207ms | 0.180 | -6.80 |
| 240ms | 0.028 | -7.81 |
| 273ms | 0.009 | -7.97 (exit essentially complete, ~-8 target reached) |
| 306ms | **0** | **y=12** (new step's `initial` state — mode="wait" confirmed: exit fully finished before enter began, no overlap) |
| 339ms | 0.109 | 10.68 (enter animating y:12→0) |

This is a direct, real-time confirmation of the exit (y:0→-8, opacity 1→0) and enter (y:12→0, opacity 0→1) tweens actually running at the specified values, with `mode="wait"`'s non-overlapping behavior visible in the data (opacity hits exactly 0 at the same frame the new element's y=12/opacity=0 initial state appears).

**Reduced-motion emulation** (`context = browser.new_context(reduced_motion="reduce")`, confirmed live via `window.matchMedia('(prefers-reduced-motion: reduce)').matches === true`): transform stayed `"none"` at every sampled frame (slide fully collapsed to 0, as the spec requires) and the opacity flip (1→0→1) completed within a single ~20–25ms sampling gap — consistent with the spec's `duration: 0.01s` collapse, and confirms the `useReducedMotion()` branch is wired correctly rather than merely present-but-inert.

**In-place swap, not remount (requirement #5)**: the `AuthModal` overlay DOM node was tagged with both a custom attribute (`setAttribute`) and a JS expando property immediately before triggering the Step 1→2 transition. Both were re-read intact on the same node after the transition completed — direct proof the same DOM node (same component instance) persisted across the step swap; the modal did not unmount/remount.

---

## Copy Lock — verified across both flows, all 7 steps

Sampled via DOM text-locator queries (not screenshot-only inspection) across every step: eyebrows (GET STARTED / VERIFY YOUR EMAIL / ACCOUNT SETUP / WELCOME BACK / SECURITY CHECK), headings, subcopy, helper text, field labels, masked-email interpolation (`jan***@kenresearch.com` from a real typed `jane@kenresearch.com` — masking logic confirmed correct), footer lines + links (both directions — "Already have an account? Sign in" / "New to Ken Research? Create account"), "Change"/"Didn't receive it?"/"Back to sign up"/"Back to sign in", checkbox terms text + both embedded links, both success screens' headings/subcopy/info-panel rows (correctly wired to real typed state — "Priya Nair" / entered email / derived company name appeared, not the reference's literal demo strings, consistent with the pre-accepted Uncertainty #5/#6 reading), both CTAs on both success screens. **No missing, reordered, or meaning-changed copy found on either flow.**

---

## Verdict

| Flow | Step | P1 | P2 | P3 | DS Compliance | Interaction/UX | Runtime/Layout | Copy Lock | Geometry |
|---|---|---|---|---|---|---|---|---|---|
| Sign-up | 1 — Create account | 0 | 0 | 0 | PASS | PASS | PASS | Match | Match |
| Sign-up | 2 — OTP verification | 0 | 0 | 0 | PASS | PASS | PASS | Match | Match |
| Sign-up | 3 — Complete profile | 0 | 0 | 1 (breathing room, non-blocking) | PASS | PASS | PASS | Match | Match (height-drift note, pre-existing) |
| Sign-up | 4 — Success | 0 | 0 | 0 | PASS | PASS | PASS | Match | Match |
| Sign-in | 1 — Sign in | 0 | 0 | 0 | PASS | PASS | PASS | Match | Match |
| Sign-in | 2 — Verify your sign in | 0 | 0 | 0 | PASS | PASS | PASS | Match | Match |
| Sign-in | 3 — Welcome back | 0 | 0 | 0 | PASS | PASS | PASS | Match | Match |

**OVERALL: PASS** — 0 P1 and 0 P2 across both flows, all 7 steps, simultaneously.

- **Compact geometry**: modal 464px / content 400px / padding 32px confirmed exactly matching the refinement's derived target, on every step of both flows. Internal gap tokens (20px/16px) independently re-measured live, matching the spec's one-step-down table exactly. Control consistency (56px height, 400px width, x=520) fully preserved across email input / primary CTA / LinkedIn CTA, both flows. The 56px-vs-48px naming discrepancy is a pre-existing, already-disclosed DS token-source drift, not a regression — P3/informational.
- **Backdrop blur**: confirmed rendering (`blur(8px)` + unchanged `--semantic-scrim` color), correctly reusing `ContactModal.tsx`'s exact precedent class; the spec's "~4px" prose estimate was off only because it didn't account for this workspace's Tailwind v4 blur scale — the actual instruction (class reuse) was followed exactly. Reads as balanced/focused per every screenshot.
- **Step transitions**: verified live with real interpolated computed-style capture (not source-inference, and not blocked by the rAF-suspension issue the builder hit) — exit/enter y and opacity values match the spec's 12px/-8px/200ms/`[0.4,0,0.2,1]` targets, `mode="wait"` confirmed non-overlapping, reduced-motion branch confirmed collapsing slide to 0 and duration to near-instant.
- **In-place swap**: directly proven via a persistent DOM-node marker surviving a real step transition — same `AuthModal` instance, no remount.
- **No regressions**: Copy Lock (all 7 steps, both flows), DS Mapping Gate (InlineLink variants, Checkbox brand-red, Select/Input height parity, OTP slot radius/active-color), Escape-key double-dismiss (re-tested live with an actually-open popover), cross-flow navigation (navbar→sign-in, sign-in↔sign-up both directions) — all confirmed intact.

One non-blocking P3 (Step 3 breathing room, 57.3px vs. the spec's own flagged-as-uncertain 85–95px estimate — real improvement over the pre-refinement 41–42px, no scroll triggered) and two informational notes (blur px value vs. Tailwind version; pre-existing 56px/48px token-source drift) are disclosed above per the PASS-with-P3 allowance; none are blocking.

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/measurement only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes — no new advisory notes altered any finding's severity this pass
- Confidence in measurements: high — all geometry pulled via live `getBoundingClientRect`/`getComputedStyle` at a controlled 1440×900 viewport in a fresh headless Playwright context (confirmed `visibilityState: "visible"`, avoiding the rAF-suspension issue disclosed by `loop-builder`); motion timing captured as real interpolated frames during an actual click-triggered transition and independently again under `reduced_motion: "reduce"` emulation; DOM-persistence of the `AuthModal` instance proven via a tagged-node check across a live transition; DS component identity verified via `data-component`/`data-slot`/`data-variant` DOM attributes cross-referenced against source, not visual inspection alone; references re-fetched fresh this pass (not reused) for all 7 step nodes across both frames; the one auto-flagged "child overflow" was independently re-verified as a false positive (correctly clipped by an `overflow-hidden` ancestor) rather than accepted or dismissed on assumption.
