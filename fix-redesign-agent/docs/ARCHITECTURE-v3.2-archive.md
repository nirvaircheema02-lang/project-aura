# Fix & Redesign Agent — Architecture v3.2 (ARCHIVED 2026-09-28)

**This is a verbatim archival copy of v3.2, made when it was superseded by v4.0 (`docs/ARCHITECTURE.md`).** It exists because this repository has no git history (`git log` shows zero commits — confirmed 2026-09-28), so overwriting the canonical file would otherwise have destroyed this content permanently. Do not build against this document — see `docs/ARCHITECTURE.md` for the current design.

---

# Fix & Redesign Agent — Architecture v3.2

Complete and self-contained. Supersedes v1.0 (2026-09-18), v2.1 (2026-09-22), v3.0 and v3.1 (2026-09-22, same day); no section defers to an earlier version.

This system consumes an audit run produced by **audit-agent** (a sibling repo) together with one or two human-authored plans, applies the authorized changes to a live page, and optionally builds the resulting Design System components on a local branch. It ends at a reviewed, approved hand-off. It never edits the target website's source or hosting, and never pushes anything without an explicit approval of the exact content and destination.

**v3.2 is a finalization pass. The six agent roles, both workflows, the execution graph's shape, both design modes, and both bounded repair loops (R3→R4→R5, L2→L3) with their retry limits are unchanged from v3.0.** It resolves naming and a set of consistency gaps found against v3.1:

- **Naming** (§0.3): the user-facing product name is **Redesign Agent**. The repository, package and every technical path stay exactly `fix-redesign-agent` — unrenamed.
- **`review/review-index.html`** is now the documented single entry point for every review gate, with what each preview type does and does not support stated explicitly (§10a), and the three-way storage boundary — audit-agent's inputs, this repo's run artifacts, the DS repository's component source, with its git-repository prerequisite — made explicit (§1.2, §9.0).
- **Selection reuse**: a valid, fresh prior selection for the same source run is used automatically, and G3 is skipped **only** in that specific, checked case — never as a general shortcut (§1.4).
- **Export validation is per-file**: each exported HTML document is checked against its own declared scope, not one blanket rule (§8.5).
- **Post-integration re-verification**: package revalidation now re-runs the acceptance and visual checks against the integrated tree, not build tooling alone (§11.4).
- **A graph-labelling fix, not a behaviour change**: G1's mapping and DS-target acknowledgements were always meant to fire in **both** design modes whenever they exist — only the section-scope sub-question is mode-dependent. An earlier diagram conflated the two so it read as if Full Page mode skipped G1 entirely; that reading was never the intent and is corrected here (§5.2a, §7.1, §11.2).

---

## 0. Status, and how to read this document

Every statement below is one of three kinds, marked throughout:

- **[built]** — code exists in this repo and its tests pass.
- **[contract]** — the typed contract exists; the node is a stub that fails loudly.
- **[proposed]** — designed here, no code yet.

### 0.1 Implementation status (verified 2026-09-22 — v3.2 fully implemented this pass)

Every node this document specifies now has real code: `NODE_STATUS` (`src/agents/index.ts`) reports all fifteen ids (S0/R1–R7/C2/L1–L5/L2b) as `implemented`, `unimplementedNodes()` returns empty, and `redesign --dry-run` says so verbatim. The whole repo typechecks clean (`pnpm build`) and the orchestrator's own test suite (gate-stop/resume semantics, both workflows, the critical session-release invariant for a `components`-only run vs. a `combined` run sharing one session) passes. Per-node and per-module dedicated test coverage for the modules built in this pass (mapping/, dom/, style/, html/, manifest/, library/, git/, session/, and R2–R7/L1–L5/L2b's own unit-level behavior) is being finalized in the same pass — see the repo's `test/` tree for the current count rather than trusting a number frozen into this document.

| Area | State | Evidence |
|---|---|---|
| config loader + schema, env overrides | **[built]** | unit-tested, including the checked-in config file |
| tracing (JSONL spans, buffered-then-flushed) | **[built]** | unit-tested |
| imaging: tile crop-planning (vendored) + flatten-to-PNG (new) | **[built]** | unit-tested incl. a real-browser composite |
| `audit-link`: `find-run` shell-out, read-side `Finding` / `AuditData` / `FixPlan` / `NewComponentPlan` schemas | **[built]** | unit-tested; **verified live** against the sibling repo |
| **R1 Resolve & Load** | **[built]** | unit-tested; **verified live** end-to-end against a real audit run carrying a real, non-fixture fix plan (23 fix / 109 findings) — audit-agent's `data.json`/`fix-plan.json` mtimes confirmed unchanged before/after |
| output store: paths, run id (embeds run type), run meta (schemaVersion 2, `runOutcome` + per-unit states), project record, listing | **[built]** | unit-tested |
| orchestrator (`pipeline.ts`): both workflows, bounded loops, gates G0–G5 as persisted pauses, decision fingerprint reuse, typed failure, run-outcome aggregation, session lifecycle (opened once, released exactly once — whether owned by a `components`-only run or shared with Workflow A in a `combined` run) | **[built]** | unit-tested, incl. resume-from-gate and the components-only/combined session-ownership cases |
| R5 outcome rule (`PASS` / `PARTIAL` / `FAIL`) | **[built]** | unit-tested as a pure function |
| LLM client (vendored), `ScriptedLlmClient` test double, R3 / R5 / L2 / L3 / C2 output schemas | **[built]** | wire-safety unit-tested |
| CLI: `redesign` (`--dry-run`/`--mode`/`--run-type`/`--max-iterations`), `decide`, `open`, `resolve-run`, `cross-run-paths`, `list`, `trace`, `resume`, `judgment status`/`show`/`submit` | **[built]** | exercised live against real audit-agent data; judgment commands unit-tested |
| **`judgmentProvider` (§4a)**: `claude-session` (default, no API/credential — pending bundles + checkpoint/resume) vs `anthropic-api` | **[built]** | `src/judgment/`, `src/llm/claude-session-client.ts`; unit-tested: bundle creation, content-addressed dedup, schema validation (valid + invalid submission), checkpoint/resume incl. mid-loop and Workflow B, no network call |
| vendored t-layer (10 files), DS loader (D1–D6 + catalog incl. `readComponentSource`), retry | **[built]** | byte-identical to source except import paths; DS loader integration-tested; `readComponentSource` now has real callers (C2, L2) |
| **C2 Element Mapper** — objective checks (IoU/text/identity/class-fingerprint), deterministic confidence classing, one batched model call for the `needs-model` remainder, DOM stamping, drift classification, section-wrapper location + landmark cross-check, capture-fingerprint computation | **[built]** | see `test/` for current coverage |
| **R2 Capture, R3 Redesign Plan, R4 Apply & Render, R5 Compare** (both measurement tiers), **R6 Component Review, R7 Assemble & Validate** (CSS-isolation export rules, per-file export validation) | **[built]** | see `test/` for current coverage |
| **L1 Resolve Plan, L2 Component Builder, L2b Integrate, L3 Component Verifier, L4 Preview, L5 Publish** | **[built]** | see `test/` for current coverage |
| gates, decisions store (append-only, fingerprinted, reusable-approval check), `context/` tree, `mapping.json`, component manifest + review HTML + `review-index.html`, run types, parallel component builds bounded by `buildConcurrency` | **[built]** | see `test/` for current coverage |
| two-line startup, name→project→run resolution, run-type inference (§1.3–1.4), component auto-queueing, prior-selection reuse, `context/scope.json` section-scope derivation and persistence, conditional G0/G1 | **[built]** | `src/session/discovery.ts`, `src/session/scope.ts` |
| `politeness.maxConcurrentContexts` | declared in config, **still enforced nowhere** | genuine open gap — see §16; must be enforced before parallel rendering is relied on at scale |
| **L3's per-variant vision comparison** | **[built] with a stated, permanent limitation** | `visionVerdict` is always `NOT_CHECKED` — rendering the generated `.tsx` needs the DS's own bundler/Storybook pipeline, which this system does not invoke automatically (§8.6's R3 row / L3's own doc comment). What IS real: the DS repo's own typecheck/lint/verify/story-presence checks, and the §9.5 acceptance checks against the live reference element. Never silently reported as CONFIRMED. |

### 0.2 Upstream and environment (verified)

