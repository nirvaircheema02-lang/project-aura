# Research References

54 authoritative sources the Audit Agent architecture's design choices are grounded in, cited inline in [`ARCHITECTURE.md`](ARCHITECTURE.md) as `#N`. Collected across 13 capability areas. Priority order throughout: official docs first, then production engineering references, then well-adopted open-source docs — nothing from tutorial/SEO sites.

Each entry: title — link — **relevant to:** the specific point used in the architecture. Entries marked "considered and not adopted/deferred" are kept deliberately, so it's clear what was evaluated and rejected, not just what was chosen.

### Graph orchestration & durable execution (4)
1. LangGraph — Durable Execution — https://docs.langchain.com/oss/python/langgraph/durable-execution — **relevant to:** the durability-scope decision (§2.2) — this is what full node-level checkpointing looks like; we compared it against and chose page-level restart instead.
2. LangGraph — Use the graph API (parallel/fan-out via `Send`) — https://docs.langchain.com/oss/python/langgraph/use-graph-api — **relevant to:** validates the fan-out/fan-in shape already in §2.1 (A3 → N parallel B → A4).
3. Temporal — Workflow Execution overview — https://docs.temporal.io/workflow-execution — **relevant to:** same comparison as #1, the alternative durable-execution model we chose not to adopt wholesale.
4. AWS Step Functions — Callback with Task Token — https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html#connect-wait-token — **relevant to:** source of the gate-timeout/`HeartbeatSeconds` behavior added to Scope/Publish/Failure gates (§4.2).

### Human-in-the-loop gates (4)
5. LangGraph — Interrupts — https://docs.langchain.com/oss/python/langgraph/interrupts — **relevant to:** validates the `gate` edge type / pause-resume design already used for all three gates (§4.2).
6. Temporal — Sending Signals, Queries & Updates — https://docs.temporal.io/sending-messages — **relevant to:** same pattern family as #5 — confirms async human-input-into-a-waiting-run is a standard design, not a workaround.
7. Temporal — Human-in-the-loop AI agent (cookbook) — https://docs.temporal.io/ai/cookbook/human-in-the-loop-python — **relevant to:** worked end-to-end example matching our gate design.
8. AWS — Amazon Augmented AI (A2I) human review loops — https://docs.aws.amazon.com/sagemaker/latest/dg/a2i-use-augmented-ai-a2i-human-review-loops.html — **relevant to:** two decisions — gate-timeout SLA behavior (§4.2) and the lightweight-sampling confidence policy (§3/S8: sampling even HIGH-confidence auto-proceeds, not just escalations).

### Retry, backoff, circuit breaking (4)
9. Exponential Backoff and Jitter — AWS Architecture Blog — https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ — **relevant to:** directly why jitter is in the §2.4 retry table — without it, N parallel B instances hitting the same failure retry in lockstep (thundering herd).
10. Addressing Cascading Failures — Google SRE Book — https://sre.google/sre-book/addressing-cascading-failures/ — **relevant to:** backs the Failure Threshold Gate's whole premise — stop retrying into a systemic failure instead of amplifying it.
11. CircuitBreaker — Martin Fowler — https://martinfowler.com/bliki/CircuitBreaker.html — **relevant to:** source of the half-open auto-retry design added to the Failure Threshold Gate (§2.4, Decision Log #4).
12. Circuit Breaker pattern — Azure Architecture Center — https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker — **relevant to:** same as #11 — formalizes the half-open state semantics actually used.

