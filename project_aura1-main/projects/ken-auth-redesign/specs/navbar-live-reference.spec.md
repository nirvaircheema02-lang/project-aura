Reference Source: Live Production Website
Reference Type: Live rendered page (not Figma, not chat image, not local file)
Live URL: https://www.kenresearch.com/
Inspected at: 1440×900 (primary target), 768×1024 (tablet check), 400×900 (mobile check)
Inspection method: Browser MCP (`preview_start` + `computer` screenshot + `javascript_tool` computed-style probes + `read_page`)

Note: this is a Loop Mode target-element task (navbar only, not a full screen/modal). Per user instruction: "I need the same navbar design as in this link" — the live rendered navbar is being treated as the visual source of truth with the same rigor as a Figma/image reference, per the task brief.

---

## Copy Lock

- Utility-bar link 1: "Procurement"
- Utility-bar link 2: "Expert Panel"
- Utility-bar dropdown trigger: "Company" (chevron, opens dropdown — dropdown panel contents not enumerated, out of scope for navbar-only target)
- Utility-bar auth: "Sign in"
- Utility-bar auth: "Sign up"
- Main-bar nav item 1: "Reports" (dropdown)
- Main-bar nav item 2: "Industries" (dropdown)
- Main-bar nav item 3: "Surveys" (dropdown)
- Main-bar nav item 4: "Consulting" (dropdown)
- Main-bar nav item 5: "Insights" (dropdown)
- Search trigger label: "Search" (static label inside the 120×35px pill — this is a click-to-expand trigger, not an inline free-typing input; confirmed via DOM inspection, see Inputs section)
- Primary CTA: "Book discovery call"
- Logo wordmark (image, not text in DOM): "KEN RESEARCH" (rendered inside a 152×18px `<img>`, so not literally editable copy — recorded for completeness)

10 copy items transcribed exactly as rendered on the live page. No footer/legal/helper copy present in the navbar itself (footer copy exists lower on the page but is out of scope for this navbar-only spec).

---

## DS Mapping Gate