| Fact | Consequence |
|---|---|
| audit-agent's Part 1 is **present in its working tree, uncommitted**: `find-run` (one JSON line on exit 0; exit 1 not found; exit 2 ambiguous with candidates), `fix-plan-import`, `fix-plan.ts`, `new-component-plan.ts`, the `fix-plan-review` skill | the linkage works today; committing is audit-agent's call |
| the audit report also exports a **New Component Plan**, per finding, with `classification`, `candidateSource` (`current_state` / `post_fix`) and `relatedFindingIds`; **there is no import command for it upstream** | this repo validates that file itself with a read-side schema |
| report HTML is **not** reproducible from `data.json` alone — it also needs `fix-plan.json`, the evidence image bytes, the project name, and two pinned code constants (the template version and the plausible-match score) | the report is reviewer context, never a data source; any figure recomputed from it must pin the same constant and record it |
| the only reviewer-authored free text anywhere is `note` (both plans) and `decidedBy` (fix plan); in-progress selections live in browser storage and never reach disk until exported | reviewer intent is narrow and precisely locatable; do not promise more |
| `data.json` does **not** persist a DOM hash (it exists only in audit-agent's database, and in two different forms) | capture freshness must be computed and recorded by this system, never compared against an audit-recorded hash |
| the DS is a plain folder: **no git repo, no remote**; `gh` is not installed | Workflow B stops at a local commit until §19 decision 1 is made; **every branch or commit operation now checks this precondition itself and refuses cleanly, once, up front (§9.0) — it is never assumed** |
| DS category barrels (`atoms/`, `molecules/`, `organisms/`, …) use **explicit named re-exports**, so every new component requires a hand-edited line; the root barrel uses `export *` and is untouched | barrels are a guaranteed shared-file collision between concurrent builds |
| the Tailwind safelist is a **generated, committed, whole-file rewrite** produced by the DS's own script from `atoms/` + `molecules/` + `organisms/` | a second guaranteed collision; must be regenerated once, by that script, never hand-edited |
| component-level tokens land in a single large, deliberately **unlayered** `:root` stylesheet | a third shared file; flattening or layering it breaks token resolution |
| the raw token build output is git-ignored and generated from a DTCG source | a new raw token means editing the token source and rebuilding, not editing CSS |

### 0.3 Naming

The user-facing product name for this system is **Redesign Agent**. This is a display-name distinction only: the repository directory (`fix-redesign-agent`), its package name, its CLI, every file path and every identifier in this document remain exactly as built — nothing here proposes a rename of code or folders. The Session Agent (§3.2) introduces itself to the user as Redesign Agent; internal commands, logs and paths keep the existing `fix-redesign-agent` naming throughout.

---

## 1. Purpose, boundary, and run types

### 1.1 What this system does

audit-agent ends at a validated `data.json` plus human-authored, sparse sidecar plans. This system then:

1. resolves the audit run from whatever reference the user has,
2. assembles context from every source the reviewer used, and **inspects the live page**,
3. applies only the authorized changes, in the authorized scope,
4. validates them visually and by measurement,
5. offers a whole-page component review and a selection export,
6. optionally builds the selected components in the DS stack on a local branch, verifies them, and
7. publishes only after an explicit approval of the exact content and destination.

### 1.2 Boundary — three storages, kept distinct

| Storage | What lives there | Access |
|---|---|---|
| **audit-agent** (sibling repo) | the original audit inputs: `data.json`, the two plans, screenshots, the report | read-only, through its own CLI and its run folders; its files are never copied here |
| **this repo's `projects/` tree** | every run artifact this system itself produces: context, mappings, page exports, the component manifest and checklist, component previews, in-context previews, validation and acceptance results | the only durable output of this system |
| **the Design System repository** (`dsRepo.path`) | the actual component source code | read always; write only on a local branch, only files a declared spec names; push and PR only after an explicit publish approval — **and only once the configured path is confirmed to be a git repository, checked before any branch or commit operation (§9.0)**; that is not the case today (§0.2, §19.1) |
| the target website | — | read-only HTTP navigation; an ephemeral in-memory DOM is mutated and discarded; no source, no hosting, no credentials |

Merge and deployment are outside this system entirely.

### 1.3 Run types — inferred, not asked

There is no run-type field in the normal input. Only `redesign` and `combined` are reachable from the two-line start; `components` is a separate, explicit entry point for "no page changes, just build what's already selected."

| Run type | Reached by | Requires | Runs | Skips |
|---|---|---|---|---|
| `redesign` | the normal input, when no valid component work is queued | a fix plan with at least one `fix` in scope | S0 · R1 · R2 · C2 · (R3→R4→R5)* · R6 · R7 · G0–G3 | all of L |
| `combined` | the normal input, when component work auto-queues (§1.4) | the same, plus ≥1 valid component-plan entry | everything; B starts after A's G2 | — |
| `components` | an explicit separate command, naming the run and skipping Mode | ≥1 valid component-plan entry; no fix plan required | S0 · R1 · R2 · C2 · R6 · L1–L5 · G0, G1, G4, (G5) | R3–R5, R7's page deliverables |

A missing requirement stops the relevant half and names the file looked for and how to produce it — for `combined`, page work still completes even if component work is blocked (§7.7). The run id carries the type: `<sourceRunId>-<runType>-<UTC stamp>`, decided the moment inputs are validated, not before.

### 1.4 Automatic component queueing

Four rules, applied after R1 validates whatever component-plan inputs exist (§2.2's two sources, plus a **third**: a `review/component-selection.json` already sitting in a *prior* redesign run for this same source audit run, found through `project.json`'s run index — §5.3 discovers it the same way it discovers everything else, without being told its path):

| Situation | Effect |
|---|---|
| a plan source is **absent**, or present with **zero entries** | component work is skipped for that source, cleanly, no error |
| a plan source **exists and fails validation** | reported as invalid, by file and reason — never silently treated as absent |
| **any** source validates with ≥1 entry | component work **auto-queues** — the run becomes `combined` without being asked |
| the user **explicitly asks** for component work (in chat, not through a file) and no source validates | reported as **blocked**, naming every path checked |

**Reuse, not repeat selection.** When the third source — a prior run's `review/component-selection.json` for this exact source audit run — exists and is valid, it is used automatically; the reviewer is not sent back through G3 to re-select what was already chosen.

| Rule | Detail |
|---|---|
| which prior run is authoritative | among every prior run under `project.json`'s index for the same `sourceRun.runId`, the most recent whose selection export validates |
| freshness required to reuse silently | the source `data.json` sha256 is unchanged, and every `findingId` the selection references still exists in it |
| freshness fails | never proceed silently on stale data — fall through to asking at G3, showing exactly what changed (findings added or gone) since the reused selection was made |
| effect on G3 | **skipped** in the silent-reuse case — L1 resolves from the reused selection exactly as if it had just been exported |
| the upstream `new-component-plan.json` (§2.2) | always merged in alongside a reused selection, never displaced by it |

This is the same pattern as G0/G1 (§11.2): reuse silently when nothing has changed, ask once when it has.

**Suggestions alone never authorize building.** R6's manifest suggestions (§9's evidence-based hints) are advisory only; only an actual entry in a validated plan — something a human selected — reaches L1. A component R6 suggests but nobody selected is never built.

---

## 2. Inputs

Both plans are **sparse** (absence means no decision), human-authored, and validated again on read — being at the canonical path never implies correctness.

### 2.1 Fix Plan (audit-agent's contract)

`<auditRunDir>/fix-plan.json`: `{ schemaVersion: 1, runId, updatedAt, entries[] }`, each entry `{ findingId, decision: fix | skip | keep_for_review, decidedAt, decidedBy, note, source }`.

| Field | Maps to | Used by |
|---|---|---|
| `findingId` | `data.json → findings[].identity.findingId` — the only join key | R1 join, C2 mapping, R6 |
| `decision: fix` | the authorized scope of Workflow A | R1 filter → R3 |
| `skip` / `keep_for_review` / absent | never applied; listed with the decision | R7 change list |
| `note` | a constraint sentence for that finding | R3, L1 |
| `decidedBy`, `decidedAt`, `source` | provenance shown in the manifest and change list | R6, R7 |

Validation on read: schema; `runId` must equal the resolved run (refuse otherwise); every `findingId` cross-checked against `data.json` (unknown reported and dropped; all-unknown refused as a wrong-run import; a repeated id keeps the last entry and is reported).

### 2.2 New Component Plan — two sources, one resolved plan

| Source | File | Can express |
|---|---|---|
| upstream export (audit report) | `<auditRunDir>/new-component-plan.json` — `entries[] { findingId, classification: NEW_COMPONENT \| DS_CANDIDATE, selectedAt, note, candidateSource: current_state \| post_fix, relatedFindingIds? }` | candidates the audit already classified, plus post-fix opportunities (repeated unmatched patterns blocked only by a known foundation-rule violation) |
| this repo's checklist export | `<redesignRunDir>/review/component-selection.json` — `selections[] { patternId, findingIds[], selection: global-shared \| new-component, suggestion, note }`, `manualCandidates[]`, `globalCandidates[]` | any detected component **including unchanged ones**, header/footer components, and components the audit never detected |

Either alone is sufficient; L1 merges them into `library/component-plan.resolved.json` keeping `origin` per entry. **The same pattern selected inconsistently by the two sources is an ask, never a silent precedence.** The names differ deliberately so neither file can overwrite the other.

| Upstream field | Consequence |
|---|---|
| `findingId` (+ `relatedFindingIds`) | → the finding's `component.signature` → one candidate per pattern, with its instances |
| `DS_CANDIDATE` | initial resolution hint `new` (strong) |
| `NEW_COMPONENT` | initial hint `new` (weaker); uncertainty flagged |
| `candidateSource: post_fix` | eligible only once its related findings are **verified fixed**; L1 records the dependency and blocks until satisfied |
| `note` | a constraint sentence for the spec |

### 2.3 Supporting context (never asked for individually)

| Context | Source | Required |
|---|---|---|
| audit data | `<auditRunDir>/data.json` | always |
| page URL | `data.json → run.targetUrl` (authoritative); `run.json → targetUrl` cross-checked, mismatch warns | always |
| evidence images and boxes | `findings[].quality.evidence[]` — absolute paths into the audit run, page-absolute boxes | for mapping; a missing file is recorded, never fatal |
| guidance and reviewer context | plan `note` / `decidedBy`; `action.recommendation`; `action.dsCandidateNote`; `review.reason`, `review.signals` (roles, tags, **class list**), `review.possibleMatches[].why`; `comparison.ruleViolations[].why`; `quality.evidence[].note` | availability varies per finding; absence is recorded, never inferred |
| related findings | findings sharing a `component.signature` | for patterns and instances |
| what the reviewer saw | `<auditRunDir>/report.html` | optional; reviewer context only |
| run metadata | `<auditRunDir>/run.json` | falls back to the run id |
| DS registry + component source | `designSystemPath`; component source read verbatim from the DS tree | always |

---

## 3. Agents, stages, skills, tools

### 3.1 Vocabulary

| Kind | Definition | Test |
|---|---|---|
| **agent** | owns a judgment — a model call with a typed structured output, or a human decision — with its own contract, failure modes and retry policy | "could two competent runs disagree?" |
| **stage (node)** | a step on the execution graph with a typed contract and one traced span per attempt; deterministic stages are tools in a fixed order | "is it on the graph?" |
| **skill** | a reusable procedure: a stateless code module, or a `SKILL.md` a session follows | "used by more than one stage or session?" |
| **tool** | an external capability with no judgment | "does it only execute?" |

### 3.2 The six roles

The count is derived, not chosen: every point where two competent runs could disagree, and nothing else.

| # | Role | Kind | Judgment it owns | Cannot be deterministic because |
|---|---|---|---|---|
| 1 | **Session Agent** | agent, conversational | which reference the user gave; what to ask when something is ambiguous; presenting every preview; recording every gate decision; choosing the next command | these are the user's decisions, mediated in conversation |
| 2 | **Element Mapper (C2)** | agent, hybrid | *proposing* which live element a finding refers to when objective checks leave several candidates | free-text section names, unlabelled elements, and real page drift |
| 3 | **Redesign Planner (R3)** | agent, ai | which targeted edits close a finding, and which findings have no safe edit | expected values must be turned into concrete, minimal DOM changes |
| 4 | **Visual Verifier (R5)** | agent, hybrid | whether the after-capture shows the intended change and nothing regressed | measurement cannot see wrapping, overlap or hierarchy |
| 5 | **Component Builder (L2)** | agent, ai | how a spec becomes code in the DS stack | code generation under conventions |
| 6 | **Component Verifier (L3)** | agent, hybrid | whether a rendered component matches its reference per variant and state | same as R5 |

**No seventh role is justified today, and the count is not fixed by policy.** Integration, packaging, plan resolution, review, previews and publishing are all determined by the manifest, the specs and the recorded decisions; adding an agent there would add model calls where files already decide. The Element Mapper is the one addition over the original design, and §6.4 deliberately limits it: **its output alone never authorizes an edit.**

Graph engineering, as this document uses the term, is the tool for scaling *work*, not for growing the agent count: independent units fan out as several typed, traced **instances of the same node**, exactly as audit-agent's own A3 dispatches B1–B6 once per page (§7.4). A bounded batch of Component Builder invocations, each building a different component in parallel, is still one role running many times — not a new one. A seventh role would only be earned by a genuinely new *kind* of judgment that neither an existing role nor a human gate can resolve; none has been found, and this is re-checked at every later build step rather than assumed closed.

### 3.3 Shared skills and tools

| Skill (code) | Used by | State |
|---|---|---|
| `audit-link`: `find-run` shell-out, read-side schemas for all three input files | S0, R1, L1 | **[built]** except the component-plan schema **[built]** |
| capture chain (browser pool, politeness, settle, aria snapshot, tiling) | R2, L4 | **[built]**, vendored |
| DS loader D1–D6, catalog resolution, **component source reader** | R1, C2, R3, L1–L3 | **[built]**, vendored; the source reader has no callers yet |
| imaging: tile crop-planning + flatten | R2, R4, R7 | **[built]** |
| tracing, retry classification, LLM client | every node | **[built]**, vendored |
| DOM locate / stamp / apply-edit / DS-stylesheet injection | C2, R4 | **[built]** |
| standalone HTML packaging + export validation | R7, L4 | **[built]** |
| manifest, suggestion rules, cross-run evidence, review HTML | R6, G3 | **[built]** |
| spec builder, DS code templates, verification harness, preview sheets | L1–L4 | **[built]** |
| decision + checkpoint store, approval fingerprints, package assembly | every gate | **[built]** |
| `fix-redesign` SKILL.md — the procedure the Session Agent follows | Session Agent | **[built]**, stale, to be rewritten |

