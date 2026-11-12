# Loop Visual QA — Single-Seed Account + Persistence-on-Completion — Iteration 1

## Status
Done: Independent live verification of loop-builder's claim — seeded account set reduced to `test@kenresearch.com` only, plus `localStorage`-backed persistence fired exactly at true Create-Account completion. All 7 requested checks (nudge/switch-flow, fresh-signup 3-step sequence, persistence proof, no-premature-persistence, reload survival, old-seed removal, regression sweep) reproduced live via Playwright against the running dev server — not trusted from the builder's self-report. Iteration 1 of 4 max.

## Reference source
No Figma/chat/local reference image applies to this pass — per `src/lib/mockAccountCheck.ts`'s own header comment, this is a **logic-only** change ("no UI/copy/DS changes"). The comparison baseline for the regression sweep (check 7) is the last-passed visual/behavioral state on record: `projects/ken-auth-redesign/comparisons/signup-flow.report.iter3.md` (modal geometry, DS mapping, Copy Lock) and `projects/ken-auth-redesign/comparisons/inline-nudge-signup.report.iter1.md` (inline wrong-flow nudge mechanic/styling). Original visual source of truth remains Figma frame `550:67`/`550:73` per `PROJECT.md`, untouched by this pass.

## Environment
- Rendered implementation: `http://localhost:3091` (Next.js dev server, already running — not restarted)
- Viewport: **1440×900**, held constant across the entire run
- Driven live via native Playwright (`sync_playwright`, headless Chromium) directly against the running app — no server restart, no mocked network layer beyond the app's own existing `mockAccountCheck.ts` simulated delay
- Full run executed **twice** (identical script) to confirm determinism; results below are consistent across both runs, including the exact `localStorage` payload
- Fresh emails invented for this pass (never previously seeded, per-run timestamped to guarantee novelty): `qa-fresh-<epoch>-a@freshtest-inc.com` (FRESH1) and `qa-fresh-<epoch>-b@freshtest-inc.com` (FRESH2)

