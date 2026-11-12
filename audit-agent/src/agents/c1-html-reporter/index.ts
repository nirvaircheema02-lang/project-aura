import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { renderRun, evidenceRelativePath, type EvidenceResolver } from '../../dashboard/views/render.ts';
import { inspectEvidenceImage } from '../../output/evidence-image.ts';
import { writeZip } from '../../output/zip.ts';
import type { FixPlan } from '../../output/fix-plan.ts';
import type { AuditData } from '../c2-json-writer/index.ts';

/**
 * C1's HTML sibling: a self-contained, single-file rendering of the SAME data.json the
 * dashboard reads (renderRun, unchanged) — every evidence screenshot embedded as a data: URI
 * so the file survives being copied or shared on its own, with no dashboard server and no
 * external asset folder. C2 stays the sole source of truth: this writes no aggregate the
 * dashboard doesn't already compute from data.json.
 */

/** Past this size, a single HTML file becomes impractical to email/Slack/attach as one file. */
export const DEFAULT_ZIP_THRESHOLD_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Reads an evidence file once and returns a data: URI; missing files degrade to "no screenshot" (never a crash), matching the live dashboard's own handling of a gone file. */
function embeddedEvidenceResolver(): { resolve: EvidenceResolver; readErrors: string[] } {
  const cache = new Map<string, string | null>();
  const readErrors: string[] = [];
  const resolve: EvidenceResolver = (ref) => {
    const cached = cache.get(ref);
    if (cached !== undefined) return cached;
    let result: string | null;
    try {
      // Synchronous on purpose: renderRun calls this resolver interleaved with string-building
      // for potentially hundreds of findings — a synchronous read keeps that call sequential
      // and simple, and these are small element-crop screenshots, not full-page captures.
      const bytes = readFileSync(ref);
      const mime = MIME_BY_EXT[extname(ref).toLowerCase()] ?? 'image/png';
      result = `data:${mime};base64,${bytes.toString('base64')}`;
    } catch (err) {
      readErrors.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
      result = null;
    }
    cache.set(ref, result);
    return result;
  };
  return { resolve, readErrors };
}

export interface HtmlReportResult {
  htmlBytes: number;
  /** Absolute paths of evidence files whose bytes are embedded in report.html. */
  embeddedRefs: string[];
  /** Refs the resolver could not read (e.g. a screenshot deleted after the run) — reported, never silently dropped. */
  missingRefs: string[];
  /** Set only when the HTML exceeded the size threshold and a report-package.zip was written alongside it. */
  zipBytes: number | null;
}

export async function writeHtmlReport(
  paths: { reportHtml: string; reportPackageZip: string },
  projectName: string,
  data: AuditData,
  opts: { zipThresholdBytes?: number; fixPlan?: FixPlan } = {},
): Promise<HtmlReportResult> {
  const threshold = opts.zipThresholdBytes ?? DEFAULT_ZIP_THRESHOLD_BYTES;
  const usedRefs = new Set<string>();
  const { resolve, readErrors } = embeddedEvidenceResolver();

  // Evidence is chosen by what is visible in it (src/output/evidence-image.ts): a flat crop of a hidden
  // element yields to its context shot, and thumbnails show the content region, not a blank centre.
  const html = renderRun(projectName, data, resolve, usedRefs, opts.fixPlan, { inspectEvidence: inspectEvidenceImage });
  await writeFile(paths.reportHtml, html, 'utf-8');
  const htmlBytes = Buffer.byteLength(html, 'utf-8');

  let zipBytes: number | null = null;
  if (htmlBytes > threshold) {
    // Fallback for an oversized standalone file: the same render with real relative-path
    // assets instead of embedded ones, packaged with the actual files it references.
    // report.html (the embedded version above) remains the preferred output regardless.
    const packageHtml = renderRun(projectName, data, 'assets', undefined, opts.fixPlan, { inspectEvidence: inspectEvidenceImage });
    const entries: Array<{ name: string; data: Buffer; compress?: boolean }> = [{ name: 'report.html', data: Buffer.from(packageHtml, 'utf-8') }];
    for (const ref of usedRefs) {
      const rel = evidenceRelativePath(ref);
      if (!rel) continue;
      try {
        entries.push({ name: `assets/${rel}`, data: await readFile(ref), compress: false }); // already-compressed PNG/JPEG
      } catch {
        /* already recorded in readErrors via the embedding pass above — skip it in the zip too */
      }
    }
    await writeZip(paths.reportPackageZip, entries);
    zipBytes = Buffer.byteLength(await readFile(paths.reportPackageZip));
  }

  return { htmlBytes, embeddedRefs: [...usedRefs].filter((r) => !readErrors.some((e) => e.startsWith(`${r}:`))), missingRefs: readErrors, zipBytes };
}
