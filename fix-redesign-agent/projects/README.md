# projects/ — Fix & Redesign Agent output tree

One folder per audited project (same slug audit-agent uses), one folder per redesign run:

```
projects/<project-slug>/redesigns/<redesignRunId>/
  redesign.html              the final standalone redesigned page (zero-network, assets embedded)
  before.png / after.png     composited full-page captures (tiles flattened; header band de-duplicated)
  before-tiles/ after-tiles/ the raw viewport tiles each composite was built from
  redesign-plan.json         R3's Zod-typed targeted-edit list — EVERY iteration's plan, not just the last
  validation-results.json    R5's per-finding + overall PASS / PARTIAL / FAIL, per iteration
  redesign-run.json          metadata + `sourceRun` back-reference into audit-agent (repo root, project, runId, data.json path + sha256)
  trace.jsonl                one OpenTelemetry span per (node, iteration) — the diagnostic trail
```

Nothing here is ever written into audit-agent's own `projects/` tree (ARCHITECTURE.md Q10/Q11).
`redesigns/` contents are gitignored, exactly as audit-agent ignores its `runs/`.
