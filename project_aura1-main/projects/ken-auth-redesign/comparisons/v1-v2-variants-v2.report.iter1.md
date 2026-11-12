## Status
Done: Loop QA compare — V2 "Cleaner Auth Direction" variant of the shared V1/V2 Auth variant system, BOTH flows (sign-up: email/OTP → profile → success; sign-in: email/OTP → success), iteration 1 of 4.

## Reference source
No fresh Figma re-pull — per the task brief, V2 has **no Figma reference** ("no Figma reference exists for V2; this is a principled design-judgment call, disclosed in the build report"). The applicable reference for this iteration is therefore twofold: (a) the already-PASSED V1 baseline (Figma frames `550:67` "SignUp" / `550:73` "SignIn", specs `signup-flow.spec.md` / `signin-flow.spec.md` / `otp-inline-refinement.spec.md` / `signup-flow-refinement.spec.md`), accessed live via the same `PreviewToggle` for a direct V1↔V2 comparison, and (b) the 8-item requirements list supplied directly in this QA task. Verified against the live render at the controlled viewport below (both variants, both flows, driven end-to-end) plus direct source-code reads (`AuthModal.tsx`, `authVariant.tsx`, `PreviewToggle.tsx`, `page.tsx`, `EmailOtpStep.tsx`, `CompleteProfileStep.tsx`, `SignupSuccessStep.tsx`, `SigninSuccessStep.tsx`, `SignupFlow.tsx`, `SigninFlow.tsx`, `AuthButtons.tsx`, `SecondaryBar.tsx`/`TopNavigation.tsx`, `mockAccountCheck.ts`).

**Environment note (affects live-capture methodology, not the verdict basis):** the sibling `v1-v2-variants-v1.report.iter1.md` (same iteration, V1 side) independently flags a peer session sharing the same browser tab throughout this QA window, resetting in-progress flows via its own clicks/typing/resizes. I hit the same contention directly: several mid-session state reads (via screenshots, and a couple of split action→read call pairs) came back showing a different variant/phase/heading than the action I had just taken should have produced, with no console error and no full page navigation in between. Cross-checking (`performance.getEntriesByType('navigation')`, `document.visibilityState`) confirmed the document itself never reloaded — the state changes are attributable to concurrent interaction on the shared tab, consistent with the sibling report's account, not a reproducible product defect. **Mitigation used:** every finding below that matters to the verdict was re-verified using a single atomic script (action + immediate read in one `javascript_exec` call, no intervening screenshot/tool call), repeated until internally consistent; several were additionally cross-checked 2–3 times independently. Visual screenshots in this session were unreliable while the Browser pane is backgrounded (documented tool behavior — "prefer read_page/get_page_text over screenshots while hidden"); one exception is the `existing@techcorp.com` wrong-flow capture below, taken as the last step of the same batch that typed/submitted it, which is internally consistent with its own follow-up DOM read. Numeric geometry claims rest on direct `getBoundingClientRect()`/`getComputedStyle()` reads, not visual estimation, so precision is not affected by the screenshot unreliability — only the supplementary visual artifact is thinner than usual for this report.

## Modal/Card geometry (explicit numbers, measured live at 1440×900)
- Modal width: **400px** (target: 400px — 360 content + 2×20 padding) — **MATCH**, identical in V1 and V2 (shared, unconditional `AuthModal.tsx` shell; `variant` never reaches this file)
- Modal height: varies by step/phase — see per-step table below (V1 vs V2)
- Content width: **360px** (email input, primary CTA both measured 360×48px) — **MATCH** (target: 360px), identical both variants
- Viewport size: 1440×900 (controlled, held constant for every measurement in this report)
- Modal-to-viewport width ratio: 400/1440 = **27.8%** — reads as a focused dialog, not a stretched landing-page card
- Left/right padding: **20px** each (card `padding: 20px`, Tailwind `p-5` = `--spacing-5` = 1.25rem, confirmed via `getComputedStyle`)
- Top/bottom padding: **20px** each (same shorthand, confirmed identical on all sides)
- Close button: **36×36px**, `-top-3 -right-3` (sibling of the padded card, anchored to the outer `relative max-w-[400px]` wrapper) — confirmed present and positioned identically in **both** V1 and V2 (shared, unconditional code)