Tools: Chromium via Playwright; the filesystem; audit-agent's CLI; the model API; the DS repo's own `typecheck` / `lint` / `verify` / safelist / story scripts; `git` (local); `gh` or the GitHub API (only after push approval).

---

## 4. Configuration

Schema-validated JSON with per-field `FIX_REDESIGN_AGENT_*` environment overrides; an invalid value fails fast naming the field.

| Key | Meaning | State |
|---|---|---|
| `auditAgentRepoRoot` | absolute path of audit-agent; read-only | **[built]** |
| `designSystemPath` | DS source for the loader; read, never vendored | **[built]** |
| `anthropicModel`, `browserChannel`, `maxIterations` | model, engine lock, loop cap | **[built]** |
| `judgmentProvider: "claude-session" \| "anthropic-api"` | who performs C2/R3/R5/L2/L3's judgment — default `"claude-session"` (§4a); `"anthropic-api"` is the original direct-API behavior | **[built]** |
| `politeness` | per-origin navigation pacing toward the production origin | **[built]**; `maxConcurrentContexts` **not enforced** |
| `dsRepo: { path, branchPrefix, remote, baseBranch }` | where Workflow B writes and, after approval, pushes; remote/base may be null until §19.1 | **[built]** |
| `plausibilityBar` | minimum possible-match score counted as plausible; default mirrors the audit's own bar, and the value used is recorded per run | **[built]** |
| `viewports` | validation and preview viewports; default is the audit's single viewport | **[built]** |
| `mapping: { iouFloor, textSimilarityFloor, requireTwoIndependentChecks }` | objective mapping thresholds (§6.4) | **[built]** |
| `maxReviewRounds` | rejection rounds per gate; default 2 | **[built]** |
| `buildConcurrency` | parallel component builds; default 2 | **[built]** |
| `captureStates` | extra interaction states to capture; default none | **[built]** |

---

## 4a. Judgment provider — `claude-session` (default) vs `anthropic-api` — **[built]**

C2, R3, R5, L2 and L3 (§3.2's five judgment-bearing nodes) are the only places this system ever needs semantic judgment. `judgmentProvider` picks who performs it, without changing any of those nodes' roles, schemas, retry limits or output contracts (§3.2, §7.5):

| Provider | Mechanism | Needs |
|---|---|---|
| **`claude-session`** (default) | The `LlmClient` these five nodes call (`src/llm/claude-session-client.ts`) writes a versioned **pending judgment bundle** — `instructions` (the system prompt), `prompt`, every referenced image's `caption` and on-disk `path` (never re-embedded bytes), and the exact JSON Schema (`wireSchema`) the answer must satisfy — to `<runDir>/judgments/<bundleId>.bundle.json`, then throws a distinct `AwaitingJudgmentError` (never a `TerminalError`/`RepairableError` — `retry.ts`'s `classify()` never sees it, so it is never retried or misreported as a failure). `pipeline.ts` catches it, checkpoints the run with `runOutcome: "awaiting-judgment"` (§7.7, a state distinct from `awaiting-approval` — a human gate waits on a DECISION; this waits on the Session Agent PERFORMING a role), and returns cleanly. The Session Agent (the Claude Code instance the run was started from) reads the bundle (`judgment show`), performs that node's judgment itself — inspecting the referenced screenshots directly for R5/L3, per the SKILL.md loop — and records the result (`judgment submit`). Submission is validated against the node's REAL Zod schema (`src/judgment/schema-registry.ts`, the same map `test/unit/llm-schemas.test.ts`'s wire-safety guard uses, so the two can never drift), never just the looser recorded JSON Schema shape; an invalid submission is refused with the exact issues and consumes no retry. A valid submission resumes the pipeline automatically — the SAME content-addressed request (`fingerprintOf({nodeId, system, prompt, image captions, wireSchema})`, §11.3's existing fingerprint idiom) finds its now-answered result and returns it with zero token usage. No nested `claude` process is ever spawned, and no Claude Code credential is ever read or reused to call an API. | Nothing — no credential, no network call from this system at all for these five nodes. |
| **`anthropic-api`** | The original behavior: `AnthropicLlmClient` (vendored, §3.3) calls the Anthropic API directly. | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`. |

**R5 and L3's vision half specifically:** both are documented (§8.6, §9.4) as inspecting screenshots — R5 always has real before/after composites to reference; L3, per its own stated scoped limitation, has no rendered component preview available at its pipeline stage today (L4's preview runs after L3), so its vision stays `NOT_CHECKED` under either provider, unchanged by this feature. In `claude-session` mode, "the Session Agent inspects the screenshots" is a SKILL.md-level instruction (read the bundle's referenced image paths before answering), not a code-enforced gate; when no meaningful image can be inspected, the deterministic parts of an answer stand untouched, the vision-facing field is recorded `NOT_CHECKED`, and a full PASS is never claimed on the strength of an uninspected image (§8.9's existing PASS rule already excludes a `REJECTED`/severe-issue vision verdict from PASS; a genuinely `NOT_CHECKED` vision alongside a fully-passing deterministic check was, and remains, a legitimate PASS — see `test/unit/r5-verdict.test.ts`'s Decision Log #10 test — the guarantee this feature adds is that a pause is never MISTAKEN for that legitimate case, never that the case itself was removed).

**CLI:** `judgment status <redesignRunId>` (list bundles + submitted/pending), `judgment show <redesignRunId> [bundleId]` (full bundle content; auto-selects when exactly one is pending, per this system's existing "one exact match proceeds automatically" idiom, §5.1), `judgment submit <redesignRunId> --file <result.json> [--bundle <id>]` (validate, record, auto-resume), `resume <redesignRunId>` (reconstruct `ctx`/`input` from the run's own `run.json` and re-invoke the orchestrator from its last checkpoint — shared internally with `judgment submit`'s auto-continue).

**Readiness:** `redesign --dry-run` reports which provider is configured; in `claude-session` mode it states no credential is needed and that the run must be started inside an authenticated Claude Code session; in `anthropic-api` mode it reports whether a credential is actually present.

---

## 5. Session startup, discovery, persistence

### 5.1 The normal input, and what `<name>` accepts

```
Project/Run: <name>
Mode: Full Page | Selected Sections
```

That is the whole normal input. `<name>` is resolved **within the configured project locations** — audit-agent's `projects/` root and this repo's own — trying, in order, an exact audit Run ID, an exact audit Run Name (case-insensitive), this repo's own run id, and, when `<name>` looks like a path or a `file://` link or a dashboard URL, the marker-file classification below. A run ID or a folder reference remains fully supported as an alternative form of `<name>`; the user is never asked which kind they gave.

| Form of `<name>` | Resolution | Not exact → |
|---|---|---|
| audit Run ID | `find-run --run-id` | exit 1 → retry the same string as a Run Name; still nothing → ask |
| audit Run Name | `find-run --run-name` (exact, case-insensitive) | exit 2 → show the candidates the command printed, ask |
| **a project name** (no specific run) | every run under that project | **exactly one run → proceed automatically. More than one → ask once which run.** |
| this repo's run id | folder lookup under `projects/*/redesigns/` | several projects share it → list, ask |
| a folder path or `file://` link to any file inside one | marker files: this repo's run meta → a run here; `data.json` + `run.json` → an audit run; `project.json` beside `runs/` → an audit project; `project.json` beside `redesigns/` → a project here | no marker → refuse, naming the markers expected; several runs → list, ask |
| an audit dashboard URL | path segments → `find-run --run-id` | as Run ID |

**One exact, unambiguous match proceeds without a question.** Every other outcome — a project with several runs, an ambiguous name, a stale source — lists what was found and asks, once. §5.4 covers the one remaining input, section scope, which the two-line form above does not carry directly.

### 5.2 Discovery and missing files

Once resolved, every artifact in §2.3 is found deterministically. A required file that is absent stops the run and names the file, the directory searched, and the command or export that produces it. For a `components` run, **both** plan paths are reported. Nothing is ever asked for individually.

### 5.2a Section scope: what is verified, what is derived, what is new — **[built]**

**Verified before writing this, not assumed:** neither `fix-plan.json` nor `new-component-plan.json` — audit-agent's actual schemas — has any field for a reviewer's section selection. `fix-plan.json` entries carry `findingId, decision, decidedAt, decidedBy, note, source`; `new-component-plan.json` entries carry `findingId, classification, selectedAt, note, candidateSource, relatedFindingIds`. Neither has a `sections` field, and no third file exists that would. **Section membership is not stored anywhere upstream — it is only derivable**, by grouping each authorized finding on its own `data.json → location.section` string. Nothing in this document claims otherwise.

**The derivation, run every time:** the candidate set for Selected Sections mode is every section containing at least one `fix`-decision finding, computed fresh from R1's output — the same default G1 already used in v3.0.

**What is new in v3.1 — a resolved-scope record this system writes for itself**, so the same question is not asked twice for the same run:

| Step | Behaviour |
|---|---|
| exactly one candidate section | proceed automatically — genuinely unambiguous, no question needed |
| a scope was already resolved for this exact source run (recorded below) and the candidate set has not changed since | reuse it silently |
| the candidate set changed since a prior resolution (new `fix` decisions touched a section outside the recorded scope) | ask once, showing what is new, before continuing |
| first time, more than one candidate, nothing recorded | ask once — the candidate list, pre-ticked to the full default — then persist the answer |

The resolved scope is written to `context/scope.json` in the run folder (mode, resolved section ids, the candidate set it was resolved from, and a timestamp) and re-read on `open`. This is the "compatible approach for persisting or resolving it" the derivation needed: a small, self-owned record, never a claim that audit-agent stores this.

### 5.3 Persistence across sessions

| File | Holds |
|---|---|
| `projects/<slug>/project.json` | the audit project this slug maps to (repo root, project name, directory), the DS target, and an index of runs here |
| `context/context.json` | every input: path, role, sha256, read-at, plus the reference the user originally gave |
| `<runDir>/run.json` | run type, status, scope, iterations, source run reference with hashes, DS registry version at audit and at build |
| `session-state.json` | last completed node, iteration, pending gate, the exact next command, checkpoints |
| `decisions.json` | every gate decision and every ask answer, each with fingerprint, actor, timestamp, note |
| `handoff.md` | the human-readable form of all of the above, regenerated after every stage |

Opening an existing run re-verifies every input hash, re-resolves a moved audit repo through `find-run`, prints the status and the pending gate, and continues. A changed input is reported as **stale** and continuing requires an explicit answer.

---

## 6. Context & Mapping

The contiguous stage group **S0 → R1 → R2 → C2**, of which C2 is new. Together they answer: what was authorized, what the page is now, what the audit found, and what the DS currently provides.

### 6.1 Authority by concern

There is no global ranking of sources. Each source is authoritative **for its own concern only**, and a source is never consulted outside it.

