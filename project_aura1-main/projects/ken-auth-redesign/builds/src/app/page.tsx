'use client';

import { useState } from 'react';
import { SignupFlow } from '@/components/flows/SignupFlow';
import { SigninFlow } from '@/components/flows/SigninFlow';
import { TopNavigation } from '@/vendor/ds/organisms';
import { Button } from '@/vendor/ds/atoms';
import { BackgroundHero } from '@/components/BackgroundHero';
import { KenLogo } from '@/components/KenLogo';
import { AuthVariantProvider, useAuthVariant } from '@/lib/authVariant';
import { AuthEmailProvider } from '@/lib/authEmail';
import { PreviewToggle } from '@/components/PreviewToggle';

type AuthMode = 'signup' | 'signin';

/**
 * Loop render entry point for the interactive sign-up flow (`SignupFlow`, per
 * `projects/ken-auth-redesign/specs/signup-flow.spec.md` — Create account → OTP
 * verification → Complete profile → Success) AND the interactive sign-in flow
 * (`SigninFlow`, per `projects/ken-auth-redesign/specs/signin-flow.spec.md` — Sign in →
 * OTP verification → Success).
 * Modal renders open by default in sign-up mode, starting at Step 1, so `loop-visual-qa`
 * can screenshot it directly at `/` — same default as before this pass, preserving the
 * already-PASSED sign-up baseline. The sign-in flow is reached by clicking the navbar's
 * "Sign in" entry point (desktop `AuthButtons` or mobile `AuthPopover`), or via either
 * flow's own cross-links (see below).
 *
 * Navbar (2026-08-26 correction, per loop-analyzer spec
 * `projects/ken-auth-redesign/specs/navbar-live-reference.spec.md`): the previous
 * import (`Navbar` from `organisms/Navbar.tsx` — tagline/phone/email utility bar +
 * "Request a Demo" CTA) was the WRONG DS component for the live-site reference
 * (https://www.kenresearch.com/) the user asked to match. The correct match,
 * already built in the DS specifically for this exact pattern (ported from
 * `topnav-v32`), is `TopNavigation` from `organisms/navbar/TopNavigation.tsx`,
 * composing SecondaryBar (Procurement / Expert Panel / Company▾ / Sign in / Sign up)
 * + PrimaryNav (logo / Reports·Industries·Surveys·Consulting·Insights▾ / search /
 * "Book discovery call" CTA) + MobileControls/AuthPopover for the <768px collapse.
 *
 * All utility-bar copy (Procurement, Expert Panel, Company, Sign in, Sign up) and
 * all five main-bar dropdown labels (Reports, Industries, Surveys, Consulting,
 * Insights) are `SecondaryBar`/`DesktopNavItems`' own real DS defaults — verbatim
 * matches to the spec's Copy Lock, so no override props are passed for them.
 *
 * `onNavigate` is the single auth-navigation handler `TopNavigation` funnels both
 * "Sign in" and "Sign up" (desktop AuthButtons) AND the mobile AuthPopover's
 * Sign-in/Sign-up rows through (`AuthButtons`/`AuthPopover` both call
 * `authPopover.onNavigate(path)` internally with `/auth?mode=signin` or
 * `/auth?mode=signup` — confirmed in `design-system/core-v2/src/organisms/navbar/
 * SecondaryBar.tsx` and `AuthPopover.tsx`). 2026-08-26 fix (this pass): previously every
 * path opened the sign-up modal regardless of which one was clicked — now the `mode` query
 * param is parsed and routed to the matching real flow (`SigninFlow` now exists; no longer
 * a placeholder).
 *
 * `onLogoClick` and the "Book discovery call" CTA / Reports-Industries-Surveys-
 * Consulting-Insights dropdown triggers are left as inert no-op stubs
 * (console.log) per task instruction — this project doesn't need real routing
 * for those, just no-error stubs. `companyDropdown` / `megaMenus` are left unset
 * (spec: dropdown *panel contents* were out of scope for this navbar-only spec;
 * the triggers' own open/close + chevron-rotation + hover states are DS-owned
 * and still exercised via `useNavDropdown`).
 *
 * BackgroundHero addition (directed exception, explicitly NOT a fidelity-to-reference
 * build — user asked for "any random section" behind the modal so the page doesn't
 * render blank): rendered inside `<main>`, behind the modal. `AuthModal`'s own shell is
 * `fixed inset-0 z-[100]` (see AuthModal.tsx), so it overlays this section correctly
 * regardless of DOM order — no z-index/stacking changes needed here.
 *
 * Both `SignupFlow` and `SigninFlow` are kept mounted at all times (each guards its own
 * render via its own `isOpen`, same as before this pass) so only one is ever visible; the
 * modal-open flag lives in `authMode` rather than a single boolean, since exactly one of
 * the two flows is open at a time. Each flow's own cross-link ("Create account" in
 * `SigninFlow`, "Sign in" in `SignupFlow`'s Step 1/Step 3 footers) calls `setAuthMode`
 * directly rather than going back through `onNavigate`, since those are in-modal switches,
 * not navbar-triggered navigation.
 *
 * `AuthEmailProvider` (ken-auth-redesign Part B, this pass) wraps the tree alongside
 * `AuthVariantProvider` so `SignupFlow`/`SigninFlow` share ONE `email` value instead of
 * each owning its own local `useState('')` — switching between the two flows (footer link
 * or the inline wrong-flow nudge added in Part C) now preserves whatever the user already
 * typed. See `src/lib/authEmail.tsx`.
 */
