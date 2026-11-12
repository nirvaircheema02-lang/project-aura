---
name: loop-build
description: |
  Run one full Loop Engineering cycle end-to-end — `/loop-build <project-name> <target-screen> <figma-url-or-"use chat image">`. Auto-bootstraps `projects/<project-name>/` if missing, then chains loop-analyzer → loop-builder → render → loop-visual-qa → fix → repeat → PASS (max 4 visual iterations), per `workflows/LOOP-ENGINEERING.md`. The user supplies only project name, target screen/component, and a Figma frame/node URL or a chat-attached image — no manual folders, no reference copying, no naming agents, no repeating workflow steps.

  Use when:
  - User types `/loop-build <project> <screen> <figma-url>` or `/loop-build <project> <screen>` with an image attached in the same message
  - User asks to "loop-build", "run Loop Mode on", "build this screen from Figma/this image with Loop Mode"

  Do NOT use for:
  - Standard Aura mode page/component builds (use `/page` or `aura-builder` directly — completely separate, unchanged system)
  - Design exploration / creative reinterpretation of a reference (Loop Mode is fidelity-only, not creative)

user-invocable: true
argument-hint: "<project-name> <target-screen> <figma-frame-url> | <project-name> <target-screen> (with image attached in chat)"
---

# /loop-build — one-shot Loop Engineering cycle

Reusable command for the **existing** Loop Engineering system (`loop-analyzer` · `loop-builder` · `loop-visual-qa` · `workflows/LOOP-ENGINEERING.md`, all added 2026-08-21). This skill does not introduce a new agent or a new workflow — it is the orchestration wrapper the main session already performs manually, made repeatable behind one command.

**Isolation:** this skill only ever touches `projects/<project-name>/` and the three `loop-*` agents. It never invokes `aura-builder`, `aura-qa`, `aura-mech`, `/page`, or `workflows/CANONICAL-WORKFLOW.md`. Standard Aura mode is untouched by this skill's existence or use.

---

## Argument format

```
/loop-build <project-name> <target-screen> <figma-url>
/loop-build <project-name> <target-screen>          (image attached in the same chat message)
```

- `<project-name>` — folder name under `projects/`. If it already exists, continue inside it (do not overwrite `references/`, `specs/`, `renders/`, `comparisons/`, `builds/` history). If it doesn't exist, create it with the standard Loop project structure (mirrors `projects/loop-engineering-project/`).
- `<target-screen>` — short id for the screen/component (e.g. `signin-modal`, `otp-step`). Used as the filename stem across `specs/`, `renders/`, `comparisons/`.
- Reference — exactly one of:
  - a Figma file/frame/node URL as the third argument, or
  - an image attached/pasted in the same chat turn (no URL argument needed)
  - (fallback, rarely needed) a local path, if neither of the above is available

If the user gives both a Figma URL and a chat image with no stated preference, prefer the Figma frame per `workflows/LOOP-ENGINEERING.md` §0.1. If neither is present, ask for one — do not guess or invent a placeholder reference.

If `/loop-build` is invoked with a `<project-name>` that already has a PASS-status `<target-screen>` comparison report, ask before re-running (avoid silently redoing finished work).

---

## Orchestration (auto-run, no user steps in between)

This mirrors `workflows/LOOP-ENGINEERING.md` §2 exactly — the skill exists only to remove the manual "now run X" prompting between steps.

1. **Resolve project folder.** `ls projects/<project-name>/`. If absent, create `PROJECT.md` + `references/ specs/ renders/ comparisons/ builds/` (template: `projects/loop-engineering-project/PROJECT.md` "New Loop project template" section).
2. **Resolve reference source** per the priority rule above. Record it — this becomes the metadata block every downstream agent reads.
3. **Spawn `loop-analyzer`** with: project path, target-screen id, resolved reference (Figma URL / chat image / local path). It writes `projects/<project-name>/specs/<target-screen>.spec.md`.
4. **Spawn `loop-builder`** (first build) with: the spec path + reference. It implements inside `projects/<project-name>/builds/`.
5. **Render** — start/refresh the Loop build's local dev server.
6. **Capture** — screenshot via the `webapp-testing` Playwright tooling into `projects/<project-name>/renders/<target-screen>.iterN.png`.
7. **Spawn `loop-visual-qa`** comparing the render against the same reference + spec. It writes `projects/<project-name>/comparisons/<target-screen>.report.iterN.md` with a PASS/FAIL verdict and P1/P2/P3 items.
8. **If PASS** → go to Report (below).
9. **If FAIL (P1/P2 remain)** → spawn `loop-builder` again with only that report, scoped to reported items. Increment iteration count.
10. **Repeat steps 5–9** until PASS or **4 visual iterations** are exhausted for this `<target-screen>`.
11. **If 4 iterations exhausted without PASS** → stop, do not keep looping. Report remaining P1/P2 items to the user and ask how to proceed (this is the one point the loop hands back to the user mid-cycle).

No confirmation gate between steps 1–10 — that's the point of the command. The only pauses are: missing reference (step 2), pre-existing PASS report (before step 1), and the 4-iteration cap (step 11).

---

## Report to user (on PASS or on cap-out)

```
→ Loop build: <project-name> / <target-screen>
→ Reference: <Figma frame/node URL | chat image | local path>
→ Iterations: <n> of 4
→ Verdict: PASS | STOPPED (cap reached, P1/P2 remain)

Spec:        projects/<project-name>/specs/<target-screen>.spec.md
Build:       projects/<project-name>/builds/
Last render: projects/<project-name>/renders/<target-screen>.iterN.png
Report:      projects/<project-name>/comparisons/<target-screen>.report.iterN.md

Remaining issues (if STOPPED):
- <P1/P2 item>
```

---

## Failure modes

| Failure | Handling |
|---|---|
| No Figma URL and no chat image given | Ask user for one — do not guess or fabricate a reference |
| Both Figma URL and chat image given, no preference stated | Prefer Figma frame/node (per LOOP-ENGINEERING.md §0.1) |
| Figma MCP unavailable this session | Tell the user Figma inspection can't run; offer chat-image or local-path fallback instead of silently guessing |
| Project folder exists with conflicting `<target-screen>` PASS already recorded | Ask before re-running that screen |
| 4 iterations exhausted, still FAIL | Stop, report remaining P1/P2s, ask user how to proceed — do not keep iterating |
| Dev server won't start for the Loop build | Report the failure, do not fake a render |

---

## Integration with existing system

- **Reads:** `workflows/LOOP-ENGINEERING.md` (the authoritative process this command automates)
- **Spawns:** `loop-analyzer`, `loop-builder`, `loop-visual-qa` — no new agents introduced
- **Writes only inside:** `projects/<project-name>/` (creating it if absent)
- **Never touches:** `aura-builder`, `aura-qa`, `aura-mech`, `workflows/CANONICAL-WORKFLOW.md`, `/page`, or any pre-existing `projects/*` folder

---

## Examples

### Figma reference
```
/loop-build ken-auth-redesign signin-modal https://www.figma.com/design/abc123/Ken-Auth?node-id=45-210
```

### Chat-image reference
```
/loop-build ken-auth-redesign signin-modal
```
(with the reference screenshot pasted/attached in the same message)
