'use client';

import { useAuthVariant } from '@/lib/authVariant';

/**
 * PreviewToggle — TEMPORARY internal review control for Loop Engineering Mode.
 *
 * >>> REMOVE BEFORE ANY REAL DEPLOYMENT OF THIS AUTH FLOW <<<
 * This is a build/QA convenience only, not part of the approved design — it lets a
 * reviewer flip between the two shared Auth copy/behavior variants (V1/V2) instantly,
 * client-side, against the same running build. No route change, no reload, no separate
 * deployed instance per variant (React state only, via `useAuthVariant()`).
 *
 * Visual distinction from production UI (deliberate, not incidental):
 * - Muted gray + dashed border pill, small "PREVIEW" microlabel above it — the navbar's
 *   real Sign in / Sign up controls use brand black/red; this uses neither, so it can
 *   never be mistaken for a real entry point.
 * - Positioned `fixed top-20 right-4`: below the navbar's SecondaryBar (h-40px) + sticky
 *   PrimaryNav (h-72px) stack's own content, and — the actual constraint that matters —
 *   clear of the centered ~360-400px modal card at common desktop widths (1440x900,
 *   1280x800): the card is horizontally centered (max ~200px either side of viewport
 *   center), so this top-right corner placement never overlaps it — verified live.
 * - `z-[110]`, ABOVE `AuthModal`'s own `z-[100]` (revised from an initial `z-[90]` attempt
 *   after live verification): `AuthModal`'s backdrop is a full-viewport `fixed inset-0`
 *   scrim, not just a card-sized overlay, so anything below `z-[100]` is entirely hidden
 *   (dimmed + unclickable) behind it the instant ANY modal is open — which would defeat
 *   this control's actual purpose, since comparing V1 vs V2 while the modal is OPEN is
 *   the primary use case. Sitting above the scrim keeps it visible/clickable throughout;
 *   it never "obscures the modal" in the sense that matters (overlapping the card's own
 *   content) since it's positioned well clear of the card, confirmed at 1440x900.
 */
export function PreviewToggle() {
  const { variant, setVariant } = useAuthVariant();

  return (
    <div data-component="PreviewToggle" className="fixed top-20 right-4 z-[110] flex flex-col items-end gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-black/40 select-none">
        Preview
      </span>
      <div
        role="tablist"
        aria-label="Auth copy variant preview (internal, not part of the product)"
        className="flex items-center gap-0.5 rounded-full border border-dashed border-black/25 bg-white/90 backdrop-blur-sm p-0.5 shadow-sm"
      >
        {(['v1', 'v2'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={variant === v}
            onClick={() => setVariant(v)}
            className={
              variant === v
                ? 'px-3 py-1 rounded-full text-xs font-medium bg-black/75 text-white transition-colors'
                : 'px-3 py-1 rounded-full text-xs font-medium text-black/45 hover:text-black/80 transition-colors'
            }
          >
            {v.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
