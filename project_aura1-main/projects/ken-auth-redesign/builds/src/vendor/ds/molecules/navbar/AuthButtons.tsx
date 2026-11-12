'use client';

export interface AuthButtonsProps {
  onSignIn: () => void;
  onSignUp: () => void;
  /**
   * EXPERIMENTAL / exploratory addition — ken-auth-redesign Loop project, Part E.
   * Additive + optional; every other consumer of this vendored `AuthButtons.tsx` is
   * unaffected when omitted (default `false`, unchanged separate-pair rendering).
   *
   * When `true`, renders ONE combined "Sign in / Register" entry point instead of the
   * separate Sign in (text link) + Sign up (outlined button) pair. Clicking it calls
   * `onSignUp` — opens the sign-up flow, which itself carries a "Sign in" footer link for
   * switching, so a returning user is never stranded on the wrong flow.
   *
   * This is a LOCAL fork of the DS navbar (lives under `src/vendor/ds/`, not the shared
   * `design-system/core-v2/`), safe to extend here without affecting any other Project
   * Aura consumer — separate mechanism from `PreviewToggle`, wired in `page.tsx` only
   * when the shared Auth preview variant is 'v2'.
   */
  combinedEntry?: boolean;
}

/**
 * AuthButtons — desktop logged-out Sign in (text link) + Sign up (outlined button) pair,
 * or (Part E, `combinedEntry`) a single combined "Sign in / Register" entry point.
 *
 * Visible only when `!isAuthenticated` on desktop secondary bar.
 *
 * @promotedFrom topnav-v32/src/app/components/navbar/molecules/AuthButtons.tsx
 */
export function AuthButtons({ onSignIn, onSignUp, combinedEntry = false }: AuthButtonsProps) {
  if (combinedEntry) {
    return (
      <div data-component="AuthButtons" data-combined-entry="true" className="flex items-center">
        <button
          type="button"
          onClick={onSignUp}
          className="
            flex items-center gap-1.5
            border border-[var(--color-foundation-black)] px-3 py-1.5 rounded-[var(--radius-button)]
            font-[var(--typography-family-body)] font-medium
            text-[var(--surface-text)]
            hover:bg-[var(--color-foundation-black)] hover:text-[var(--color-foundation-white)]
            transition-all duration-200
            focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-[rgba(20,16,22,0.5)] focus-visible:ring-offset-2
            text-[var(--typography-size-nav-helper)] leading-[var(--typography-line-height-nav-helper)]
          "
        >
          Sign in / Register
        </button>
      </div>
    );
  }

  return (
    <div data-component="AuthButtons" className="flex items-center gap-3">
      <button
        type="button"
        onClick={onSignIn}
        className="
          flex items-center gap-1
          font-[var(--typography-family-body)] font-normal
          text-[var(--surface-text-muted)] hover:text-[var(--color-brand-red)]
          transition-colors bg-transparent border-none cursor-pointer
          text-[var(--typography-size-nav-helper)] leading-[var(--typography-line-height-nav-helper)]
        "
      >
        <svg className="size-[12px]" fill="none" viewBox="0 0 12 12" stroke="currentColor" aria-hidden="true">
          <path
            d="M6.5 1.5H2.5C2.22386 1.5 2 1.72386 2 2V10C2 10.2761 2.22386 10.5 2.5 10.5H6.5M8 8.5L10.5 6M10.5 6L8 3.5M10.5 6H5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Sign in
      </button>

      <button
        type="button"
        onClick={onSignUp}
        className="
          flex items-center gap-1.5
          border border-[var(--color-foundation-black)] px-3 py-1.5 rounded-[var(--radius-button)]
          font-[var(--typography-family-body)] font-medium
          text-[var(--surface-text)]
          hover:bg-[var(--color-foundation-black)] hover:text-[var(--color-foundation-white)]
          transition-all duration-200
          focus-visible:outline-none focus-visible:ring-2
          focus-visible:ring-[rgba(20,16,22,0.5)] focus-visible:ring-offset-2
          text-[var(--typography-size-nav-helper)] leading-[var(--typography-line-height-nav-helper)]
        "
      >
        <svg className="size-[12px]" fill="none" viewBox="0 0 12 12" stroke="currentColor" aria-hidden="true">
          <path d="M6 5.5C6.82843 5.5 7.5 4.82843 7.5 4C7.5 3.17157 6.82843 2.5 6 2.5C5.17157 2.5 4.5 3.17157 4.5 4C4.5 4.82843 5.17157 5.5 6 5.5Z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 9.5C3 8.17 4.34 7 6 7C7.66 7 9 8.17 9 9.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Sign up
      </button>
    </div>
  );
}
