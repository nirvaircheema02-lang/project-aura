import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/figma-export/prepare.mjs', import.meta.url));

export type FigmaExportResult = { ok: true; outDir: string; sections: number; chunks: number; images: number } | { ok: false; reason: string };

/**
 * Prepares `<run>/figma-export/` from the built React Preview (scripts/figma-export/prepare.mjs; REDESIGN_RULES.md "Figma export"). It reads the rendered page, so it must run
 * after the final preview build. It never throws: the Figma copy is an add-on to the preview, and a failure here must not change the run's outcome.
 */
export async function exportFigmaBundle(runDir: string, opts: { timeoutMs?: number } = {}): Promise<FigmaExportResult> {
  if (!existsSync(join(runDir, 'preview-app', 'dist', 'index.html'))) return { ok: false, reason: 'the built preview (preview-app/dist) is missing' };
  return await new Promise<FigmaExportResult>((resolve) => {
    execFile(process.execPath, [SCRIPT, runDir], { timeout: opts.timeoutMs ?? 300_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { resolve({ ok: false, reason: (stderr || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300) }); return; }
      try {
        const j = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { outDir: string; sections: number; chunks: unknown[]; images: number };
        resolve({ ok: true, outDir: j.outDir, sections: j.sections, chunks: j.chunks.length, images: j.images });
      } catch { resolve({ ok: false, reason: 'the export finished but its summary could not be read' }); }
    });
  });
}