## Modal/Card geometry (regression check only — no target changed by this logic-only pass)
- Modal card width: 400px (unchanged before/after the full interaction sequence)
- Modal card height: 388.8px (Step 1 default; varies by step content, unchanged from baseline)
- Content width: ~360px (400px card − 2×20px `p-5` padding, per `AuthModal.tsx`'s current documented geometry pass)
- Viewport size: 1440×900
- Modal-to-viewport width ratio: 27.8%
- Left/right padding: 20px, Top/bottom padding: 20px
- Close button: 44×44px hit area, positioned at `-top-[50px] -right-[50px]` relative to the card (measured box: x=926, y=205.58 vs. card x=520, y=255.58 — matches source exactly)
- **No drift observed**: identical `getBoundingClientRect()` values captured at baseline (before any interaction) and again after the full 7-check sequence (V1↔V2 toggling, 3 full flow completions, 2 abandonments, multiple reloads) — this logic-only change introduced zero geometry regression.

## Form control geometry
Not the focus of this pass (no control sizing was touched by the builder's change); spot-checked visually across all captured screenshots (email input, OTP slots, profile fields, CTA buttons) against the last-passed baseline (`signup-flow.report.iter3.md`) — no visible deviation. Full pixel remeasurement not repeated here since no control-geometry-affecting code was in scope.

---

## Independent verification, check by check

### 1. `test@kenresearch.com` on Create Account → inline nudge → switch to sign-in → OTP proceeds
- Typed `test@kenresearch.com`, submitted → after the simulated 400ms account check, inline text appeared: **"You already have an account with this email. Sign in instead"** (verbatim match).
- Email field: confirmed still `visible` (`true`), **no `readonly` attribute, no `disabled` attribute** — field stayed fully editable, contradicting nothing (the field itself was never meant to lock here; only the OTP-phase morph locks it, which correctly did not fire).
- Neutral-styling verification via live `getComputedStyle` on the nudge `<p>` itself: `color: rgb(115,115,115)` (the DS's neutral `--semantic-ink-subtle` tone, same as ordinary helper text), `background-color: rgba(0,0,0,0)` (fully transparent — no box fill), `border-width: 0px`, `box-shadow: none`, `border-radius: 0px`. Also checked the immediate parent (`<form>`) for any wrapping panel styling — same result, `rgba(0,0,0,0)` background, `0px` border, `none` shadow. **Confirmed: no error/warning box of any kind, plain inline text exactly as specified.**
- Clicked "Sign in instead" → modal switched: heading became `#signin-email-heading` = **"Sign in"** (confirmed via live DOM query, not just screenshot impression). Email field value after switch: **`test@kenresearch.com`** — preserved verbatim, not cleared.
- Submitted sign-in with the preserved email → after the check, **no mismatch nudge appeared**; the flow proceeded normally into the OTP phase (`"Enter 6-digit code"` label + OTP slot row rendered, confirmed visible). Screenshots: `persist-01-nudge-signup-testaccount.png`, `persist-02-switched-to-signin-preserved-email.png`, `persist-03-signin-otp-reached-testaccount.png`.

**Check 1: CONFIRMED, exactly as specified.**

### 2. Fresh email through full Create Account: OTP → Complete Profile → Account Ready, all 3 steps actually rendered
Using FRESH1 (invented, never seeded): submitted email → **OTP step rendered** (`"Enter 6-digit code"` visible, screenshot `persist-04`) → filled `123456`, submitted → **Complete Profile step rendered** (`#complete-profile-heading` = "Complete your profile", screenshot `persist-05`, distinct DOM/heading from the OTP step, not a jump) → filled full name/phone/company (company auto-detected correctly as "Freshtest Inc" from the `freshtest-inc.com` domain, confirming no incidental regression to that unrelated behavior), checked the terms checkbox, submitted → **Account Ready step rendered** (`#signup-success-heading` = "Your account is ready", screenshot `persist-06`), info panel correctly echoing the real typed name/email/company.

Three separate DOM headings (`complete-profile-heading` → `signin`/`signup-success-heading`) were queried and three separate screenshots captured at each distinct step — this is a genuine sequential render of all three steps, not a shortcut/jump straight to success.

**Check 2: CONFIRMED, exactly as specified.**

### 3. Persistence proof — same email now proceeds to OTP on sign-in (no nudge)
After a full page reload (fresh React state, `localStorage` untouched by a reload), switched to the sign-in flow via the footer "Sign in" link and typed FRESH1. Submitted → **no "no account" nudge appeared**; the flow proceeded straight into the OTP phase (`"Enter 6-digit code"` visible, `text=No account found for this email.` count = 0). Screenshot `persist-07-signin-fresh1-post-reload1-otp.png`.

**Check 3: CONFIRMED.**

### 4. Do-not-persist-prematurely rule — abandoned Complete Profile must NOT register
Using FRESH2 (invented, distinct from FRESH1): completed email + OTP, **reached** Complete Profile (`#complete-profile-heading` confirmed visible, screenshot `persist-09`), then **deliberately did not submit** — abandoned via a hard page reload instead. Switched to sign-in, typed FRESH2 → **"No account found for this email."** nudge appeared (confirmed visible), and the flow correctly did **not** reach the OTP step (`text=Enter 6-digit code` count = 0). Screenshot `persist-10-signin-fresh2-no-account-nudge.png`.

Direct `localStorage` read (see below) independently confirms FRESH2 is absent from the persisted set — this isn't just a UI-behavior inference, the underlying store itself never received it.

**Check 4: CONFIRMED — nothing was saved before true completion.**

### 5. Survives a hard page refresh — real `localStorage`, not in-memory state
After check 3's reload-based confirmation, performed a **second, independent hard reload**, switched to sign-in again, and retyped FRESH1 → again proceeded straight to OTP with no nudge (`check5_signin_fresh1_reaches_otp_after_2nd_reload = True`, `check5_no_mismatch_nudge_after_2nd_reload = True`). Screenshot `persist-08-signin-fresh1-post-reload2-otp.png`.

Beyond the behavioral proof, a **direct `localStorage` read** was taken at the end of the session (ground truth, not inference):
```
localStorage key: ken-auth-redesign:registered-emails
Value:            ["qa-fresh-<epoch>-a@freshtest-inc.com"]   (FRESH1 only)
```
This is real, durable `window.localStorage` — confirmed via `Object.keys(window.localStorage)` returning exactly this one key — not `sessionStorage`, not a React-state polyfill, not a cookie. It survived two independent full-page reloads within this run.

**Check 5: CONFIRMED.**

### 6. Old seeded emails (`demo@`/`existing@kenresearch.com`) no longer pre-exist
After a fresh reload, switched to sign-in and typed `demo@kenresearch.com` → **"No account found for this email."** nudge appeared (screenshot `persist-11`). Edited the field in place (clearing the stale mismatch per the component's own documented behavior) to `existing@kenresearch.com` and resubmitted → **same "No account found" nudge appeared again** (screenshot `persist-12`). Neither email reached the OTP step. Direct `localStorage` read confirms neither string is present in the persisted set (`localStorage_contains_demo_should_be_False = False`, `localStorage_contains_existing_should_be_False = False`), and the hardcoded seed set in `mockAccountCheck.ts` was independently read from source (line 42: `new Set(['test@kenresearch.com'])`) — confirming by code inspection, not just black-box behavior, that these two are no longer hardcoded anywhere.

**Check 6: CONFIRMED.**

### 7. Regression sweep
- **Modal geometry**: identical before/after the full run (see Modal/Card geometry section above) — no drift.
- **Close button**: visible throughout, `aria-label="Close modal"`, 44×44px hit area at the documented offset — unchanged.
- **Headings**: Step 1 "Create your account" (signup) / "Sign in" (signin) / "Complete your profile" / "Your account is ready" all rendered correctly and matched Copy Lock strings verbatim in every screenshot.
- **V1/V2 toggle**: `PreviewToggle`'s `role="tab"` V1/V2 buttons both visible and functional; clicking V2 flipped `aria-selected` correctly, re-rendered the signup step with V2's copy/spacing variant live (no reload, no console error), and the navbar's combined "Sign in / Register" entry point appeared as designed (`combinedAuthEntry={variant==='v2'}`); clicking back to V1 correctly reverted. Screenshot `persist-13-v2-toggle-signup.png`.
- **Transitions**: all step/phase swaps (email→OTP, OTP→profile, profile→success, signup↔signin flow switch) completed cleanly with no visual glitch, no stuck intermediate state, across two full script runs.
- **Nudge neutral styling**: re-confirmed identical neutral treatment (no box/border/color-warning) on all four nudge occurrences captured this pass (test@ already-exists, FRESH2 no-account, demo@ no-account, existing@ no-account) — all render through the same plain-text + `InlineLink` mechanic, no divergence between the "already-exists" and "no-account" variants' container styling.
- **Console/runtime**: zero `error`/`warning`-level console messages across the entire two-run session — only benign dev-mode `React DevTools`/`[HMR] connected` notices. Zero page errors (`pageerror` listener). Zero horizontal overflow at any point (`scrollWidth` held at 1440 = viewport width, baseline and final).

**Check 7: CONFIRMED — no regressions found.**

---

## A. VISUAL FIDELITY
No P1/P2/P3 findings. This was a logic-only change (seed reduction + persistence); no UI/copy/DS surface was touched, and none was found to have shifted.

## B. DESIGN SYSTEM COMPLIANCE — PASS
- Actual components used (unchanged from last-passed baseline): `Input`, `Button` (variant=brand), `InlineLink` (variant=solid for the nudge action links, confirmed by visual/color consistency with the already-verified `data-variant="solid"` pattern from `signup-flow.report.iter3.md`), `InputOTP`/`InputOTPSlot`, `Select`, `Checkbox`, `Badge`.
- Actual tokens used: `--color-brand-red`, `--semantic-ink-subtle` (nudge text color, confirmed `rgb(115,115,115)` live), `--radius-button`, `--radius-card`.
- Custom CSS exceptions: none introduced by this pass.
- Any mapped DS component approximated with custom CSS instead of used directly: none. This pass touched only `src/lib/mockAccountCheck.ts` (pure logic) and the one call-site wiring in `SignupFlow.tsx` (`markAccountAsRegistered(email)`) — read directly from source, confirmed no JSX/styling changes accompanied it.

## C. INTERACTION / UX — PASS
- Inline nudge: correct message + action-link pairing for both mismatch kinds (`already-exists` → "Sign in instead"; `no-account` → "Create account"), neutral styling confirmed live (see check 1/7).
- Cross-flow email preservation: confirmed working (test@kenresearch.com carried over signup→signin via the nudge's action link).
- Editing the email after a mismatch correctly clears the stale nudge and re-checks on next submit (exercised in check 6, switching from demo@ to existing@ in the same field without a reload).
- Full 3-step signup sequence (OTP → Complete Profile → Account Ready) and the 2-step signin sequence both exercised live end-to-end with real DOM-state verification at each step, not just visual inspection.
- Keyboard/focus: no blocking issues observed; OTP field accepted keyboard-typed digits via the real underlying `input-otp` control.

## D. RUNTIME / LAYOUT SAFETY — PASS
- Console errors: none (only benign `[HMR] connected` / React DevTools info notices, zero `error`/`warning`-level entries)
- Page errors (`pageerror`): none
- Horizontal overflow: none (`scrollWidth` 1440 = viewport width, both at baseline and after the full 7-check run)
- Modal/child overflow: none observed in any of the 13 captured screenshots
- Viewport clipping: none
- Unexpected layout shift: none observed across V1↔V2 toggling or any step transition

---

## Direct ground-truth data (not inference)

```
localStorage key:  ken-auth-redesign:registered-emails
Final value:       ["qa-fresh-<epoch>-a@freshtest-inc.com"]   (FRESH1 only — the ONE
                    email that reached true Create-Account completion this run)

Confirmed absent from that persisted set:
  - FRESH2 (abandoned at Complete Profile, never submitted)         → absent, correct
  - test@kenresearch.com (hardcoded seed, not persisted separately) → absent, correct
  - demo@kenresearch.com (old seed, removed)                        → absent, correct
  - existing@kenresearch.com (old seed, removed)                    → absent, correct
```

Source inspection of `src/lib/mockAccountCheck.ts` confirms the hardcoded set is now exactly `new Set(['test@kenresearch.com'])` (line 42), and `markAccountAsRegistered()`'s one call site (`src/components/flows/SignupFlow.tsx`, in `CompleteProfileStep`'s `onSubmit`) fires immediately before `setStep('success')` and nowhere else — matching the builder's claim by direct code read, not just black-box behavior.

---

## Verdict

**PASS** — all 7 requested checks confirmed live, reproduced identically across two independent full runs:
1. Zero P1 issues
2. Zero P2 issues
3. Section B (DS Compliance): PASS
4. Section C (Interaction/UX): PASS
5. Section D (Runtime/Layout Safety): PASS
6. Copy Lock: matches exactly (nudge strings, headings, footer strings all verbatim)
7. Modal proportions: unchanged, no regression
8. Form control geometry: unchanged, no regression

No P3s to report either — nothing non-blocking was found.

## Self-check
- Model used: Sonnet
- Production code touched: no
- Creative suggestions given: no (fidelity/functional verification only)
- UI/UX Pro Max used only advisory, never overriding reference/DS: n/a this pass — no new interaction pattern was introduced, this was a backend-logic verification pass; no advisory notes generated
- Confidence in measurements: high — every claim above was verified via live DOM queries (`getBoundingClientRect`, `getComputedStyle`, `input_value()`, direct `localStorage` reads) against the actual running dev server, not screenshots alone; the full 7-check sequence was executed twice with identical results (including the exact `localStorage` payload down to the persisted email string), and the one behavioral claim requiring source-level confirmation (single call site for `markAccountAsRegistered`, hardcoded seed reduced to one entry) was independently verified by reading `mockAccountCheck.ts` and `SignupFlow.tsx` directly rather than trusting the builder's inline comments alone.
