import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runR2 } from '../../src/agents/r2-capture-original/index.ts';
import { runR4 } from '../../src/agents/r4-apply-render/index.ts';
import { runR7 } from '../../src/agents/r7-assemble-output/index.ts';
import type { IterationRecord, R1Output, R3Output, R5Output } from '../../src/agents/types.ts';
import { stampsCheck, zeroNetworkCheck } from '../../src/html/export-validate.ts';
import { upsertStyleRule } from '../../src/dom/stylesheet.ts';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import type { ComponentManifest } from '../../src/manifest/schema.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';
import { ensureRedesignDirs, redesignPaths, sectionFragmentPath, type RedesignPaths } from '../../src/output/redesign-store.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { fakeRegistry, makeFinding } from '../helpers/fixture-audit-run.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * runR7 producing real exported HTML under a temp RedesignPaths — the highest-value node in
 * this batch per ARCHITECTURE.md §8.4/§8.5. R7 itself does NOT decide what counts as global:
 * it trusts whatever the live DOM already carries as `data-fra-scope="excluded"` (C2's job,
 * simulated here by baking the attribute directly into the fixture header/footer) and slices
 * exports purely off that attribute — confirmed by reading r7's real source before assuming so.
 */

const STYLE_CSS = `body{margin:0;font-family:sans-serif}\n.btn{color:rgb(176, 31, 36)}\n`;

// Inline <style> deliberately, not <link rel="stylesheet"> — see the dedicated
// "original.html asset inlining" test below for why an EXTERNAL relative stylesheet is
// unsafe to rely on in the happy-path fixture (a confirmed bug in the asset-inlining path).
const FIXTURE_PAGE = `<!doctype html><html><head><title>r7 fixture</title><link rel="canonical" href="/r7page">
<style>body{margin:0;font-family:sans-serif} .btn{color:#000000;padding:8px 16px;background:#eeeeee}</style>
</head><body>
<header data-fra-scope="excluded"><nav>Ken Research</nav></header>
<main>
  <section>
    <h1 data-fra-element="hero1">Fix the page, not the story</h1>
    <button data-fra-element="btn1" class="btn">Get a free consultation</button>
    <a href="https://example.com/whitepaper">Read the whitepaper</a>
  </section>
</main>
<footer data-fra-scope="excluded">© Ken Research</footer>
</body></html>`;

// Used only by the dedicated asset-inlining bug test below.
const FIXTURE_PAGE_WITH_EXTERNAL_CSS = `<!doctype html><html><head><title>r7 external-css fixture</title><link rel="canonical" href="/r7page-external-css">
<link rel="stylesheet" href="/r7-style.css">
</head><body><main><button data-fra-element="btn1" class="btn">CTA</button></main></body></html>`;

// Used only by the §8.1 Selected Sections isolation test below — two distinct, independently
// stamped sections, so one can be "selected" and the other left "unselected".
const FIXTURE_PAGE_TWO_SECTIONS = `<!doctype html><html><head><title>r7 two-section fixture</title><link rel="canonical" href="/r7page-two-sections">
<style id="page-style">.btn{color:#000000}</style>
</head><body>
<section data-fra-section="hero" data-fra-scope="content">
  <button data-fra-element="hero-btn" class="btn">Hero CTA</button>
</section>
<section data-fra-section="features" data-fra-scope="content">
  <button data-fra-element="features-btn" class="btn">Features CTA</button>
</section>
</body></html>`;

// Used only by the nested-section export-failure-isolation regression test below: "nested"
// sits INSIDE "parent" rather than as its sibling — a real page's own section names are an
// analytical judgment, not a guarantee of sibling-level DOM containers (found live).
const FIXTURE_PAGE_NESTED_SECTION = `<!doctype html><html><head><title>r7 nested-section fixture</title>
<style>.btn{color:#000000}</style>
</head><body>
<section data-fra-section="parent" data-fra-scope="content">
  <button data-fra-element="parent-btn" class="btn">Parent CTA</button>
  <div class="wrapper">
    <section data-fra-section="nested" data-fra-scope="content">
      <button data-fra-element="nested-btn" class="btn">Nested CTA</button>
    </section>
  </div>
</section>
<section data-fra-section="other" data-fra-scope="content">
  <button data-fra-element="other-btn" class="btn">Other CTA</button>
</section>
</body></html>`;