| Element | DS component/token (actual path) | Status |
|---|---|---|
| Navbar shell (utility bar + main bar composition) | `design-system/core-v2/src/organisms/navbar/TopNavigation.tsx` (exported as `TopNavigation` from `@kenresearch/design-system/organisms`) | mapped |
| Utility bar container | `design-system/core-v2/src/organisms/navbar/SecondaryBar.tsx` | mapped |
| "Procurement" / "Expert Panel" links | `design-system/core-v2/src/atoms/TextLink.tsx` (`size="sm"`) — already used inside `SecondaryBar.tsx` | mapped |
| "Company ▾" dropdown trigger | `design-system/core-v2/src/molecules/navbar/CompanyTrigger.tsx` + `design-system/core-v2/src/atoms/DropdownChevron.tsx` | mapped |
| "Sign in" / "Sign up" pair | `design-system/core-v2/src/molecules/navbar/AuthButtons.tsx` | mapped |
| Main bar container | `design-system/core-v2/src/organisms/navbar/PrimaryNav.tsx` (sticky shell owned by `TopNavigation.tsx`, `h-[72px]` in DS vs. live site's 60px — see Uncertainties) | mapped (height delta flagged) |
| Logo (K mark + wordmark) | `design-system/core-v2/src/atoms/LogoButton.tsx` (slot-based — consumer injects the actual logo asset as `children`) | mapped |
| Main nav items ("Reports ▾" etc.) | `design-system/core-v2/src/molecules/navbar/NavDropdownTrigger.tsx`, composed via `design-system/core-v2/src/organisms/navbar/DesktopNavItems.tsx` | mapped |
| Search pill | `design-system/core-v2/src/molecules/navbar/SearchBar.tsx` — DS version is a real `<input>` (typing works immediately); live site's is a static-label click-to-expand trigger — same 120×35px pill geometry, different interaction model (see Uncertainties) | mapped (interaction-model delta flagged) |
| "Book discovery call" CTA | `design-system/core-v2/src/atoms/Button.tsx` — variant to select, size to select (see Uncertainties: live button is 166×40px, `border-radius: 5px`, red bg, white text 14px/400 — closest is `variant="brand"` or `variant="primary"`, needs visual confirmation against Button's actual rendered radius/height, DS Button default radius token may not be exactly 5px) | mapped (variant/size to confirm) |
| Typography — utility-bar text (Procurement/Expert Panel/Company/Sign in/Sign up) | `--typography-size-nav-helper` / `--typography-line-height-nav-helper` (13px, matches live's 13px measured) | mapped |
| Typography — main-bar nav items (Reports etc.) | `--typography-size-nav-primary` / `--typography-line-height-nav-primary` (live measured 14px/20px) | mapped |
| Links (color/hover) | `--surface-text-muted` default → `--color-brand-red` on hover (`TextLink`, `CompanyTrigger`, `NavDropdownTrigger` all use this pattern already) | mapped (from DS, not reference — reference only shows default state) |
| Colors — utility bar bg | `--color-ramp-black-50` (DS SecondaryBar uses this token; live measured `rgb(250,250,250)` ≈ `#fafafa`) | mapped |
| Colors — utility bar border | `--border-soft` (DS token; live measured `rgba(0,0,0,0.05)`) | mapped |
| Colors — main bar bg | `--color-foundation-white` (live measured `rgb(255,255,255)`) | mapped |
| Colors — CTA red | `--color-brand-red` (live measured CTA bg is red per screenshot; exact hex not captured — brand-red token is the correct semantic match per CLAUDE.md brand rules, "Ken red `#b01f24` (CTAs only)") | mapped |
| Radius — Sign-up button | `--radius-button` (DS `AuthButtons.tsx` already uses this; live measured `6px`) | mapped |
| Radius — CTA button | to confirm against `Button.tsx`'s actual size-variant radius (live measured `5px` — very close to a `--radius-button`-family token but not bit-exact; flag for visual convergence) | mapped (needs px confirmation) |
| Radius — Search pill | live measured `border-radius: 9999px` (full pill) — DS `SearchBar.tsx` already uses `rounded-[99px]` | mapped |
| Spacing — utility bar height | live measured `40px` — DS `SecondaryBar.tsx` uses `h-[40px]` | mapped |
| Spacing — main bar container max-width/padding | DS `PrimaryNav.tsx` / `SecondaryBar.tsx` both use `max-w-[var(--container-page)] mx-auto px-4 sm:px-6 md:px-8` | mapped |
| Focus state | `AuthButtons.tsx` / `TextLink.tsx` / `CompanyTrigger.tsx` / `NavDropdownTrigger.tsx` own `focus-visible:ring-2 focus-visible:ring-[rgba(20,16,22,0.5)] focus-visible:ring-offset-2` | mapped (from DS, not reference) |
| Hover state | Each DS nav/link component's own `hover:text-[var(--color-brand-red)]` (links) / `hover:bg-[var(--color-foundation-black)] hover:text-[var(--color-foundation-white)]` (Sign-up button) / gradient underline scale-in (`NavDropdownTrigger`) | mapped (from DS, not reference) |
| Filled/active state | `TextLink.tsx`'s `active` prop → `text-[var(--color-brand-red)]`; `CompanyTrigger`/`NavDropdownTrigger` `isOpen` → chevron rotation + underline | mapped (from DS, not reference) |
| Error state | N/A — navbar has no form/validation surface | not applicable |
| Disabled state | Not exercised by any navbar element in the reference; DS `Button.tsx` has its own disabled styling if the CTA needs it later | mapped (from DS, not reference, currently unused) |
| Mobile/tablet collapse (< md / 768px) — circular account icon | `design-system/core-v2/src/organisms/navbar/MobileControls.tsx` (Avatar + Hamburger, `md:hidden`) + `design-system/core-v2/src/organisms/navbar/AuthPopover.tsx` (unauthenticated state = "Welcome" header → Sign-in/Sign-up rows) | mapped |

23 rows: 21 mapped outright, 2 mapped-with-a-numeric-delta-to-confirm (main-bar height 72px DS vs 60px live; CTA radius 5px live vs DS Button's actual token value not yet measured), 1 not-applicable (error state — no form in a navbar), 0 `NO DS EQUIVALENT` gaps found. This is a strong pre-existing match: `design-system/core-v2/src/organisms/navbar/` (TopNavigation + SecondaryBar + PrimaryNav + DesktopNavItems + MobileControls + AuthPopover + molecules/navbar/{AuthButtons,CompanyTrigger,NavDropdownTrigger,SearchBar}) already implements this exact navbar pattern — it was ported from `topnav-v32` specifically for this. **`ken-auth-redesign/builds/src/app/page.tsx` currently imports the wrong organism** (`Navbar` from `organisms/Navbar.tsx` — the tagline/phone/email + "Request a Demo" variant) instead of `TopNavigation` from `organisms/navbar/TopNavigation.tsx`. This is the single most important build instruction in this spec.

---

## Navbar Geometry Target (in place of Modal/Card Geometry Target — not a modal pattern)

- Total navbar height (utility bar + main bar): live measured `40px + 60px = 100px`. DS `SecondaryBar` matches at 40px; DS `PrimaryNav`/`TopNavigation` main bar is hard-coded `h-[72px]` (12px taller than live's 60px) — **flag: builder should override main-bar height to 60px for this build to match the live reference**, or confirm with user whether the DS's 72px is an intentional post-port refinement that should NOT be overridden. Do not silently change a DS-owned constant without flagging it.
- Sticky/fixed behavior: confirmed via DOM inspection — outer wrapper is `position: sticky; top: 0; z-index: 1000` around the whole two-band navbar (utility bar scrolls away is NOT what happens — the entire navbar, both bands, stays pinned together at scroll). DS `TopNavigation.tsx` renders `SecondaryBar` OUTSIDE the sticky wrapper (only the main `<nav>` bar is `sticky top-0 z-[50]`) — **delta flagged**: on the live site, scrolling does NOT leave the utility bar behind; both bands stick together. DS's current composition would let the utility bar scroll away while only the main bar sticks. This needs a build-time decision/flag.
- z-index: live measured `1000` on the sticky wrapper; DS main-nav bar uses `z-[50]`, DS SecondaderyBar uses `z-[60]`. Not a hard blocker (z-index is only relevant relative to other same-page elements) but noted for consistency.
- Breakpoint collapse to single circular account icon: confirmed via live resize test — the "Sign in"/"Sign up" text pair is still fully visible at exactly 768px width (tablet). It collapses to the single circular avatar-icon + hamburger pattern below 768px (tested confirmed present at 400px width). This matches Tailwind's `md` breakpoint (768px) exactly, and matches DS `SecondaryBar.tsx`'s own `hidden md:block` / DS `MobileControls.tsx`'s own `md:hidden` classes bit-for-bit. No delta — DS is already correct here.
- Primary desktop target width: main bar / utility bar both span full viewport width with inner content constrained to `max-w-[var(--container-page)]` (DS token), matching the live site's edge-to-edge white/grey bands with a centered content column — confirmed via live screenshot (content column visually inset ~16-32px from viewport edge depending on breakpoint, consistent with DS's `px-4 sm:px-6 md:px-8`).

---

## Form Control Geometry — N/A structurally, but recording the one input-like control for consistency

This navbar has no traditional form (email/password inputs); the only input-like control is the search pill. Recording its geometry per the spirit of this section:

| Control | DS component | DS size variant | Height (DS real value) | Radius (DS token) | Matches live? |
|---|---|---|---|---|---|
| Search pill | `SearchBar.tsx` (`molecules/navbar`) | fixed size, no variant prop | `h-[35px] w-[120px]` | `rounded-[99px]` | yes — live measured outer pill at `120×35px`, `border-radius: 9999px` (full pill), byte-for-byte match |

No "shared content width" comparison applies here (search pill is a fixed-size independent element, not aligned to other form controls).

---

## Viewport / Reference size

Primary target: 1440×900 desktop. Also inspected 768×1024 (tablet) and 400×900 (mobile) for the documented collapse behavior only — those are not additional build targets beyond what DS breakpoints already provide.

## Container / navbar size

- Utility bar: full-width, `40px` tall, content column `max-w-[var(--container-page)]` centered.
- Main bar: full-width, live-measured `60px` tall (DS default is `72px` — see Geometry Target delta above), content column `max-w-[var(--container-page)]` centered.

## Alignment

- Utility bar: flex row, `justify-between` — left cluster (Procurement, Expert Panel, Company▾), right cluster (Sign in, Sign up).
- Main bar: flex row, `justify-between` — logo far-left, nav items + search center-right cluster, CTA far-right.

## Spacing

- Utility bar left-cluster gap: DS `gap-6` (24px) between TextLinks/CompanyTrigger — live measured left-edge-of-Procurement to left-edge-of-Expert-Panel ≈ 102px (78px link width + ~24px gap), consistent with DS's `gap-6`.
- Utility bar right-cluster gap: DS `AuthButtons` uses `gap-3` (12px) between Sign-in and Sign-up — live measured Sign-up left edge (1336) minus Sign-in right edge (1267+57=1324) ≈ 12px, matches exactly.
- Main bar nav-items gap: DS `DesktopNavItems.tsx` uses `gap-6 xl:gap-8` — not independently re-measured at 1440px against live pixel-for-pixel; flagged as "uncertain, confirm on first render" since live measurement of inter-item gaps wasn't isolated per-item in this pass.

## Typography hierarchy

| Role | Live measured | DS token |
|---|---|---|
| Utility-bar link (Procurement, Expert Panel, Company) | 13px / 400 weight / muted grey (`rgba(0,0,0,0.6)` ≈ measured, though a later probe at repositioned viewport read `rgb(101,101,101)`/`rgb(10,10,10)` for Sign in/up — see note below) | `--typography-size-nav-helper` |
| Sign in / Sign up | 13px / 400 weight | `--typography-size-nav-helper` |
| Main-bar nav items (Reports, etc.) | 14px / 400 weight / `rgb(64,64,64)` default | `--typography-size-nav-primary` |
| CTA "Book discovery call" | 14px / 400 weight / white on red | Button atom's own size-variant type scale — confirm exact weight (DS Button may render medium/semibold by default; live reads as regular 400 — flag for visual confirmation) |

Note: color probes returned two different rgb readings for the utility-bar text across two separate JS passes (`rgba(0,0,0,0.6)` vs `rgb(101,101,101)` for similar elements, and `rgb(10,10,10)`/`rgb(20,16,22)` for Sign-in/Sign-up in different probes) — this is very likely because the earlier probe at 1280px caught a slightly different DOM node than the later 1440px probe (findByExactText matching order isn't stable across renders). Treat the specific hex values as approximate; the DS's own existing muted-grey → brand-red hover tokens (already used in `TextLink`/`AuthButtons`) are the correct semantic target regardless of the exact live hex, per DS-wins priority rule. Flagging this as a color-precision uncertainty for `loop-visual-qa` to nail down against a fresh side-by-side render rather than treating either probe's hex as gospel.

## Colors / tokens

- Utility bar bg: `rgb(250,250,250)` → `--color-ramp-black-50` (assumed nearest token; DS SecondaryBar already uses this exact token for this exact element, so treat as confirmed by construction rather than independently re-derived from the hex).
- Utility bar border: `rgba(0,0,0,0.05)` → `--border-soft`.
- Main bar bg: `rgb(255,255,255)` → `--color-foundation-white`.
- Main bar shadow: live measured `0 8px 12px -4px rgba(0,0,0,0.15)` — DS `TopNavigation.tsx`'s own doc comment references a "purple-tint shadow `rgba(128,108,224,0.15)`" for its `h-72px` shell, which is a **different color family than the live site's neutral-black shadow** — flag as a delta: if pixel-fidelity to the live reference is the goal, the DS's purple-tinted shadow should not silently override the live site's neutral shadow; needs user confirmation on which wins (DS is normally source of truth for a component's own "state," but a cast shadow tint is closer to a copy/visual fact from the reference than a state — recording as an uncertainty rather than deciding unilaterally).
- CTA red: matches `--color-brand-red` (`#b01f24` per CLAUDE.md brand tokens) semantically; exact live hex not captured in this pass (screenshot shows Ken red visually consistent with brand token).

## Radius

- Sign-up button: `6px` → `--radius-button` (DS already uses this).
- CTA button: `5px` (live) — close to but not proven identical to `--radius-button`'s resolved px value; flag for confirmation.
- Search pill: `9999px` (full pill) — DS `rounded-[99px]` (effectively identical at this size).

## Borders

- Utility bar: `1px solid rgba(0,0,0,0.05)` bottom border only.
- Sign-up button: `1px solid` (live measured `rgb(229,231,235)` in one probe context, though DS's own component uses `border-[var(--color-foundation-black)]` — likely probe caught a non-hovered/unstyled intermediate state or a different candidate element; DS's own real border color for this component is the authority per DS-wins priority, not the possibly-mismeasured live hex).

## Shadows

- Main bar: `0 8px 12px -4px rgba(0,0,0,0.15)` (neutral black-tint) — see Colors section delta re: DS's purple-tinted shadow comment.
- Utility bar: no shadow, border-bottom only.

## Backdrop / overlay

Not present in the default (non-scrolled, non-menu-open) navbar state on the live site. DS's `TopNavigation.tsx` already implements a backdrop-blur overlay for when a mega-menu/dropdown is open (`bg-black/[0.02] backdrop-blur-[2px]`) — this is a DS-owned interaction state, not something the reference screenshot shows in its default state, so it is recorded as "from DS" per the rule that dropdown/interaction states are sourced from the DS component, not invented from a static reference image.

## Inputs

No traditional text inputs in the navbar. The search pill is the only input-like control — see Form Control Geometry above and the Uncertainties section for its interaction-model delta (DS = live-typable input; live site = static-label click-to-expand trigger).

## Buttons

- "Sign up" (utility bar): bordered pill/rect, `88×34px` roughly measured, `6px` radius, `border` — maps to `AuthButtons.tsx`'s sign-up button exactly (already has this shape/behavior).
- "Book discovery call" (CTA): `166×40px`, `5px` radius, red bg, white text, `20px` horizontal padding — maps to `Button.tsx`; exact variant/size prop to select needs visual confirmation (`variant="brand"` size `"md"` or `"lg"` are the closest candidates by height; flagged in Uncertainties).

## Icons

- Sign-in icon: small door/arrow glyph, 12px, left of "Sign in" text — already present in DS `AuthButtons.tsx` (inline SVG, `size-[12px]`).
- Sign-up icon: small person glyph, 12px, left of "Sign up" text — already present in DS `AuthButtons.tsx`.
- Company chevron: `DropdownChevron` atom, 10px — matches DS `CompanyTrigger.tsx`.
- Main-nav-item chevrons: `DropdownChevron` atom, 12px — matches DS `NavDropdownTrigger.tsx`.
- Search icon: magnifying glass, 16px, right-aligned inside the pill — matches DS `SearchBar.tsx`'s `lucide-react` `Search` icon at `size={16}`.

## OTP controls

Not present in a navbar. N/A.

## States (sourced from DS components, not the static reference)

- Hover (utility links / main nav items): text transitions to `--color-brand-red`; main-nav items additionally show a gradient underline (`black → grey → red`) scaling in from 0 to full width — both already implemented in `TextLink.tsx` / `CompanyTrigger.tsx` / `NavDropdownTrigger.tsx`.
- Hover (Sign-up button): bg fills to `--color-foundation-black`, text inverts to white — already implemented in `AuthButtons.tsx`.
- Focus-visible: `ring-2 ring-[rgba(20,16,22,0.5)] ring-offset-2` on every interactive nav element — consistent DS-wide pattern, already implemented.
- Open/active (Company / main-nav dropdowns): chevron rotates (`DropdownChevron isOpen`), backdrop blur overlay appears (`TopNavigation.tsx`), announced via `aria-live` region — already implemented, DS-owned, not visible in the static reference's default screenshot.
- Mobile/tablet collapse (<768px): circular Avatar replaces the text Sign-in/Sign-up pair; tapping opens `AuthPopover` with "Welcome" header + Sign-in/Sign-up rows (unauthenticated variant) — confirmed present on the live site at 400px width and already implemented in DS `MobileControls.tsx` + `AuthPopover.tsx`.
- Disabled: not exercised anywhere in this navbar; no action needed.
- Error: not applicable — no form/validation surface in a navbar.

## Responsive behaviour

- ≥1024px (`lg`): full desktop layout — utility bar with all links + Sign in/Sign up text, main bar with all 5 nav items + search pill + CTA. Confirmed present at 1440px.
- 768–1023px (`md`–`lg`): utility bar unchanged (still shows Sign in/Sign up text — `hidden md:block` on `SecondaryBar` keeps it visible at exactly 768px, confirmed live), but main bar's `DesktopNavItems` (nav items + search, `hidden lg:flex`) drops out — replaced by a more compact tablet control set. DS already has a dedicated `TabletControls.tsx` for this band; live site at 768px showed hamburger + logo + "Book discovery call" CTA + Search pill, consistent with a tablet-specific control cluster rather than the full desktop set.
- <768px (`md` breakpoint): utility bar's Sign in/Sign up pair disappears entirely, replaced in the main bar by a circular account-avatar icon (opens `AuthPopover`) + hamburger. Confirmed present at 400px width. Matches DS `MobileControls.tsx`'s `md:hidden` exactly.

## Component mapping (summary — see DS Mapping Gate above for full detail)

| Reference element | DS component/token |
|---|---|
| Whole navbar | `organisms/navbar/TopNavigation.tsx` |
| Utility bar | `organisms/navbar/SecondaryBar.tsx` |
| Procurement / Expert Panel | `atoms/TextLink.tsx` |
| Company ▾ | `molecules/navbar/CompanyTrigger.tsx` |
| Sign in / Sign up | `molecules/navbar/AuthButtons.tsx` |
| Main bar shell | `organisms/navbar/PrimaryNav.tsx` |
| Logo | `atoms/LogoButton.tsx` (slot) |
| Reports/Industries/Surveys/Consulting/Insights ▾ | `molecules/navbar/NavDropdownTrigger.tsx` via `organisms/navbar/DesktopNavItems.tsx` |
| Search pill | `molecules/navbar/SearchBar.tsx` |
| Book discovery call | `atoms/Button.tsx` (variant/size TBD) |
| Mobile collapse (avatar+hamburger) | `organisms/navbar/MobileControls.tsx` |
| Auth popover (mobile "Welcome" card) | `organisms/navbar/AuthPopover.tsx` |

## Reuse opportunities

`TopNavigation.tsx` is a single drop-in organism that already composes every other row in this table — the build task is fundamentally a wiring/config task (pass the right `items`, `ctaButton`, `logo`, `companyDropdown` props and swap the import from `organisms/Navbar` to `organisms/navbar/TopNavigation`), not a from-scratch build. No new component should be created.

## Compact/rhythm evaluation

The live site's rhythm is tight and consistent with the DS's own existing navbar family — 40px utility band, 60px main band (vs DS's 72px default), generous but not loose gaps (24px utility-cluster gap, 12px auth-pair gap). Nothing here suggests the DS's real component defaults would produce a stretched/loose result; the only rhythm delta worth flagging is the 60px-vs-72px main-bar height (see Geometry Target section) and the shadow-tint delta (see Colors section) — both already flagged as uncertainties above rather than silently resolved.

## UI/UX Pro Max Notes (advisory only — does not override reference or DS)

- Touch targets: DS's `MobileControls.tsx` already enforces `min-width/min-height: 44px` on the hamburger button and DS `Avatar` sizing — good baseline WCAG 2.5.5 compliance already in place, no change needed.
- The search pill's click-to-expand interaction (live site) vs. DS's always-typable input: from a usability standpoint, an always-visible typable input (DS's current behavior) is arguably more discoverable/faster to use than a click-to-expand trigger. This is flagged as advisory only — per Loop Mode rules, if 1:1 fidelity to the live reference is the goal, the reference's click-to-expand behavior should win; this note does not recommend overriding that.
- Dropdown chevrons at 10–12px are close to the practical minimum for touch/visual legibility; DS's existing sizing is a reasonable accessibility-conscious default and doesn't need adjustment based on this reference.
- No color-contrast concerns identified from the sampled tokens (muted grey on white/off-white utility bar, white on red CTA) — both are pre-existing DS pairings already audited elsewhere in the workspace per `design-system/core-v2/docs/`.

## Uncertainties requiring visual convergence

- **Main-bar height**: DS `TopNavigation.tsx`/`PrimaryNav` hard-codes `h-[72px]`; live site measures `60px`. Needs a decision: override to 60px for fidelity to this reference, or keep DS's 72px as an intentional system-wide standard and accept the 12px delta. First thing `loop-visual-qa` should measure on the first render.
- **Utility+main sticky grouping**: live site sticks BOTH bands together as one unit (`position: sticky` on an outer wrapper around both); DS's `TopNavigation.tsx` only makes the main `<nav>` sticky, leaving `SecondaryBar` outside the sticky wrapper (scrolls away independently). Needs a build-time decision on whether to wrap both in one sticky container to match the live site exactly.
- **Main bar shadow color**: live measures a neutral black-tint shadow (`rgba(0,0,0,0.15)`); DS's own doc comment describes a purple-tinted shadow (`rgba(128,108,224,0.15)`) as its "canonical" main-bar shadow. Needs user confirmation on which should win for this build.
- **CTA button exact radius/weight**: live measures `5px` radius / regular(400) weight on "Book discovery call"; DS `Button.tsx`'s resolved radius/weight per variant wasn't independently re-measured in this pass (source not re-read in full). `loop-builder` should pick the closest existing size/variant and `loop-visual-qa` should confirm the rendered radius/weight against this live measurement.
- **Inter-nav-item gap at 1440px**: DS uses `gap-6 xl:gap-8`; not independently pixel-measured against the live site item-by-item in this pass. Flag for first-render visual comparison.
- **Utility-bar/link exact hex colors**: two JS probes returned inconsistent rgb readings for what should be the same elements (see Typography hierarchy note) — likely a DOM-matching artifact across separate script runs, not necessarily two real different colors. Treat DS's own existing token choices for these components as authoritative per DS-wins priority; have `loop-visual-qa` do one clean, single-pass color sample on the actual rendered build rather than trusting either of this pass's two conflicting reads.
- **`ken-auth-redesign/builds` currently imports the wrong navbar organism.** This isn't a visual uncertainty so much as a required build correction: `src/app/page.tsx` line 5 imports `Navbar` from `organisms/Navbar.tsx` (tagline/phone/email utility bar, "Request a Demo" CTA, Cmd-K search trigger) — none of which matches the live reference. The correct import is `TopNavigation` from `organisms/navbar/TopNavigation.tsx`, wired with `items` = Reports/Industries/Surveys/Consulting/Insights, `companyDropdown` slot, `ctaButton` = a `Button` reading "Book discovery call", and utility-bar links Procurement/Expert Panel already built into `SecondaryBar` by default (no override needed).
