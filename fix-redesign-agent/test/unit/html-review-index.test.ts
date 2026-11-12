import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IterationRecord, RedesignOutcome } from '../../src/agents/types.ts';
import { renderReviewIndexHtml } from '../../src/html/review-index.ts';
import type { ComponentManifest } from '../../src/manifest/schema.ts';
import { redesignPaths } from '../../src/output/redesign-store.ts';

/**
 * `review/review-index.html` (§10a) — the single documented entry point for every review
 * gate. Must link every artifact §10a's table lists, organised under its four sections:
 * page outputs, component review, component previews, QA/validation results.
 */

const paths = redesignPaths('/aa/projects', 'example.com-page', 'page-audit-redesign-test');

function manifestFixture(): ComponentManifest {
  return {
    schemaVersion: 1,
    redesignRunId: 'page-audit-redesign-test',
    createdAt: '2026-09-18T10:00:00.000Z',
    pageId: 'p1',
    auditAiMode: null,
    auditDsRegistryVersion: 'e'.repeat(64),
    designSystem: { path: '/ds', dsRegistryVersion: 'f'.repeat(64), changedSinceAudit: false },
    viewport: { width: 1440, height: 900 },
    scope: { contentSectionIds: ['hero'], excludedSectionIds: [] },
    sections: [],
    components: [],
    counts: { findings: 2, located: 2, unlocated: 0, excluded: 0, fixRequested: 2, fixApplied: 1, fixVerified: 1, byBucket: {}, otherPageFindings: 0 },
  };
}

function iterationFixture(overall: RedesignOutcome, failedChecks: string[] = []): IterationRecord {
  return {
    iteration: 1,
    plan: { iteration: 1, chunks: 1, usage: null, plan: { edits: [], unaddressed: [] } },
    applied: { iteration: 1, after: { tiles: [], totalHeight: 0, truncated: false, composite: null }, applied: [] },
    validation: { iteration: 1, checks: [], structural: { ok: true, lostInteractive: [], lostText: [], note: '' }, vision: 'NOT_CHECKED', visionIssues: [], visionVerdicts: null, overall, failedChecks, usage: null },
  };
}

describe('renderReviewIndexHtml', () => {
  it('links every §10a artifact: page outputs, component review, component previews, QA/validation results', () => {
    const sectionIds = ['hero', 'features'];
    const html = renderReviewIndexHtml(paths, manifestFixture(), 'PARTIAL', [iterationFixture('PARTIAL', ['finding a: still wrong'])], sectionIds);

    // Page outputs (§10a): static snapshot rendering.
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.originalHtml)}">original.html`);
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.redesignHtml)}">redesign.html`);
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.redesignContentHtml)}">redesign-content.html`);
    for (const id of sectionIds) {
      expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.sectionsDir)}/${id}.html">sections/${id}.html</a>`);
    }
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.beforePng)}">before.png</a>`);
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.afterPng)}">after.png</a>`);

    // Component review (checklist).
    expect(html).toContain('<a href="component-review.html">component-review.html</a>');
    expect(html).toContain('<a href="component-manifest.json">component-manifest.json (raw)</a>');

    // Component previews (Workflow B, live render).
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.previewsDir)}/">library/previews/ (per component)</a>`);
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.inContextHtml)}">library/in-context/redesign-with-components.html</a>`);

    // QA / validation results.
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.validationResultsJson)}">validation-results.json</a>`);
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.exportValidationJson)}">export-validation.json</a>`);
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.changeListMd)}">change-list.md</a>`);
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.acceptanceJson)}">library/acceptance.json (once built)</a>`);
    expect(html).toContain(`<a href="${relative(paths.reviewDir, paths.packageValidationJson)}">library/package-validation.json (once built)</a>`);
  });

  it('states the page verdict, iteration count, and the LAST iteration\'s failed-check count', () => {
    const html = renderReviewIndexHtml(paths, manifestFixture(), 'PARTIAL', [iterationFixture('FAIL', ['a']), iterationFixture('PARTIAL', ['b', 'c'])], []);
    expect(html).toContain('<span class="status-partial">PARTIAL</span>');
    expect(html).toContain('after 2 iteration(s)');
    expect(html).toContain('2 failed check(s)'); // from the LAST iteration (2 failures), not the first (1)
  });

  it('omits the failed-check count entirely when the last iteration passed clean', () => {
    const html = renderReviewIndexHtml(paths, manifestFixture(), 'PASS', [iterationFixture('PASS', [])], []);
    expect(html).not.toContain('failed check(s)');
  });

  it('titles the page with the redesignRunId and shows the run folder path', () => {
    const html = renderReviewIndexHtml(paths, manifestFixture(), 'PASS', [iterationFixture('PASS')], []);
    expect(html).toContain(`<title>Review — ${manifestFixture().redesignRunId}</title>`);
    expect(html).toContain(paths.runDir);
  });
});
