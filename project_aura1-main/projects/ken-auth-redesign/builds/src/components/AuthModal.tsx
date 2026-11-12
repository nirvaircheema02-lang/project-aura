'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

export interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  /** aria-labelledby target id — pass the id of the heading rendered inside `children`. */
  labelledBy: string;
}

/**
 * AuthModal — shared shell for the ken-auth-redesign Loop project.
 *
 * WHY: Every screen in the auth flow (signup-email, signup-otp, login, etc.) shares the
 * same centered-card-over-scrim shell. Built once here so later screens only swap the
 * inner content, not the modal chrome.
 *
 * Shell choice (spec Uncertainty #A) — attempted `ui/dialog.tsx` (Radix) this iteration,
 * then reverted; see "Shell attempt + revert" note below for the full reasoning. Landed
 * back on this hand-rolled shell, whose structural classes (overlay `bg-black/50`,
 * card `rounded-[10px]` / `p-6 md:p-8` / `shadow-2xl`, close `top-4 right-4` `w-11 h-11`
 * `text-black/40 hover:text-black`) are modeled on `atoms/ContactModal.tsx`'s real,
 * already-compiling classes — not invented.
 *
 * Shell attempt + revert (this iteration): tried rebuilding on
 * `design-system/core-v2/src/ui/dialog.tsx` (Radix `Dialog`/`DialogContent`) as the more
 * genuinely reusable, composable DS primitive — `ContactModal.tsx` is a single-purpose
 * lead-capture form that doesn't accept `children` and isn't designed as a generic shell,
 * so "reusing" it only ever means copying its JSX pattern, not consuming a shared
 * component; `ui/dialog.tsx` is a real composable wrapper meant for exactly this.
 * `@radix-ui/react-dialog` resolved cleanly (already a `core-v2` peer dep) and typecheck/
 * build/lint all passed. But a live render check caught a hard blocker invisible to
 * build tooling: `ui/dialog.tsx` has zero prior consumers anywhere in the workspace
 * (verified by grep), so its Tailwind classes — `fixed`, `top-[50%]`, `translate-x-[-50%]`,
 * `z-50`, etc. — were never captured by the DS's pre-generated
 * `design-system/core-v2/src/styles/_safelist.generated.css`, and this project's own
 * Tailwind v4 content scan doesn't reach into `core-v2/src/ui/dialog.tsx` either. Result:
 * the dialog rendered with `position: static` and no centering — content pushed below the
 * viewport, invisible, confirmed via computed-style inspection at 1440x900 (DevTools:
 * `dialog-content` rect `top: 900` = viewport height, `z-index: auto`). That is a real DS
 * build-pipeline gap (out of Loop scope to fix — would mean editing the shared DS's
 * Tailwind/safelist infra, not this project's build), not a design-fidelity judgment call,
 * so reverted rather than leaving a broken render. Flagging to Aura/tech as an infra
 * follow-up: `ui/dialog.tsx` is effectively unusable by any consumer today until either
 * its classes are added to the generated safelist or the content-scan glob is widened.
 *
 * Card sizing (baseline — geometry-strengthened re-analysis): the spec's mandatory
 * Modal/Card Geometry Target section pixel-measured the reference (not estimated) and set
 * a hard numeric target of `max-w-[480px]` with `p-10` (40px, `--spacing-10`) padding on all
 * sides — between the two real DS shell precedents (`ContactModal.tsx` 500px, `ui/dialog.tsx`
 * 512px) and never exceeding 512px. This replaced the prior iteration's `max-w-[640px]`
 * `p-6 md:p-8`, which was the confirmed mechanism behind the "too wide/stretched" user-reported
 * regression. Text wraps inside the resulting ~400px content column; the modal is not widened
 * to fit text.
 *
 * Refinement pass (`signup-flow-refinement.spec.md` §1): outer padding steps down one real DS
 * token, `--spacing-10` (40px) → `--spacing-8` (32px) (`p-10` → `p-8`), and max-width falls out
 * arithmetically from that (400px content column, held fixed, + 2×32px padding = 464px), not
 * an independently eyeballed width. Content column width (400px) and control heights (48px)
 * are unchanged. Backdrop also gains `backdrop-blur-sm` alongside the existing tokenized
 * `--semantic-scrim`, matching `ContactModal.tsx`'s scrim+blur precedent (§3 of the same spec)
 * without regressing to that file's hardcoded `bg-black/50`.
 *
 * Second geometry pass (prior iteration — explicit user-directed tightening, not a QA fix):
 * padding stepped down one more real DS token, `--spacing-8` (32px) → `--spacing-5` (20px)
 * (`p-8` → `p-5`). Content column dropped one clean step below the previous 400px to 384px
 * (400 − 16px, a `--spacing-4` step) — user-directed and explicit, not left as an open
 * question. Max-width fell out arithmetically: 384 + 2×20 = 424px (`max-w-[464px]` →
 * `max-w-[424px]`). No step file hardcodes an independent content width (confirmed by grep —
 * every field/button/label uses `w-full`/`flex-1`, none set their own `max-w`/`w-[…]` at the
 * content-column level), so the content-width change took effect everywhere via this one
 * shell file; only `EmailOtpStep.tsx`'s OTP row also picked up a `justify-center` on its
 * container (no slot resize) to stay visually balanced at the new 384px column (6×48px slots
 * + 5×8px gaps = 328px, was left-packed with 72px slack at 400px, now 56px slack at 384px —
 * centering splits that evenly rather than leaving it one-sided).
 *
 * Padding correction (prior iteration — explicit user-directed, superseded the `--spacing-5`
 * step above mid-flight): padding moved one real DS token back up, `--spacing-5` (20px) →
 * `--spacing-6` (24px) (`p-5` → `p-6`). Content column 384px, max-width 432px.
 *
 * Shared-variant refinement pass (this iteration — `ken-auth-redesign` Part B, applies
 * unconditionally to BOTH V1 and V2, not variant-conditional): padding steps back down one
 * real DS token, `--spacing-6` (24px) → `--spacing-5` (20px) (`p-6` → `p-5`). Verified against
 * the actual token, not assumed: `src/vendor/tokens/tokens.css:259` defines
 * `--spacing-5: 1.25rem` (20px). Tailwind v4's own default `spacing-*` scale (`N × 0.25rem`)
 * puts its stock `p-5` utility at exactly `1.25rem`/20px too — same value as the DS token — so
 * the bare Tailwind class is used directly (no `p-[var(--spacing-5)]` override needed).
 * Content column steps down 384px → 360px (a `--spacing-6`/24px step). Max-width falls out
 * arithmetically: 360 + 2×20 = 400px (`max-w-[432px]` → `max-w-[400px]`). Grep-confirmed no
 * step file (`EmailOtpStep.tsx`, `CompleteProfileStep.tsx`, `SignupSuccessStep.tsx`,
 * `SigninSuccessStep.tsx`) hardcodes an independent content width — every field/button/label
 * uses `w-full`/`flex-1`, so this one shell change takes effect everywhere. The OTP row is
 * left-aligned (not centered) per the already-established fix documented in
 * `EmailOtpStep.tsx` — at 360px that row's 328px fixed width leaves 32px of slack (down from
 * 56px at 384px), still comfortably fits, no realignment needed.
 *
 * Backdrop (verified, not changed): `--semantic-scrim` resolves to `rgba(0, 0, 0, 0.5)`
 * (`src/vendor/ds/styles/base.css:114`) — a genuinely dark/dimmed 50%-black overlay, not a
 * too-light/neutral one. No darker DS scrim/overlay token exists in this project's vendored
 * tokens (grepped `tokens.css` + `base.css` for `scrim`/`overlay` — only this one token).
 * Kept as-is; `backdrop-blur-sm` alongside it is unchanged from the prior pass.
 *
 * Close button (prior iteration — Part B item 1): moved OUTSIDE the padded card content, from
 * an `absolute top-4 right-4` child of the padded card div (so its position drifted whenever
 * the card's own padding changed — exactly what happened across the `p-8`→`p-6`→`p-5`→`p-6`
 * history above) to a sibling of the card, absolutely positioned against a new shared
 * `relative` OUTER wrapper that also carries the modal's `max-w-[400px]`. That pass landed on
 * `-top-3 -right-3` with a single `w-9 h-9` circle doing double duty as both the hit area and
 * the visible surface — half-outside/half-overlapping the card's top-right corner. Because it
 * no longer lives inside the card's own padding box, future padding changes to the card can
 * never again move it. Side effect (net improvement, not the goal): it also no longer scrolls
 * away with the card's internal `overflow-y-auto` on tall content, since it's outside that
 * scrolling element entirely.
 *
 * Close button geometry + hover refinement (this iteration — explicit user-directed fix; the
 * single-circle `-top-3 -right-3`/`w-9 h-9` shape above read as "stuck to the card corner"
 * since a 36px circle offset by only 12px overlaps the card by 24px). Two-layer sizing now
 * used: the outer `<button>` is the full `w-11 h-11` (44px) WCAG 2.5.5 touch target — matching
 * this project's other established 44px targets (`IconBox.tsx` `size="sm"` docs "44px ×
 * 44px... Matches V0_lite `size-11`") — but is itself visually transparent (no bg/border/
 * shadow); a nested `<span>` centered inside it carries the actual visible white circle,
 * sized down to `w-9 h-9` (36px, within the requested 32–36px range and equal to the prior
 * iteration's circle size, so only ITS position changes, not its visual scale). Live-measured
 * (getBoundingClientRect on the card and the visible circle) and iterated to `-top-[50px]
 * -right-[50px]` on the outer button — with the circle centered 4px inside that 44px box on
 * every side, this places the visible circle's near edges ~10px outside the card's top and
 * right edges (within the requested 8–12px range) with zero visual overlap, while the extra
 * 4px of invisible hit-area padding floats further away from the card (never toward/over it),
 * so the enlarged hit area cannot intercept clicks meant for card content. Border: added
 * `border border-black/10` to the visible circle, reusing `vendor/ds/ui/input.tsx`'s exact
 * existing neutral-border token/opacity (`border-black/10`) rather than inventing a new value.
 * Hover (restrained, B2B-appropriate — NOT the 180° rotation a more playful product might use):
 * icon rotates 90° (`group-hover:rotate-90`) over 180ms (`duration-[180ms] ease-out`, within
 * the requested 150–200ms range) using Tailwind v4's native transform composition (no `group`
 * needed on a wrapper other than the outer button); "slightly brighter" reuses the existing
 * `text-black/40`→`hover:text-black` icon-darkening plus two subtle, neutral additions:
 * `shadow-md`→`shadow-lg` and `border-black/10`→`border-black/20` on the visible circle only —
 * no color shift toward brand red, no scale/bounce. `group`/`group-hover:` is used throughout
 * (on the outer button) so hovering anywhere in the enlarged 44px hit area — including the
 * invisible padding — triggers the visible circle's hover state, not just direct circle hover.
 * Accessibility unchanged: `onClick`, `aria-label="Close modal"`, and the focus-visible ring
 * treatment all still live on the outer `<button>` exactly as before.
 *
 * Close button chrome removal (this pass — explicit user-directed fix, supersedes the visible
 * white circle described immediately above): the nested `<span>` carrying `bg-white`/
 * `border border-black/10`/`shadow-md`/`group-hover:shadow-lg`/`group-hover:border-black/20`
 * has been removed entirely — only the bare `X` icon renders now, no circular surface behind
 * it. Eliminated the wrapper `<span>` rather than keeping it as an empty centering shell (less
 * markup for the same visual result, since the outer `<button>` is already
 * `flex items-center justify-center`). Everything else about the outer `<button>` is
 * byte-identical: same `w-11 h-11` 44px hit-area, same `-top-[50px] -right-[50px]` position
 * (same ~10px outside-the-card gap this was tuned to), same focus-visible ring. The icon's own
 * treatment is also untouched — `text-black/40` default, `group-hover:text-black`,
 * `transition-[color,rotate] duration-[180ms] ease-out`, `group-hover:rotate-90` — only the
 * background chrome around it is gone. Live-verified against the modal's actual backdrop:
 * the button sits entirely outside the card (above/right of its top-right corner via the
 * negative offset), so the bare `text-black/40` icon is always painted directly over the
 * modal's scrim (`--semantic-scrim` ~50% black + `backdrop-blur-sm`, confirmed above) — never
 * over the card's own white surface. Reads as a legible, if intentionally understated, dark
 * mark against that scrim (same default-state opacity this icon already used before the white
 * circle existed behind it); a rough contrast estimate against the flattened scrim tone lands
 * near, not comfortably above, the WCAG non-text 3:1 threshold — see build report's "Close
 * button legibility" note for the live-observed read and the estimate behind it.
 *
 * Close icon color fix (prior pass — explicit user-directed fix, addressed the legibility
 * concern flagged immediately above): `text-black/40` → `text-white/80`, and
 * `group-hover:text-black` → `group-hover:text-white` (full opacity). The transparent circle
 * background stayed removed (not reintroduced) at that time — only the icon's own color
 * changed. A dark mark at 40% opacity read with only modest contrast against the ~50%-black
 * blurred scrim; white at 80% opacity reads clearly against that same dark backdrop. Default is
 * kept at 80% rather than full white specifically so hover (100% white) still has headroom to
 * read as "brighter" per the established hover spec above — inverting to black on hover would
 * contradict that intent and look jarring against a white default. `w-5 h-5`,
 * `transition-[color,rotate] duration-[180ms] ease-out`, and `group-hover:rotate-90` are all
 * unchanged by this pass.
 *
 * Close button light translucent backing (this pass — explicit user-directed fix,
 * reintroduces a wrapping `<span>` that was fully removed two passes ago): the icon-only
 * treatment above read as floating with no backing at all against the scrim — a regression
 * past "light transparent" into fully bare, not a return to the heavier solid-white +
 * border + shadow circle from further back (that stays removed). A `<span>` (`w-9 h-9
 * rounded-full`, matching the already-established 36px-visual-circle-inside-44px-hit-area
 * pattern) is reintroduced as an `absolute inset-0 m-auto` child of the `<button>` — the
 * button is itself `position: absolute` (against the outer wrapper), which makes it a valid
 * containing block for its own absolutely-positioned children, so `inset-0 m-auto` centers
 * the span inside the button's 44px box with no extra `relative` wrapper needed; being taken
 * out of flow, it also can't disturb the icon's own flex-centered position (no layout shift).
 * Unlike the earlier removed circle, this one carries NO `border`/`shadow` — only a light
 * translucent tint: `bg-white/15` default, `group-hover:bg-white/25` on hover, with its own
 * `transition-colors duration-150` (a separate, shorter transition from the icon's own
 * `duration-[180ms]` color/rotate transition, but the same 150–200ms family). Live-verified
 * via computed-style + real `:hover` match (element-ref-based hover, not raw screenshot
 * coordinates — see build report): default renders as a soft, barely-there tint clearly
 * short of solid white; hover brightens subtly in the same direction as the icon's own
 * `text-white/80`→`text-white` brightening. The icon itself (`text-white/80`,
 * `group-hover:text-white`, `group-hover:rotate-90`, `duration-[180ms] ease-out`), the
 * button's 44px hit-area/position/focus-ring, and the `w-9 h-9` span sizing are all otherwise
 * unchanged.
 *
 * Card max-height clearance fix (this pass — confirmed regression, reproduced by direct
 * measurement, not visual impression): the card's `max-h-[calc(100vh-4rem)]` only reserves
 * 64px of total vertical slack, splitting to ~32px above/below when the card is centered at
 * (or near) that cap. The close button sits OUTSIDE the card at `-top-[50px]`, so it needs at
 * least 50px of clearance above the card's top edge to stay on-screen — 32px isn't enough, and
 * neither, it turns out, is whatever clearance a step's natural content height happens to leave
 * once that height gets close to the old cap. Live-measured at 2000x780 on the Complete Profile
 * step (tallest step: 4 fields + checkbox + button + footer link) before this fix: card height
 * 700.83px, card top 39.59px, close button top **-10.41px** (confirmed clipped above the
 * viewport, unclickable in that region). Fix: `max-h-[calc(100vh-4rem)]` ->
 * `max-h-[calc(100vh-7rem)]` — reserves 112px total (~56px each side when centered), which is
 * enough headroom for the button's 50px offset plus a small buffer. This works by *lowering*
 * the cap below that step's natural content height (700.83px), rather than raising it — so the
 * card gets capped for the first time at short viewports and its own pre-existing
 * `overflow-y-auto` takes over as the internal-scroll safety net (confirmed: at 780px the card
 * clips to 668px client height against 701px scroll height, 33px scrolls internally; the close
 * button, being a sibling outside the scrollable div, is entirely unaffected by that scroll).
 * Re-measured after the fix, same step, same 2000-wide viewport, three heights: 780px -> card
 * height 668px (capped), card top 56px, close button top **6px**; 900px -> card height 700.83px
 * (natural, uncapped — 900-112=788 > 700.83), card top 99.59px, close button top **49.59px**;
 * 1150px -> card height 700.83px (natural), card top 224.59px, close button top **174.59px**
 * (unchanged from before the fix, confirming no regression at spacious heights, since the new
 * cap of 1150-112=1038px still comfortably exceeds the content's natural height). All three
 * live-verified further via `elementFromPoint` (button unobstructed) and a real dispatched
 * click sequence (pointerdown/mousedown/pointerup/mouseup/click) that closed the modal. Spot-
 * checked at 780px on two shorter steps for regression: email/OTP-collecting phase (close
 * button top 145.58px) and OTP-verifying phase (90.78px), plus the Success step (96.02px) — all
 * comfortably clear, confirming this was never an issue on shorter steps and remains fine after
 * the change. The button's own offset/size/icon/hover treatment and the card's `overflow-y-auto`
 * are both untouched — only this one max-height value changed.
 */
