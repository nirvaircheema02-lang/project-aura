import type { PublishPlan } from './publish-plan.ts';
import type { ProjectFile } from '../output/run-store.ts';

/**
 * The pinned, versioned layout contract (IMPLEMENTATION-PLAN.md §6). C3's
 * Figma write is an LLM-mediated tool call, so repeated runs only converge on
 * the same node structure if the instruction is fixed and versioned — without
 * this, "no duplicate frames" (§2.5 rule 5) is best-effort rather than
 * guaranteed.
 *
 * BUMP THE VERSION whenever the instruction OR the plan's content format changes (how a
 * value is written into a card — e.g. the `2.441rem (39.06px)` rule, src/output/
 * display-values.ts): the version is recorded with the run, so a difference between two
 * runs is attributable to a contract change rather than mistaken for drift.
 */
export const FIGMA_CONTRACT_VERSION = 'figma-layout-v6'; // v6: the 00 Overview page carries B7's Coverage Gate as one more summary tile (`Coverage gate`: PASSED, or INCOMPLETE — N unaccounted; green / red / gray by its verdict) — one more tile in the existing row, no other change to the six-page structure, the cards or the markers. v5: an Expected typography value stored in rem is written with its resolved px beside it (`2.441rem (39.06px)`) in every plan string that quotes one — marker-card actual → expected bullets, a page card's actual-vs-expected, a root-cause card's "expected", recommendation / reason text — the px being the rem length × the page's MEASURED root font size (data.json pageSummary[].rootFontSizePx; the browser default only for a run that recorded none). Display formatting only (src/output/display-values.ts, shared with the HTML report and the Excel report): the layout, data.json, DS values and status are unchanged. v4: markerGroups also cover NEEDS_REVIEW/UNVERIFIED findings (AMBER/GRAY), not just INCORRECT/DEVIATION — v3 was PageAuditFrame.markerGroups, the curated, deduplicated interactive-marker set (Decision Log #32)

/**
 * LEGACY / INACTIVE PATH — do not extend. `buildPublishInstruction` below is the OLD headless
 * text-instruction publish mechanism. It is confirmed-failed (IMPLEMENTATION-PLAN.md §6 Spike 3:
 * headless Figma OAuth fails, explicitly out of scope for v1) and nothing in the CLI calls it.
 * The CURRENT supported path is `src/figma/publish-ops.ts`'s `buildFigmaOperationPlan` (a
 * structured, testable operation list) replayed by a live, Figma-MCP-authenticated session per
 * `docs/FIGMA-PUBLISH-RUNBOOK.md` — see that module and doc, not this one, for new work.
 *
 * `buildPublishInstruction` below targets the HEADLESS Claude Code publish path specifically —
 * text-only, no Figma MCP tool access, no way to screenshot-verify an image landed, which is
 * exactly why it still forbids image upload and still reads the flat per-finding `markers`/
 * `cards` (never `markerGroups`). The approved interactive-marker system (Default/Hover
 * components, real screenshots, `markerGroups`' curated root-cause set) is a LIVE, authenticated
 * Figma-MCP session's job — see docs/FIGMA-PUBLISH-RUNBOOK.md, which reads `markerGroups`
 * directly rather than going through this instruction-text generator at all.
 */

/** Constraints that come from the tool's own contract and from verified spike results — not preferences. */
export const HARD_CONSTRAINTS = [
  'NEVER call loadAllPagesAsync, setPluginData or createImageAsync — the use_figma tool documents them as unsupported.',
  'Use await figma.setCurrentPageAsync(page) to switch pages; never assign figma.currentPage.',
  'Call figma.listAvailableFontsAsync() once and fall back to Inter if Noto Serif / DM Sans are unavailable; record which was used.',
  'Return the ids of every node you create or mutate, keyed exactly as requested.',
  'Do not upload or place any image: screenshot delivery is deferred (see the plan\'s imageDelivery note). Create a labelled placeholder frame instead.',
] as const;

export interface PublishInstruction {
  contractVersion: string;
  system: string;
  prompt: string;
  /** Node ids known from previous publishes — present ids must be MUTATED, never recreated (§2.5 rule 5). */
  knownNodes: ProjectFile['figmaNodes'];
}

/**
 * Builds the exact instruction handed to the headless Claude Code run that
 * owns the Figma write. Deterministic: the same plan and the same known-node
 * map always produce the same text, which is what makes a republish idempotent.
 */
