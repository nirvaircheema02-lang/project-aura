import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { R7Output } from '../agents/types.ts';
import type { ComponentSpec, L2Output, L4Output } from '../library/types.ts';
import type { DesignMode } from '../session/types.ts';
import { renderComponentsIndexHtml, type OutputComponentEntry } from '../html/components-index.ts';
import {
  ensureNewComponentDir,
  ensureRedesignDeliverableDirs,
  newComponentDeliverableDir,
  redesignDeliverableSectionPath,
  sectionFragmentPath,
  type RedesignPaths,
} from './redesign-store.ts';

/**
 * The two clean, user-facing deliverables — `redesign/` (Workflow A, driven by fix-plan.json)
 * and `new-component/` (Workflow B, driven by new-component-plan.json / the checklist export).
 * SIBLING folders directly under the run root, never nested in one another and never wrapped in
 * a shared parent. A packaging step, deliberately separate from R7 (page exports) and L4
 * (previews), which own the INTERNAL run tree — everything here is a COPY of already-produced,
 * already-validated artifacts; nothing is regenerated or re-derived. Internal JSON, PNG tiles,
 * traces and checkpoint files are never placed under either one.
 *
 * IMPORTANT, stated once here rather than at every call site: `redesign/` can only ever hold a
 * static HTML snapshot, never real React/Next.js source — that would require the target site's
 * own source repository, which this system does not have and does not touch (docs/ARCHITECTURE.md
 * §10, §14). `new-component/<Name>/` is different: it holds REAL, approved React/TypeScript
 * source, copied verbatim from the Design System branch (which remains the source of truth).
 */

export interface RedesignDeliverableResult {
  pageHtmlName: string;
  pageHtmlPath: string;
  sectionIds: string[];
}

/**
 * Copies Workflow A's already-self-contained export (§8.4: every stylesheet/font/image already
 * inlined — this module never touches CSS or asset handling itself) into `redesign/`. Full Page →
 * `redesigned-page.html`; Selected Sections → `redesigned-sections.html` PLUS one standalone file
 * per selected section, mirroring exactly the internal `sectionFragmentPath` this same
 * `sectionIds` list already produced at R7.
 */
/**
 * An HTML comment only — invisible, changes no layout/style/behavior — so the honest provenance
 * of this file travels with it even if it's opened later with no other explanation attached.
 * Never a claim this system doesn't stand behind: this really is everything that a live capture
 * + CSS isolation can produce, no more (docs/ARCHITECTURE.md §10).
 */
const SNAPSHOT_PROVENANCE_COMMENT =
  '<!-- Static HTML snapshot, not original React/Next.js source. Every stylesheet, font and image below is already inlined, so this file opens standalone. Script-driven behavior (hydration, client routing, JS-built menus, form submission, live data) does not run here — see docs/ARCHITECTURE.md §10. -->\n';

async function copyWithProvenanceComment(src: string, dest: string): Promise<void> {
  const html = await readFile(src, 'utf-8');
  await writeFile(dest, html.replace(/^(<!doctype html>)/i, `$1\n${SNAPSHOT_PROVENANCE_COMMENT}`));
}

export async function buildRedesignDeliverable(paths: RedesignPaths, mode: DesignMode, r7: Pick<R7Output, 'redesignContentHtml'>, sectionIds: string[]): Promise<RedesignDeliverableResult> {
  // Cleared first, not merely overwritten: a resume can shrink the selected-section set (or, in
  // principle, switch mode) since the last build — a stale section file left over from an
  // earlier invocation would otherwise silently survive (a deliverable must reflect exactly the
  // CURRENT set, the same rule §11.4 already holds components to).
  if (existsSync(paths.redesignDeliverableSectionsDir)) await rm(paths.redesignDeliverableSectionsDir, { recursive: true, force: true });
  await ensureRedesignDeliverableDirs(paths);
  const pageHtmlName = mode === 'selected-sections' ? 'redesigned-sections.html' : 'redesigned-page.html';
  const pageHtmlPath = join(paths.redesignDeliverableDir, pageHtmlName);
  await copyWithProvenanceComment(r7.redesignContentHtml, pageHtmlPath);

  const copiedSectionIds: string[] = [];
  if (mode === 'selected-sections') {
    for (const sectionId of sectionIds) {
      const src = sectionFragmentPath(paths, sectionId);
      // A section whose wrapper R7 couldn't locate (§8.2) never got a fragment written —
      // never assumed present; simply absent from the deliverable's section list too.
      if (!existsSync(src)) continue;
      await copyWithProvenanceComment(src, redesignDeliverableSectionPath(paths, sectionId));
      copiedSectionIds.push(sectionId);
    }
  }
  return { pageHtmlName, pageHtmlPath, sectionIds: copiedSectionIds };
}