let server: Awaited<ReturnType<typeof startLocalServer>>;
let pool: BrowserPool;
let roots: string[] = [];

beforeAll(async () => {
  server = await startLocalServer({
    '/r7page': { body: FIXTURE_PAGE },
    '/r7page-external-css': { body: FIXTURE_PAGE_WITH_EXTERNAL_CSS },
    '/r7-style.css': { body: STYLE_CSS, headers: { 'content-type': 'text/css' } },
    '/r7page-two-sections': { body: FIXTURE_PAGE_TWO_SECTIONS },
    '/r7page-nested-section': { body: FIXTURE_PAGE_NESTED_SECTION },
  });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FraR7Test/0.1' });
  await pool.start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.close();
});

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function freshPaths(): RedesignPaths {
  const root = mkdtempSync(join(tmpdir(), 'fra-r7-'));
  roots.push(root);
  return redesignPaths(root, 'r7-project', 'r7-run');
}

function makeR1(targetUrl: string, findings: R1Output['findings']): R1Output {
  return {
    sourceRun: {
      auditAgentRepoRoot: '/aa',
      projectName: 'r7-project',
      runId: 'r7-run',
      displayName: 'R7 Fixture Run',
      targetUrl,
      runDir: '/aa/projects/r7-project/runs/r7-run',
      dataJsonPath: '/aa/…/data.json',
      dataJsonSha256: 'd',
      fixPlanJsonPath: null,
      fixPlanSha256: null,
      newComponentPlanJsonPath: null,
      newComponentPlanSha256: null,
      reportHtmlPath: null,
      screenshotsDir: '/aa/…/screenshots',
    },
    audit: { schemaVersion: 1, run: { runId: 'r7-run', targetUrl }, findingCount: findings.length },
    targetUrl,
    findings,
    fixPlan: { schemaVersion: 1, runId: 'r7-run', updatedAt: null, entries: [] },
    fixEntries: [],
    fixFindings: findings,
    decisionCounts: { fix: findings.length, skip: 0, keep_for_review: 0, undecided: 0 },
    droppedUnknownFindingIds: [],
    newComponentPlan: null,
    registry: fakeRegistry(),
    warnings: [],
  };
}

function mappingEntry(elementId: string, findingId: string): MappingEntry {
  return {
    element: elementId,
    stamp: elementId,
    findingIds: [findingId],
    signature: null,
    instanceIndex: null,
    instanceCount: null,
    sectionId: 'hero',
    scope: 'content',
    resolution: { method: 'objective', confidence: 'confirmed', checks: { geometry: true, identity: true, text: true, classFingerprint: true, passedCount: 4 }, candidatesConsidered: 1 },
    drift: { class: 'identical', auditBox: null, liveBox: null, styleDeltas: [], note: '' },
    affordances: { tagName: elementId === 'hero1' ? 'h1' : 'button', role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false },
    dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' },
  };
}

function emptyManifest(redesignRunId: string): ComponentManifest {
  return {
    schemaVersion: 1,
    redesignRunId,
    createdAt: new Date(0).toISOString(),
    pageId: 'p1',
    auditAiMode: null,
    auditDsRegistryVersion: 'e'.repeat(64),
    designSystem: { path: '/fake/design-system', dsRegistryVersion: 'f'.repeat(64), changedSinceAudit: false },
    viewport: { width: 1440, height: 900 },
    scope: { contentSectionIds: ['hero'], excludedSectionIds: [] },
    sections: [],
    components: [],
    counts: { findings: 1, located: 1, unlocated: 0, excluded: 0, fixRequested: 1, fixApplied: 1, fixVerified: 1, byBucket: {}, otherPageFindings: 0 },
  };
}

