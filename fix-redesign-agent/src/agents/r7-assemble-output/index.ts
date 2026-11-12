import { readFile, writeFile } from 'node:fs/promises';
import { EXTRACTED_PROPERTIES } from '../../t-layer/computed-style.ts';
import { captureElement, withDeadline } from '../../t-layer/screenshot.ts';
import { openStandinPage, waitForStylesheets } from '../../html/temp-page.ts';
import { serializeStandaloneDocument } from '../../html/serialize.ts';
import { unselectedUntouchedOnPage, validateExport, type ExportExpectation, type ParityTarget } from '../../html/export-validate.ts';
import { renderReviewIndexHtml } from '../../html/review-index.ts';
import { STAMP_ATTR_SCOPE, STAMP_ATTR_SECTION } from '../../mapping/stamp.ts';
import { renderComponentReviewHtml } from '../../manifest/review-html.ts';
import { renderChangeListMd } from '../../output/change-list.ts';
import { componentCropPath, sectionFragmentPath, writeJsonFile } from '../../output/redesign-store.ts';
import { TerminalError } from '../../retry.ts';
import type { ExportValidationResult, R7Input, R7Output } from '../types.ts';

/**
 * R7 — Assemble & Validate (deterministic, §8.6). Re-locates stamps, captures after-crops,
 * serializes every export under §8.4's CSS-isolation rules, validates each under §8.5, then
 * writes the change list, the review checklist and the run's one documented entry point.
 */

export const R7_STATUS = 'implemented' as const;

export interface R7Deps {
  log?: (line: string) => void;
}

/** Hard per-crop deadline: one element that never settles must not park the whole assembly. */
const CROP_DEADLINE_MS = 25_000;

