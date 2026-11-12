'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type AuthVariant = 'v1' | 'v2';

export interface AuthVariantContextValue {
  variant: AuthVariant;
  setVariant: (variant: AuthVariant) => void;
}

const AuthVariantContext = createContext<AuthVariantContextValue | null>(null);

/**
 * useAuthVariant — reads the current shared Auth preview variant ('v1' | 'v2') + its
 * setter. Must be used inside an `<AuthVariantProvider>` (mounted once in `page.tsx`).
 *
 * Consumed by `PreviewToggle` (writes it) and by `SignupFlow.tsx`/`SigninFlow.tsx`
 * (read it to pick between the V1/V2 copy objects passed down to `EmailOtpStep`,
 * `CompleteProfileStep`, `SignupSuccessStep`, `SigninSuccessStep`).
 */
export function useAuthVariant(): AuthVariantContextValue {
  const ctx = useContext(AuthVariantContext);
  if (!ctx) {
    throw new Error('useAuthVariant() must be called within an <AuthVariantProvider>.');
  }
  return ctx;
}

/**
 * AuthVariantProvider — single source of truth for which shared Auth copy/behavior
 * variant is active. Plain React state (no persistence, no route/query param) so
 * switching is instant and never reloads the page — per this Loop task's requirement
 * that the toggle switch "instantly ... React state only, no reload, no route change."
 * Default is 'v1' per spec.
 */
export function AuthVariantProvider({ children }: { children: ReactNode }) {
  const [variant, setVariant] = useState<AuthVariant>('v1');
  const value = useMemo(() => ({ variant, setVariant }), [variant]);
  return <AuthVariantContext.Provider value={value}>{children}</AuthVariantContext.Provider>;
}
