import { relative } from 'node:path';
import type { ComponentManifest } from '../manifest/schema.ts';
import type { RedesignPaths } from '../output/redesign-store.ts';
import type { IterationRecord, RedesignOutcome } from '../agents/types.ts';

/**
 * `review/review-index.html` — the ONE documented entry point for every review gate (§10a).
 * Organised by what each linked thing actually supports, stated explicitly, never implied.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rel(from: string, to: string): string {
  return relative(from, to);
}

export function renderReviewIndexHtml(paths: RedesignPaths, manifest: ComponentManifest, outcome: RedesignOutcome, iterations: IterationRecord[], sectionIds: string[]): string {
  const from = paths.reviewDir;
  const last = iterations.at(-1)?.validation;
  const failedChecks = last?.failedChecks ?? [];

  return `<!doctype html><!-- review-index-v1 -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review — ${escapeHtml(manifest.redesignRunId)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px}section{margin-bottom:32px}h2{border-bottom:1px solid #ccc;padding-bottom:4px}a{display:block;margin:4px 0}.status-${outcome.toLowerCase()}{font-weight:bold}</style>
</head><body>
<h1>Redesign run: ${escapeHtml(manifest.redesignRunId)}</h1>
<p>Run folder: <code>${escapeHtml(paths.runDir)}</code></p>
<p>Page verdict: <span class="status-${outcome.toLowerCase()}">${outcome}</span> after ${iterations.length} iteration(s)${failedChecks.length ? ` · ${failedChecks.length} failed check(s)` : ''}</p>

<section>
<h2>Page outputs</h2>
<p>A static rendering of the page's markup and styles at the recorded viewport. Native CSS-only affordances (hover, focus, &lt;details&gt;, form validation UI) work when opened directly. Script-driven behaviour — hydration, client navigation, JS-built menus, form submission, live data — does NOT run; this is a structural limit of the snapshot (docs/ARCHITECTURE.md §10), not a defect.</p>
<a href="${rel(from, paths.originalHtml)}">original.html — unmodified capture</a>
<a href="${rel(from, paths.redesignHtml)}">redesign.html — full page, edits applied (QA context, header/footer retained)</a>
<a href="${rel(from, paths.redesignContentHtml)}">redesign-content.html — the deliverable (header/footer removed)</a>
${sectionIds.map((id) => `<a href="${rel(from, paths.sectionsDir)}/${id}.html">sections/${id}.html</a>`).join('\n')}
<a href="${rel(from, paths.beforePng)}">before.png</a>
<a href="${rel(from, paths.afterPng)}">after.png</a>
</section>

<section>
<h2>Component review</h2>
<p>The checklist — one card per detected pattern, changed or not, with a suggestion and its reasoning.</p>
<a href="component-review.html">component-review.html</a>
<a href="component-manifest.json">component-manifest.json (raw)</a>
</section>

<section>
<h2>Component previews (Workflow B, once built)</h2>
<p>A LIVE render of each built/updated component in a real browser context, beside its evidence crop, one view per variant and state actually probed. A state shown here that was never probed is labelled "proposed" — never implied verified.</p>
<a href="${rel(from, paths.previewsDir)}/">library/previews/ (per component)</a>
<a href="${rel(from, paths.inContextHtml)}">library/in-context/redesign-with-components.html</a>
</section>

<section>
<h2>QA / validation results</h2>
<p>Pass or fail per check, per finding or per component, with every failure named — never a bare score.</p>
<a href="${rel(from, paths.validationResultsJson)}">validation-results.json</a>
<a href="${rel(from, paths.exportValidationJson)}">export-validation.json</a>
<a href="${rel(from, paths.changeListMd)}">change-list.md</a>
<a href="${rel(from, paths.acceptanceJson)}">library/acceptance.json (once built)</a>
<a href="${rel(from, paths.packageValidationJson)}">library/package-validation.json (once built)</a>
</section>
</body></html>`;
}