### Idempotency & concurrency-safe shared state (7)
13. Idempotent requests — Stripe API Docs — https://docs.stripe.com/api/idempotent_requests — **relevant to:** source of the idempotency-key pattern behind §2.5 rule 4 (dedup-on-write, cache-and-replay for deterministic nodes).
14. Designing robust and predictable APIs with idempotency — Stripe Engineering — https://stripe.com/blog/idempotency — **relevant to:** rationale behind #13 — informed the decision to let AI nodes re-run fresh instead of forcing blind replay of a possibly-bad attempt.
15. REL04-BP04 Make mutating operations idempotent — AWS Well-Architected Framework — https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_prevent_interaction_failure_idempotent.html — **relevant to:** validates idempotent-mutating-operation design generally; backs §2.5 rules 4 and 5.
16. Azure API Guidelines — Repeatable Requests — https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md — **relevant to:** source of the composite-key namespacing pattern (§2.5 rule 1) and the run-level `(url, mode)` guard (§2.5 rule 6).
17. Redis — INCR — https://redis.io/docs/latest/commands/incr/ — **relevant to:** one option for atomic `fan_out` counter increments (§2.5 rule 2).
18. PostgreSQL — UPDATE ... RETURNING — https://www.postgresql.org/docs/current/sql-update.html — **relevant to:** alternative atomic-counter mechanism, same rule.
19. DynamoDB — atomic counter operations — https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/example_dynamodb_Scenario_AtomicCounterOperations_section.html — **relevant to:** same rule — its documented hot-partition warning is specifically why the append-only-log alternative is offered alongside a plain shared counter.

### Content-addressed hashing / dedup (4)
20. Git Internals — Git Objects — https://git-scm.com/book/en/v2/Git-Internals-Git-Objects — **relevant to:** canonical worked example behind the Registry Candidate dedup signature (§2.5 rule 3).
21. IPFS — Content Addressing / CIDs — https://docs.ipfs.tech/concepts/content-addressing/ — **relevant to:** second canonical reference for the same content-addressing principle.
22. Python `hashlib` — https://docs.python.org/3/library/hashlib.html — **relevant to:** concrete implementation primitive for the stable signature, paired with canonical sorted-key serialization.
23. `object-hash` (npm) — https://www.npmjs.com/package/object-hash — **relevant to:** same, Node/TS implementation option, with an explicit hash-stability contract.

### Web crawling & extraction — Playwright (4)
24. Playwright — Actionability — https://playwright.dev/docs/actionability — **relevant to:** reliability of B1 Page Analyzer / T-layer crawling against production pages (auto-wait behavior).
25. Playwright — Evaluating JavaScript — https://playwright.dev/docs/evaluating — **relevant to:** the sanctioned computed-style extraction mechanism B4's token comparator depends on.
26. Playwright — Screenshots — https://playwright.dev/docs/screenshots — **relevant to:** mechanism behind B5 Visual Verifier's evidence capture.
27. Playwright — Browser Contexts — https://playwright.dev/docs/browser-contexts — **relevant to:** directly informs per-instance browser isolation (§2.7) — each parallel B instance gets its own context, no state leakage.

### Reading the Design System — Figma REST API (4)
28. Figma — File Endpoints — https://developers.figma.com/docs/rest-api/file-endpoints/ — **relevant to:** candidate read path for D1/D2 if the DS source is ever Figma-backed directly (currently D3 reads via Style Dictionary instead — see §6, Repository & Design System access).
29. Figma — Variables (Local) Endpoint — https://developers.figma.com/docs/rest-api/variables-endpoints/ — **relevant to:** same, specifically for D3 Tokens if Figma-direct reading is chosen over the DTCG file later.
30. Figma — Component Types — https://developers.figma.com/docs/rest-api/component-types — **relevant to:** same family — how D4 Components/Variants would be parsed if read via the Figma API.
31. Figma — Rate Limits — https://developers.figma.com/docs/rest-api/rate-limits — **relevant to:** directly informs the "cache D once per run" decision (§2.2) — avoids repeated polling from N parallel B instances.

### Publishing the audit — Figma Plugin API (6)
32. Figma Plugin API — root — https://developers.figma.com/docs/plugins/api/figma/ — **relevant to:** entry point for all of C3's node-creation/mutation calls.
33. Figma — `createFrame` — https://developers.figma.com/docs/plugins/api/properties/figma-createframe/ — **relevant to:** how C3 lays out each audit report page; also cited for the idempotent-write extension to Figma (§2.5 rule 5 — avoiding duplicate frames on re-publish).
34. Figma — Working with Images — https://developers.figma.com/docs/plugins/working-with-images — **relevant to:** how C3 turns B5's captured screenshots into Figma image fills.
35. Figma — `createImageAsync` — https://developers.figma.com/docs/plugins/api/properties/figma-createimageasync/ — **relevant to:** same, the specific API call C3 uses.
36. Figma — Annotations (`figma.annotations`) — https://developers.figma.com/docs/plugins/api/figma-annotations/ — **relevant to:** mechanism for C3's numbered issue markers (v1.0 §16); also the other citation for §2.5 rule 5.
37. Figma — Annotation reference — https://developers.figma.com/docs/plugins/api/Annotation/ — **relevant to:** same, the data-shape reference C3 needs for annotation records.

