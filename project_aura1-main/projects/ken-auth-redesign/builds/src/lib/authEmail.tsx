'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export interface AuthEmailContextValue {
  email: string;
  setEmail: (email: string) => void;
}

const AuthEmailContext = createContext<AuthEmailContextValue | null>(null);

/**
 * useAuthEmail — reads the shared work-email value + its setter. Must be used inside an
 * `<AuthEmailProvider>` (mounted once in `page.tsx`, alongside `AuthVariantProvider`).
 *
 * ken-auth-redesign Part B: lifted out of `SignupFlow.tsx` / `SigninFlow.tsx`, which
 * previously each held their own independent `useState('')` for `email` — switching flows
 * (via the footer "Sign in"/"Create account" link, or the inline wrong-flow nudge added in
 * Part C) lost whatever the user had already typed, since the two flows never shared state.
 * Mirrors the existing `useAuthVariant()` Context pattern in `authVariant.tsx` (single
 * provider, a hook that throws outside it) rather than introducing a different
 * state-sharing mechanism into this codebase.
 *
 * Only `email` moves up here — each flow's own internal `step`/`phase` state (which screen
 * is showing, OTP-entry progress, etc.) stays local to that flow, unchanged.
 */
export function useAuthEmail(): AuthEmailContextValue {
  const ctx = useContext(AuthEmailContext);
  if (!ctx) {
    throw new Error('useAuthEmail() must be called within an <AuthEmailProvider>.');
  }
  return ctx;
}

/**
 * AuthEmailProvider — single source of truth for the work-email value shared between
 * `SignupFlow` and `SigninFlow`. Plain React state, no persistence (resets on page
 * reload/close, same as the two independent `useState('')`s it replaces) — the only change
 * is that both flows now read/write the SAME state instead of two separate instances.
 */
export function AuthEmailProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState('');
  const value = useMemo(() => ({ email, setEmail }), [email]);
  return <AuthEmailContext.Provider value={value}>{children}</AuthEmailContext.Provider>;
}