### Card height by step/phase — V1 vs V2 (the actual "compactness" measurement, item 6)
| Step | V1 height | V2 height | Delta |
|---|---|---|---|
| Sign-up — collecting (default view) | 417.3px | 388.8px | **−28.5px** |
| Sign-up — verifying (OTP revealed) | 576.9px | 544.8px | **−32.2px** |
| Sign-up — Complete profile | 729.3px | 700.8px | **−28.5px** |
| Sign-up — Success | 462.4px | 462.4px | 0 (no eyebrow in **either** variant on this step — confirmed by design, not an oversight: `SignupSuccessStep.tsx`'s own doc-comment states this explicitly) |
| Sign-in — collecting (default view) | not independently re-measured this pass (see note) | 360.3px¹ | — |

¹ Sign-in collecting V2 card height measured in isolation during the wrong-flow test sequence; a directly-comparable V1 sign-in collecting height was not captured this iteration due to the shared-tab contention noted above — not treated as a gap in the verdict since (a) the delta mechanism (eyebrow removal, ~28–32px) is already demonstrated consistently across 3 independent sign-up steps, and (b) `EmailOtpStep.tsx` is the exact same shared component for both flows, so the same delta applies structurally to sign-in's collecting phase as well.

**Every V2 card is measurably shorter than its V1 counterpart by almost exactly the eyebrow's own footprint (~28–32px = eyebrow line height + its `mb-2` margin), confirming item 6: V2 reads as visibly more compact than V1, purely from eyebrow removal, with no other content trimmed.**

## Form control geometry (explicit numbers, measured live / confirmed via source)
- Email input: 360×48px, radius 5px (`--radius-button`), DS component confirmed: **yes** (`@/vendor/ds/ui/input.tsx`) — identical both variants
- Primary CTA: 360×48px, radius 5px, DS component confirmed: **yes** (`@/vendor/ds/atoms` `Button` variant="brand" size="md" fullWidth) — identical both variants
- Secondary/social CTA: **removed** in both variants (LinkedIn CTA + "OR" divider gone from the email-collect phase — Part B item 5, shared-shell baseline, not variant-conditional; confirmed absent via live DOM query, `linkedInPresent:false, orDividerPresent:false`)
- Shared content width across all three: **yes** for the two controls that remain (email input / primary CTA, both exactly 360px, both variants); the removed LinkedIn CTA is out of scope by design
- Complete Profile step (sign-up only): Full name / Company name inputs 360×48px; phone row is `SelectTrigger` (92px) + `Input` (`flex-1`) pair spanning the 360px column — unchanged, identical DOM/CSS in both variants, only the eyebrow paragraph differs

---

## A. VISUAL FIDELITY

### P1 (major)
(none)

### P2 (noticeable)
(none)

### P3 (finishing/detail — non-blocking)
- The experimental navbar "Sign in / Register" combined entry (Part E, item 7) introduces the word "Register" — a term not used anywhere else in either flow (which consistently says "Sign up" / "Create account"). Functionally correct (opens the sign-up flow, confirmed live) and explicitly disclosed as an independent, lower-priority exploration in source comments — flagged as a minor terminology-consistency note for whoever picks this experiment up next, not a fidelity defect.
- A precise V1 sign-in "collecting" card height was not independently captured this iteration (see footnote above) due to shared-tab contention; the compactness claim (item 6) is still well-supported by 3 consistent sign-up measurements plus the fact that sign-in shares the exact same `EmailOtpStep.tsx` component.
- Visual screenshots for this report are thinner than usual (see Environment note) — geometry/copy findings rest on direct DOM measurement instead, which is the more precise method for the numeric claims in this report but means fewer illustrative images are attached.

**Composition/spacing/typography/radius/borders/shadows/dividers/backdrop/icons/link styling/responsive:** all confirmed identical to the already-passed V1 baseline in both variants — `AuthModal.tsx` (the shell) is completely unconditional on `variant`; the only V2-conditional code anywhere in the codebase is (a) the copy objects picked in `SignupFlow.tsx`/`SigninFlow.tsx`, (b) the `{eyebrow && (...)}` conditional in `EmailOtpStep.tsx`, (c) the `variant !== 'v2'` conditional in `CompleteProfileStep.tsx`, and (d) the `combinedAuthEntry`/`combinedEntry` navbar prop threaded from `page.tsx` through `TopNavigation`/`SecondaryBar`/`AuthButtons`. Confirmed by full source read — no other file branches on `variant`.

---

## B. DESIGN SYSTEM COMPLIANCE — **PASS**
- Actual components used (unchanged from the already-passed V1 baseline, both variants use the identical component tree): `@/vendor/ds/atoms` `Button` (variant="brand"), `InlineLink` (variant="solid"/"muted"), `Badge` (variant="pill", theme="success"), `Divider` (variant="subtle"); `@/vendor/ds/ui/input.tsx` `Input`; `@/vendor/ds/ui/input-otp.tsx` `InputOTP`/`InputOTPGroup`/`InputOTPSlot`; `@/vendor/ds/ui/checkbox.tsx` `Checkbox`; `@/vendor/ds/ui/select.tsx` `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`/`SelectValue`
- Actual tokens used: `--font-serif` (headings, all screens both flows — confirmed live: `"Noto Serif", "Noto Serif Fallback", ... serif`), `--spacing-5` (20px card padding), `--button-height-md` (48px, all controls), `--radius-button` (5px), `--radius-card` (10px), `--semantic-scrim` (`rgba(0,0,0,0.5)`) + `backdrop-blur-sm` (computes to `blur(8px)` under this project's Tailwind v4 scale — verified correct, a naming-vs-computed-px curiosity already noted in the sibling V1 report, not a defect), `--color-brand-red`, `--semantic-status-success-*`, `--semantic-status-warning-*`, `--color-ramp-black-50`, `--typography-size-xl/sm/xs`
- Custom CSS exceptions: the eyebrow `<p>` (inline-styled with tokens, no dedicated "Eyebrow" DS atom exists) and the `wrongFlow` warning panel / success info panel (no Alert/Banner or KeyValue/Summary DS atom exists) — all three are genuine, already-documented NO-DS-EQUIVALENT cases carried unchanged from the passed V1 baseline. **V2 introduces zero new custom CSS or new NO-DS-EQUIVALENT cases** — its only change to this markup is a boolean condition (`{eyebrow && (...)}` / `{variant !== 'v2' && (...)}`) wrapping the exact same already-approved JSX, and a swapped string value.
- Any mapped DS component approximated with custom CSS instead of used directly: **none**

## C. INTERACTION / UX — **PASS**
- Input states — all confirmed live, both variants (shared code path, `variant` does not affect input rendering): default (empty, placeholder `name@company.com`); focus (`getComputedStyle` confirms a distinct outline + border-color change on focus, both the email input and the close button); filled (typed values render correctly — `existing@techcorp.com`, `newuser@techcorp.com`, `newperson@techcorp.com` all confirmed in the live DOM); disabled+readOnly (email field goes `readOnly`+`disabled` with masked value `new***@techcorp.com` during the verifying phase, confirmed live); error (OTP slots: submitting 3 of 6 digits produces `aria-invalid="true"` on a slot plus the message "Enter all 6 digits to continue.", confirmed live)
- Button states: default/focus confirmed live (primary CTA focus shows a ring plus a `0 4px 16px` brand-red-tinted shadow); loading confirmed live (button dims during the ~350ms mock OTP-send delay); hover/pressed/disabled not independently re-exercised via synthetic pointer hover this iteration (no real-mouse-hover simulation available in this session's tooling) but are DS-component defaults, unmodified by any variant-conditional code — same standing as the already-passed V1 baseline
- Keyboard/focus: visible focus rings confirmed on email input, primary CTA, and close button; Escape-to-close logic and popover-vs-modal Escape-priority handling are unchanged shared code (not variant-conditional), carried from the passed baseline
- Form hierarchy: pass — with the eyebrow removed in V2, the heading now correctly becomes the first visible element in the card on every affected screen (confirmed live: sign-up collecting, sign-up verifying, sign-in collecting, sign-in verifying, Complete Profile — see item-by-item verification below); hierarchy below the heading (subcopy → label → field → helper → CTA → footer) is unchanged
- Accessibility concerns (advisory, UI/UX Pro Max, non-blocking): removing the eyebrow does not affect `aria-labelledby` wiring — that id lives on the `<h1>` itself, not the eyebrow, in both variants, confirmed via source (`STEP_HEADING_ID` map, unchanged). The `PreviewToggle`'s `role="tablist"`/`role="tab"` pattern remains appropriately labelled and out of the product's own a11y surface. The experimental navbar "Sign in / Register" button is a real `<button>` with visible hover/focus treatment (same class pattern as the existing Sign up button) — no new a11y gap introduced.

## D. RUNTIME / LAYOUT SAFETY — **PASS**
- Console errors: **none** — checked repeatedly across the full session (both variants, both flows, every phase reached); only HMR/dev-tooling info logs present (`[Fast Refresh]`, React DevTools banner), zero warnings/errors, confirmed with `onlyErrors:true` filters throughout
- Horizontal overflow: **none** — `document.documentElement.scrollWidth === window.innerWidth` (1440) confirmed at multiple checkpoints across both variants
- Modal overflow (content exceeding modal bounds): none observed on any reached screen in either variant; content column consistently 360px within the 400px card at every step; OTP row (328px) and the Select+phone pair (360px combined) both fit comfortably within the 360px column with no clipping
- Child element overflow (any element exceeding its parent): **one pre-existing, disclosed, unchanged-from-baseline item to note honestly rather than omit** — the close button (`-top-3 -right-3`, 36×36px) intentionally straddles the card's visual edge by design (a documented, deliberate half-outside circular-close-button pattern, per `AuthModal.tsx`'s own doc-comment and per Part B item 1 of this task's own shared-refinements list). Measured against its actual DOM parent (the outer `relative max-w-[400px]` wrapper, not the padded card div), this is the same already-established, already-disclosed pattern the sibling V1 report also examined and did not treat as a defect — it is unchanged between V1 and V2 (confirmed: identical position/size in both), does not create page-level scroll/overflow, and does not clip or hide any content. Flagged here for transparency per the render-safety instruction's "no exceptions" wording, but not counted as a new P1 for this iteration since it is neither new, nor accidental, nor specific to the V1/V2 delta being verified — it is exactly the shared refinement item 5 asked me to confirm is *present*, and it is.
- Viewport clipping: none at 1440×900 in either variant (tallest screen reached, Complete Profile at ~700–730px, comfortably under the `max-h-[calc(100vh-4rem)]` ≈ 836px ceiling)
- Unexpected layout shift on state change: none — step transitions use `AnimatePresence mode="wait"` (old content fully exits before new enters); the OTP block's height animates via a real Framer `height: 0 → 'auto'` measurement, not a layout-shifting hard cut

---

## Item-by-item verification (the 8 checks from the task)

1. **Toggle switches V1→V2 instantly, no reload, React state only** — **PASS**. Clean atomic test: click → 50ms (still V1, mid-transition) → 300ms (V2 settled, eyebrow gone) → held stable through 4.8s. `location.href` unchanged (`http://localhost:3091/`) before and after. `read_network_requests` showed zero new requests fired by the toggle click (only the original page-load chunks). Confirmed by source: `authVariant.tsx`'s `AuthVariantProvider` is a plain `useState`, no route/query param, no persistence — exactly as its own doc-comment claims.
2. **No eyebrow anywhere in V2, no empty-but-present DOM element** — **PASS**, all 5 named eyebrows confirmed absent by direct live DOM check (`querySelector('p.uppercase')` → `null`, not an empty string), each on its own screen:
   - "GET STARTED" (sign-up collecting) — absent, confirmed
   - "VERIFY YOUR EMAIL" (sign-up verifying/OTP) — absent, confirmed
   - "WELCOME BACK" (sign-in collecting) — absent, confirmed
   - "SECURITY CHECK" (sign-in verifying/OTP) — absent, confirmed
   - "ACCOUNT SETUP" (Complete Profile) — absent, confirmed
   Source confirms the mechanism is a true conditional render (`{eyebrow && (<p>...)}` in `EmailOtpStep.tsx`; `{variant !== 'v2' && (<p>...)}` in `CompleteProfileStep.tsx`), not an empty string rendered invisibly — verified live by the selector returning `null`, not an empty-text node.
3. **Sign-up begins directly with "Create your account" as the first/topmost visible element** — **PASS**, confirmed live (`card.firstElementChild`'s rendered text starts with "Create your account", no eyebrow line above it).
4. **Sign-in heading structure simplified** — **PASS**. Heading "Sign in" present (unchanged from V1). V2 subcopy, exact wording found live: **"Sign in with your registered work email."** — vs. V1's **"Sign in to your Ken Research account using your registered work email."** This reads as genuinely simplified, not a copy-paste: it drops the redundant restatement of the product name ("Ken Research account") to a user already on that product's sign-in screen, shortens from one long compound sentence to a single clause, and retains only the one functionally load-bearing detail (must be a *registered work* email). Not a fixed spec item — a disclosed builder design choice, and a reasonable one.
5. **Shared V1 refinements (Part B) also present in V2** — **PASS**, all confirmed live in V2 render, not V1-only:
   - Close button placement: outside the card's padding box, `-top-3 -right-3`, 36×36px — confirmed identical to V1
   - No LinkedIn: confirmed absent in V2 (shared, unconditional removal in `EmailOtpStep.tsx`)
   - Noto Serif headings: confirmed live (`"Noto Serif", "Noto Serif Fallback", ... serif`) on V2 headings
   - Geometry 360px content / 20px padding / 400px modal: confirmed identical in V2 (same unconditional `AuthModal.tsx`)
   - Dark backdrop: confirmed identical (`rgba(0,0,0,0.5)` + `blur(8px)`)
   - 48px controls: confirmed identical (email input, primary CTA both 360×48px in V2)
6. **V2 reads as visibly more compact than V1** — **PASS**, quantified above: every V2 screen with an eyebrow removed is measurably 28–32px shorter than its V1 counterpart, with no other content trimmed (a clean, single-cause compaction, not a side effect of something else changing).
7. **Navbar V2 exploration (Part E)** — **implemented and working**. The "Sign in / Register" combined entry point replaces the separate Sign in/Sign up pair when V2 is active (confirmed live: V1 shows two controls, `ref` "Sign in" + "Sign up"; V2 shows one, "Sign in / Register"). Clicking it correctly opens the sign-up flow (confirmed live: heading "Create your account" after click, modal was confirmed closed beforehand so this was a genuine open-from-navbar, not a residual open modal). Minor P3 terminology note above ("Register" vs. the rest of the product's "Sign up"/"Create account") — not a blocker, and the task explicitly said not to fail the build over this item's absence, let alone its presence-with-a-minor-nit.
8. **Wrong-flow states, DS Mapping Gate, Copy Lock discipline for V2 copy** — **PASS**.
   - Sign-up wrong-flow (existing account, `existing@techcorp.com`): heading stays "Create your account" (no eyebrow), panel reads **"An account already exists with this email."**, action **"Sign in instead"** — confirmed live, verbatim match to source, real `Button variant="brand"` (not a custom-CSS approximation).
   - Sign-in wrong-flow (no account, `newperson@techcorp.com`): heading stays "Sign in" (no eyebrow), panel reads **"We couldn't find an account with this email."**, action **"Create account"** — confirmed live, verbatim match to source.
   - No invented copy found anywhere beyond the three disclosed V2 deltas (eyebrow removal, sign-in subcopy shortening, navbar "Sign in / Register" label) across every screen traversed (sign-up collecting/verifying/wrong-flow/profile/success; sign-in collecting/verifying/wrong-flow/success).

---

## Verdict
- Zero P1 issues: yes
- Zero P2 issues: yes
- Section B (DS Compliance): PASS
- Section C (Interaction/UX): PASS
- Section D (Runtime/Layout Safety): PASS
- Copy Lock matches (for what's locked in): yes — all V2 copy differences are exactly the three disclosed builder design choices (eyebrow removal, sign-in subcopy shortening, experimental navbar label); everything else verbatim-matches the already-passed V1 Copy Lock
- Modal proportions match target closely: yes — 400px modal / 360px content / 20px padding in both variants, no stretched/page-sized feel (27.8% of a 1440px viewport)
- Form control geometry consistent: yes — 48px height and 360px shared content width identical in both variants, real DS component sizing throughout, no custom-CSS-approximated control found

**PASS**

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/requirements verification only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: yes (the one advisory-flavored note — "Register" vs "Sign up" terminology — is recorded as a P3/advisory note, not used to fail a DS-conformant, disclosed, working feature)
- Confidence in measurements: high for geometry/fonts/DS-mapping/copy/render-safety — every load-bearing check was performed as a single atomic script (action + immediate verification, no intervening tool call) and several were independently repeated to confirm consistency, specifically because a peer session was concurrently driving the same shared browser tab throughout this window (see Environment note; also independently disclosed in the sibling `v1-v2-variants-v1.report.iter1.md`). Medium confidence specifically on: (a) the sign-in "collecting" phase V1-vs-V2 height comparison (V2 measured directly; V1 not independently re-measured this pass, inferred from the shared-component argument), and (b) hover/pressed button states (not exercised via synthetic pointer hover this session — standing on the same DS-default basis as the already-passed V1 baseline rather than fresh live confirmation).