| Concern | Authority | Everything else |
|---|---|---|
| **authorized scope** — what may be changed at all | the user's plans | nothing may widen it; neither the audit nor the model may add a target |
| **current page state** — structure, styles, assets, fonts, affordances, geometry | this run's live capture | audit evidence may only *hint* at where to look |
| **historical findings** — what was wrong, expected values, tokens, the DS match at audit time | `data.json` | the live page may contradict it; that is recorded as drift, not a correction |
| **current DS rules** — components, variants, tokens, rules | the DS registry and component source read at build time | the audit's DS version is historical context |
| **corrected reference** — what a component should look like once fixes are applied | a verified corrected preview from this run, or a named prior run | never assumed; if it does not exist the dependent work is blocked |
| **reviewer intent** | the plans' `note` / `decidedBy`, plus the audit's own recommendation and review fields | never inferred from the page |
| **what the reviewer was looking at** | the audit report | never page truth, never DS truth |

**Conflicts are recorded, never silently resolved.** Each is written to `context/conflicts.json` and surfaced at the next gate:

| Conflict | Handling |
|---|---|
| live page contradicts audit evidence for an element | a drift record (§6.5); the live page governs current state, the audit still governs what was found |
| `data.json` target URL vs run metadata | `data.json` governs; warning recorded |
| plan `runId` vs the resolved folder | refuse the run |
| the two component-plan sources disagree about a pattern | ask |
| the DS changed between audit and build so an **expected value moved** | **never silently applied.** The finding is flagged `expectation-changed`, showing the audit's expectation and the current one, and requires acknowledgement at G1 before any edit uses the new value |
| a DS component or token referenced by a finding no longer exists | the finding becomes `unaddressed` with that reason; never substituted |

The last two encode the rule that an approved expectation is never quietly changed underneath the person who approved it.

### 6.2 What is assembled (R1, extended) — **[contract → proposed extension]**

Plans, audit data, run metadata, evidence paths, the report (as reviewer context only), the guidance fields of §2.3, related findings by shared signature, the DS registry, and — for every DS component a finding names or plausibly matches — the **component's source text**, read verbatim from the DS tree. Any figure recomputed from the report's own logic (for example post-fix opportunities) pins the same constant the report used and records that value.

### 6.3 What is inspected (R2 + C2) — **[built]**

A live capture at the audit's viewport, then per candidate element: geometry, content, assets, computed styles, and **observable affordances** — tag, role, `href`, type, `tabindex`, `aria-expanded` / `controls` / `haspopup`, disabled state, cursor, form association. Additional interaction states are captured only when `captureStates` asks; the audit holds no expected values for them, so they are evidence, never a validation target.

### 6.4 Mapping: objective checks first, model second, neither sufficient alone — **[built]**

**Many findings may map to one element.** This is normal: a single element can carry several findings (different rules, different properties, or a repeated pattern with per-instance findings). `mapping.json` is therefore **element-keyed**, not finding-keyed:

```
element e17
  stamp          data-fra-element="e17"   data-fra-findings="<id> <id> …"
  findingIds     [ … ]                     signature, instanceIndex, instanceCount
  sectionId      scope: content | excluded | unselected
  resolution     method, confidence class, checks passed, candidates considered
  drift          class, audit box vs live box, style deltas
  affordances    role, href, tabindex, aria-*, disabled, cursor
  dsReference    component file, variants, the source excerpt that justified it
```

**Objective checks** — computed, reproducible, no model involved:

| Check | Passes when |
|---|---|
| geometry | the live box overlaps the audit box above `iouFloor` (default 0.6) after scroll normalisation |
| identity | tag and role agree with the audit's record |
| text | normalised text or accessible name similarity is above `textSimilarityFloor`, or both are empty |
| class fingerprint | the element's classes overlap the class list the audit recorded in its review signals, when one exists |
| uniqueness | exactly one candidate in the document passes the checks above |

**Confidence classes and what each authorizes:**

| Class | Reached when | Authorizes |
|---|---|---|
| `confirmed` | uniqueness holds and at least two independent checks pass | edits, previews, specs |
| `probable` | several candidates passed objectively and the **Element Mapper selected one** among them | edits only after a batch acknowledgement at G1 — never on model confidence alone |
| `ambiguous` | several candidates remain and the model could not select one that passes objectively, or its selection fails a check | a human must resolve; otherwise the finding is `unaddressed` |
| `absent` | no candidate passes | `unaddressed`, with the drift record as the reason |

The model's role is strictly to **propose a selection among enumerated candidates that already pass objective checks**. It can never create a `confirmed` mapping, can never override a failed check, and its stated confidence is recorded but is not an authorization input.

**Conflicting findings on one element** — two findings demanding different values for the same property — are detected at planning time and escalated, never silently reconciled by the planner.

**Two prohibitions, as rules:**
1. Audit evidence is never substituted for the live page. Evidence boxes are locating hints and reference images; nothing else.
2. A `findingId` is a content fingerprint computed by the audit; **the page does not contain it**. `data-fra-*` attributes are written by C2 as the *result* of mapping and are read back only inside the same captured document.

### 6.5 Drift

| Class | Meaning | Effect |
|---|---|---|
| `identical` | within tolerance on geometry, text and styles | proceed |
| `moved` | geometry changed only | proceed; recorded |
| `restyled` | computed styles differ from the audit's record | proceed; the finding's measured baseline is recomputed from the live element, and the difference is shown at G2 |
| `content-changed` | text or child structure differs | proceed only if the mapping is `confirmed`; shown at G1 |
| `absent` | no candidate | `unaddressed`; never guessed |
| `ambiguous` | several candidates | human resolution |

### 6.6 Capture freshness and reuse

Freshness is a **capture fingerprint**, not a DOM hash alone: the DOM structure, every stylesheet's URL and content hash, `@font-face` sources and their hashes, in-scope image and media asset URLs and hashes, the viewport, and the rendering policy. CSS, assets and fonts are included because a typography or spacing fix is meaningless if the font or stylesheet behind it changed.

| Situation | Reuse |
|---|---|
| within a run, across loop iterations | yes — the live session stays open |
| after a gate or a crash closed the browser | re-capture, then **revalidate before replaying** (§6.7) |
| a previous run's capture | only when the URL, viewport, rendering policy **and** the freshly computed capture fingerprint all match; default is always re-capture |
| audit screenshots as the live page | **never** |
| audit evidence boxes as locating hints | always — that is their purpose |
| a prior run's verified corrected output as a component reference | yes, recorded by run id and hash, when its dependencies are satisfied |

### 6.7 Resume revalidation — **[built]**

Before any recorded edit is replayed onto a fresh capture, all three must be revalidated, in this order:

1. **Capture freshness** — recompute the capture fingerprint. Any difference in DOM, CSS, assets or fonts means the log is **not** replayed: the run re-plans from the current state and reports exactly what changed.
2. **Mappings** — re-run the objective checks for every element the log touches. Anything that is no longer `confirmed` (or acknowledged `probable`) drops out of the replay and is reported.
3. **DS dependencies** — recompute the registry version and the source hash of every referenced component and token. A change re-derives expectations, flags `expectation-changed` where an approved expectation moved, and invalidates the approvals that covered it.

Only edits surviving all three are replayed; everything else is re-planned or reported.

---

## 7. Execution graph

### 7.1 Spine

```
Project/Run: <name>          Mode: Full Page | Selected Sections
        │
        ▼
S0 resolve <name> within the configured project locations
        │  one exact match ──────────────────────────────────┐
        │  project has several runs → ask ONCE, pick the run  │
        ▼                                                     ▼
     [G0 — SKIPPED when the match was exact and sources are fresh; ASKED only on ambiguity or staleness]
        │
        ▼
     R1 resolve & load (both plan sources + the prior selection export, §1.4)
        │
        ▼
     R2 capture ──► C2 inspect · map · stamp · drift
        │
        ▼
     resolve section scope (§5.2a, Selected Sections only) · check mappings and DS-target questions (§6.4, §8.8, BOTH modes)
        │
     [G1 has two independent halves, and the whole gate is skipped only when BOTH are clear:
        · scope half  — asked only in Selected Sections mode, and only when the candidates are ambiguous / not already recorded.
                         Full Page mode has no per-section choice, so this half never applies to it.
        · acknowledgement half — `probable` mappings, `expectation-changed` conflicts, DS-target questions (§8.8).
                         Asked in BOTH modes whenever any exist. Full Page mode never skips these.]
        │
        ▼
     run type resolved: redesign, unless §1.4 auto-queues component work → combined
        │
        ▼
   Workflow A: (R3→R4→R5 loop) → R6 → R7 → G2 (always) → G3 (always, if any component work is queued)
        │
        ▼ (combined only — B never overlaps A; starts after G2)
   Workflow B: L1 → parallel {L2→L3} → L2b → L4 → G4 (always) → optional G5 (always, if G4 was design-only)
```

`components`-only runs enter through a separate, explicit command that names the run directly and has no Mode — everything from R1 onward is identical.

### 7.2 Workflow A

```
  ┌─ loop ≤ maxIterations, exits on PASS ──────────────────────────────────────────┐
  │  R3 plan targeted edits ──► R4 apply to the live DOM ──► R5 measure · diff · vision │
  │     └ no measurable mismatch → DS-target branch (§8.6) → swap edit or unaddressed   │
  └────────────────────────────────────────────────────────────────────────────────┘
                     │
   R6 component review (manifest · DS compare · cross-run evidence · suggestions)
                     │
   R7 assemble · export · validate exports ──► G2 page / section approval
                     │   reject ≤ maxReviewRounds → notes become R3 constraints → loop
                     ▼
   G3 selection export ──► component-selection.json  (+ the upstream plan, if present)
```

### 7.3 Workflow B

```
   L1 resolve plan ── ambiguous → ask ── blocked dependency → report, do not proceed
        │  per component: resolution · reference · scope evidence · write set · depends-on
        ▼
   dependency sort ──► parallel fan-out, bounded by buildConcurrency
        │   per component:  ┌─ loop ≤ 3 ─┐
        │                   │ L2 build ──► L3 verify (DS checks · render · acceptance · vision) │
        │                   └────────────┘
        ▼ join
   L2b integrate (serial, deterministic): barrels · tokens · regenerate safelist
        │
   L4 preview: per component + in-context page render, against the integrated tree
        │
   G4 component approval  →  approve & push  |  approve design  |  request changes
        │                         │                  │                 └ notes → L2, ≤ maxReviewRounds
        │                         │                  ▼
        │                         │            G5 push approval (exact package)
        ▼                         ▼                  ▼
   package assembly (approved only) ──► revalidate the exact package ──► L5 publish: commit; push; PR
```

### 7.4 Dependencies, parallelism, and shared files

- **Workflow A is serial** by nature: one live DOM.
- **A and B never overlap.** B changes the DS; a mid-run registry change would shift A's baseline. In a combined run B starts after G2.
- **Within B, components build in parallel**, bounded by `buildConcurrency` (default 2), after a topological sort over two dependency kinds: `dependsOn.findings` (a corrected reference that must be verified first) and `dependsOn.components` (for example a molecule using a new atom).
- **Fan-out / fan-in, in audit-agent's own vocabulary.** Each ready component is one dispatched instance of the Builder → Verifier pair, keyed by `(redesignRunId, componentId)`. `build.json` tracks atomic `dispatched / completed / failed` counters — never read-modify-write — so a retry replays only the failed instance, never the batch. **L2b Integrate is the fan-in**: it waits for `dispatched == completed + failed` before running, the same completeness rule audit-agent's A3 uses before consolidating. This is the mechanism, not a new agent, that lets concurrent component work scale: more work is more instances of Builder/Verifier, never a new node type.
- **Conflicts are removed, not locked.** Each spec declares a **write set** before building. A build may write only files in its own write set, and **never a shared file**; a build that touches an undeclared file is rejected and that component fails without affecting the batch. Every shared change is *declared* and applied afterwards by **L2b Integrate**, serially and deterministically:

