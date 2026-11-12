# Validation Notes — real-page dry-run walkthroughs

Evidence record for the fixes in [`ARCHITECTURE.md`](ARCHITECTURE.md) §0 (URL canonicalization), §2.4 (network/console noise scoping), §2.7 (render-settled & dynamic-content preconditions), and §5.2 (B2/B4 responsibility clarifications).

**Method, stated honestly:** no Audit Agent code existed when these were run. They are structured desk-checks: real kenresearch.com pages were actually opened and inspected (navigation, accessibility tree, computed styles, network log, console log, live JS queries in a real browser), then the B-graph was walked node-by-node against what each page actually contained, checking every plausible failure against the spec until no unresolved gap remained. This validates the *design*; it cannot validate an implementation that doesn't exist yet (see §5).

---

## 1. Consulting sub-page (single-page mode)

**URL:** `https://www.kenresearch.com/consulting/strategy-consulting/market-entry-consulting`

**Observed live:**
- `window.location.href` matched the given URL exactly (no redirect) — but a different page on the site links to the same content via a shorter path, `/market-entry-consulting`.
- On re-check: the page declares `<link rel="canonical">` and `og:url`, both pointing to the long path exactly.
- 11+ async API/XHR calls fire after initial load (`/api/auth/session`, `/api/user`, several `/app/survey/api/...`, `/app/ghost/api/collateral/...`) — a hydrating Next.js app, not a static page.
- Three "0+" stat counters and one "$0Mn" counter present as that literal text in the live DOM at capture time. On re-check: scrolled into view, dispatched a real `scroll` event, waited 3 seconds — **still "0+"/"$0Mn."**
- Primary CTA (`Talk to a Strategy Expert`) renders `rgb(176, 31, 36)` — exactly `#b01f24`, the Ken red brand token.
- A naive "select by visible text" query on that button returned `fontSize: 12px`, `padding: 0px` — not its real rendered appearance. The query grabbed a descendant/wrapper node, not the styled component root.
- The "Select Industry" field is a plain `<input placeholder="Select Industry">` with `role: null` — no ARIA/DOM signal that it's a dropdown.
- Multiple `<video>` elements (POV preview thumbnails) with fallback text in the accessibility tree.
- Multiple visually-similar CTAs resolve to different destinations (`/talk-to-us`, `/book-a-discovery-call`, `/custom-form`).
- Footer has off-domain links to `forms.office.com` (IT Support / Website Issue) rendered as ordinary page links.

| # | Node | Scenario | Verdict | Resolution (→ ARCHITECTURE.md) |
|---|---|---|---|---|
| 1 | §0 / A1 | Same page reachable via two URL paths | Gap | URL canonicalization, preferring the declared canonical tag (§0) |
| 2 | B1 | Async calls still in flight at capture | Gap | Render-settled precondition — network-idle wait (§2.7) |
| 3 | B1/B4 | Placeholder counters read as literal zero; waiting did **not** fix it | Gap | Confidence-flag escalation is the primary safeguard; settle-and-recheck is a first pass only (§2.7) |
| 4 | B2 | Dropdown control with no ARIA role | Gap | B2 uses combined DOM + visual evidence, never role alone (§5.2) |
| 5 | B2→B4 | Independent re-query grabbed the wrong node → confident but wrong measurement | Gap (highest severity — actively misleading) | B4 consumes B2's exact element reference (§5.2) |
| 6 | B6 | Off-domain utility links could pollute DS Candidates | Gap (minor) | Off-domain exclusion unless a recognized DS CTA pattern (§5.2) |
| 7 | B5 | `<video>` mid-load misread as rendering bug | Folded into #3 | Same dynamic-content mechanism |
| 8 | B3 | Similar CTAs, different hrefs — reuse or drift? | Already handled | B3 confidence + S8 routing |
| 9 | C1–C3 | PII from the lead-gen form leaking across runs | Already handled | Per-instance browser isolation (§2.7) |
| 10 | B4 | `type="number"` phone input — pattern or violation? | Already handled | B3/B4 classification + confidence |