describe('runR7 — real exported HTML, §8.4/§8.5', () => {
  it('exports original/redesign/redesign-content with header+footer sliced correctly, zero network, unique stamps, and per-file export validation', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r7page`;
    const finding = makeFinding({
      findingId: 'a'.repeat(32),
      label: 'Get a free consultation',
      mismatches: [{ property: 'color', actual: 'rgb(0, 0, 0)', expected: '#b01f24', expectedToken: '--color-ken-red', comparison: 'color-deltaE', delta: null }],
    });
    const r1 = makeR1(url, [finding]);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [mappingEntry('hero1', 'hero-finding'), mappingEntry('btn1', finding.identity.findingId)], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content(); // pre-edit, already carrying the data-fra-* stamps baked into the fixture

      // kind='attribute', not 'style': a real DOM mutation survives cloneNode/outerHTML
      // serialization. A kind='style' edit (upsertStyleRule → CSSOM sheet.insertRule) does
      // NOT — see the dedicated bug test at the bottom of this file for why that matters.
      const edit: TargetedEdit = { findingId: finding.identity.findingId, selector: '[data-fra-element="btn1"]', expectedMatches: 1, kind: 'attribute', property: 'data-cta-emphasis', value: 'true', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'flag this CTA as the emphasized action', confidence: 0.95 };
      const plan: R3Output = { iteration: 1, plan: { edits: [edit], unaddressed: [] }, chunks: 1, usage: null };
      const applied = await runR4({ paths, log: () => {} }, { r1, session, plan, iteration: 1, previousApplied: [] });
      expect(applied.applied[0]!.applied).toBe(true);

      const validation: R5Output = {
        iteration: 1,
        checks: [{ findingId: finding.identity.findingId, fixed: true, detail: 'attribute now applied', measured: [] }],
        structural: { ok: true, lostInteractive: [], lostText: [], note: 'interactive inventory and text coverage unchanged' },
        vision: 'NOT_CHECKED',
        visionIssues: [],
        visionVerdicts: null,
        overall: 'PASS',
        failedChecks: [],
        usage: null,
      };
      const iterations: IterationRecord[] = [{ iteration: 1, plan, applied, validation }];

      const result = await runR7({ log: () => {} }, { r1, session, iterations, outcome: 'PASS', manifest: emptyManifest('r7-run'), paths, redesignRunId: 'r7-run', mode: 'full-page', sectionIds: [] });

      // 1. Every documented export exists and parses.
      for (const p of [paths.originalHtml, paths.redesignHtml, paths.redesignContentHtml, paths.redesignPlanJson, paths.validationResultsJson, paths.exportValidationJson, paths.changeListMd, paths.componentManifestJson, paths.componentReviewHtml, paths.reviewIndexHtml]) {
        expect(existsSync(p)).toBe(true);
      }
      const originalHtml = readFileSync(paths.originalHtml, 'utf-8');
      const redesignHtml = readFileSync(paths.redesignHtml, 'utf-8');
      const redesignContentHtml = readFileSync(paths.redesignContentHtml, 'utf-8');
      expect(originalHtml.startsWith('<!doctype html>')).toBe(true);
      expect(redesignHtml.startsWith('<!doctype html>')).toBe(true);

      const parsePage = await session.context.newPage();
      try {
        await parsePage.setContent(redesignContentHtml, { waitUntil: 'domcontentloaded' });
        expect(await parsePage.evaluate(() => Boolean(document.body))).toBe(true);
      } finally {
        await parsePage.close();
      }

      // 2. Header/footer retained in the QA copies, sliced out of the deliverable — driven
      // purely by the DOM's own data-fra-scope="excluded" attribute, not any R7-side decision.
      expect(originalHtml).toMatch(/<header\b/i);
      expect(originalHtml).toMatch(/<footer\b/i);
      expect(redesignHtml).toMatch(/<header\b/i);
      expect(redesignHtml).toMatch(/<footer\b/i);
      expect(redesignContentHtml).not.toMatch(/<header\b/i);
      expect(redesignContentHtml).not.toMatch(/<footer\b/i);
      expect((redesignContentHtml.match(/data-fra-removed="excluded"/g) ?? []).length).toBe(2);

      // 3. The edit really landed in the deliverable, not just the QA copy.
      expect(redesignContentHtml).toContain('data-cta-emphasis="true"');
      expect(originalHtml).not.toContain('data-cta-emphasis');

      // 4. Zero network (the app's own definition — content anchors excepted) and unique stamps,
      // on every export that actually matters (original/redesign/content).
      for (const html of [originalHtml, redesignHtml, redesignContentHtml]) {
        expect(zeroNetworkCheck(html)).toEqual([]);
        expect(stampsCheck(html)).toEqual([]);
      }
      expect(redesignHtml).toContain('href="https://example.com/whitepaper"'); // the one legitimate content link, untouched

      // 5. exportValidation is per-file, not one blanket verdict.
      expect(result.exportValidation).toHaveLength(3);
      expect(new Set(result.exportValidation.map((v) => v.file))).toEqual(new Set(['redesign.html', 'redesign-content.html', 'original.html']));
      for (const v of result.exportValidation) expect(v.ok, `${v.file} failed: ${v.failures.join('; ')}`).toBe(true);

      expect(result.unlocatedFindingIds).toEqual([]);
      expect(result.htmlBytes).toBeGreaterThan(0);
    } finally {
      await session.release();
    }
  }, 60_000);

  it('reports an unlocated finding when its stamp is lost off the LIVE page by assembly time (§7.6), without hanging on the before-crop', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r7page`;
    const finding = makeFinding({ findingId: 'b'.repeat(32) });
    const r1 = makeR1(url, [finding]);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [mappingEntry('hero1', finding.identity.findingId)], unmapped: [], conflicts: [], usage: null };
      // originalHtml is captured WHILE hero1 still exists — the before-crop reads it from here.
      session.originalHtml = await session.page.content();
      // Simulate a re-render dropping the stamped element off the LIVE page only (§7.6) — the
      // before-crop (from originalHtml) must still succeed; only the live re-check fails.
      await session.page.evaluate(() => document.querySelector('[data-fra-element="hero1"]')?.remove());

      const iterations: IterationRecord[] = [];
      const result = await runR7({ log: () => {} }, { r1, session, iterations, outcome: 'FAIL', manifest: emptyManifest('r7-run-2'), paths, redesignRunId: 'r7-run-2', mode: 'full-page', sectionIds: [] });

      expect(result.unlocatedFindingIds).toEqual([finding.identity.findingId]);
      expect(existsSync(join(paths.componentsDir, 'hero1-before.png'))).toBe(true); // before-crop still captured from the pre-removal originalHtml
      expect(existsSync(join(paths.componentsDir, 'hero1-after.png'))).toBe(false); // after-crop correctly skipped — never guessed
    } finally {
      await session.release();
    }
  }, 60_000);

  /**
   * Regression test for a real, now-fixed bug: `original.html`/`beforePage` in
   * src/agents/r7-assemble-output/index.ts opened a BRAND NEW page that had never navigated
   * anywhere, then called `page.setContent(session.originalHtml, ...)` straight away — an
   * `about:blank`-origin page can't `fetch()` a relative-URL stylesheet at all (confirmed
   * empirically: this holds even with a `<base href>` correcting the URL string, since a
   * `<base>` tag never changes the page's actual origin, which is what same-origin `fetch()`
   * is gated on). Fixed by `html/temp-page.ts`'s `openStandinPage`: navigate to the audited
   * page's real URL first, with that one navigation intercepted and fulfilled LOCALLY (so it
   * never actually leaves the process), which gives the page the real origin without any
   * extra production traffic — then `setContent()` overwrites the DOM as before. The same fix
   * applies to R5's structural baseline (r5-compare/structural.ts, see r5-compare.test.ts).
   */
  it('original.html correctly inlines an external, RELATIVE stylesheet', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r7page-external-css`;
    const r1 = makeR1(url, []);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [mappingEntry('btn1', 'unused-finding')], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content();

      const result = await runR7({ log: () => {} }, { r1, session, iterations: [], outcome: 'FAIL', manifest: emptyManifest('r7-run-3'), paths, redesignRunId: 'r7-run-3', mode: 'full-page', sectionIds: [] });

      // Correct behavior per §8.4: every stylesheet inlined, nothing reported missing.
      expect(result.missingAssets).toEqual([]);
      const originalHtml = readFileSync(paths.originalHtml, 'utf-8');
      expect(originalHtml).toContain('rgb(176, 31, 36)'); // the external stylesheet's rule, inlined
    } finally {
      await session.release();
    }
  }, 60_000);

  /**
   * Regression test for a real, now-fixed bug: a `kind: 'style'` edit is applied by
   * `upsertStyleRule` (src/dom/stylesheet.ts) via CSSOM `sheet.insertRule(...)`, which mutates
   * the live `CSSStyleSheet` object but previously left no text node under the
   * `<style id="fra-injected-edits">` element — so `cloneNode`/`outerHTML`-based serialization
   * (src/html/serialize.ts) exported an empty style tag, silently dropping every style edit
   * from redesign.html/redesign-content.html. Fixed by mirroring `sheet.cssRules` into the
   * `<style>` element's `textContent` after every insert/delete. Note: the browser's CSSOM
   * canonicalizes color values on the way back out — `#b01f24` round-trips as
   * `rgb(176, 31, 36)`, not the original hex string; that's expected, not a bug.
   */
  it('a kind="style" edit applied by R4 is actually present in the exported redesign-content.html', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r7page`;
    const finding = makeFinding({ findingId: 'd'.repeat(32) });
    const r1 = makeR1(url, [finding]);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [mappingEntry('btn1', finding.identity.findingId)], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content();

      const styleEdit: TargetedEdit = { findingId: finding.identity.findingId, selector: '[data-fra-element="btn1"]', expectedMatches: 1, kind: 'style', property: 'color', value: '#b01f24', removeValue: null, dsComponent: null, dsVariant: null, dsToken: '--color-ken-red', rationale: 'apply the Ken red CTA color', confidence: 0.95 };
      const plan: R3Output = { iteration: 1, plan: { edits: [styleEdit], unaddressed: [] }, chunks: 1, usage: null };
      const applied = await runR4({ paths, log: () => {} }, { r1, session, plan, iteration: 1, previousApplied: [] });
      expect(applied.applied[0]!.applied).toBe(true); // R4 itself succeeds — the loss happens at export time

      const iterations: IterationRecord[] = [];
      await runR7({ log: () => {} }, { r1, session, iterations, outcome: 'PASS', manifest: emptyManifest('r7-run-4'), paths, redesignRunId: 'r7-run-4', mode: 'full-page', sectionIds: [] });

      const redesignContentHtml = readFileSync(paths.redesignContentHtml, 'utf-8');
      expect(redesignContentHtml).toContain('rgb(176, 31, 36)'); // #b01f24, canonicalized by the CSSOM
      expect(redesignContentHtml).toContain('data-fra-injected="edits"');
    } finally {
      await session.release();
    }
  }, 60_000);

  describe('§8.1 Selected Sections content-isolation guarantee', () => {
    it('drops the unselected section from redesign-content.html (hidden placeholder), keeps the selected one, and the export validator passes clean', async () => {
      const paths = freshPaths();
      await ensureRedesignDirs(paths);
      const url = `${server.origin}/r7page-two-sections`;
      const r1 = makeR1(url, []);
      const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
      try {
        session.mapping = { entries: [], unmapped: [], conflicts: [], usage: null };
        session.originalHtml = await session.page.content();

        const result = await runR7({ log: () => {} }, { r1, session, iterations: [], outcome: 'PASS', manifest: emptyManifest('r7-run-5'), paths, redesignRunId: 'r7-run-5', mode: 'selected-sections', sectionIds: ['hero'] });

        const redesignContentHtml = readFileSync(paths.redesignContentHtml, 'utf-8');
        expect(redesignContentHtml).not.toContain('data-fra-section="features"');
        expect(redesignContentHtml).toMatch(/data-fra-removed="features"/);
        expect(redesignContentHtml).toMatch(/data-fra-section="hero"[^>]*data-fra-scope="content"|data-fra-scope="content"[^>]*data-fra-section="hero"/);

        const contentCheck = result.exportValidation.find((v) => v.file === 'redesign-content.html')!;
        expect(contentCheck.ok, contentCheck.failures.join('; ')).toBe(true);
      } finally {
        await session.release();
      }
    }, 60_000);

    it('regression: export validation FAILS a redesign-content.html where an unselected section actually carries an injected style edit', async () => {
      const paths = freshPaths();
      await ensureRedesignDirs(paths);
      const url = `${server.origin}/r7page-two-sections`;
      const r1 = makeR1(url, []);
      const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
      try {
        session.mapping = { entries: [], unmapped: [], conflicts: [], usage: null };
        session.originalHtml = await session.page.content();

        // Simulate a defect elsewhere (R3 should never do this — this is a defense-in-depth
        // test of the CHECK itself, independent of whether the upstream guarantee holds):
        // an edit landed on the UNSELECTED "features" section's button.
        await upsertStyleRule(session.page, 'features-btn', 'color', 'rgb(9, 9, 9)');

        const result = await runR7({ log: () => {} }, { r1, session, iterations: [], outcome: 'PASS', manifest: emptyManifest('r7-run-6'), paths, redesignRunId: 'r7-run-6', mode: 'selected-sections', sectionIds: ['hero'] });

        const contentCheck = result.exportValidation.find((v) => v.file === 'redesign-content.html')!;
        expect(contentCheck.ok).toBe(false);
        expect(contentCheck.failures.some((f) => f.includes('features-btn'))).toBe(true);
      } finally {
        await session.release();
      }
    }, 60_000);

    it('adversarial-review regression: a section physically NESTED inside another (found live against a real page) fails its OWN fragment export loudly, without discarding the sibling section\'s already-successful export or the combined redesign-content.html', async () => {
      const paths = freshPaths();
      await ensureRedesignDirs(paths);
      const url = `${server.origin}/r7page-nested-section`;
      const r1 = makeR1(url, []);
      const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
      try {
        session.mapping = { entries: [], unmapped: [], conflicts: [], usage: null };
        session.originalHtml = await session.page.content();

        // "nested" is deliberately NOT selected — mirrors the real bug: a section outside the
        // reviewer's selection (e.g. an unrelated section the audit found but nobody chose)
        // physically sits inside "parent", which the reviewer DID select alongside "other".
        const result = await runR7({ log: () => {} }, { r1, session, iterations: [], outcome: 'PASS', manifest: emptyManifest('r7-run-nested'), paths, redesignRunId: 'r7-run-nested', mode: 'selected-sections', sectionIds: ['parent', 'other'] });

        // "parent" isolates cleanly (removing "nested" and "other", both leaves, is safe).
        expect(existsSync(sectionFragmentPath(paths, 'parent'))).toBe(true);
        expect(readFileSync(sectionFragmentPath(paths, 'parent'), 'utf-8')).toContain('Parent CTA');

        // "other" cannot isolate: removing "parent" (required to exclude it) would silently take
        // "nested" — which is not even in scope — down with it. Never done silently: no file,
        // and a loud, findable failure in export-validation instead.
        expect(existsSync(sectionFragmentPath(paths, 'other'))).toBe(false);
        const otherCheck = result.exportValidation.find((v) => v.file === 'sections/other.html')!;
        expect(otherCheck.ok).toBe(false);
        expect(otherCheck.failures[0]).toContain('nested');

        // The combined document and the OTHER section's export are unaffected by this one failure.
        expect(existsSync(paths.redesignContentHtml)).toBe(true);
        const contentCheck = result.exportValidation.find((v) => v.file === 'redesign-content.html')!;
        expect(contentCheck.ok, contentCheck.failures.join('; ')).toBe(true);
      } finally {
        await session.release();
      }
    }, 60_000);
  });
});