export default function Home() {
  // AuthVariantProvider (ken-auth-redesign Part A) wraps the whole page tree so both
  // `PreviewToggle` (writes the variant) and `HomeContent` (reads it, via `useAuthVariant()`,
  // to pick V1/V2 copy for the mounted flows + the Part E combined navbar entry) share the
  // exact same React state — no prop-drilling a variant flag through every layer by hand.
  return (
    <AuthVariantProvider>
      <AuthEmailProvider>
        <HomeContent />
      </AuthEmailProvider>
    </AuthVariantProvider>
  );
}

function HomeContent() {
  const [isOpen, setIsOpen] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode>('signup');
  const { variant } = useAuthVariant();

  const handleAuthNavigate = (path: string) => {
    // `/auth?mode=signin` -> SigninFlow, `/auth?mode=signup` (or anything else) -> SignupFlow.
    const mode: AuthMode = path.includes('mode=signin') ? 'signin' : 'signup';
    setAuthMode(mode);
    setIsOpen(true);
  };

  return (
    <>
      {/* PreviewToggle (ken-auth-redesign Part A) — TEMPORARY internal review control, not
          part of the product. See PreviewToggle.tsx for the full rationale + removal note. */}
      <PreviewToggle />
      <TopNavigation
        logo={<KenLogo />}
        onLogoClick={() => console.log('[TopNavigation] logo clicked — no home route wired yet')}
        isAuthenticated={false}
        onNavigate={handleAuthNavigate}
        onSignOut={() => console.log('[TopNavigation] sign out — unreachable, isAuthenticated is always false')}
        ctaButton={
          <Button
            variant="brand"
            size="sm"
            onClick={() => console.log('[TopNavigation] "Book discovery call" clicked — no routing wired yet')}
          >
            Book discovery call
          </Button>
        }
        // EXPERIMENTAL / exploratory (ken-auth-redesign Part E, independent of PreviewToggle):
        // V2 preview shows ONE combined "Sign in / Register" navbar entry point instead of the
        // separate Sign in / Sign up pair; V1 preview is untouched. See AuthButtons.tsx for the
        // additive prop this threads through (SecondaryBar -> AuthButtons).
        combinedAuthEntry={variant === 'v2'}
      />
      <main className="min-h-screen bg-[var(--semantic-surface-white,#fafafa)]">
        <BackgroundHero />
        {!isOpen && (
          <div className="flex justify-center pb-16">
            <button
              onClick={() => setIsOpen(true)}
              className="text-sm text-black/60 underline"
            >
              Reopen {authMode === 'signin' ? 'sign-in' : 'signup'} modal
            </button>
          </div>
        )}
        <SignupFlow
          isOpen={isOpen && authMode === 'signup'}
          onClose={() => setIsOpen(false)}
          onSwitchToSignin={() => setAuthMode('signin')}
        />
        <SigninFlow
          isOpen={isOpen && authMode === 'signin'}
          onClose={() => setIsOpen(false)}
          onSwitchToSignup={() => setAuthMode('signup')}
        />
      </main>
    </>
  );
}