function sanitizeComponentDirName(name: string, componentId: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, '');
  return cleaned || componentId;
}

export interface ComponentDeliverableResult {
  componentId: string;
  name: string;
  dirName: string;
  sourceFileNames: string[];
  hasPreview: boolean;
}

/**
 * Copies the EXACT approved component source files (§11.4's approved-only rule: only specs in
 * `approvedSpecs`, only builds that respected their write set — never a rejected or still-pending
 * one) into `new-component/<Name>/`, plus a portable copy of its L4 preview (the reference-crop
 * `file://` link L4 writes only works from inside this run's own tree, so it is rewritten to the
 * crop copied alongside it, or dropped outright when no crop actually exists — never left
 * pointing at an internal path). The Design System branch remains the untouched source of truth;
 * this only ever reads it, never writes back.
 */
export async function buildNewComponentDeliverable(paths: RedesignPaths, redesignRunId: string, approvedSpecs: ComponentSpec[], buildResults: L2Output[], l4Results: L4Output[], dsRepoPath: string): Promise<ComponentDeliverableResult[]> {
  // Cleared first, not merely added to: §11.4 rule 3 can shrink the approved set between two
  // invocations of the SAME run (a rebuild invalidates a prior G4 approval, or a rejected
  // component is dropped) — without this, that component's files from an earlier invocation
  // would silently keep sitting in the deliverable, violating "only the exact APPROVED files."
  if (existsSync(paths.newComponentDir)) await rm(paths.newComponentDir, { recursive: true, force: true });
  await ensureNewComponentDir(paths);
  const out: ComponentDeliverableResult[] = [];
  const usedDirNames = new Set<string>();

  for (const spec of approvedSpecs) {
    const build = buildResults.find((b) => b.componentId === spec.componentId);
    if (!build || !build.writeSetRespected) continue;

    // `name` is a display label, not guaranteed unique (two independently detected patterns can
    // both be called "Card"); `componentId` IS unique (§9.1) — used only to disambiguate a
    // collision, never in place of the readable name, so two approved components never overwrite
    // each other's folder.
    let dirName = sanitizeComponentDirName(spec.name, spec.componentId);
    if (usedDirNames.has(dirName)) dirName = `${dirName}-${spec.componentId.slice(-6)}`;
    usedDirNames.add(dirName);
    const destDir = newComponentDeliverableDir(paths, dirName);
    await mkdir(destDir, { recursive: true });

    const sourceFileNames: string[] = [];
    for (const relPath of build.filesWritten) {
      const abs = relPath.startsWith('/') ? relPath : join(dsRepoPath, relPath);
      if (!existsSync(abs)) continue;
      const name = basename(abs);
      await copyFile(abs, join(destDir, name));
      sourceFileNames.push(name);
    }

    const l4 = l4Results.find((l) => l.componentId === spec.componentId) ?? null;
    let hasPreview = false;
    if (l4 && existsSync(l4.previewHtmlPath)) {
      let html = await readFile(l4.previewHtmlPath, 'utf-8');
      const refPng = l4.previewPngPaths[0];
      const hasRealCrop = Boolean(refPng && existsSync(refPng));
      if (hasRealCrop) await copyFile(refPng!, join(destDir, 'reference.png'));
      // L4 embeds `<img src="file://<cropPath>">` whenever a cropPath STRING was recorded, even
      // when the actual capture failed and no file exists there (a documented non-fatal case,
      // §9.5) — `previewPngPaths` being empty is the only reliable signal of that. Never ship an
      // internal, absolute run-tree path either way: rewrite to the portable copy when one
      // exists, otherwise replace the broken image outright rather than leak the path unrewritten.
      html = html.replace(
        /<img[^>]*src="file:\/\/[^"]*"[^>]*>/,
        hasRealCrop ? '<img src="reference.png" alt="reference" style="max-width:400px;border:1px solid #ccc">' : '<p>(reference image unavailable)</p>',
      );
      await writeFile(join(destDir, 'preview.html'), html);
      hasPreview = true;
    }

    out.push({ componentId: spec.componentId, name: spec.name, dirName, sourceFileNames, hasPreview });
  }

  if (existsSync(paths.inContextHtml)) {
    await copyFile(paths.inContextHtml, paths.newComponentInContextHtml);
  }
  await writeFile(
    paths.newComponentIndexHtml,
    renderComponentsIndexHtml(
      redesignRunId,
      out.map((c): OutputComponentEntry => ({ name: c.name, componentId: c.componentId, dirName: c.dirName, sourceFileNames: c.sourceFileNames, hasPreview: c.hasPreview })),
      existsSync(paths.newComponentInContextHtml),
    ),
  );

  return out;
}