export async function runR7(deps: R7Deps, input: R7Input): Promise<R7Output> {
  const log = deps.log ?? (() => {});
  const { r1, session, iterations, outcome, manifest, paths, redesignRunId, mode, sectionIds } = input;
  const mapping = session.mapping;
  if (!mapping || !session.originalHtml) throw new TerminalError('R7: session.mapping/originalHtml is not set — C2 must run before R7.');

  const missingAssets: string[] = [];
  let embeddedAssets = 0;
  const unlocatedFindingIds: string[] = [];

  // 1. Re-verify every stamp still resolves on the live page (hydration re-renders can drop attributes, §7.6).
  for (const entry of mapping.entries) {
    const count = await session.page.locator(`[data-fra-element="${entry.element}"]`).count();
    if (count === 0) unlocatedFindingIds.push(...entry.findingIds);
  }
  if (unlocatedFindingIds.length > 0) log(`R7 · ${unlocatedFindingIds.length} finding(s) lost their stamp before assembly — reported, not guessed`);

  log(`R7 · step 1 done (${mapping.entries.length} stamps verified) — taking after-crops`);
  // 2. After-crops for every located element, from the LIVE (edited) page.
  let componentCrops = 0;
  for (const entry of mapping.entries) {
    if (unlocatedFindingIds.includes(entry.findingIds[0] ?? '')) continue;
    try {
      await withDeadline(captureElement(session.page.locator(`[data-fra-element="${entry.element}"]`).first(), componentCropPath(paths, entry.element, 'after')), CROP_DEADLINE_MS, `R7 after-crop ${entry.element}`);
      componentCrops++;
    } catch (e) {
      /* an off-canvas, zero-size or never-settling element — not fatal, just no after-crop for it */
      if (e instanceof Error && e.message.includes('no result within')) log(`R7 · ${e.message}`);
    }
  }

  log(`R7 · after-crops done (${componentCrops}) — opening the before page`);
  // 3. Before-crops + original.html + export validation's "before" baseline, all from a temp
  // page loaded with the PRE-EDIT originalHtml — the live page has since been mutated by R4.
  const beforePage = await openStandinPage(session.context, r1.targetUrl);
  const liveValuesForParity = new Map<string, Record<string, string>>();
  try {
    await beforePage.setContent(session.originalHtml, { waitUntil: 'domcontentloaded' });
    await waitForStylesheets(beforePage); // crops must show the page WITH its CSS
    await beforePage.setViewportSize(session.viewport);
    for (const entry of mapping.entries) {
      try {
        await withDeadline(captureElement(beforePage.locator(`[data-fra-element="${entry.element}"]`).first(), componentCropPath(paths, entry.element, 'before')), CROP_DEADLINE_MS, `R7 before-crop ${entry.element}`);
      } catch (e) {
        if (e instanceof Error && e.message.includes('no result within')) log(`R7 · ${e.message}`);
      }
    }
  } finally {
    await beforePage.close();
  }

  // 4. Serialize every export under §8.4's isolation rules.
  log('R7 · before-crops done — serializing original.html');
  const originalTemp = await openStandinPage(session.context, r1.targetUrl);
  let originalResult;
  try {
    await originalTemp.setContent(session.originalHtml, { waitUntil: 'domcontentloaded' });
    originalResult = await serializeStandaloneDocument(originalTemp, { excludeSelector: null });
  } finally {
    await originalTemp.close();
  }
  await writeFile(paths.originalHtml, originalResult.html);
  embeddedAssets += originalResult.embeddedAssets;
  missingAssets.push(...originalResult.missingAssets);

  log('R7 · original.html written — serializing redesign.html');
  const redesignResult = await serializeStandaloneDocument(session.page, { excludeSelector: null });
  await writeFile(paths.redesignHtml, redesignResult.html);
  embeddedAssets += redesignResult.embeddedAssets;
  missingAssets.push(...redesignResult.missingAssets);

  // Selected Sections: sections outside the resolved scope are marked data-fra-scope="unselected"
  // on the live page right before serialization so the content export can drop them (below).
  // Harmless to leave in place afterward: the per-section fragment loop matches by
  // data-fra-section only.
  if (mode === 'selected-sections') {
    await session.page.evaluate(
      ({ selectedIds, secAttr, scopeAttr }) => {
        for (const el of Array.from(document.querySelectorAll(`[${secAttr}]`))) {
          const id = el.getAttribute(secAttr);
          if (id && !selectedIds.includes(id) && el.getAttribute(scopeAttr) !== 'excluded') el.setAttribute(scopeAttr, 'unselected');
        }
      },
      { selectedIds: sectionIds, secAttr: STAMP_ATTR_SECTION, scopeAttr: STAMP_ATTR_SCOPE },
    );
  }
  // Selected Sections delivers only the selected sections (user-agreed rule, 2026-10-05): the
  // unselected ones are dropped from this file too, not merely marked.
  // The unselected sections are dropped from the content export below, so the "an unselected section must be
  // unmodified" guarantee is checked here against the live page, where they are still present.
  const unselectedEditFailures = mode === 'selected-sections' ? await unselectedUntouchedOnPage(session.page) : [];
  // The static content export is a reference snapshot (the React Preview is the deliverable): if it cannot be produced — e.g. the
  // structural safety check trips on a wrongly-sized excluded wrapper — the run continues and the failure is recorded in
  // export-validation.json and the log, never dropped silently.
  let contentResult: Awaited<ReturnType<typeof serializeStandaloneDocument>> | null = null;
  let contentExportError: string | null = null;
  try {
    contentResult = await serializeStandaloneDocument(session.page, { excludeSelector: mode === 'selected-sections' ? '[data-fra-scope="excluded"], [data-fra-scope="unselected"]' : '[data-fra-scope="excluded"]' });
    await writeFile(paths.redesignContentHtml, contentResult.html);
    embeddedAssets += contentResult.embeddedAssets;
    missingAssets.push(...contentResult.missingAssets);
  } catch (err) {
    contentExportError = err instanceof Error ? err.message : String(err);
    log(`R7 · redesign-content.html could not be exported — continuing without it: ${contentExportError}`);
  }

  const sectionHtmlPaths: string[] = [];
  // §8.4's safety check (never silently delete a subtree that structurally CONTAINS another
  // content section) can legitimately trip on a real page: the audit's own section names are
  // an analytical judgment, not a guarantee that each one is a DOM-sibling-level container —
  // two "sections" can be nested rather than siblings. Found live against a real page. One
  // section's export failing this way must never discard every OTHER section's already-
  // successful, unrelated export (§7.6's own rule: an edit's stamp being lost is "re-located...
  // still lost → reported", never "the whole run's other work is discarded too") — isolate it,
  // record it loudly in export-validation.json (§8.5) below, never drop it silently.
  const sectionExportFailures: Array<{ sectionId: string; error: string }> = [];
  if (mode === 'selected-sections') {
    for (const sectionId of sectionIds) {
      try {
        const fragResult = await serializeStandaloneDocument(session.page, { excludeSelector: `[data-fra-section]:not([data-fra-section="${sectionId}"])` });
        const fragPath = sectionFragmentPath(paths, sectionId);
        await writeFile(fragPath, fragResult.html);
        sectionHtmlPaths.push(fragPath);
        embeddedAssets += fragResult.embeddedAssets;
        missingAssets.push(...fragResult.missingAssets);
      } catch (err) {
        sectionExportFailures.push({ sectionId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // 5. Export validation — parity targets are every located, in-scope element's key properties.
  for (const entry of mapping.entries) {
    if (unlocatedFindingIds.includes(entry.findingIds[0] ?? '')) continue;
    const style = await session.page.locator(`[data-fra-element="${entry.element}"]`).first().evaluate((el, props) => {
      const cs = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const p of props) out[p] = cs.getPropertyValue(p);
      return out;
    }, EXTRACTED_PROPERTIES as unknown as string[]);
    liveValuesForParity.set(entry.element, style);
  }
  const parityTargets: ParityTarget[] = mapping.entries.filter((e) => !unlocatedFindingIds.includes(e.findingIds[0] ?? '')).map((e) => ({ stamp: e.element, properties: [...EXTRACTED_PROPERTIES] }));

  const exportValidation: ExportValidationResult[] = [];
  const expectationFor = (file: string, scope: ExportExpectation['scope'], headerFooterRetained: boolean, onlySectionId?: string): ExportExpectation => ({ file, scope, headerFooterRetained, ...(onlySectionId ? { onlySectionId } : {}) });

  log('R7 · exports serialized — validating exports');
  const redesignCheck = await validateExport(session.context, redesignResult.html, expectationFor('redesign.html', 'whole-page', true), { viewport: session.viewport, targets: parityTargets, liveValues: liveValuesForParity });
  exportValidation.push({ file: 'redesign.html', ok: redesignCheck.ok, failures: redesignCheck.failures });

  // In Selected Sections the content export no longer contains the unselected sections, so only
  // elements inside the selected sections are expected there.
  const contentTargets = mode === 'selected-sections' ? mapping.entries.filter((e) => !unlocatedFindingIds.includes(e.findingIds[0] ?? '') && e.sectionId !== null && sectionIds.includes(e.sectionId)).map((e) => ({ stamp: e.element, properties: [...EXTRACTED_PROPERTIES] })) : parityTargets;
  if (contentResult) {
    const contentCheck = await validateExport(session.context, contentResult.html, expectationFor('redesign-content.html', 'content-no-header-footer', false), { viewport: session.viewport, targets: contentTargets, liveValues: liveValuesForParity });
    exportValidation.push({ file: 'redesign-content.html', ok: contentCheck.ok && unselectedEditFailures.length === 0, failures: [...contentCheck.failures, ...unselectedEditFailures] });
  } else {
    exportValidation.push({ file: 'redesign-content.html', ok: false, failures: [`export failed: ${contentExportError ?? 'unknown error'}`, ...unselectedEditFailures] });
  }

  const originalCheck = await validateExport(session.context, originalResult.html, expectationFor('original.html', 'whole-page', true), null);
  exportValidation.push({ file: 'original.html', ok: originalCheck.ok, failures: originalCheck.failures });

  for (const sectionId of sectionIds) {
    const failure = sectionExportFailures.find((f) => f.sectionId === sectionId);
    if (failure) {
      exportValidation.push({ file: `sections/${sectionId}.html`, ok: false, failures: [`export failed: ${failure.error}`] });
      continue;
    }
    const html = await readFile(sectionFragmentPath(paths, sectionId), 'utf-8');
    const check = await validateExport(session.context, html, expectationFor(`sections/${sectionId}.html`, 'one-section', false, sectionId), null);
    exportValidation.push({ file: `sections/${sectionId}.html`, ok: check.ok, failures: check.failures });
  }

  await writeJsonFile(paths.exportValidationJson, exportValidation);

  // 6. Crop paths into the manifest, now that they exist on disk; stamp the real redesignRunId.
  const manifestWithCrops = {
    ...manifest,
    redesignRunId,
    createdAt: new Date().toISOString(),
    components: manifest.components.map((c) => {
      const entry = mapping.entries.find((e) => e.findingIds.includes(c.findingId));
      if (!entry) return c;
      return { ...c, crops: { before: componentCropPath(paths, entry.element, 'before'), after: componentCropPath(paths, entry.element, 'after') } };
    }),
  };
  await writeJsonFile(paths.componentManifestJson, manifestWithCrops);
  await writeFile(paths.componentReviewHtml, renderComponentReviewHtml(manifestWithCrops));

  // 7. redesign-plan.json (every iteration) and validation-results.json.
  await writeJsonFile(paths.redesignPlanJson, iterations.map((it) => ({ iteration: it.iteration, plan: it.plan.plan, chunks: it.plan.chunks })));
  await writeJsonFile(
    paths.validationResultsJson,
    iterations.map((it) => ({ iteration: it.iteration, checks: it.validation.checks, structural: it.validation.structural, vision: it.validation.vision, visionIssues: it.validation.visionIssues, overall: it.validation.overall, failedChecks: it.validation.failedChecks })),
  );

  // 8. change-list.md — applied / unaddressed / out-of-scope, never silently missing anything
  // authorized. §8.1: in Selected Sections mode, a content-scope finding whose OWN section
  // isn't one of the resolved `sectionIds` is ALSO out of scope — checking `entry.scope` alone
  // (set by C2, which has no notion of section selection) would silently drop it from every
  // report (never "applied", never "unaddressed", never listed here) the moment R3 correctly
  // stopped planning edits for it.
  const outOfScope = r1.fixFindings
    .filter((f) => {
      const entry = mapping.entries.find((e) => e.findingIds.includes(f.identity.findingId));
      if (!entry || entry.scope !== 'content') return true;
      if (mode === 'selected-sections') return entry.sectionId === null || !sectionIds.includes(entry.sectionId);
      return false;
    })
    .map((f) => {
      const entry = mapping.entries.find((e) => e.findingIds.includes(f.identity.findingId));
      const reason = !entry ? 'unaddressed: no live element mapped for this finding' : entry.scope === 'excluded' ? 'global-header-footer' : mode === 'selected-sections' ? 'section-not-selected' : 'out of scope';
      return { findingId: f.identity.findingId, reason };
    });
  await writeFile(paths.changeListMd, renderChangeListMd({ fixFindings: r1.fixFindings, fixEntries: r1.fixEntries, allFindings: r1.findings, iterations, outOfScope }));

  // 9. The one documented entry point (§10a).
  await writeFile(paths.reviewIndexHtml, renderReviewIndexHtml(paths, manifestWithCrops, outcome, iterations, sectionIds));

  log(
    `R7 · assembled ${1 + 1 + 1 + sectionHtmlPaths.length} export(s) · ${embeddedAssets} asset(s) embedded · ${missingAssets.length} missing · ${exportValidation.filter((v) => !v.ok).length} export check failure(s)` +
      (sectionExportFailures.length > 0 ? ` · ${sectionExportFailures.length} section export(s) FAILED (nested-section structure): ${sectionExportFailures.map((f) => f.sectionId).join(', ')}` : ''),
  );

  return {
    originalHtml: paths.originalHtml,
    redesignHtml: paths.redesignHtml,
    redesignContentHtml: paths.redesignContentHtml,
    sectionHtmlPaths,
    htmlBytes: Buffer.byteLength(redesignResult.html, 'utf-8'),
    beforePng: session.before.composite ? session.before.composite.path : null,
    afterPng: iterations.at(-1)?.applied.after.composite?.path ?? null,
    redesignPlanJson: paths.redesignPlanJson,
    validationResultsJson: paths.validationResultsJson,
    exportValidationJson: paths.exportValidationJson,
    changeListMd: paths.changeListMd,
    componentManifestJson: paths.componentManifestJson,
    componentReviewHtml: paths.componentReviewHtml,
    reviewIndexHtml: paths.reviewIndexHtml,
    exportValidation,
    embeddedAssets,
    missingAssets,
    unlocatedFindingIds,
  };
}
