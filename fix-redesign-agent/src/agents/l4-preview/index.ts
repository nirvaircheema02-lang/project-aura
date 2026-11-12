import { copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AcceptanceResult, ComponentSpec, L4Output } from '../../library/types.ts';
import { componentPreviewHtmlPath } from '../../output/redesign-store.ts';
import type { RedesignPaths } from '../../output/redesign-store.ts';

/**
 * L4 — Preview (deterministic, §9.4, §10a). Per component: the evidence crop beside what
 * was actually probed, one view per state — a state never probed is labelled `proposed`,
 * never implied verified. In-context: reuses Workflow A's own `redesign-content.html` (R4's
 * component-swap edits already live there for anything actually swapped on the page) — see
 * L3's docblock for why a from-scratch isolated render of the generated `.tsx` is out of
 * this system's reach without the DS's own bundler running.
 */

export const L4_STATUS = 'implemented' as const;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function runL4(paths: RedesignPaths, spec: ComponentSpec, acceptance: AcceptanceResult[]): Promise<L4Output> {
  const rows = acceptance
    .map((a) => `<tr class="${a.evidenceClass}"><td>${escapeHtml(a.area)}</td><td>${escapeHtml(a.check)}</td><td>${a.passed ? '✓' : '✗'}</td><td>${escapeHtml(a.evidenceClass)}</td><td>${escapeHtml(a.detail)}</td></tr>`)
    .join('\n');
  const cropImg = spec.reference.cropPath ? `<img src="file://${spec.reference.cropPath}" alt="reference" style="max-width:400px;border:1px solid #ccc">` : '<p>(no reference crop)</p>';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(spec.name)} preview</title>
<style>body{font-family:system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 8px;font-size:13px}.proposed{background:#fff3cd}.missing-evidence{background:#f8d7da}</style>
</head><body>
<h1>${escapeHtml(spec.name)} <small>(${escapeHtml(spec.componentId)})</small></h1>
<p>Resolution: ${escapeHtml(spec.resolution)} · Category: ${escapeHtml(spec.category)} · Scope: ${escapeHtml(spec.scope)}${spec.scopeEvidenceMissing ? ' (reviewer-asserted, no cross-run evidence)' : ''}</p>
<p>Reference source: ${escapeHtml(spec.reference.source)}</p>
${cropImg}
<h2>States observed vs to be designed</h2>
<p>Observed: ${spec.statesObserved.map(escapeHtml).join(', ') || '(none)'}</p>
<p>To be designed (never implied verified): ${spec.statesToDesign.map(escapeHtml).join(', ') || '(none)'}</p>
<h2>Acceptance checks (§9.5)</h2>
<table><thead><tr><th>Area</th><th>Check</th><th>Passed</th><th>Evidence class</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
<p><strong>Note:</strong> this preview shows the reference evidence and the acceptance checks measured against the corrected live element. A from-scratch isolated render of the generated component code requires the Design System's own bundler/Storybook pipeline, which is not invoked automatically here (docs/ARCHITECTURE.md §9.4/§10).</p>
</body></html>`;

  const previewPath = componentPreviewHtmlPath(paths, spec.componentId);
  await writeFile(previewPath, html);

  const pngPaths: string[] = [];
  if (spec.reference.cropPath && existsSync(spec.reference.cropPath)) {
    const dest = previewPath.replace(/\.html$/, '-reference.png');
    await copyFile(spec.reference.cropPath, dest);
    pngPaths.push(dest);
  }

  const inContextExists = existsSync(paths.redesignContentHtml);
  if (inContextExists) await copyFile(paths.redesignContentHtml, paths.inContextHtml);

  return { componentId: spec.componentId, previewHtmlPath: previewPath, previewPngPaths: pngPaths, inContextRendered: inContextExists };
}