### Design-token / compliance tooling (4)
38. Style Dictionary — https://styledictionary.com/ — **relevant to:** directly why D3 Tokens reuses the Design System's existing pipeline instead of a separate schema (Decision Log #3).
39. Style Dictionary — Design Tokens concept — https://styledictionary.com/info/tokens/ — **relevant to:** same decision — the token-structure model D3 aligns to.
40. Knapsack Documentation — https://docs.knapsack.cloud/ — **relevant to:** considered as a reference for design/code consistency-check workflows relevant to B4's approach; not adopted, kept as context only.
41. Backlight Documentation — https://backlight.dev/docs/ — **relevant to:** same, an alternate reference considered and not adopted.

### Visual regression (3)
42. Playwright — Visual Comparisons (`toHaveScreenshot`) — https://playwright.dev/docs/test-snapshots — **relevant to:** considered for the §4.4 memoization signal (visual-diff pre-filter); explicitly deferred (Decision Log #7) — DOM-hash only for now.
43. Percy by BrowserStack — https://www.browserstack.com/docs/percy — **relevant to:** same, considered and deferred alongside #42.
44. Chromatic — https://docs.chromatic.com/docs/visual/ — **relevant to:** same, considered and deferred.

### Execution tracing — OpenTelemetry (4)
45. OpenTelemetry — Traces (concepts) — https://opentelemetry.io/docs/concepts/signals/traces/ — **relevant to:** core trace/span model adopted for §2.6 Execution Tracing instead of a bespoke log schema.
46. OpenTelemetry — Trace Semantic Conventions — https://opentelemetry.io/docs/specs/semconv/general/trace/ — **relevant to:** same — the standardized attribute-naming §2.6 adopts.
47. OpenTelemetry — Semantic Conventions for Generative AI — https://opentelemetry.io/docs/specs/semconv/gen-ai/ — **relevant to:** specifically why OTel was chosen over a custom schema — purpose-built for tracing AI/LLM nodes like B1–B6.
48. "OpenTelemetry for Generative AI" (project writeup) — https://opentelemetry.io/blog/2024/otel-generative-ai/ — **relevant to:** rationale backing #47's adoption.

### Structured reporting — Excel (3)
49. openpyxl Tutorial — https://openpyxl.readthedocs.io/en/stable/tutorial.html — **relevant to:** implementation option for C1 Excel Reporter's multi-tab workbook (v1.0 §15), Python ecosystem.
50. SheetJS — docs home — https://docs.sheetjs.com/ — **relevant to:** same, JS/TS ecosystem alternative for C1.
51. SheetJS — Writing Files — https://docs.sheetjs.com/docs/api/write-options/ — **relevant to:** same, the specific multi-sheet workbook API C1 would use.

### Confidence scoring & calibration (3, plus #8 above shared with this area)
52. "On Calibration of Modern Neural Networks" (Guo et al., ICML 2017) — https://arxiv.org/abs/1706.04599 — **relevant to:** directly why the confidence-sampling policy exists (§3, S8) — raw model confidence can't be trusted as a true probability without validation.
53. Anthropic — Structured Outputs — https://platform.claude.com/docs/en/build-with-claude/structured-outputs — **relevant to:** mechanism for how B3/B5/B6 emit a schema-constrained `confidence` field in the first place.
54. OpenAI — Structured Model Outputs — https://developers.openai.com/api/docs/guides/structured-outputs — **relevant to:** same capability, alternate-vendor reference.

**Total: 54 distinct resources.**

**Gap noted during collection:** no authoritative turnkey "design-drift-detection" product exists beyond Style Dictionary/Knapsack/Backlight (#38–41) — not filled with weaker sources.