| Shared file | Handled by | Affects rendering? |
|---|---|---|
| the category barrel (explicit named re-exports) | L2b appends in a fixed order | no — wiring only |
| the root barrel (`export *` per directory) | untouched | no |
| the shared token stylesheet | L2b applies declared token additions in a fixed order, preserving the unlayered block | **yes** |
| the generated safelist | L2b regenerates it once by running the DS's own script | **yes** |
| the raw token source | a token addition edits the DTCG source and rebuilds; never hand-edited CSS | **yes** |

This mirrors the upstream concurrency doctrine: disjoint namespaced writes plus one serial integration point, rather than a locking service.

- **Browser concurrency** must be enforced by the pool before parallel rendering. Local DS and preview renders are not subject to the production origin's pacing, which applies per origin.

### 7.5 Retry limits (normative)

| Where | Policy | Then |
|---|---|---|
| model transport | 6 attempts, exponential from 2 s capped at 60 s, honouring `retry-after`; a demand beyond the cap stops immediately | terminal |
| structured output failing its schema | one repair re-ask carrying the validation issues | terminal |
| deterministic node, retryable error | 3 attempts, 2 s base with jitter — **idempotent by construction, mirroring audit-agent's own concurrency doctrine**: R4's edits are keyed by `(findingId, property)` and cache-and-replay their own prior result rather than reapplying on top of it; R7's exports overwrite their own named file wholesale rather than appending; L2's writes are confined to a declared write set (§9.4), so a retried write lands on the same key, never a second one | terminal |
| ai / hybrid node | 2 attempts, fresh each time — never a replay of a bad first attempt | terminal |
| C2 mapping | deterministic pass 3 attempts; one batched model call for the ambiguous remainder; never a second | escalate to G1 |
| R3 → R4 → R5 | `maxIterations` (default 3), early exit on PASS | outcome `PARTIAL` / `FAIL` |
| L2 → L3 per component | 3, early exit on PASS | that component `PARTIAL` / `FAIL`; the batch continues |
| package revalidation | 1 | the package is not publishable |
| G2 / G4 rejection rounds | `maxReviewRounds` (default 2) | the unit closes as `blocked`, with the notes recorded |
| S0 resolution | none | ask |
| push / PR | 3 on network errors only; authentication and permission errors never retried | recorded; the approval survives for the same fingerprint |

### 7.6 Failure handling

| Failure | Effect | Resume |
|---|---|---|
| a node throws | run meta records the node, iteration and first line; span marked in error; browser closed; the edit log kept | reopen, fix, continue from the last checkpoint after §6.7 revalidation |
| an input changed since the run started | reported as stale at the next gate | continue only on an explicit answer |
| an evidence file is missing | recorded as missing evidence; mapping falls back to the remaining checks | — |
| mapping `absent` or `ambiguous` | that finding is `unaddressed` or escalated; never guessed | resolve at G1 |
| an edit's stamp is lost to a re-render | re-located at assembly; still lost → reported | — |
| a build writes outside its write set | that component fails; the batch continues | rebuild after the spec is corrected |
| a dependency is unsatisfied | that component is **blocked** with exactly what is missing | satisfy, or run A first |
| a required plan input is missing | the run or that half is **blocked**, naming both paths checked | provide the export |

### 7.7 Run outcomes

Two different things are reported, and they are never conflated.

**Per unit** — a unit is one Fix finding in A, or one component in B:

`done` · `blocked` (needs an input, a dependency, or a human) · `awaiting-approval` · `failed`.

**Per run** — the most severe unit state present, in this order: `failed` → `blocked` → `awaiting-approval` → `completed`, plus `running`. **`awaiting-judgment`** (§4a, `judgmentProvider: "claude-session"`) is a further run-outcome value **outside this aggregation** — set directly by the orchestrator on a pending judgment bundle, the same way `awaiting-approval` is sometimes set directly ahead of a gate, never derived from unit states. It means "paused for the Session Agent to perform a role", never "paused for a human decision" — the two are never conflated in CLI output or in `run.json`.

> **A run is `completed` only when every requested unit is `done`.** A combined run is never reported as complete while any requested work is blocked, failed, or awaiting approval — even if the other workflow finished cleanly. Counts per state are always printed alongside the status.

The page-level verdict (`PASS` / `PARTIAL` / `FAIL`) is a **separate axis**: it describes how well the applied fixes validated. A run can be `completed` with a page verdict of `PARTIAL`; a run whose page verdict is `PASS` is still `blocked` if a component was never built. **The same model covers a reused-but-stale selection (§1.4): while it awaits re-confirmation at G3, the component work it would have started is `blocked`, not silently `done` — requested work stays visibly distinct from completed work in every case, not only the ones this document happened to introduce first.**

---

## 8. Workflow A — page and section redesign

### 8.1 Design modes

| Mode | Scope | Applied | Delivered |
|---|---|---|---|
| **Full Page** | every content section of the captured page | every `fix` finding outside the global header and footer | the complete corrected page content with header and footer removed; the full page for QA context; the unmodified original; before and after composites; per-component crops |
| **Selected Sections** | one or more sections chosen at G1 | `fix` findings inside the selected sections only | one standalone fragment per selected section, plus the complete content document in which unselected sections appear **unmodified** and marked as such; composites cropped to the selected sections and the full page |

The scope is a recorded object — mode, section ids, exclusions — written at G1 and reread on resume. Findings outside the scope are never dropped; they appear in the change list with the reason (`section-not-selected`, `global-header-footer`, `unaddressed`).

### 8.2 Section identity

A section id is derived from the audit's own section name — the label the reviewer already saw — normalised to a slug, with a numeric suffix on collision. At C2 each section's **wrapper element** is located as the lowest common ancestor of its mapped members, widened to the nearest sectioning element, and cross-checked against document landmarks; when the two disagree, both are shown at G1 and the choice is recorded. A section whose wrapper cannot be located is listed, cannot be chosen as a fragment, and its findings remain available in Full Page mode. Section ids are stable across runs for as long as the audit names the section the same way; a renamed section is a new id and the change is reported rather than guessed.

### 8.3 Global header and footer

A section is **global** when the audit named it as the header or footer, or its wrapper is the document's banner or contentinfo landmark; a navigation section is global only when it sits inside the banner.

Global sections are **never edited in Workflow A** and are removed from every content deliverable. Their findings and every component detected in them are routed to the manifest as **global candidates** and enter Workflow B. The full-page QA document shows them unmodified, for context only. Inclusion requires an explicit scope choice at G1, recorded as such. Exclusion is a routing decision, never a deletion: every excluded finding is listed.

### 8.4 CSS isolation in exported documents

Removing the header and footer, or isolating a section, must not change how the remaining content renders. The export rules are:

1. **Never lift a subtree out of its document.** Serialize the whole document and remove the excluded subtrees, keeping the root, head, body and every intermediate wrapper with its attributes and classes, so descendant and class-based selectors still match.
2. **Preserve sibling position.** A removed subtree that has siblings inside the content root is replaced by an inert placeholder element so positional selectors keep their indices. Type-based positional selectors can still shift; this is recorded as a known limitation of fragment exports.
3. **Inline every stylesheet at the exact position of its link, in document order.** Never merge, reorder, minify or rewrite selectors. Layer statements are preserved exactly; the DS's shared token block is deliberately unlayered and must remain so.
4. **Preserve all conditional rules** — media, container and support queries — verbatim, so responsive behaviour survives in the export.
5. **Inline fonts** as data URIs. Without this the export renders in fallback faces and every typography fix looks wrong.
6. **Inline images and media** as data URIs; anything that cannot be inlined is recorded as a missing asset and never left as a live URL.
7. **The DS stylesheet injected for component swaps** is appended after the page's own styles, marked as injected, and disclosed in the change list.

### 8.5 Validation of exported HTML

Every exported document must pass all of the following before G2; a failure blocks the gate and names what failed. **Each file has its own intended scope, and the scope check below is evaluated against that file's own row, never one blanket rule:**

| File | Intended scope |
|---|---|
| `original.html` | the whole captured page, unmodified |
| `redesign.html` | the whole page, edits applied, header and footer **retained** — the QA context copy |
| `redesign-content.html` (Full Page) | every content section, edits applied, header and footer **absent** |
| `redesign-content.html` (Selected Sections) | every content section; selected ones edited, unselected ones **unmodified and marked** `data-fra-scope="unselected"`; header and footer **absent** |
| `sections/<sectionId>.html` | exactly that one section, standalone, nothing else |

| Check | Fails when |
|---|---|
| parse | the document does not parse, or parsing repairs change the structure |
| zero network | any `src`, `href`, `url()` or import still points at a network resource (content anchors excepted — they are links, not loads) |
| **scope** | the document contains anything outside **its own row above** — an excluded subtree in a content export, another section in a fragment export, an unselected section edited when it should be untouched, or a missing header/footer in `redesign.html` |
| stamps | a stamp is duplicated, or a mapping entry has no corresponding element |
| **rendered parity** | the export, reopened in the same browser at the same viewport, differs from the live post-edit page beyond tolerance on the computed styles and geometry of any mapped element — reported per element and property |

Rendered parity is what actually proves CSS isolation worked; the other checks are necessary but not sufficient.

### 8.6 Nodes

| Node | Kind | Responsibility | State |
|---|---|---|---|
| **R1 Resolve & Load** | deterministic | resolve the run; read and validate both plans and the audit data in place; filter to the authorized scope; load the DS registry; on resume, reload the recorded scope | **[built]** |
| **R2 Capture** | deterministic | politely capture the live page at the audit's viewport; settle; tiles and composite; record the capture fingerprint | **[built]** |
| **C2 Inspect · Map · Stamp** | hybrid | §6.3–§6.5: inspect, map with objective checks, stamp, classify drift, resolve each element's DS reference and read its source; write `mapping.json` | **[built]** |
| **R3 Redesign Plan** | ai | one batched structured call over the authorized findings, chunked beyond a bound, with the DS catalog, tokens, rules, component source and the mapped element table → targeted edits plus an explicit `unaddressed` list. Edits address **stamped elements**; a selector may be supplied only to reach a descendant of a stamped element. Iteration *n* receives *n−1*'s plan and verdict; G2 notes enter as constraints | **[built]** |
| **R4 Apply & Render** | deterministic | apply only the planned edits: style edits as rules in an injected stylesheet so responsive rules survive; swaps only against a catalog-resolved entry; record the previous value of everything touched into the replayable edit log; capture the after state | **[built]** |
| **R5 Compare** | hybrid | re-measure each finding's properties; structural diff within scope (interactive inventory and text coverage); one batched vision comparison; produce `PASS` / `PARTIAL` / `FAIL` naming every failed check | verdict rule **[built]**, tiers **[built]** |
| **R6 Component Review** | deterministic | the manifest over **every** detected component, changed or not: identity, section, scope, DS match, tokens, fix status, boxes and crops, evidence references, states captured versus missing, cross-run evidence, and a suggestion carrying its rule id and confidence. Runs even when the page verdict is `PARTIAL` or `FAIL` | **[built]** |
| **R7 Assemble & Validate** | deterministic | re-locate stamps; after-crops; serialize once; produce every export under §8.4 and validate each under §8.5; write the change list, the review checklist, the index and the handoff | **[built]** |

