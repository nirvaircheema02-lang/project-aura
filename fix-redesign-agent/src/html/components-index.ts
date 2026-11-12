/**
 * `new-component/index.html` — individual + in-context previews of the approved components in
 * the clean deliverable package (docs/ARCHITECTURE.md's packaging spec). Distinct from
 * `review/component-review.html` (§10a), which is the G3 selection surface.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface OutputComponentEntry {
  name: string;
  componentId: string;
  dirName: string;
  /** Basenames only (already copied into `dirName/`) — e.g. `Card.tsx`, `Card.stories.tsx`. */
  sourceFileNames: string[];
  /** `dirName/preview.html`, when L4 produced one. */
  hasPreview: boolean;
}

export function renderComponentsIndexHtml(redesignRunId: string, entries: OutputComponentEntry[], hasInContext: boolean): string {
  const cards = entries
    .map(
      (e) => `<section class="component">
  <h2>${escapeHtml(e.name)} <small>(${escapeHtml(e.componentId)})</small></h2>
  ${e.hasPreview ? `<iframe class="preview" src="${escapeHtml(e.dirName)}/preview.html" title="${escapeHtml(e.name)} preview"></iframe>` : '<p class="muted">(no preview)</p>'}
  <p class="files">Source: ${e.sourceFileNames.map((f) => `<a href="${escapeHtml(e.dirName)}/${escapeHtml(f)}">${escapeHtml(f)}</a>`).join(' · ') || '(none)'}</p>
</section>`,
    )
    .join('\n');

  return `<!doctype html><!-- components-index-v1 -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Components — ${escapeHtml(redesignRunId)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:1000px;margin:40px auto;padding:0 20px;color:#1a1a1a}
h1{font-size:22px}
.top-link{display:inline-block;margin:8px 0 20px;font-size:14px}
.component{border:1px solid #ddd;border-radius:8px;padding:16px 20px;margin:18px 0}
.component h2{margin-top:0;font-size:16px}
.component iframe.preview{width:100%;height:360px;border:1px solid #eee;border-radius:6px;background:#fff}
.muted{color:#888;font-size:13px}
.files{font-size:13px;margin-top:10px}
.files a{color:#b01f24}
</style>
</head><body>
<h1>Approved components (${entries.length})</h1>
${hasInContext ? '<a class="top-link" href="in-context.html">Open the in-context page preview →</a>' : ''}
${cards || '<p>No components approved yet.</p>'}
</body></html>`;
}