export function AuthModal({ isOpen, onClose, children, labelledBy }: AuthModalProps) {
  useEffect(() => {
    /* Fix (iter2 P2 #4): a nested Radix popover (Select/Dropdown/Popover) handles its own
     * Escape-to-close via a document-level `capture: true` listener (Radix's
     * `useEscapeKeydown`), but it does NOT call `stopPropagation()` or `preventDefault()`
     * after dismissing itself — so the same Escape keypress kept bubbling up to this
     * modal's own (bubble-phase) listener and closed the whole modal too. Root cause was
     * listener *timing*, not a missing DS prop: registering our own listener with
     * `capture: true` on `window` means it now runs BEFORE Radix's document-capture
     * listener (capture order is outermost → innermost: window, then document), so we can
     * read the DOM while the popover is still open and bail out — leaving Radix's own
     * handler (which fires next) to close just the popover, per standard combobox
     * behavior. A second Escape press, with no open popover, closes the modal as before. */
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isOpen) return;
      const openPopover = document.querySelector(
        '[data-slot="select-content"], [data-slot="dropdown-menu-content"], [data-slot="popover-content"]',
      );
      if (openPopover) return;
      onClose();
    };
    window.addEventListener('keydown', handleEscape, { capture: true });
    return () => window.removeEventListener('keydown', handleEscape, { capture: true });
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      data-component="AuthModal"
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-[var(--semantic-scrim)] backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      <div className="relative max-w-[400px] w-full" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="group absolute -top-[50px] -right-[50px] z-10 w-11 h-11 rounded-full flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-red)] focus-visible:ring-offset-2"
          aria-label="Close modal"
        >
          <span className="absolute inset-0 m-auto w-9 h-9 rounded-full bg-white/15 transition-colors duration-150 group-hover:bg-white/25" />
          <X className="w-5 h-5 text-white/80 transition-[color,rotate] duration-[180ms] ease-out group-hover:text-white group-hover:rotate-90" />
        </button>
        <div className="bg-white rounded-[2.5px] w-full p-5 shadow-2xl animate-in zoom-in-95 duration-200 max-h-[calc(100vh-7rem)] overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