**Second-order checks:** canonicalization must stay conservative (never strip a param that changes content — could wrongly merge distinct pages). Network-idle (#2) does *not* cover counter animation (#3) — animation timing isn't network-bound; both are needed. B2 assigning each component a stable per-page reference (for #5) also gives `finding_id` a natural stable value (§2.5 rule 1).

---

## 2. Report Store listing & Report Detail

**Report Store — `/report-store`:**
- 343 network requests on one page (vs. ~74 on the consulting page) — tabbed report feeds (`quick-access-report-store/?tab=trending_now|new_this_week|recently_updated`), faceted filters, live search.
- The tabs are separate content states behind interaction, each API-backed — a passive snapshot only sees the default tab. → Interactive-disclosure expansion (§2.7).
- "Recommended For You — based on your browsing history and interests" is genuinely personalized; per-instance isolation means the agent always sees the cold-start variant. → Personalized-content scoping (§2.7).
- "2,00,000+ reports available" → Bounded listing-sampling policy (§2.7).

**Report Detail — `/malaysia-industrial-packaging-pallets-supply-chain-packaging-solutions-market`:**
- Network log showed `GET /survey/plant-based-dairy-alternative-perception-survey?_rsc=... → [FAILED: net::ERR_ABORTED]` — a hover-*prefetch* for an unrelated page, not a failure of the page being audited. → Network-noise scoping (§2.4).
- Report chapters truncated behind "Read More" — same class as the tabs above. → Unified into interactive-disclosure expansion (§2.7).

---

## 3. Survey landing page

**URL:** `/brand-perception-survey`

- The same "0+" stat-counter signature appears again ("Respondents Engaged...," "Brand Perception Survey Conducted...," "C-Suite & Industry Experts...") — two unrelated templates, same signature. Confirms it's a shared-component pattern, modeled as a recurring signature (§2.7).
- 1198+ console messages on this page alone — nearly all benign `<link rel="preload">`-not-used warnings, with at least one meaningful one buried in them: `Swiper Loop Warning: The number of slides is not enough for loop mode...` (a real carousel misconfiguration). → Console-message noise policy (§2.4).

---

## 4. Outcome

- **Scope:** 4 distinct templates (consulting sub-page, report listing, report detail, survey landing).
- **Pass-1 fixes re-checked:** canonicalization strengthened (canonical tag found); dynamic-content fix substantively revised after real testing showed waiting doesn't resolve it; network-idle confirmed necessary but insufficient alone (paired with noise scoping); B2 evidence, B2→B4 handoff, and off-domain exclusion stand with no counter-evidence.
- **New findings from additional templates:** 7, all resolved into additive mechanisms reusing existing ones (S8, existing sequential edges, T-layer) — no new agents.
- **Stop condition met:** no unresolved failure within the tested scope.

## 5. Limits of this method

- The B2→B4 element-handoff contract (§5.2) can only be confirmed as a *design* here — whether an implementation actually honors it needs real code and real test runs.
- Only 4 templates were tested; A2's template classification will surface more families on a full-site run. Treat this as validated within that scope, not exhaustively.
- The placeholder-counter behavior could be a genuine broken data-binding on the live site *or* an animation trigger automation can't reproduce — this dry-run can't tell which, which is exactly why the architecture escalates it rather than deciding.

## 6. Corrections from real code (Phase 2, 2026-09-11)

These dry-run findings were re-tested with real code against the same live templates (captures in `test/fixtures/templates/`, replayed offline by `test/integration/t-layer-fixtures.test.ts`):

- **Placeholder counters — the dry-run's "waiting doesn't resolve it" was a test artifact.** The dry-run dispatched a *synthetic* `scroll` event, which does not move the scroll position or re-run `IntersectionObserver`. With real wheel input the counters resolve: consulting `0+`→`1000+`/`2000+`/`500+`, `$0Mn`→`$500Mn`; survey `0+`→`250000+`/`1200+`/`1500+`. The escalation backstop (§2.7) stays for counters that genuinely never resolve.
- **Prefetch aborts confirmed at scale:** 39–67 speculative-request failures per page, 0 critical-path failures on all 4 templates — noise scoping (§2.4) is load-bearing, not theoretical.
- **Swiper loop warning confirmed live** on the survey page — kept as evidence; everything else in the console suppressed by policy with counts recorded.
- **Production carries no `data-component` / `data-variant` attributes** on any of the 4 templates (the Design System repo has them on 161/289 files). B2/B3 cannot use them as a signal on production — resolves `IMPLEMENTATION-PLAN.md` §12 open decision #5.
- **Report detail redirects** (`308`) from the bare slug to `/industry-reports/<slug>`; the final URL is the page identity.
- **B2→B4 handoff** is now confirmed in real code (aria-ref resolves to the exact element, stamp survives unrelated DOM mutation, stale refs fail closed) — the §5 limit above no longer applies.
