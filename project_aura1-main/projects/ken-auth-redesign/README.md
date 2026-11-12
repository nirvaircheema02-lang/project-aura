# ken-auth-redesign

Redesign of the Ken Research authentication experience — sign-up and sign-in flows,
built as a Next.js app against the internal Ken Research design system.

Built in **Loop Engineering Mode**: each screen is analyzed from a Figma reference into a
spec, implemented, then visually QA'd against the reference, iterating until the render
matches. The `specs/` and `comparisons/` folders are the paper trail of that loop.

## Flows

**Sign-up** — Create account → Email OTP verification → Complete profile → Success
**Sign-in** — Sign in → Email OTP verification → Success

Both render inside a shared `AuthModal` shell over a background hero, with the site's
`TopNavigation` behind it. The navbar's "Sign in" / "Sign up" entry points route between
the two flows, as do the in-modal cross-links.

## Structure

```
builds/            Next.js 16 + React 19 app (the implementation)
  src/app/         Route entry — renders the modal open by default in sign-up mode
  src/components/
    AuthModal.tsx    Shared modal shell
    BackgroundHero.tsx
    flows/           SignupFlow, SigninFlow — step orchestration
    screens/         Individual step screens (OTP, profile, success)
    icons/
specs/             Per-screen implementation specs, derived from the Figma reference
comparisons/       Visual-QA reports + reference/render screenshots, per iteration
PROJECT.md         Project configuration and screen status
```

## Running locally

> **Note:** this project depends on two internal workspace packages —
> `@kenresearch/design-system` and `@kenresearch/tokens` — declared as `workspace:*`.
> They are not published to npm and are not included in this repository, so a standalone
> clone will **not** `pnpm install` on its own. To run it, place this folder inside the
> Ken Research pnpm workspace that provides those packages (as
> `projects/ken-auth-redesign`) and install from the workspace root.

```bash
cd builds
pnpm install     # from the workspace root
pnpm dev         # http://localhost:3091
```

Other scripts: `pnpm build`, `pnpm start`, `pnpm lint`, `pnpm typecheck`.

## Stack

Next.js 16 · React 19 · Tailwind CSS v4 · Framer Motion · TypeScript ·
`@kenresearch/design-system` (core-v2) · `@kenresearch/tokens`

## Status

Design exploration. Not production code, and not wired to a real auth backend — all
data in the flows is mock data.