### 8.7 Design System usage

Values come from tokens — an edit names the token it derives from. Component swaps resolve through the catalog by exact match, never substring. Rules and anti-patterns constrain the planner, and each rule violation maps to an edit or to a stated `unaddressed` reason. The DS stylesheet is injected so swapped markup renders with real tokens. One registry snapshot is taken per run and recorded by version.

### 8.8 Findings with no measurable mismatch

Reviewers legitimately mark findings the audit could not measure. These are never silently skipped:

| The finding carries | The planner produces |
|---|---|
| measured mismatches | property edits using the expected values and their tokens |
| rule violations only | rule-driven edits with expected values from the DS rules |
| neither, but a DS component match | a swap to that component, variant resolved from the catalog |
| neither, but a plausible match at or above the configured bar | a swap to the top plausible match, marked as inferred |
| none of the above | an ask at G1: which DS component should this become? Unanswered, it is `unaddressed` with that exact reason |

### 8.9 Visual validation

Per iteration and within scope: re-measurement of every edited property against the expected value; a structural diff proving no interactive element or text was lost; and a vision comparison of before and after against the intended change. The three outcomes stay distinct — a rejected vision verdict is never reported as a pass, and a partially-fixed page is never reported as complete. Validation runs at the audit's viewport, and at every additional configured viewport when `viewports` names more.

---

## 9. Workflow B — Design System components

### 9.0 Precondition: the DS repository

Before L1 dispatches anything, the configured `dsRepo.path` is checked once: is it actually a git repository? If not, Workflow B stops here and says so plainly — never attempting a branch or commit operation against a plain folder and failing confusingly partway through a build. This is a known, recorded gap today (§0.2, §19.1): the Design System is currently a plain folder with no `.git` and no remote. The check exists so that becomes one explicit, early, clearly-worded refusal, rather than something a component build discovers on its own, partway through.

### 9.1 Resolution (L1, deterministic; ambiguity asks)

| Resolution | Rule, first match wins | Produces |
|---|---|---|
| **reuse** | the audit matched an existing component and the page fix was verified using it as-is | no library change; recorded as a page-only fix |
| **update** | an existing component matches or plausibly matches, but a needed variant, size, state, prop or token does not exist in the catalog, or the reviewer's note names one | an **additive change spec** against that component |
| **new** | no plausible match, and the pattern repeats or recurs elsewhere with evidence, or a plan source marks it new | a **component spec**: name and category per DS conventions, anatomy from the stamped instances, variant axes inferred across instances, tokens, roles, states observed versus to be designed, and any post-fix prerequisite |
| **ambiguous** | conflicting signals — a plausible match but marked new, two candidate files, a single instance with no recurrence, or the two plan sources disagreeing | **stop and ask**; the answer is recorded and the entry re-resolved |

### 9.2 Reference resolution

Each candidate's reference is chosen in this order and recorded: a **verified corrected** element from this run; the same from a named prior run, by run id and hash; otherwise the live element as captured. A candidate that needs a corrected reference which does not exist is **blocked**, naming exactly what is missing — never built against an uncorrected reference.

### 9.3 Component scope — evidence required

| Scope | Evidence |
|---|---|
| `page-local` | instances only on this page |
| `multi-page` | recurrence in other audited runs, with the matching basis recorded |
| `global` | originates in the header or footer |

**Global reuse is never assumed.** A selection marked shared without supporting evidence is honoured — the reviewer may know something the evidence does not show — but it is flagged, and the spec states that its shared status rests on the reviewer's assertion.

### 9.4 Build, integrate, verify

- **L2 Build** — the spec becomes code in the DS's own stack on a local branch: a typed component, token-only styling, variant configuration, a story, and a documentation entry. Existing components are touched only for an `update`, and only additively. A new raw token is a flagged governance item edited in the token source, never invented in a stylesheet. **Writes are confined to the declared write set.**
- **L2b Integrate** — serial, deterministic, after the parallel builds join: declared barrel entries applied in a fixed order; declared token additions applied to the shared token block preserving its unlayered structure; the safelist regenerated by the DS's own script. Nothing here is model-written.
- **L3 Verify** — the DS repo's own type check, lint, verification and story build, plus a per-variant render compared with the reference image, plus the acceptance checks below.

### 9.5 Minimum component acceptance checks

Every result is labelled with its evidence class, and the three are never blurred:

- **observed** — measured on the live reference or on the rendered component,
- **missing evidence** — nothing in the audit or the capture can settle it,
- **proposed** — behaviour the builder introduced that no evidence supports.

| Area | Minimum check | Typical evidence class |
|---|---|---|
| **responsive layout** | renders at every configured viewport with no overflow, no clipped text, no overlap, and no horizontal page scroll | **observed** at the audit viewport; **proposed** at any viewport the run did not capture |
| **interaction states** | default always; hover, focus, active and disabled only where the element's affordances imply them | **observed** only if captured; otherwise **missing evidence**, and the built styling is **proposed** |
| **keyboard** | reachable in document order; a visible focus indicator; a button activates on Enter and Space; a disclosure closes on Escape | **observed** when probed deterministically on the reference; otherwise **proposed** |
| **accessibility** | correct role, accessible name and state; text contrast meets the DS's own rule; no attribute referencing a missing id | role, name and contrast **observed**; anything beyond **proposed** |

> A component with any **proposed** result in a required area is never marked `PASS`. It is `PARTIAL`, with each proposal listed for a human decision at G4.

---

## 10. What a snapshot preserves, and where real code is required

| | HTML snapshot of the live page (Workflow A) | Component code in the DS repo (Workflow B) | Site source access |
|---|---|---|---|
| preserved reliably | layout, styling, text, images, structure, link targets, CSS-only states, and the exact production rendering of everything not authorized for change | the component's API, variants, states, tokens, behaviour, responsive rules and stories | everything, including routing, forms and data |
| must be inferred | nothing for the snapshot itself; a developer translates the change list into source | anatomy and variant axes from the instances; states no evidence covers | — |
| unavailable | script behaviour: hydration, client navigation, script-driven menus, tabs and carousels, form submission, live data, authentication, personalisation | the page itself as a working site | — |
| status | in scope | in scope, local branch, gated publish | **explicitly deferred** — a site-source mode would be a new workflow with its own approval model |

---

## 10a. `review/review-index.html` — the documented entry point for review

Every gate that shows the user something (G2, G3, G4) points at **one file**: `review/review-index.html`, regenerated by the relevant stage before that gate runs. It is the single page a person opens; nothing here is meant to be found by browsing the run folder by hand.

It links, organised by what each thing actually supports:

| Section of the index | Links to | What it supports |
|---|---|---|
| **Page outputs** | `original.html`, `redesign.html`, `redesign-content.html`, `sections/<sectionId>.html`, `before.png` / `after.png` | a **static** rendering of the page's markup and styles at the recorded viewport. Native, CSS-only affordances work when opened directly — hover and focus styling, `<details>` disclosure, native form-validation UI. Script-driven behaviour — hydration, client-side navigation, JS-built menus or carousels, form submission, live data — does **not** run; §10 states this as a structural limit of the snapshot, not a defect to fix |
| **Component previews** | `library/previews/<component>.html` / `.png`, one per built or updated component | **not** a live render of the built component through the Design System's own bundler/Storybook pipeline — that is out of this system's reach without invoking that pipeline (§9.4/§10). What it actually shows: the reference evidence crop beside the §9.5 acceptance checks measured against the corrected live reference element, one row per check. A state shown here that was never probed is labelled `proposed` — the preview never implies a state was verified when it was only designed |
| **In-context previews** | `library/in-context/redesign-with-components.html` | the same static-snapshot limits as page outputs, but rendered with the built components swapped into the real page layout, so their fit can be judged in place |
| **QA / validation results** | `validation-results.json`, `export-validation.json`, `acceptance.json`, `package-validation.json`, rendered readably | pass or fail per check, per finding or per component, with every failure named — never a bare score |

**At every gate that asks (G2, G3, G4), the exact output folder path and the `review/review-index.html` path are shown first**, before any individual file — nobody is handed a bare file list with no stated place to start.

**Two different recording mechanisms, kept deliberately distinct:**
- **Selection** (G3) is recorded by an **export from `component-review.html`** — a client-side download of `component-selection.json`, saved into the run folder. There is no separate chat confirmation for this decision; the file itself *is* the record.
- **Design approval and publish approval** (G2, G4, G5) are **never** recorded by a button inside an HTML file. They happen in conversation with the Session Agent, which then runs `pnpm run agent decide <redesignRunId> --gate <G> --outcome <…>` to persist the fingerprinted record (§11.3). Opening `review-index.html` shows the material a decision is based on; it never itself grants that decision.

---

## 11. Approvals

### 11.1 Principles

1. **Selecting a component authorizes preparing it — not approving a design nobody has seen.**
2. Selection, design approval and push approval are three different decisions, recorded separately.
3. Every approval carries a fingerprint of exactly what was approved and is reused only when the recomputed fingerprint is identical.
4. **No repetitive confirmation, and no confirmation at all when there is nothing to confirm.** G0 and G1 ask only when the reference is ambiguous, an input is missing, a mapping is merely `probable`, an expectation moved, or the section scope genuinely cannot be derived (§5.1, §5.2a) — never as a rubber-stamp step when the answer is already unambiguous. **G2 through G5 always ask**: they are the visual design approval and the publish authorization, and nothing about a faster start shortens them.
5. Merge and deployment are outside this system.

### 11.2 Gates