export function buildPublishInstruction(plan: PublishPlan, project: ProjectFile): PublishInstruction {
  const known = project.figmaNodes;
  const isRepublish = Object.keys(known.pages).length > 0;

  const pageSpecs = Object.entries(plan.pages)
    .map(([name, content]) => {
      const c = content as { tiles: Array<{ label: string; value: string }>; headers: string[]; rows: string[][] };
      const parts: string[] = [`## ${name}`];
      if (known.pages[name]) parts.push(`existing page node id: ${known.pages[name]} — MUTATE this page, do not create a new one`);
      if (c.tiles.length > 0) parts.push(`summary tiles: ${c.tiles.map((t) => `${t.label}=${t.value}`).join(' · ')}`);
      if (c.headers.length > 0) {
        const MAX_ROWS = 200;
        const shown = c.rows.slice(0, MAX_ROWS);
        const dropped = c.rows.length - shown.length;
        parts.push(
          `table headers: ${c.headers.join(' | ')}`,
          `rows (${shown.length} of ${c.rows.length}):`,
          ...shown.map((r) => `  ${r.join(' | ')}`),
        );
        // A page publishes exactly what's listed here — a silent cap would read as "covered
        // everything" when it didn't (third-pass review OUT-3).
        if (dropped > 0) parts.push(`  … ${dropped} more row(s) not published (table capped at ${MAX_ROWS} rows)`);
      }
      return parts.join('\n');
    })
    .join('\n\n');

  const auditSpecs = plan.pageAudits
    .map((p) => {
      const frameId = known.frames[p.key];
      return [
        `### Page audit: ${p.title}`,
        frameId ? `existing frame node id: ${frameId} — MUTATE it` : 'no existing frame — create one',
        `header: ${p.complianceLabel}`,
        `screenshot placeholder: ${p.screenshots.length} capture(s) pending delivery — label it "${plan.imageDelivery.status}"`,
        `numbered markers (${p.markers.length}): ${p.markers.map((m) => `#${m.number} at x=${m.box.x},y=${m.box.y},w=${m.box.width},h=${m.box.height} (${m.severity})`).join('; ') || 'none'}`,
        `issue cards (${p.cards.length}):`,
        ...p.cards.map(
          (c) =>
            `  #${c.number} ${c.title} · ${c.status} · ${c.severity} · confidence ${c.confidence} · review ${c.reviewState}\n     actual vs expected: ${c.actualVsExpected.replace(/\n/g, ' | ')}\n     recommendation: ${c.recommendation}`,
        ),
      ].join('\n');
    })
    .join('\n\n');

  const system = [
    'You are publishing a Design System audit into Figma via the use_figma tool.',
    'You are a RENDERER, not an auditor: publish exactly the values given. Never recompute, re-judge, re-word or omit a finding.',
    `Layout contract: ${plan.contractVersion}. The same contract must always produce the same node structure.`,
    ...HARD_CONSTRAINTS.map((c) => `- ${c}`),
  ].join('\n');

  const prompt = [
    `Figma file: ${project.figmaFileKey ?? '(none yet — create one in the configured team/project first)'}`,
    `Run: ${plan.runId} · target ${plan.targetUrl} · DS version ${plan.dsRegistryVersion} · browser ${plan.renderingEngine}`,
    isRepublish
      ? 'This is a REPUBLISH. For every node id supplied below, resolve it with getNodeByIdAsync and mutate it in place. Only create a node when its id is absent or resolves to null (a human deleted it).'
      : 'This is the first publish for this project. Create the pages below and return every created node id.',
    '',
    `Create/update exactly these pages, in this order: ${Object.keys(plan.pages).join(', ')}.`,
    '',
    pageSpecs,
    '',
    '## 03 Page Audits — frames',
    auditSpecs || '(no page audits)',
    '',
    `Image delivery: ${plan.imageDelivery.note}`,
    '',
    'Return a JSON object mapping: pages{name->id}, frames{pageKey->id}, markers{findingId->id}.',
  ].join('\n');

  return { contractVersion: plan.contractVersion, system, prompt, knownNodes: known };
}

/**
 * Merges the node ids a publish returned back into the project's map, so the
 * NEXT run mutates the same nodes instead of duplicating them. Existing ids
 * are kept unless the publish reported a new one for that key.
 */
export function mergePublishedNodes(project: ProjectFile, returned: Partial<ProjectFile['figmaNodes']>): ProjectFile {
  return {
    ...project,
    figmaNodes: {
      pages: { ...project.figmaNodes.pages, ...(returned.pages ?? {}) },
      frames: { ...project.figmaNodes.frames, ...(returned.frames ?? {}) },
      markers: { ...project.figmaNodes.markers, ...(returned.markers ?? {}) },
      imageHashes: { ...project.figmaNodes.imageHashes, ...(returned.imageHashes ?? {}) },
    },
  };
}
