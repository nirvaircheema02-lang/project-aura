# projects/

Empty until the first audit runs. Each audit target becomes a project here; each execution or re-audit becomes a run inside it. See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §6.

```
projects/<project-name>/
├── project.json          ← persists the Figma destination + target config (tracked in git)
│     { target_url, mode, figma_file_key, figma_file_url,
│       figma_team_plan_key, created_at }
└── runs/                 ← .gitignore'd (large binaries)
    └── <run_id>/
        ├── report.xlsx   ← mandatory deliverable — complete structured report
        ├── data.json     ← internal backing data only
        ├── screenshots/  ← backing data for Figma's visual pages
        └── history/      ← baselines re-audits diff against
```

The other mandatory deliverable — the Figma audit file — lives in Figma, not here; its key is in `project.json`, so every run of the same project updates the same file.