| Gate | When | Asked | Shown when asked | Outcomes |
|---|---|---|---|---|
| **G0 Start** | after S0 | **only if** the match was ambiguous or an input is stale | what resolved and how; URL; inferred run type; authorized counts; what changed | proceed · stop |
| **G1 Scope & acknowledgements** | after C2 | scope half: **only in Selected Sections mode, and only if** the candidates are ambiguous / not already recorded. Acknowledgement half: **in both modes, whenever** a `probable` mapping, an `expectation-changed` finding, or an unresolved DS-target question (§8.8) exists. Skipped only when **neither half** has anything to ask | candidate sections (if that half fired); the specific uncertain mappings, changed expectations, or DS-target questions (if that half fired) | the resolved scope, plus acknowledgements, for whichever half asked |
| **G2 Page / section approval** | after R7 | **always** | run folder path and `review/review-index.html` first, then: the exports, original, before and after, the change list, the verdict with every failed check, export-validation results (§8.5, per file) | approve · request changes (≤ `maxReviewRounds`) |
| **G3 Component selection** | after G2, or on request after a partial run | **when component work is queued** — **skipped** in the narrow case of a valid, fresh, reused prior selection (§1.4); asked otherwise | run folder path and `review/review-index.html` (which links to `component-review.html`), then: the checklist — one card per pattern with crops, instances, sections, DS match, cross-page evidence, suggestion with rule and confidence, uncertainty flags, global candidates, and a manual add | the export itself |
| **G4 Component approval** | after L4 | **always** | run folder path and `review/review-index.html` (which links to each component's preview and the in-context preview), then: previews per variant and state, acceptance results with evidence classes (§9.5), verifier verdicts, **the exact changed files**, **the intended repository and branch**, and scope evidence | **approve & push** · **approve design** · **request changes** |
| **G5 Push approval** | only when G4 gave design-only | **always, in that case** | the same file list and destination; nothing re-litigated | approve · decline |

When G0 or a half of G1 is skipped, or G3 is skipped on reuse, the resolved state (what matched, what scope was used, which selection was reused) still appears in the very next thing the user sees — G2's summary, or G4's — so nothing that would have been shown is actually lost, only the extra question is.

### 11.3 Fingerprints

| Approval | Covers |
|---|---|
| G2 | the exported documents and the validation results |
| G3 | the exported selection, plus the upstream plan if used |
| G4 design, per component | that component's own built files, its previews, and its acceptance results |
| push, per package | branch, remote, base branch, and every `(path, blob hash)` in the package — **including shared files** |

### 11.4 The approved-only publish package

Approving components individually does not prove the integrated set builds. Therefore:

1. The package is assembled from **approved components only** — their own files, plus the shared-file state derived from exactly that subset: barrel entries for approved components only, declared token additions from approved specs only, and the safelist regenerated over that subset.
2. **The exact package is revalidated** — integration re-run for the subset, then the DS's own type check, lint, verification and story build over the package, **and a final acceptance and visual pass (§9.5) re-run against each component as it actually renders from the integrated tree — not its isolated, pre-integration build.** A token merge or a barrel change can alter how a component looks even when its own files never changed; this is the check that catches that. A package that fails any of this is not publishable, whatever the per-component approvals say.
3. **Shared changes invalidate approvals for affected components.** If assembling the approved subset changes a *rendering-affecting* shared file (the token block or the generated safelist) relative to what G4 showed, every component whose preview depended on it is re-rendered and its design approval is invalidated. Wiring-only shared files (barrels) cannot change a rendered preview and invalidate only the package fingerprint.
4. Previews at G4 are rendered against the **integrated** tree, not against components in isolation, so the common case is that the approved subset reproduces exactly what was approved and nothing is invalidated.
5. Rebuilding one component invalidates that component's approvals only; untouched components keep theirs.

### 11.5 Combined approval

**Approve & push** records two approvals in one action, and they bind **exactly what separate approval would bind**: the per-component design fingerprints, and the package fingerprint of §11.3 computed over the same assembled, revalidated package. It is offered only when the destination is fully known and the package can be computed at that moment; otherwise only design approval is offered, and the reason is stated. It never implies merge or deployment.

Publishing commits exactly the package. Work that is not approved stays uncommitted on the branch. Any fingerprint mismatch at publish time is a refusal that names what changed.

---

## 12. Responsibility table

| Name | Kind | Execution | Inputs | Outputs | State |
|---|---|---|---|---|---|
| Session Agent | agent | conversational | the user's reference, previews, answers | commands, recorded decisions | **[built]** skill, to be rewritten |
| S0 Open / Resume | stage | deterministic | a reference | resolved run, discovered inputs, project and session state | **[built]** |
| R1 Resolve & Load | stage | deterministic | audit run, plans, DS path, scope | validated inputs, authorized set, registry | **[built]** |
| R2 Capture | stage | deterministic | R1 | live session, capture fingerprint, before shots | **[built]** |
| **C2 Element Mapper** | **agent** | hybrid | R1, live session, evidence | `mapping.json`, stamps, drift, DS references | **[built]** |
| R3 Redesign Planner | **agent** | ai | R1, mapping, DS context, prior iteration | targeted edits, unaddressed list | **[built]** |
| R4 Apply & Render | stage | deterministic | plan, session | applied edits, edit log, after shots | **[built]** |
| R5 Visual Verifier | **agent** | hybrid | mapping, plan, applied, shots | checks, structural diff, verdict, outcome | verdict **[built]** |
| R6 Component Review | stage | deterministic | R1, mapping, iterations, other runs, catalog | the manifest | **[built]** |
| R7 Assemble & Validate | stage | deterministic | everything above | exports, validation, change list, review files, handoff | **[built]** |
| L1 Resolve Plan | stage | deterministic, asks | both plan sources, manifest, catalog, verified references | resolved plan, resolutions, specs, dependencies, write sets | **[built]** |
| L2 Component Builder | **agent** | ai | a spec, DS conventions | files inside the declared write set | **[built]** |
| L2b Integrate | stage | deterministic | declared shared changes | barrels, tokens, regenerated safelist | **[built]** |
| L3 Component Verifier | **agent** | hybrid | branch, specs, references | DS checks, acceptance results, vision verdict | **[built]** |
| L4 Preview | stage | deterministic | integrated tree, page session | preview sheets, in-context page | **[built]** |
| L5 Publish | stage | deterministic, gated | the approved package | commit; after approval, push and PR record | **[built]** |

Shared skills and tools are listed in §3.3.

---

## 13. Output contracts

One working folder per run. The source audit is preserved in place and referenced by path and hash; nothing is copied out of it.

```
projects/<project-slug>/
  project.json
  redesigns/<sourceRunId>-<runType>-<UTC stamp>/
    run.json  session-state.json  decisions.json  handoff.md  trace.jsonl
    context/
      context.json          every input: path, role, sha256, read-at, the user's original reference
      mapping.json          element-keyed: stamps, findingIds, checks, confidence, drift, affordances, DS reference
      conflicts.json        every recorded conflict and how it was surfaced
      capture.json          the capture fingerprint: DOM, stylesheets, fonts, assets, viewport, policy
    original.html  before.png  before-tiles/  components/<elementId>-before.png
    redesign.html  redesign-content.html  sections/<sectionId>.html
    after.png  after-tiles/  components/<elementId>-after.png
    redesign-plan.json  validation-results.json  export-validation.json  change-list.md
    review/
      component-manifest.json  component-review.html  component-selection.json  review-index.html
    library/
      component-plan.resolved.json  resolution.json  specs/<component>.json
      build.json  acceptance.json  previews/<component>.html|.png
      in-context/redesign-with-components.html
      package.json  package-validation.json  publish.json
```

| Path | `redesign` | `components` | `combined` |
|---|---|---|---|
| `run.json`, `session-state.json`, `decisions.json`, `handoff.md`, `trace.jsonl`, `context/*` | ✓ | ✓ | ✓ |
| `original.html`, `before.png`, before tiles, before crops | ✓ | ✓ (reference only) | ✓ |
| `redesign*.html`, `sections/*`, after images, `redesign-plan.json`, `validation-results.json`, `export-validation.json`, `change-list.md` | ✓ | — | ✓ |
| `review/component-manifest.json` | ✓ | ✓ | ✓ |
| `review/component-review.html`, `component-selection.json`, `review-index.html` | ✓ | ✓ | ✓ |
| `library/*` | — | ✓ | ✓ |
| `library/publish.json` | — | only after push approval | only after push approval |

| Format | Rule |
|---|---|
| JSON | every file carries `schemaVersion` and is validated on read; fields are added, never repurposed |
| HTML | zero network; stylesheets, fonts and media inlined; opens from the filesystem; stamps documented in the manifest so a consumer can strip them |
| PNG | CSS pixels at the recorded viewport |
| JSON Lines | one span per line |
| Markdown | regenerated, human-readable, never a source of truth |

---

## 14. Structurally out of scope

Workflow A writes only its run folder and mutates only an ephemeral browser context reached by read-only navigation. Workflow B writes only a local branch of the DS repo, only files a spec declares, with shared files touched exclusively by the deterministic integration step. Publishing commits exactly the approved package and at most opens a pull request; it never merges and never deploys. No node holds a path to the target website's hosting or source. audit-agent's tree, database and published artifacts are never written, and its run files are never copied here.

---

## 15. Earlier conflicting requirements, resolved

| Conflict | Resolution |
|---|---|
| "stops at the selection export" vs. a connected component workflow with push | Workflow B is part of this architecture; G3 remains a valid stopping point, and a later session resumes at L1 |
| this repo's checklist export vs. the audit report's own component plan sharing a name | the upstream file keeps its name and shape; this repo's export is named differently; L1 merges both with provenance |
| header and footer "applied but excluded" vs. "handled separately" | never edited in Workflow A; routed to Workflow B; shown unmodified in the QA document only |
| "the site's source is never touched" vs. source access | the page workflow stays snapshot-based; source access exists only for the DS repo, on a local branch; a site-source mode is deferred |
| "a separate agent in a new session" vs. "within the same architecture" | one repo, one architecture, separate workflows and output subtrees; every gate is a valid session boundary |
| a fixed agent count vs. "minimum necessary" | roles are derived from judgment points; six is the result, and §3.2 states why no seventh exists |
| an earlier "no checkpoint need" decision vs. gates | the no-engine-fork reasoning stands; the no-checkpoint clause is superseded by file checkpoints |
| a proposed `page/` subfolder vs. the implemented paths | page artifacts stay where the implemented store puts them; only additions |
| global source ranking vs. authority by concern | replaced: each source is authoritative for its own concern only, and conflicts are recorded |
| model confidence as a mapping authorization | replaced: objective checks authorize; the model may only propose among candidates that already pass |
| selection treated as approval | never: selection authorizes preparation only |

---

## 16. Gaps and recommended defaults

| Gap | Default |
|---|---|
| the upstream component plan has no import command | this repo validates it with its own read-side schema; if an import appears upstream, its normalised output is accepted unchanged |
| partial DS matching in audits without a model | proceed with confidence and basis shown; recommend a model-mode re-audit only when the unresolved share exceeds a configured threshold |
| section identity | audit section names, cross-checked against landmarks, disagreements shown at G1 |
| interaction states | observe affordances; capture no synthetic states unless configured; label everything else missing or proposed |
| viewports | the audit's viewport by default; more only when configured, and non-captured viewports yield proposed results |
| parallel builds | concurrency 2; write sets declared; shared files only in the integration step |
| browser concurrency | must be enforced by the pool before parallel rendering |
| preview surface | zero-server HTML and PNG; the DS's story tooling used inside verification, not as the review surface |
| approval recording | a command with fingerprints; the review surface only exports selections |
| publishing tooling | the GitHub CLI when installed, otherwise the REST API with a token from the environment; only after approval |
| component naming | derived from the audit's component type through a DS-convention map; ask when two categories fit |
| the session skill's stale text | rewrite alongside this document |

---

## 17. Build sequence

| Step | Scope | State |
|---|---|---|
| 1 | foundation: toolchain, config, vendored modules, `audit-link`, **R1**, orchestrator, output store, tracing, LLM client, R3/R5 schemas, the outcome rule, tests | **done, R1 verified live** |
| 2 | contracts: run types, scope, element-keyed mapping, manifest, component-plan schemas, decision and checkpoint store with fingerprints, output paths, run-outcome model | **done** |
| 3 | S0 open and resume, project and session state, G0, G1, the decision command, skill rewrite | **done** |
| 4 | **R2** capture and fingerprint; **C2** inspect, map, stamp, drift, DS reference; **R4** apply and edit log; **R3** prompt, chunking, the no-mismatch branch; **R5** measurement tiers | **done** |
| 5 | **R6** manifest, suggestions, cross-run evidence; **R7** exports, CSS isolation, export validation, change list, review surface; G2, G3 | **done** |
| 6 | **L1** merge, resolution, references, specs, dependencies, write sets; **L2** builder; **L2b** integrate; **L3** verify and acceptance checks; **L4** previews; G4 | **done** |
| 7 | package assembly and revalidation; **L5** commit; push and pull request behind approval | **done locally (commit + blob-hash re-verification); push/PR code exists but is untested against a real remote — still needs §19.1** |
| 8 | end-to-end tests across all three run types, including resume from every gate | **done at the orchestrator level (mocked nodes, real gate/resume/session-lifecycle semantics); per-node real-browser integration tests done for each node individually; no single test wires every real node together through a live capture — deliberately: doing that against the actual target site would mean navigating production, which this build avoided (see §14)** |
| — | outside this repo: audit-agent commits its work; optionally adds an import for its component plan | pending upstream |

---

## 18. Verification

- **Mapping** — one fixture per drift class and per confidence class; many findings resolving to one element; a conflicting pair on one element escalating; a model proposal that fails an objective check never reaching `probable`.
- **Freshness and resume** — the capture fingerprint changing in DOM, in a stylesheet, in a font and in an asset, each independently preventing replay; mappings revalidated before replay; a DS change flagging `expectation-changed` and invalidating the covering approval.
- **Exports** — the header and footer absent; stamps unique; zero network; and rendered parity between the export and the live post-edit page, including a deliberately broken isolation case that must fail.
- **Workflow B** — write-set violation rejected without failing the batch; overlapping write sets serialised deterministically; barrels and safelist produced only by integration; a blocked dependency reported, never built around.
- **Approvals** — rebuilding one component of several invalidating only its own approvals; a rendering-affecting shared change invalidating dependent design approvals while a wiring-only change does not; the combined approval binding the same fingerprints as the separate path; publish refusing on any mismatch.
- **Outcomes** — a combined run with one blocked component never reported as complete; each run type's output contract asserted; a component-only run with no plan reporting both paths checked.
- **Boundary** — audit-agent's tree byte-for-byte unchanged before and after every run; the DS working tree unchanged outside the branch.

---

## 19. Remaining user decisions

1. **Which repository, remote and base branch hold the Design System.** It is a plain folder today with no git history, and the GitHub CLI is not installed. Everything up to a local commit is unaffected; publishing cannot exist until this is settled.
2. **Whether to re-audit in model mode before component work** when a large share of patterns resolve as unresolved. This is a cost decision; the default is to proceed with confidence and basis shown.

Everything else has a recommended default in §16 and needs no decision to begin.

---

## Decision log

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | repo location and toolchain | standalone sibling; own git; Node ≥ 24; dependencies pinned to the sibling's versions | a service, not a designed page; the other workspace pins an older engine; identical pins mean vendored code runs unmodified |
| 2 | configuration | schema-validated JSON plus per-field environment overrides | mirrors the sibling's proven mechanism; the one cross-repo idiom this ecosystem has is a configured absolute path |
| 3 | vendor versus shell out | vendor closed execution utilities verbatim with provenance headers; shell out for run resolution; never vendor the path layout | vendor what you must execute independently; ask the live owner for a query whose answer it evolves |
| 4 | tracing sink | JSON Lines beside the artifacts; no database | spans land next to what they explain; still standard spans |
| 5 | imaging | crop-planning vendored; marker remapping dropped; flatten written new | the planning half was filed under its consumer; the flatten step never existed |
| 6 | reading upstream artifacts | read-side schema copies, permissive at the envelope | additive upstream fields pass through; a removed field fails loudly naming the path |
| 7 | run-resolution contract | one JSON line on success; ambiguity and not-found are distinct non-zero exits | pinned at the consumer; **verified against the upstream implementation** |
| 8 | orchestrator shape | a plain ordered chain with bounded loops; no engine fork | no fan-out need; intra-run cycles are avoided by doctrine |
| 9 | iteration semantics | edits cumulative; each iteration sees the last plan and verdict; previous values recorded | the loop corrects itself; recorded values keep a revert possible |
| 10 | outcome rule | a pure function producing three distinct outcomes | distinct outcomes stay distinct; testable without a browser or a model |
| 11 | output tree | one folder per run, hashes of every source recorded | trees align by name without co-locating files; hashes prove read-never-written |
| 12 | stubs | stubs fail loudly; the CLI refuses and names them | never fake success |
| 13 | model access | the planner and verifier require a credential; the dry run never does | planning from free text needs judgment |
| 14 | trust boundary on plans | validated again on read regardless of location | location never implies correctness |
| 15 | two plan inputs | both are sparse, human-authored sidecars validated in place | one reviewer mental model; no server |
| 16 | the component review node | deterministic, after the loop, runs even on a partial page | its inputs and outputs are independent of the page verdict |
| 17 | component boundaries | re-located on the live page and stamped as the result of mapping | upstream persists no selectors; stamping makes boundaries recoverable without affecting captures |
| 18 | global header and footer | never edited in the page workflow; routed to the component workflow; every exclusion listed | separate handling is routing, not deletion |
| 19 | design modes | two modes as a recorded scope object; section identity from the audit's own names | the audit already names the sections the reviewer thinks in |
| 20 | session startup | many reference forms, marker-file classification, exact match proceeds and everything else asks | never guess; a new session must reach the same state from whatever the user has |
| 21 | gates and resume | gates are persisted pauses, never auto-approved, never timed out | files suffice because every stage's output is a file |
| 22 | where the component workflow writes | a local branch only; publishing exclusively behind approval | the no-push rule becomes structural |
| 23 | cross-run evidence | read-only over other runs via the documented layout, matched strongest-basis-first, always showing the basis | the only source of shared-across-pages evidence |
| 24 | suggestions | a pure decision table with rule ids and confidence; unresolved is legitimate; the human's selection overrides and disagreement is flagged | the checklist must show its reasoning |
| 25 | registry re-baseline | recomputed after any DS change and recorded everywhere it is used | a build must be visible as a baseline change, never as a page regression |
| 26 | two component-plan sources | the upstream file supported as exported; this repo's export named differently; merged with provenance; disagreement asks | a colliding name would corrupt one or the other |
| 27 | output paths | page artifacts stay where the implemented store puts them; everything else is additive | additive must also hold for implemented code |
| 28 | approval fingerprints | every approval records exactly what was approved; identical recomputation reuses it; any difference re-asks | one rule seen from two sides |
| 29 | findings with no measurable mismatch | property edits, then rule-driven edits, then a DS target, then an ask; never silently skipped | real plans mark undecidable findings; ignoring them would report success on nothing |
| 30 | retry limits | the normative table in §7.5 | bounded everywhere; authentication failures never retried |
| 31 | agent structure | derived from judgment points | minimum necessary is a derivation, not a number |
| 32 | workflow location | one repo, separate node groups, output subtrees and branch; a session boundary at selection | shares the manifest, loader, browser and tracing |
| 33 | **authority by concern** | each source authoritative only for its own concern; conflicts recorded; an approved expectation never silently changed | a global ranking made the live page override historical findings, and let a DS change quietly move what a reviewer approved |
| 34 | **objective mapping checks** | geometry, identity, text, class fingerprint and uniqueness authorize; the model may only propose among candidates that already pass; confidence alone never authorizes | a mis-mapped element edits the wrong thing invisibly, which is the worst failure this system can have |
| 35 | **many findings per element** | mapping is element-keyed with a finding list; conflicting demands on one property escalate | one element commonly carries several findings; a finding-keyed map would stamp the same element repeatedly and hide the conflict |
| 36 | **capture freshness** | a fingerprint over DOM, stylesheets, fonts and assets — not a DOM hash alone; upstream persists no hash anyway | a typography fix is meaningless if the font behind it changed |
| 37 | **resume revalidation** | freshness, then mappings, then DS dependencies, before any replay | replaying stale edits onto a changed page is silent corruption |
| 38 | **CSS isolation and export validation** | never lift a subtree; preserve cascade, conditional rules, fonts and sibling positions; prove it with a rendered-parity check against the live page | removing the header must not change how the rest renders, and only a parity check actually proves it |
| 39 | **shared files in the DS** | write sets declared; builds never touch shared files; one deterministic integration step owns barrels, tokens and the generated safelist | barrels use explicit named exports and the safelist is a generated whole-file rewrite — concurrent builds would collide on both |
| 40 | **approved-only package** | assembled from approved components only, then revalidated as a package; rendering-affecting shared changes invalidate dependent design approvals, wiring-only changes do not | per-component approval does not prove the integrated set builds, and a shared change can alter an approved appearance |
| 41 | **combined approval** | binds exactly the fingerprints the separate path binds, offered only when the destination and package are known | a combined action must not be a weaker promise than two separate ones |
| 42 | **acceptance checks** | minimum checks for responsive layout, applicable states, keyboard and accessibility, each labelled observed, missing-evidence or proposed; any proposal in a required area prevents a pass | a component built from a single desktop snapshot has invented behaviour, and that must be visible rather than assumed |
| 43 | **run outcomes** | four unit states aggregated to a run status; complete only when every requested unit is done; the page verdict is a separate axis | a combined run that finished half its work is not complete, however well that half validated |
| 44 | **no overlap between the workflows** | the component workflow starts after the page approval | a mid-run DS change would shift the page workflow's baseline |
| 45 | **run types** | three, fixed at start and recorded in the run id; a missing input blocks only the half that needs it | component-only work is a first-class case, not a degraded redesign |
| 46 | **normal input is two lines** | `Project/Run: <name>` plus `Mode: Full Page \| Selected Sections`; every other reference form (Run ID, folder path, dashboard link) is a variant of `<name>`, not a separate top-level choice | a five-way "which kind of reference is this" question is friction the resolution algorithm can absorb by itself |
| 47 | **run type is inferred, not a third field** | `redesign` vs `combined` is decided by which component-plan inputs actually validate (§1.4); `components`-only stays a deliberate, separate command | the normal input already states intent (page work, some mode); asking a person to also declare "will there be component work" duplicates what the files already say |
| 48 | **automatic component queueing** | absent or empty plan source → skip; invalid → report; any source with ≥1 valid entry → auto-queue; an explicit request with nothing valid → blocked; suggestions never authorize | four distinguishable states were being collapsed into "is there a file or not" |
| 49 | **section scope: verified absent upstream, derived, then self-persisted** | checked both upstream schemas before writing this — neither stores a section selection; the candidate set is derived from `location.section` on authorized findings; this system's own `context/scope.json` remembers the resolved choice per run and re-asks only when the candidate set changes | claiming something is "already stored" when it is not would be worse than the extra question it was meant to save; the actual fix is deriving reliably and remembering the answer, not pretending an upstream field exists |
| 50 | **G0/G1 conditional, G2–G5 unconditional** | the two resolution gates skip when their answer is already unambiguous; the four approval gates never skip | a resolution question and a design or publish approval are not the same kind of gate, and only the first kind can ever be safely automatic |
| 51 | **judgment provider: `claude-session` default, no fallback** | C2/R3/R5/L2/L3's judgment is performed by the running Session Agent via a pending-bundle/checkpoint/submit cycle (§4a) — never an external model call, never a spawned `claude` process, never a silent fallback to `anthropic-api` on a hard judgment | the standing requirement was to run the complete workflow without a separate API credential or billing, using the Session Agent that is already authenticated; a silent API fallback would defeat that on the first case that felt hard |
| 52 | **`awaiting-judgment` is its own run-outcome axis, never `awaiting-approval`** | a pending judgment bundle checkpoints the run distinctly from a human gate pause, set directly by the orchestrator exactly as `awaiting-approval` sometimes already is (§7.7) | conflating "the Session Agent needs to act" with "a human needs to decide" would make `decide`'s gate semantics ambiguous and could route a role-performance step through the wrong CLI command |
