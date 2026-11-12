# Phase 2 — Code-Level Implementation Plan

**Status: Phase 2 build in progress.** §10 steps 1–9 (Foundation, D-layer, T-layer, B-graph, C1/C2, C4 dashboard, Figma spikes, C3 minus the blocked image path, A-graph/full-site) are implemented and tested — the D-layer against the real Design System on disk (read-only), the T-layer against real Chromium on a local server plus replayed live captures of the 4 validated kenresearch.com templates. See §10 for per-step status. C3's `upload_assets` screenshot-delivery step is explicitly excluded from this build pass — see §6, confirmed unresolved. This document follows from the approved architecture ([`ARCHITECTURE.md`](ARCHITECTURE.md) v1.3) and from grounding research conducted directly against this session's connected Figma tools, the Design System on disk, current library documentation, and current Playwright documentation — every claim below is either **verified** (checked against a live tool, a real file, or a fetched doc) or explicitly flagged **unverified/spike**. Nothing here redesigns the architecture; several findings *require* new architecture-level clarifications, called out as such.

**v1.3 addition (this revision): §11 adds the C4 Local Audit Dashboard** — a mandatory third output alongside Figma and Excel, per `ARCHITECTURE.md` §6/Decision Log #18. Touches §1 (one new dependency row), §5 (one new module folder), §8 (one new agent-mapping row), §9 (one new testing row), §10 (one new build step), in addition to its own dedicated §11.

---

## 1. Technology choices

