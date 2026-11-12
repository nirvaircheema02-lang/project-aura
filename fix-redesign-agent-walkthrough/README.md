# Fix & Redesign Agent — Visual Walkthrough

Open `dist/index.html` directly in a browser. It is one self-contained, offline HTML file. Local preview: http://127.0.0.1:4312/ while the preview server is running.

This is documentation, not a redesign output. It does not invoke the agent, change a Fix Plan, approve a gate or publish anything. The agent's actual deliverable remains its generated React preview and runnable source.

Ten English chapters cover purpose, starting a session, connected workflows, the eleven active stages (including the RV Resolver), Fix JSON interpretation, shared resources and skills, persistent and locked design rules, verification, the Figma export, and output locations. Three SVG views show system context, Selected sections and Full page. They describe the file-backed state machine, the one-pass R3/R4/R5 loop and the single correction budget; they do not claim that this project uses Audit Agent's graph engine or runs parallel page workers.

Interactive examples explain correction outcomes, review decisions, geography options, dark-surface inputs and conflicting CTA expectations. The session builder creates a copyable prompt and safely quoted CLI examples from Run ID/Name and mode. These controls never execute commands.

The guide distinguishes active R6 component review from disabled L-series component building/publishing. It documents the RV Resolver and its resolved targets, deterministic judgments, the PASS / FAIL / INCOMPLETE status, the shared and per-project user style rules, and the limits of DOM component-swap edits.

## Sources and evidence

- Code inspected: 31 October 2026.
- Twenty-nine local source excerpts, each with its path, line offset and SHA-256, are embedded.
- Saved example: `cndp-survey-page-audit-v4-redesign-20261028-090140`.
- Its saved status is FAIL, 23 of 200 findings are reported measured verified, and the run is awaiting approval. The guide shows the failed and unverified counts and the first gaps; no saved result was re-verified while creating it.
- Configuration (including the pass limit, deterministic judgments and the correction budget) and design tokens are read from the actual Fix & Redesign Agent configuration.
- DM Sans is embedded locally, using the font asset already bundled in the Audit Agent walkthrough. UI styling reuses that walkthrough's Ken DS presentation conventions. No external font or network requests are required.

## Files

- `content.mjs`: chapter copy.
- `graphs.mjs`: accessible SVG system and mode diagrams.
- `app.js`: navigation, prompt builder and interactive explanations.
- `style.css`: existing walkthrough styles plus local layout rules.
- `guide.template.html`: HTML shell.
- `build.mjs`: embeds configuration, DS tokens, font, source excerpts and saved evidence.
- `verify.cjs`: browser interaction, text fit, responsive and offline checks.
- `verification.json`: latest successful browser verification.
- `dist/index.html`: movable/shareable standalone guide.

Build and check from this directory:

```sh
node build.mjs
node verify.cjs
```

The browser check reuses Playwright already installed in `../fix-redesign-agent/node_modules`. No dependency install is needed for the guide. Rebuilding updates the source snapshot and saved example; narrative should be reviewed if the implementation changes.

The agent's runtime files, audit inputs and the existing Audit Agent walkthrough were left unchanged.