| Choice | Decision | Why |
|---|---|---|
| Language | **TypeScript** | D3 (Style Dictionary) and D4 (TS component/variant parsing via the compiler API) are Node-only. A Python service would have to shell out to `style-dictionary build` or re-implement DTCG alias resolution — a direct violation of §6's "never duplicated" rule, since that would be a second interpretation of the same tokens. C3's `use_figma` payload is JavaScript either way. Verified: local `python3` is 3.9.6; every Python candidate (langgraph, anthropic, mcp, temporalio, pytest) requires >=3.10. |
| Runtime | **Node 24 (Krypton LTS)**, own `.nvmrc` | The sibling repo pins Node 20.20.1, but Node 20 reached end-of-life 2026-04-30 (verified against the official Node release schedule) — do not inherit it. This machine already runs Node v24.12.0. Node 24 gives type-stripping (`process.features.typescript === 'strip'`, verified) so the CLI/workers need no build step, and native `--env-file` removes the need for `dotenv`. Node 22 is the conservative fallback if 24 proves premature. |
| Package manager | **pnpm** (matches the DS's `packageManager: pnpm@10.33.0`, `engines.node >=20`) | Keeps `audit-agent` and the Design System's own tooling compatible if anyone ever needs to run both. |
| Module system | ESM (`"type": "module"`) | Style Dictionary 4.x is ESM-only. |
| Local dashboard server (C4, §11) | **Fastify 5.x** + `@fastify/static` | Minimal dependency footprint (consistent with this plan's general bias against heavy frameworks — hand-rolled retry, hand-rolled config, etc.), TypeScript-native, and its schema-validation hooks reuse the same Zod definitions the rest of the service already has. Server-rendered pages + a small amount of vanilla client-side JS for filter/sort interactivity — no SPA build pipeline for a local-only, single-user tool. Recommendation, not locked — see open decision in §12. |

---

## 2. Graph engine — custom TypeScript orchestrator (not LangGraph.js)

This is the one decision in this plan that's a genuine judgment call rather than a forced conclusion from the research — both options were verified in real depth. Recommendation: **a small, purpose-built orchestrator over `better-sqlite3` + `p-queue`**, not LangGraph.js. Reasoning, weighed against the verified facts from both sides:

1. **ARCHITECTURE.md §2.2 already mandates a fully custom, queryable SQL schema** (`escalation_queue[]`, `fan_out` counters, `checkpoints[]`, `cache_hits`) regardless of engine. Verified: LangGraph.js's SQLite checkpointer creates exactly two tables, `checkpoints` and `writes`, both storing **opaque BLOBs** keyed by `thread_id` — not queryable domain rows. Adopting LangGraph.js doesn't reduce this work; it adds a second, shadow persistence layer that must be kept from diverging from the SQL tables §2.2 already requires ("declare SQL authoritative, treat channels as transient" becomes an ongoing discipline burden, not a one-time decision).
2. **Decision Log #1 (page-level restart only, explicitly not full node-level durability) fights LangGraph.js's default, not helps it.** Verified: LangGraph.js's default `durability` is `'async'` (checkpoint per super-step — i.e. per-node). Getting page-level-only restart requires precise, easy-to-lose configuration (`durability: 'exit'` + one graph invocation per page, `thread_id = page_id`). A custom orchestrator makes page-level restart the natural, undefeatable default rather than a setting someone can accidentally regress.
3. **§2.4's three-way `RETRYABLE`/`REPAIRABLE`/`TERMINAL` classification has no native equivalent in either option.** Verified: LangGraph.js's `RetryPolicy.retryOn(e)` is a two-way retry/don't-retry predicate — `REPAIRABLE`'s bounded re-ask-with-validation-error must be hand-written inside the node either way. The one thing LangGraph.js would contribute here — an `errorHandler` that runs after retries are exhausted — is a ~20-line pattern to replicate directly (it's just a SQL insert into `escalation_queue` either way).
4. **§2.5's rules are all raw SQL primitives, and the grounding verified them working on plain SQLite with zero engine involvement**: a partial `UNIQUE` index on `(url, mode) WHERE status='RUNNING'` correctly rejected a second concurrent run while allowing a completed one; `INSERT ... ON CONFLICT DO UPDATE SET dispatched=dispatched+1 RETURNING dispatched` returned `1` then `2` (verified live on this machine, Node v24.12.0, SQLite 3.50.4). LangGraph.js contributes nothing to §2.5 that SQLite doesn't already give directly.
5. **Dependency footprint.** LangGraph.js pulls `@langchain/core` (peer `^1.1.48`), which itself pulls `langsmith`, `js-tiktoken`, `mustache`, `p-queue@^6`, `@cfworker/json-schema` — an unrelated LLM-tooling stack — into a service whose LLM path (Anthropic SDK + Zod + `zodOutputFormat`, already decided) and observability path (§2.6, plain OpenTelemetry) need none of it.
6. **Maturity/docs gap, verified**: `langchain-ai/langgraph` (Python) has 41,361 GitHub stars vs. `langchain-ai/langgraphjs` at 3,267; several load-bearing answers in this research (durability modes, `RetryPolicy` defaults, `errorHandler` semantics, `maxConcurrency` plumbing) had to be read directly out of the shipped `.d.ts`/sources rather than documented contracts, because the JS docs are thinner than the Python-first docs.
7. **Acknowledged cost of this choice** (why it's close, not a blowout): LangGraph.js's `interrupt()`/`Command({resume})` gate primitive, its native `Send`-based fan-out with `maxConcurrency`, and its jitter-by-default `RetryPolicy` are genuinely good, independently-tested primitives that the custom orchestrator must reimplement and test itself. That is real, first-party work this plan is choosing to take on (§9 gives the testing strategy for exactly this).

**If this recommendation is overridden**, `stack.json`'s LangGraph.js option (§2.1's `Send` for fan-out, `interrupt()`/`Command({resume})` for gates, `RetryPolicy` for jitter, `durability: 'exit'` + thread-per-page for Decision Log #1) is fully specified and can be swapped in — the SQL schema in §7 below does not change either way, since it's already engine-independent by design.

### Orchestrator shape (custom option)

A typed edge registry (discriminated union matching ARCHITECTURE.md §2.1's seven edge types) driving a small loop:
- **`fan-out`**: `p-queue` 9.3.3 (`concurrency` for the bound, `intervalCap`/`interval` for *rate* — needed for Figma's 10/min budget and A1's politeness budget, which `p-limit` cannot express).
- **`fan-in`**: `Promise.allSettled` over the queue, giving `dispatched == completed + failed` (§2.4 partial fan-in) directly.
- **`gate`**: the run row moves to `AWAITING_*_CONFIRMATION` and the process can exit; a separate `resume <run_id>` command re-enters at the recorded position. No checkpointer needed — Decision Log #1 already fixed the restart granularity at "page," so there is no finer state to recover.
- **`error`**: a `classify(err): 'RETRYABLE'|'REPAIRABLE'|'TERMINAL'` function, per-node retry tables from §2.4, exponential backoff **with explicit jitter** (this is not optional — the reason jitter exists is exactly this architecture's fan-out shape, ref `RESEARCH-REFERENCES.md #9`).
- **`feedback`**: cross-run only (§4), implemented as ordinary reads/writes against the SQL tables in §7 — never an in-run cycle.

---

## 3. Dependencies (pinned, with why)

| Purpose | Package @ version | Notes |
|---|---|---|
| Graph state, S7 history, §2.5 tables, §2.6 spans | `better-sqlite3@12.11.1` | Pin the `12.x` line (`engines: 20.x‖22.x‖23.x‖24.x‖25.x‖26.x`), not `13.x` (`node>=22` only) unless the repo commits to Node 22+. Verified `.transaction()` (deferred/immediate/exclusive, savepoint nesting, rollback-on-throw) and a 5000ms default busy timeout — removes two real bug classes under fan-out. Set `PRAGMA journal_mode=WAL` explicitly at startup. |
| Bounded concurrency + rate pacing | `p-queue@9.3.3` | `concurrency` (fan-out bound) + `intervalCap`/`interval` (rate limiting for Figma's 10/min, A1's per-origin politeness). `p-limit` cannot express the interval half — do not substitute it. |
| Retry (if not hand-rolled) | *hand-rolled ~30 lines*, no library | `p-retry`'s shape doesn't fit the three-way classification + per-execution-type table (§2.4). **Important integration detail**: the Anthropic SDK retries on its own by default (`maxRetries: 2`, on 408/409/429/5xx) *underneath* whatever node-level policy is set — an AI node with `maxAttempts: 2` can silently issue 6 API calls. Set `maxRetries: 0` on the Anthropic client and let the node policy own retry/backoff/classification entirely. |
| Structured outputs (S0 contract, `confidence_band`, `escalation_status`) | `zod@4.6.1` + `@anthropic-ai/sdk@0.124.0` | Zod 4 is the only version satisfying the SDK's peer range (`^3.25.0‖^4.0.0`) *and* `@langchain/langgraph`'s peer range *and* `@modelcontextprotocol/sdk`'s peer range simultaneously — one hoisted copy. Use `zodOutputFormat` (`@anthropic-ai/sdk/helpers/zod`) + `client.messages.parse()`. Keep schemas inside the documented JSON-Schema subset: no recursion, no `min`/`max`/`minLength`, `additionalProperties: false` required — the SDK strips unsupported constraints and validates client-side, so a constraint outside the subset silently never reaches the model. `zodOutputFormat`'s thrown `AnthropicError` issue list is exactly the text to feed the bounded `REPAIRABLE` re-ask (§2.4). |
| Excel report (C1, mandatory deliverable) | `exceljs@4.4.0` | The only JS library covering all of §15's needs (multi-sheet + styling + embedded images + conditional formatting) in one package — `xlsx`/SheetJS CE cannot style or embed images at all (that's behind SheetJS Pro), which fails the mandatory-deliverable bar outright. Accept the staleness (no release since 2023-10-19); wrap it behind one adapter module so a future swap touches one file. Do **not** use the streaming writer — it doesn't support images, and the report embeds screenshots. |
| Content-addressed dedup signature (§2.5 rule 3) | `canonicalize@5.0.0` (RFC 8785 JCS) + `node:crypto` `sha256` | Not `object-hash` (last published 2022, own ad-hoc stability contract) — JCS is a written standard. `canonicalize@5` needs Node 22+; fall back to `safe-stable-stringify@2.5.0` if the repo must support Node 20. |
| D3 token resolution | `style-dictionary@4.4.0` *(exact match to the DS's own pinned `^4.3.0`, not the published `5.5.3` latest)* | Verified: `new StyleDictionary({...dsConfig, log:{verbosity:'silent'}}).formatPlatform('css')` runs entirely **in memory** (writes only happen in `buildPlatform`/`buildAllPlatforms`) and produced output byte-identical to the DS's own checked-in `build/tokens.css`. Import `style-dictionary/utils` for alias/reference resolution so D3 never disagrees with the DS's own build — even though today's `tokens.json` has zero aliases, build on the real resolver, not a hand-rolled walker, so the first alias anyone adds doesn't silently mis-resolve. |
| D4 component/variant extraction | `ts-morph@28.0.0` pinned against `typescript@5.9.3` | Match the DS's own `devDependency: typescript ^5.5` — do not point the compiler API at the published `7.0.2` "latest" (the native port; incompatible). |
| §2.6 Execution Tracing | `@opentelemetry/api@1.9.1`, `@opentelemetry/sdk-trace-base@2.11.0`, `@opentelemetry/semantic-conventions@1.43.0` (import `/incubating` for the `ATTR_GEN_AI_*` constants) | No official `@opentelemetry/instrumentation-anthropic` exists (verified: 404 on npm) — write manual spans, one per graph node keyed to `(run_id, page_id, node_id)`, importing the GenAI attribute constants rather than hardcoding attribute strings. The GenAI semantic-conventions package is still evolving (moved repos 2026-05-05) — pin the exact version. |
| Browser automation (T-layer) | `playwright@1.63.0` | Node's reference implementation, ahead of the Python port (`1.62.0`). **Locally installed is `1.60.0`** — pin one version explicitly before relying on any 1.61+ API surface (e.g. `page.ariaSnapshotJSON`). |
| CLI | `commander@15.0.0` (or `14.0.3` if staying Node-20-compatible) | 4–6 subcommands (`audit-site`, `audit-page`, `resume`, `gate approve/reject`, `escalations`) with a required-enum `--mode` flag — matches §0's "never inferred, always explicit" rule directly via Commander's own validation. |
| Config loading (Decision Log #17) | *hand-rolled ~40-line loader*, Zod-validated | Not `c12` (npm `latest` tag is currently an RC) or `cosmiconfig` (`v10` needs Node `^22.18‖>=24`, and its multi-format search is more machinery than one config file needs). Schema-validated defaults, `audit-agent.config.json` (or `.ts`, since Node 24 runs it directly), then `AUDIT_AGENT_*` env overrides, secrets via `--env-file`. Fail fast with a readable error if the DS path doesn't resolve — the same posture §0 takes on a missing `mode`. |
| Test runner | `vitest@4.1.11` (moving to `5.0.0` once the repo commits to Node 24-only) | Fake timers matter more here than usual — §2.4's exponential+jitter backoff and gate-timeout escalation should be tested without real waits. |
| Figma transport | *none directly* — see §6 | No MCP client library is used directly by this service; C3 shells out to a headless Claude Code run (§6). |

---

## 4. D-layer implementation — the Design System has real, verified problems D3/D4/D5/D6 must not paper over

This is the single most important section of this plan to read carefully. The grounding didn't just map D1–D6 to file paths — it found that **the Design System itself has unresolved internal contradictions**, and a naive D-layer implementation would turn every one of them into a confidently wrong audit finding. Concretely, before any code is written:

### D3 Tokens — two-layer model, not a single source read

- **Source layer**: `tokens/tokens.json` (286 tokens, W3C DTCG, zero aliases today) via `style-dictionary/utils` (§3).
- **Effective layer — what B4 must actually compare against**: the DS's own script (`scripts/check-tokens.mjs`, `DEFINITION_SOURCES`) defines the real cascade as exactly four files in this order: `tokens/build/tokens.css` → `core-v2/src/styles/base.css` → `editorial-light.css` → `cinematic-dark.css`. **Verified: 26 tokens are overridden at runtime** — all 6 `--shadow-*` and all 16 `--button-*` (e.g. `--button-height-md` is `40px` in `tokens.css` but `48px` in `base.css`, and the live docs site confirms `48px` is what actually renders) plus 5 `--semantic-ink-*`. `base.css` deliberately places these in an **unlayered** `:root` specifically to beat the `@layer tokens` import — its own comment says so. **A D3 that reads only `tokens.json` will generate confidently wrong B4 findings on every button and every shadow in the system.**
- **Shadows are structurally corrupted in every generated build output.** Because shadow tokens are typed `$type: "color"`, Style Dictionary's color transform reduces a multi-layer `box-shadow` string to its first color (`shadow.md`'s real value becomes `rgba(0,0,0,0.1)` in `tokens.css`). D3 must read shadow *original* values from `tokens.json`'s `original.$value` (which Style Dictionary's `getPlatformTokens()` exposes) or from `base.css` directly — never from any generated CSS/JS/flat-JSON output.
- **Do not ingest `DESIGN.md` or `motion/MOTION_SPEC.md` as token sources.** Both contradict the real build (`DESIGN.md`: `--radius-md 8px` vs. real `15px`; `MOTION_SPEC.md`: `--duration-fast 150ms` vs. real `200`). Treat all Markdown as D5 prose only, never as D3 truth — an explicit source allowlist (`tokens.json` + the 4 canonical CSS files + `charts/theme/tokens.ts`) is a required implementation guardrail, not a nicety.
- **Charts are a separate, newer truth.** `core-v2/src/charts/theme/tokens.ts` (modified 2026-09-01) replaced the chart palette with a purple ramp and explicitly forbids brand red in chart data — while `tokens.json`'s `chart.palette.1` still says `#b01f24`, "Primary series — Ken red." The TS file is what Highcharts actually consumes; D3 must resolve this precedence explicitly (chart tokens come from the TS file, not the DTCG source) or B4 will contradict itself on every chart audit.
- **No compiled DS stylesheet exists on disk to diff against** — `base.css` depends on `@import 'tailwindcss'` and Tailwind v4 processing, so resolving *effective* computed values requires either (a) a small PostCSS/Tailwind build step for the DS's own styles, or (b) reading computed values from a live rendered page (recommended — load the DS's compiled CSS in a Playwright page and read `getComputedStyle(root)` per `[data-variant]`, rather than re-implementing CSS cascade/layer rules by hand).

### D4 Components/Variants — four extraction mechanisms, not one

Ken's components do **not** use a uniform variant model (confirmed: CVA appears in exactly 6 files, all shadcn `ui/` primitives). A single extractor will not cover the DS. D4 needs four passes over `core-v2/src/**/*.tsx` (289 files):
1. TS string-literal union types (the dominant Ken pattern — 39 exported `*Variant`/`*Size`/`*Theme` types, e.g. `Button.tsx`'s `ButtonVariant`/`ButtonSize`/`ButtonBackground`).
2. `Record<Variant, X>` lookup maps → Tailwind arbitrary-value classes carrying `var(--token)` (e.g. `Badge.tsx`'s `themeColors` table — the cleanest extraction target, a direct variant→token mapping).
3. IIFE switch functions and inline style objects (`Button.tsx`'s `variantClass`/`variantInlineStyle`) — **and note explicitly**: Button's hover styling is applied via React state into an inline `style` object, not CSS at all, and is **un-extractable from any stylesheet** — the only way to observe it is to actually hover the element in Playwright.
4. `cva()` configs (6 files, all shadcn `ui/` — and their referenced theme vars like `bg-primary`/`bg-destructive` are **not defined anywhere** in `core-v2/src/styles`, i.e. shadcn primitives are unthemed in this DS today; D4 should record that fact rather than treat it as a bug to paper over).

**DOM detection signal caveat**: `data-component="<Name>"` covers only 161/289 files (atoms 52/55, molecules 47/60, organisms 61/81, but **0/46 shadcn `ui/`, 1/34 charts, 0/9 templates**), and only 8 `data-variant`/6 `data-size` occurrences exist DS-wide — variants are essentially invisible in the DOM. **Whether the audited production site (not this DS repo) retains `data-component` in its build is unverified** — confirm this against a real production page before B2/B3 architecture leans on it as a primary signal, per ARCHITECTURE.md §5.2's existing "combined DOM + visual evidence, never role/attribute alone" rule.

### D5 States/Rules — two tracks

- **Track A (do first): lift six already-executable rule-checkers directly into the audit agent** as B4 deterministic modules — `scripts/{check-tokens,check-components,check-font-scale,check-ink-roles}.mjs` and `core-v2/scripts/{verify-css-vars,lint-section-alternation}.mjs` already encode rule IDs (`R8.4`, `R4.3`, `R4.10`, Bible §1.11/§1.12.1) as regex/logic and produce `file:line` violations. This is the highest-value, lowest-risk D5 asset — near-drop-in.
- **Track B (LLM extraction, S8-banded): `RULES.md`** is the best prose source (stable `R#.#` IDs, explicit WHY/WHAT/WHEN/WHEN-NOT/WHERE fields per rule) — extract into a rules JSON keyed by its native IDs, with every extracted rule carrying a source path + line range so a finding is traceable. **`ANTI_PATTERNS.md`'s "Cat N.N" IDs do not resolve to any literal anchor in either of its two divergent copies** (root 234 lines, `core-v2/docs` 29KB) — do not build rule-lookup logic that assumes those IDs are addressable strings.
- **Recipes are partially stale**: `case-study.md` still points at `design-system/core/src/app/components/`, a directory verified not to exist, and still cites GSAP/Lenis, removed from the workspace 2026-05-08. Any recipe-derived template expectation needs a staleness check before being trusted as ground truth.

### D6 Version — must be a content hash, not semver

Both DS packages are frozen at `0.1.0` across months of real content changes (`tokens.json` May 28, `base.css` Aug 25, `charts/theme/tokens.ts` Sep 1 — all 2026), and `design-system/` is **not under git** at all. **If `ds_registry_version` is taken from semver, §4.4's re-audit memoization will produce false cache hits** — a page would be silently skipped as "unchanged" after a real DS change. `ds_registry_version` must be a canonical-JSON + stable-hash (same discipline as §2.5 rule 3) over `{tokens.json, tokens/build/tokens.css, base.css, editorial-light.css, cinematic-dark.css, charts/theme/tokens.ts}` for the token half and `{the 9 barrel `index.ts` files + every `core-v2/src/**/*.tsx`}` for the component half. Record package.json versions and file mtimes as advisory metadata only, never as the cache key.

### D1 fallback mode — a genuinely different registry, never merge

The docs site (`https://ken-design-system-n26.vercel.app/`) is the deployed OG v4.3 app, **not core-v2** — confirmed by its computed values (`--brand-red` resolves, `--color-brand-red` does not; `--radius-md` is `15px` there vs. `8px` in `DESIGN.md`) and by its CSS asset being byte-identical to `Design_system_vs_26 (og and final)/dist/`. It has zero `[data-component]`/`[data-slot]` nodes, zero `<a href>` (41 `<button>`-only nav — a fallback crawler must click, not link-walk), and its only machine-readable artifact is its same-origin CSS asset (460 custom properties, readable via CSSOM). **D1 fallback mode must carry its own distinct `ds_registry_version` and must never be merged into the filesystem-mode registry** — they are different vocabularies for the same brand.

---

## 5. Module / folder structure

```
audit-agent/
├── docs/                          ← existing (ARCHITECTURE.md, RESEARCH-REFERENCES.md, VALIDATION-NOTES.md, this file)
├── workflows/                     ← existing (AUDIT-AGENT-WORKFLOW.md)
├── projects/                      ← existing, runtime output (§6 of ARCHITECTURE.md)
├── src/
│   ├── cli/                       ← commander entry points: audit-site, audit-page, resume, gate, escalations
│   ├── config/                    ← Zod-validated loader (Decision Log #17), config schema
│   ├── graph/
│   │   ├── engine.ts              ← the custom orchestrator (or LangGraph.js adapter, if overridden)
│   │   ├── edges.ts               ← §2.1 typed edge definitions
│   │   ├── state.ts               ← §2.2 Graph State type + SQL-backed store
│   │   ├── retry.ts               ← §2.4 classify() + per-execution-type policy tables
│   │   └── gates.ts               ← §4.2 Scope / Publish / Failure Threshold gates, timeout-to-fallback
│   ├── agents/
│   │   ├── a1-site-mapper/
│   │   ├── a2-template-classifier/
│   │   ├── a3-audit-dispatcher/
│   │   ├── a4-site-consolidator/
│   │   ├── b1-page-analyzer/
│   │   ├── b2-component-detector/
│   │   ├── b3-ds-matcher/
│   │   ├── b4-compliance-auditor/
│   │   ├── b5-visual-verifier/
│   │   ├── b6-new-component-evaluator/
│   │   ├── c1-excel-reporter/
│   │   ├── c2-json-writer/
│   │   └── c3-figma-publisher/    ← includes the headless-Claude-Code invocation (§6)
│   ├── ds/                        ← D-layer, per §4 above
│   │   ├── d1-reader/             ← filesystem-mode + fallback-mode (docs site), each with its own registry identity
│   │   ├── d2-registry/
│   │   ├── d3-tokens/             ← source layer (style-dictionary/utils) + effective layer (4-file cascade resolver)
│   │   ├── d4-components/         ← ts-morph, 4 extraction passes
│   │   ├── d5-rules/              ← Track A (lifted check-*.mjs) + Track B (RULES.md extraction)
│   │   └── d6-version/            ← content-hash, not semver
│   ├── skills/                    ← S0–S9 as schemas/policy modules, not agents
│   │   ├── s0-result-contract.ts
│   │   ├── s1-ds-source-reading.ts
│   │   ├── s2-site-page-analysis.ts
│   │   ├── s3-component-taxonomy.ts   ← includes §2.5 rule 3's dedup-signature computation
│   │   ├── s4-ds-matching.ts
│   │   ├── s5-compliance-classification.ts
│   │   ├── s6-visual-qa.ts
│   │   ├── s7-audit-state-history.ts
│   │   ├── s8-confidence-escalation-policy.ts   ← bands + sampling (§3) + retry policy (§2.4)
│   │   └── s9-registry-update-governance.ts
│   ├── t-layer/
│   │   ├── browser.ts             ← §2.7 BrowserContext-per-instance pool
│   │   ├── render-settled.ts      ← composite gate: critical-path idle + DOM-mutation quiet window + document.fonts.ready
│   │   ├── network-noise.ts       ← §2.4 Next.js prefetch/RSC filtering
│   │   ├── console-noise.ts       ← §2.4 console classification + allowlist
│   │   ├── disclosure.ts          ← §2.7 tab/accordion/"Read More" expansion, with the safety predicate
│   │   ├── element-registry.ts    ← §5.2 B2→B4 handoff (aria-ref + stamped attribute + finding_id fingerprint)
│   │   ├── computed-style.ts      ← B4's getComputedStyle extraction + normalization (oklch-aware)
│   │   ├── screenshot.ts          ← B5 evidence capture (element crop / context / tiled overview)
│   │   └── canonicalize.ts        ← §0 URL canonicalization
│   ├── llm/
│   │   ├── client.ts              ← Anthropic client, maxRetries: 0, model = claude-opus-5
│   │   └── schemas/               ← Zod schemas per AI node, JSON-Schema-subset-safe
│   ├── db/
│   │   ├── schema.sql             ← §7 below
│   │   └── migrations/
│   ├── tracing/                   ← §2.6 OTel spans
│   ├── figma/
│   │   ├── publish.ts             ← invokes headless Claude Code (§6)
│   │   ├── prompt-contract.ts     ← the versioned, pinned layout instruction (§6)
│   │   └── reconcile.ts           ← REST-API reads for idempotency reconciliation
│   └── dashboard/                 ← C4, §11 — NOT under src/agents/: not a run-scoped graph node, a standalone
│       │                            deterministic server (§11 launch model) started/reused across runs
│       ├── server.ts              ← long-running Fastify app; start-if-not-running, reuse-if-already-running
│       ├── routes/                ← summary, compliance, issues, pages, components, evidence — one file per view
│       └── views/                 ← server-rendered templates + the small vanilla-JS filter/sort layer
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/                  ← recorded real-page captures (§9)
├── package.json
├── tsconfig.json
├── .nvmrc                         ← 24, own pin, not inherited from project_aura1-main
└── audit-agent.config.json
```

---

## 6. C3 Figma Publisher — the one place the architecture's assumptions had to change

Grounded finding, verified against this session's live Figma tool schemas, the installed Figma plugin's skill files, and Figma's own current documentation:

**The Figma remote MCP server (`https://mcp.figma.com/mcp`) is closed to arbitrary clients.** Dynamic OAuth client registration returns `Forbidden` for unlisted clients (Figma staff, forum, 2025-10-06 and 2026-04-02: *"MCP access is currently limited to supported clients and integrations"*). The Figma MCP Catalog lists 24 named clients (VS Code, Cursor, Claude Code, etc.) — there is no generic/custom/SDK entry. This rules out **every path that has this standalone service talk to Figma's MCP server directly** — a raw MCP SDK client, the Claude API's `mcp_servers`/`mcp_toolset` connector, all blocked the same way. The Figma **REST API** (a separate credential) is read-mostly: it cannot create or modify a single frame, node, or page, and has no image-upload endpoint at all.

**The only path that can actually write native Figma content unattended: C3 shells out to a headless Claude Code run** (`claude -p`, or the Claude Agent SDK driving the same binary) on the audit-agent host, with the Figma MCP server authorized once via `claude mcp login figma`. Claude Code *is* an approved catalog client with write-to-canvas enabled — verified live via this session's own connected tools (`whoami` confirms the account holds a Full seat on `team::1364202946001928079`, matching Decision Log #16). Auth is stored per Claude Code's documented headless recipe: one interactive `claude mcp login figma`, tokens then persist in the OS keychain/credentials file and auto-refresh for subsequent non-interactive runs.

This changes one thing about ARCHITECTURE.md §5.2's classification of C3 as "deterministic + AI (layout)": **on this implementation, the Figma write itself is not a deterministic SDK call — it's an LLM-mediated tool invocation** that Figma has specifically allowlisted. Consequences the implementation must account for (none of them are architecture changes — they're implementation-level requirements the architecture already implied but didn't have to specify):

- **A pinned, versioned prompt contract** (`src/figma/prompt-contract.ts`) is what makes repeated runs converge on the same node structure — without it, "no duplicate frames" (§2.5 rule 5) is best-effort, not guaranteed.
- **Screenshots go through `upload_assets`, never `figma.createImageAsync`.** The `use_figma` tool's own contract states: *"MUST NEVER use loadAllPagesAsync, setPluginData, createImageAsync. They are not supported API."* Flow: create a placeholder node in `use_figma`, get its node id back; call `upload_assets({fileKey, count, nodeIds, scaleMode:'FIT'})` to get single-use upload URLs (≤60 per call, ≤10MB/asset); POST the PNG bytes from `runs/<run_id>/screenshots/` to each URL directly. This directly supersedes `RESEARCH-REFERENCES.md #35` for this implementation path.
- **Idempotent republish, three tiers** (since `setPluginData` is unavailable, the one obvious place to stash a key on a node): (1) **primary** — `project.json` (already the file that owns the Figma destination, §6 of ARCHITECTURE.md) extended to `{figma_project_id, pages: {}, frames: {}, markers: {}, image_hashes: {}}`; `use_figma` is contractually required to "return ALL created/mutated node IDs," so this map is always populated; republish resolves each id with `getNodeByIdAsync` — `null` means a human deleted it (recreate), non-null means mutate in place; (2) **recovery fallback** — deterministic node naming (`aura/<project>/<page-key>/<finding_id>`) queryable via `page.query('FRAME[name=...]')`; (3) **optional, needs a spike** — `setSharedPluginData`/`getSharedPluginData`/`findAllWithCriteria({sharedPluginData:{...}})` survive in the tool's standalone typings and are *not* on its forbidden list, but whether they function at runtime inside `use_figma` is unconfirmed.
- **`create_new_file` needs an explicit `projectId`, not just the team `planKey`.** Without it, the file lands in the *individual user's drafts* (Figma documents drafts as private, deleted with the account) — not team-owned, which would quietly contradict Decision Log #16's intent. Add `figma_project_id` to config and `project.json`; discover it via a team-project URL or `GET /v1/teams/.../projects` (REST, separate credential).
- **Numbered issue markers**: real ellipse+TEXT nodes (not `figma.annotations`, which carries no number and cannot click-through) with `textNode.setRangeHyperlink(0, len, {type:'NODE', value: issueCardNodeId})` — verified present in the tool's standalone typings.
- **Fonts**: write-to-canvas currently states "Custom fonts aren't supported yet" — call `figma.listAvailableFontsAsync()` once at publish start and fall back to Inter if Noto Serif Display / DM Sans are unavailable; record the fallback in `policy_version` rather than silently degrading brand fidelity.
- **Rate limits**: 200 tool calls/day, 15/min on the Pro/Full-seat plan — `create_new_file`/`whoami` are exempt, but reads (`get_metadata`, `get_screenshot`) are not. Use the REST API (separate limit) for reconciliation reads; reserve MCP reads for spot validation.
- **Documented as beta and free-during-beta, not guaranteed free long-term.** C3 is a mandatory deliverable from run 1 (§6 of ARCHITECTURE.md), so the plan is betting a mandatory output on a third party's beta feature. A documented degradation path exists (a human-triggered Figma plugin reading the run's `data.json`, authored via `create_generative_plugin`) and should be specified alongside the primary path, not treated as out of scope.

**Blocking spikes — all three run, results below. None left pending user confirmation.**

1. **Image upload → visual render: RUN. RESULT: CONFIRMED UNRESOLVED, BLOCKING.** `upload_assets` itself works — POSTing a real PNG (a genuine 1080×495 photo pulled live from `kenresearch.com`, not a synthetic pixel) returns HTTP 200 with a correct `imageHash`, and reading the node's own fill data back via the Plugin API confirms `{type: IMAGE, visible: true, opacity: 1, scaleMode: FIT, imageHash: <matches>}` — the file's stored data is provably correct. But `get_screenshot` rendered the node as **flat gray with zero photographic content**, reproduced twice 20s apart (ruling out a simple propagation race). Root cause undiagnosed: leading hypothesis is that `get_screenshot`/`get_metadata` depend on an actual Figma desktop app instance actively rendering the file (both tools' own descriptions say they operate "in the Figma desktop app," and none is running in this environment); cannot rule out a separate image-CDN propagation delay for the bytes behind the hash. **This blocks C3's screenshot-delivery mechanism specifically — no other part of C3 (frame creation, idempotent node tracking, text/marker writes) is affected.** Per explicit instruction, this is not re-opened for further live debugging as part of Phase 2 — see the build-scope carve-out below.
2. **Node tracking metadata: RUN. RESULT: PARTIALLY CONFIRMED, NOT BLOCKING.** `setSharedPluginData`/`getSharedPluginData` work correctly, including surviving a separate, later tool invocation (real cross-run persistence, not just within-script). `findAllWithCriteria({sharedPluginData:...})` does **not** actually filter — it returns every node regardless of criteria (confirmed via a negative-control query). The plan's actual primary (`project.json` node-ID map) and secondary (`page.query('FRAME[name=...]')`, independently confirmed to work) republish mechanisms are unaffected — only the optional third tier (search-by-tag) is unusable and should be dropped from the design rather than relied on.
3. **Fully headless publish: RUN. RESULT: CONFIRMED FAILED, NOT BLOCKING FOR v1 (explicit scope decision).** A genuinely separate, non-interactive `claude -p` process (piped stdin from `/dev/null`, no TTY) failed with `Failed to authenticate: OAuth session expired and could not be refreshed`; `claude mcp list` independently confirms `plugin:figma:figma` needs authentication outside this interactive session. **Explicitly out of scope for v1**: C3 runs inside an authenticated interactive session, not as an unattended/cron job, until this is revisited.

**Phase 2 build-scope carve-out**: everything in this document is in scope for Phase 2 implementation **except** the actual `upload_assets`-based image-delivery code path in C3 (spike 1). C3's frame/page creation, idempotent node-ID tracking via `project.json`, and text/marker writes proceed normally; the screenshot-upload step is stubbed/deferred pending further diagnosis, tracked as its own follow-up rather than blocking the rest of the system.

---

## 7. Schemas

### Database (SQLite, `better-sqlite3`, WAL mode)

```sql
-- Run-level Graph State (§2.2)
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL CHECK (run_type IN ('full-site','single-page')),
  url TEXT NOT NULL,
  canonical_url TEXT,
  status TEXT NOT NULL,               -- PLANNING..COMPLETE (§2.2)
  ds_registry_version TEXT NOT NULL,  -- content hash, D6
  policy_version TEXT NOT NULL,       -- S8/S9 policy snapshot at run start
  started_at INTEGER NOT NULL,
  scope_json TEXT                     -- template families, page count, est. B-instance count
);

-- Run-level concurrency guard (§2.5 rule 6) — verified working via this exact pattern
CREATE UNIQUE INDEX runs_active_target ON runs(url, run_type) WHERE status = 'RUNNING';

CREATE TABLE checkpoints (            -- §2.2 checkpoints[]
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  name TEXT NOT NULL,                 -- 'scope_confirmation' | 'publish_confirmation' | 'failure_threshold'
  status TEXT NOT NULL,               -- PENDING | APPROVED | REJECTED
  decided_by TEXT, decided_at INTEGER,
  timeout_at INTEGER,                 -- gate-timeout-to-fallback-reviewer
  PRIMARY KEY (run_id, name)
);

CREATE TABLE fan_out (                -- §2.2 fan_out counters, atomic via ON CONFLICT
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  dispatched INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  retrying INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE findings (               -- S0 Result Contract, §2.5 rule 1's 4-part key
  run_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  node_id TEXT NOT NULL,              -- which agent node produced this (B3, B4, ...)
  finding_id TEXT NOT NULL,           -- stable content fingerprint, survives across runs (§4.4 diffing)
  classification TEXT NOT NULL,       -- MATCH | DEVIATION | INCORRECT | NEW_COMPONENT | DS_CANDIDATE
  confidence REAL,
  confidence_band TEXT,               -- HIGH | MEDIUM | LOW
  escalation_status TEXT,             -- NONE | QUEUED | IN_REVIEW | RESOLVED
  registry_update_ref TEXT,
  payload_json TEXT NOT NULL,         -- full S0 record: identity/location/component/classification/comparison/quality/action/history
  PRIMARY KEY (run_id, page_id, node_id, finding_id)
);

CREATE TABLE escalation_queue (
  run_id TEXT NOT NULL, page_id TEXT, node_id TEXT, finding_id TEXT,
  reason TEXT NOT NULL,               -- LOW_CONFIDENCE | NODE_FAILURE
  detail_json TEXT, status TEXT NOT NULL DEFAULT 'QUEUED',
  created_at INTEGER NOT NULL
);

CREATE TABLE registry_update_requests (  -- §4.1, S9
  candidate_ref TEXT PRIMARY KEY,
  proposed_by TEXT NOT NULL,          -- 'B6'
  status TEXT NOT NULL,               -- PROPOSED | UNDER_REVIEW | APPROVED | REJECTED | MERGED
  signature TEXT NOT NULL,            -- content-addressed dedup key, §2.5 rule 3
  reviewed_by TEXT, merged_at INTEGER
);
CREATE UNIQUE INDEX rur_signature ON registry_update_requests(signature)
  WHERE status IN ('PROPOSED','UNDER_REVIEW');   -- dedup: one live request per pattern

CREATE TABLE audit_history (          -- S7, baselines for §4.4 diffing
  page_id TEXT NOT NULL, run_id TEXT NOT NULL, dom_hash TEXT NOT NULL,
  ds_registry_version TEXT NOT NULL, completed_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, run_id)
);

CREATE TABLE spans (                  -- §2.6, OTel-shaped, GenAI semantic conventions
  span_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, page_id TEXT, node_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, error_detail TEXT
);
```

### `project.json` (extended per §6 above)

```jsonc
{
  "target_url": "https://www.kenresearch.com/...",
  "mode": "full-site",
  "figma_file_key": "...", "figma_file_url": "...",
  "figma_team_plan_key": "team::1364202946001928079",
  "figma_project_id": "...",                 // required — avoids landing in personal drafts
  "pages": { "03 Page Audits": "<pageNodeId>", "...": "..." },
  "frames": { "<page_id>": "<frameNodeId>" },
  "markers": { "<finding_id>": "<markerNodeId>" },
  "image_hashes": { "<screenshot_sha256>": "<figmaImageHash>" },
  "created_at": "..."
}
```

### Config (Decision Log #17)

```jsonc
// audit-agent.config.json, Zod-validated, env-overridable (AUDIT_AGENT_*)
{
  "designSystemPath": "/Users/sachin/Project-aura/project_aura1-main/design-system",
  "figmaTeamPlanKey": "team::1364202946001928079",
  "anthropicModel": "claude-opus-5"
}
```

---

## 8. Agents and skills — code mapping

Every agent is a module under `src/agents/<name>/`, not a class hierarchy — matching the architecture's own framing ("skills are reusable knowledge, not agents"). Each exports one function with the shape `(input, ctx: {db, config, tracer}) => Promise<Result>`, where `ctx` carries the shared skill modules (`src/skills/*`) as plain imports, not injected services — skills are knowledge/policy, not runtime objects.

| Agent | Execution type | Skills it imports |
|---|---|---|
| A1 Site Mapper | deterministic | S2, S8 (retry) |
| A2 Template Classifier | AI (`claude-opus-5` call via `src/llm`) | S2, S3, S8 |
| A3 Audit Dispatcher | deterministic | S7, S8 |
| A4 Site Consolidator | AI | S5, S7, S8 |
| B1 Page Analyzer | AI + deterministic T-layer calls | S2, S8 |
| B2 Component Detector | AI | S3, S8 |
| B3 DS Matcher | AI | S4, S8 |
| B4 Compliance Auditor | AI + deterministic (token comparator) | S5, S8 |
| B5 Visual Verifier | AI | S6, S8 |
| B6 New Component Evaluator | AI | S3 (dedup signature), S8, S9 |
| C1 Excel Reporter | deterministic | S0, S8 |
| C2 JSON Writer | deterministic | S0, S7, S8 |
| C3 Figma Publisher | deterministic dispatch + LLM-mediated write (§6) | S0, S8, S9 |

**C4 Local Audit Dashboard is intentionally absent from this table.** This table maps *run-scoped graph nodes* — things a run's graph invokes once, in sequence, as part of that run's execution. C4 is not one of those: per §11's locked launch model, it is a single long-running server process, started/reused independently of any particular run, serving every project/run from one process. It reads S0 Result Contract records (same as C1/C2/C3) but is never itself a step the graph engine dispatches. Full spec, including its data access pattern, is in §11.

`src/skills/s8-confidence-escalation-policy.ts` is the single place the HIGH/MEDIUM/LOW bands, the sampling rate, and the per-execution-type retry table live — every node imports it rather than hardcoding thresholds, matching the architecture's explicit reasoning for making S8 a skill in the first place.

---

## 9. Testing strategy

| Layer | Approach |
|---|---|
| **Unit** | Pure logic in isolation: `classify()` (§2.4), the S8 confidence-band function, the §2.5 dedup-signature computation (canonical serialization + hash — assert two differently-key-ordered objects hash identically), the D3 4-file cascade resolver (assert it reproduces the *verified* 26-token override list), the URL canonicalization precedence rule (assert the §0 canonical-vs-state-param conflict resolves the documented way — see the note in `pw.json`'s risks: keep the observed URL as `page_id` when state-changing query params are present, even if a canonical tag drops them). |
| **Contract** | Every AI node's Zod schema validated against the JSON-Schema subset the Anthropic API actually accepts (no recursion, no numeric/string length constraints, `additionalProperties:false`) — a schema that silently has constraints stripped client-side is a real, hard-to-notice failure mode worth a dedicated test. |
| **Fixture-based integration** | Record real captures from the 4 templates already validated in `VALIDATION-NOTES.md` (consulting sub-page, report listing, report detail, survey landing) as fixtures under `test/fixtures/` — HTML snapshots + network/console logs — and replay them through B1–B6 without hitting the live site on every test run. This directly exercises the render-settled precondition, the prefetch-noise filter, the console-noise filter, and the placeholder-counter escalation against known, previously-observed real behavior (the "0+" counters, the `_rsc=` prefetch abort, the 1198-message console flood, the `role:null` dropdown). |
| **Playwright mechanism tests, live but scoped** | A small, separate suite (not run on every commit) that exercises the actual browser mechanisms in §2.7 against the real site or a pinned mirror: BrowserContext isolation, the disclosure-expansion safety predicate (assert it refuses to click a submit button or an off-path link — this is a correctness requirement, not a nicety, given the lead-gen form risk `pw.json` flagged), the aria-ref → stamped-attribute handoff surviving one DOM mutation. |
| **Figma spikes as tests** | All three blocking spikes in §6 have already been run once, live (not just planned): `upload_assets` node-tracking (`setSharedPluginData`) confirmed working, its `findAllWithCriteria` search confirmed broken, and headless publish confirmed failing (out of scope for v1). The image-render result (confirmed unresolved, §6) should still be converted into a small always-skipped-by-default integration test, so a future Figma-side fix or regression is caught automatically rather than requiring another manual spike. |
| **D-layer regression tests** | Since the Design System itself has verified internal contradictions (shadow corruption, cascade overrides, stale docs), D3/D4/D5/D6 tests should assert against the *verified facts* in this plan and `docs/RESEARCH-REFERENCES.md`'s grounding, e.g.: "D3's effective-layer resolver returns `48px` for `--button-height-md`, not `40px`" — this pins the D-layer's correctness to real, checked values, not assumptions. |
| **Graph/state tests** | The verified SQLite primitives directly: assert the partial `UNIQUE` index rejects a second concurrent run; assert `ON CONFLICT DO UPDATE ... RETURNING` produces atomic sequential counts under concurrent writers; assert a `checkpoints` row transitions `PENDING → AWAITING_* → APPROVED/REJECTED` and that a timeout produces the fallback-reviewer escalation, not a silent auto-decision. |
| **C2 parity tests — Dashboard, Excel, Figma each independently, not against each other** | **C2 JSON/Audit Data is the single canonical source of truth (Decision Log #19). No output is another output's oracle.** For a fixed fixture run's `data.json`: (1) a **C1↔C2 parity test** asserts every number C1's Excel writes (finding counts by classification, confidence-band breakdown, escalation-queue size, per-page/per-component rollups) matches what that same `data.json` actually contains; (2) a **C3↔C2 parity test** asserts the same, independently, for what C3 publishes to Figma; (3) a **C4↔C2 parity test** asserts the same, independently, for what the dashboard renders. Each of the three is computed and asserted directly against `data.json` — never against one of the other two outputs. If C1 and C4 ever agree with each other but both disagree with `data.json`, that must still fail (an Excel↔Dashboard-only comparison would miss exactly that case, which is why cross-output comparison was rejected as the test strategy). Also assert C4 makes zero writes to `data.json`/the SQLite store during a request (a read-only-connection or write-attempt-throws test, not just an audit of the code). |

---

## 10. Build sequence

Ordered so every milestone is independently runnable and testable before the next depends on it — not a single big-bang build.

1. **Foundation — DONE**: config loader + Zod validation, SQLite schema + migrations, the graph engine's edge registry and Graph State store (no agents yet — provable with synthetic nodes). 28 tests passing.
2. **D-layer — DONE**: D1 (filesystem mode; fallback mode stubbed, needs T-layer), D2 (registry, one cached load), D3 (source + effective-per-variant layers, verified against the real 26-token override), D4 (4-pass extractor), D5 (Track A: all 6 checker scripts executed live; Track B: RULES.md extraction), D6 (content hash, not semver). 27 tests passing against the real Design System on disk (read-only) — 24 real source-inconsistency findings preserved, not silently fixed; see the D-layer report for detail. D1 fallback mode remains unimplemented pending T-layer (step 3 below).
3. **T-layer — DONE**: BrowserContext pool, render-settled composite gate, network/console noise filters, URL canonicalization — plus disclosure expansion (with the lead-gen safety predicate), the aria-ref element registry, computed-style normalization, screenshot tiling, dynamic-content settling, and per-origin politeness. Tested against real Chromium on a local server and against live captures of the 4 validated templates (`test/fixtures/templates/`, replayed offline). Findings recorded in `VALIDATION-NOTES.md` §6.
4. **B-graph, single-page mode first — DONE (one caveat)**: B1→B2→B3→(B4→B5|B6) running through the engine, S0 records written to SQLite, compliance scored per v1.0 §13, re-audit history/deltas (S7), DS-candidate governance (S9). Verified end-to-end against real Chromium + the real Design System registry on a page with known-wrong values: the 44px CTA is caught by *measurement* against the real effective `--button-height-md` (48px), the compliant control passes, a rule violation classifies INCORRECT/CRITICAL, three identical cards dedupe to one governance proposal, and the off-domain footer link is excluded. **Caveat: AI judgment is untested** — no `ANTHROPIC_API_KEY` is configured, so all six nodes ran against a deterministic scripted stand-in that derives answers from the same prompt text. The plumbing, routing, schemas, comparator and persistence are real; prompt quality is not yet validated. A credential is required before step 11.
   - Per-component conditional realized as a data partition: a real page has components going both ways at once, so B3 splits matched/unmatched via S8's routing rule and each node runs once per page (one batched call per node, not one per element).
5. **C1/C2 — DONE**: C2 writes the canonical `data.json` (the five reporting levels of v1.0 §14, every aggregate computed once); C1 writes the nine-tab workbook of §15 reading only C2. Project → Runs storage with `project.json` persisting the Figma destination. C1↔C2 parity is asserted by reading the numbers back out of the generated .xlsx (Decision Log #19).
6. **C4 dashboard (§11) — DONE**: one long-running Fastify server (Decision Log #20) serving every project/run from `/projects/:project/runs/:runId`, reading each run's `data.json` and computing nothing of its own. Summary, compliance, issues/deviations/incorrect, severity, confidence, review state, pages, components, screenshots and evidence, with client-side filter/sort. Read-only (no mutating route exists, asserted in tests). Verified in a real browser against a real pipeline run; C4↔C2 parity asserted against the same data.json it serves. The CLI (`audit-page`, `dashboard`) starts-or-reuses it automatically, and refuses clearly when no Anthropic credential is present.
7. **C3 spike phase — DONE**: all three spikes run live against real Figma; results and their consequences are recorded in §6. Image delivery is confirmed unresolved and is the one carved-out piece of C3.
8. **C3 real implementation — DONE except the blocked image path**: deterministic publish plan for all 8 Figma pages (including `07 Re-Audit History`), numbered issue markers placed from B2's MEASURED element geometry, the pinned/versioned layout contract (`figma-layout-v1`), idempotent republish that mutates known node ids from `project.json`, and the headless Claude Code transport. Screenshot upload ships labelled placeholders with the blocker's note rather than blank images, and the known headless-auth failure is reported as `unavailable` rather than hanging or faking success. Everything up to the tool call is tested without credentials; the live write remains credential-gated.
9. **A-graph (full-site mode) — DONE**: A1 (sitemap-first discovery, bounded crawl fallback, canonicalized inventory) → A2 (template families) → **Scope Gate** → A3 (dispatch, §4.4 cache hits, page-level restart) ⇉ parallel page audits ⇉ A4 (root-cause consolidation) → **Publish Gate**. Verified against a real local multi-page site: nothing dispatches before scope approval, a deliberately broken page fails without blocking its siblings (dispatched = completed + failed), the failed page is reported rather than dropped, and a second run of the unchanged site reuses prior results as cache hits. Both gates persist what the reviewer needs before pausing, so resume re-enters routing instead of re-running the node.
10. **§2.6 tracing, S8 sampling, gate-timeout-to-fallback — DONE**: real OpenTelemetry spans exported into the `spans` table (GenAI attribute names taken from `@opentelemetry/semantic-conventions`, not hardcoded), with **every node attempt** as its own span so a retry is visible as a retry and a failed span carries the error that `NODE_FAILURE` escalations reference. S8's deterministic calibration sample (5%, keyed by finding id, stable across re-runs) pulls a fraction of clean HIGH-confidence findings into the review queue. Gate timeouts escalate to a **fallback reviewer** exactly once per gate and leave the checkpoint **PENDING** — never auto-approved, never auto-rejected (§4.2). CLI: `gates`, `gate approve|reject`, `trace <runId>`, plus real `audit-site` and `resume`. One gap found and closed while testing: a run resumed in a new process had an empty in-memory page collector, so A4 would have consolidated an empty site — page results are now read back from SQLite (`pageResultsFromDb`) and merged, and `templateFamily` flows through the page session into each finding's location so it survives the restart. 211 tests passing.
11. **First real single-page audit** against `kenresearch.com` (the same consulting sub-page URL used in `VALIDATION-NOTES.md`), reviewed by a human — via the dashboard first, since it's the fastest review surface — before the first full-site run is attempted. **Status: ready, blocked only on an Anthropic credential.** Engine locked (Decision Log #22: Playwright Chromium 153.0.8010.12, Playwright 1.63.0). Because the real Claude path had never executed, a 10-agent review (5 dimensions, each adversarially verified) was run first: 30 confirmed findings, 3 blockers — B4 recorded MATCH when nothing was compared, `var()` token aliases produced false DEVIATIONs and silently skipped colors, and B4's single call overran its output budget on the target page — plus B1/B2 claiming screenshots they never sent. All fixed (Decision Logs #23, #24) and covered by tests that run the REAL client against a local Messages-API stand-in enforcing the documented limits, including the real CLI as a child process. A second independent pass (12 agents, adversarially verified) then attacked the fixes themselves and confirmed 38 more defects — among them alpha-blind colors (false MATCHes on the site's alpha text inks), Tailwind's composite shadows (a false DEVIATION on every shadowed card), gradients always failing, the page header being promoted to the whole page, classification-bearing finding ids breaking every re-audit delta, and a §4.4 cache that would publish an empty second site report. All fixed (Decision Logs #25–#28) with regression tests, several against real Chromium serializations and the real DS tokens. A third pass (adversarially verified) attacked those fixes and confirmed 14 more — the comparator splitting `rgb(0 0 0 / 0.1)` at its slash, unclamped pill radii and gradient positions (false DEVIATIONs), a hedged B5 remark raising severity, cross-section listing caps, colliding finding ids under duplicate DOM ids, re-audit deltas across a B3 routing flip / DS edit / browser bump, unverified prior issues invisible in Excel and Figma, gone elements listed as MATCH in the dashboard, and Ctrl-C during navigation crashing on a closed database. All fixed (Decision Logs #29, #30); each regression test was confirmed to fail on the pre-fix code. 331 tests passing. A keyless **live preflight** of the target page (real browser, real requests, scripted answers — `scripts/preflight-wire.ts`) is re-run after each round and must stay inside API limits.
12. **First real full-site audit**, starting with a Scope Gate that a human explicitly approves rather than auto-runs.

---

## 11. C4 Local Audit Dashboard — mandatory v1 output (added per Decision Log #18)

**Status: plan only, per this same document's standing rule — no server/route code written yet.**

### What it is

A local, interactive, read-only web view over one run's audit result — the fast alternative to opening Excel or the Figma file just to check what a run found. One URL per project/run:

```
http://localhost:<port>/projects/<project-name>/runs/<run_id>
```

Served by a process running on the same machine as the audit (not deployed, not hosted, not exposed beyond localhost by default).

### Hard constraint: no independent calculation, verified against C2 directly — not against C1/C3

C4 reads `runs/<run_id>/data.json` (C2's output), itself sourced from the `findings` / `escalation_queue` / `fan_out` / `audit_history` tables in §7's SQLite schema — the same canonical source C1 and C3 also read (**C2 is the single source of truth, Decision Log #19**). **C4 never computes a derived number that isn't already one of S0's fields in that data.** If a future contributor is tempted to add a "quick client-side aggregate," that's the constraint being violated — route the aggregation through the same place C1/C3 get it from instead.

This is verified as a **C4↔C2 parity test** (§9) — asserting the dashboard's rendered numbers against `data.json` directly, not against what C1 or C3 happen to show for the same run. C1 and C3 get their own equivalent, independent parity tests against C2. None of the three outputs is ever treated as another's source of truth.

C4 has no write path. It opens `data.json`/the SQLite store read-only; there is no route that mutates a run.

### Required views → data source (no new schema — this is entirely a read/render mapping over §7's existing tables)

| View | Reads from |
|---|---|
| Summary | Aggregate over `findings` for the run: counts by `classification`, by `confidence_band`; `escalation_queue` count |
| Compliance | `findings.classification` grouped by `page_id` / component identity |
| Issues, Deviations, Incorrect matches | `findings` filtered by `classification IN ('DEVIATION','INCORRECT', ...)` — same enum S0/C1/C3 already use, not a re-derived category |
| Severity, Confidence | `findings.confidence`, `findings.confidence_band` — S8's bands, not a new scale |
| Pages | `findings` grouped by `page_id`, joined against `audit_history` for last-audited timestamp |
| Components | `findings` grouped by detected component identity (payload_json) |
| Screenshots and evidence | `runs/<run_id>/screenshots/` served as static files — the same evidence C3 uploads to Figma |

### Recommended tech (open to override — see §12)

Fastify 5.x server (§1), server-rendered views + a small vanilla-JS layer for client-side filter/sort/search across the tables above (no SPA framework, no build pipeline — this is a local single-user tool, not a shipped product surface). `src/dashboard/` module layout is in §5.

### How it's launched (locked — Decision Log #20)

**One long-running local server process, automatically started if not already running (and reused if it is) whenever an `audit-site`/`audit-page` command runs — not a per-run process, not something a human has to separately remember to launch.** It serves every project and every run from that one process/port for the lifetime of the machine session — the URL pattern above (`/projects/<project-name>/runs/<run_id>`) is exactly the per-project/run routing this one server exposes.

Startup logic (CLI's `audit-site`/`audit-page` entry points, §5's `src/cli/`): before or alongside dispatching the run, check whether the dashboard's fixed local port is already bound by this service (a lockfile or a lightweight self-identifying health-check route both work — implementation detail, not an open question); if not, spawn/detach it; if so, do nothing further — the existing server already serves the new run the moment C2 writes that run's `data.json`. No separate `audit-agent dashboard` subcommand is required for the common path, though one may still exist for explicitly stopping/restarting the server.

**Module placement correction: C4 is *not* a `src/agents/` entry.** Per Decision Log #21, only `src/dashboard/` exists — see §5. It is not a run-scoped graph node the way C1/C2/C3 are (nothing in a run's graph execution "calls" C4), so it does not belong alongside things the graph engine dispatches; it is a standalone deterministic server module the CLI ensures is running.

---

## 12. Open decisions still needing a call before or during build

1. **Graph engine**: custom orchestrator (recommended, §2) vs. LangGraph.js — override if the team would rather have battle-tested gate/fan-out primitives despite the dual-state-model cost.
2. **Figma degradation path**: build the human-triggered plugin fallback (§6) alongside C3 from the start, or treat it as a later contingency if the beta write-to-canvas access is later paid/withdrawn.
3. **Politeness/traffic policy for A1 against production `kenresearch.com`**: coordinate rate limits and User-Agent identification with whoever owns Leadfeeder/Contentsquare/GA on that site, since a full-site audit multiplies real request volume (verified: 74–343 requests per page, cold cache per `BrowserContext`).
~~4. **Browser channel pin**~~ — **resolved (Decision Log #22, build step 11)**: locked to Playwright's bundled Chromium, exact build recorded per run.
5. ~~**D4's reliance on `data-component`**~~ — **resolved by evidence (T-layer build, 2026-09-11)**: production kenresearch.com emits **zero** `data-component` / `data-variant` attributes on all 4 validated templates (the DS repo has them on 161/289 files — authoring intent that never reaches production). B2/B3 must not use them as a signal at all on production; detection is visual + structural + computed-style, per ARCHITECTURE.md §5.2. Pinned as a regression check in `test/integration/t-layer-fixtures.test.ts`.

~~6. C4 dashboard server lifecycle~~ — **resolved, Decision Log #20**: one long-running server, auto-started/reused per run. See §11.
