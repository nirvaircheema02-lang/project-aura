import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runR2 } from '../../src/agents/r2-capture-original/index.ts';
import type { R1Output } from '../../src/agents/types.ts';
import { ensureRedesignDirs, redesignPaths, type RedesignPaths } from '../../src/output/redesign-store.ts';
import { captureFingerprintsEqual } from '../../src/mapping/types.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { fakeRegistry } from '../helpers/fixture-audit-run.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * runR2 against a real Chromium page — proves the LIVE session handed back stays usable, the
 * capture fingerprint is real (not a stub), and before-tiles/composite land on disk. R2
 * deliberately does not use `withCapturedPage` (see its own header comment) so this exercises
 * that hand-rolled capture sequence directly, not the shared helper `t-layer-browser.test.ts` covers.
 */

const FIXTURE_PAGE = `<!doctype html><html><head><title>r2 fixture</title><link rel="canonical" href="/r2page">
<style>body{margin:0;font-family:sans-serif} .card{padding:24px;background:#ffffff}</style>
</head><body><main><div class="card"><h1>Hello capture</h1><p>Static content for a stable fingerprint.</p></div></main></body></html>`;

let server: Awaited<ReturnType<typeof startLocalServer>>;
let pool: BrowserPool;
let roots: string[] = [];

beforeAll(async () => {
  server = await startLocalServer({ '/r2page': { body: FIXTURE_PAGE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FraR2Test/0.1' });
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

function freshPaths(projectSlug = 'r2-project', runId = 'r2-run'): RedesignPaths {
  const root = mkdtempSync(join(tmpdir(), 'fra-r2-'));
  roots.push(root);
  return redesignPaths(root, projectSlug, runId);
}

function makeR1(targetUrl: string): R1Output {
  return {
    sourceRun: {
      auditAgentRepoRoot: '/aa',
      projectName: 'r2-project',
      runId: 'r2-run',
      displayName: 'R2 Fixture Run',
      targetUrl,
      runDir: '/aa/projects/r2-project/runs/r2-run',
      dataJsonPath: '/aa/…/data.json',
      dataJsonSha256: 'd',
      fixPlanJsonPath: null,
      fixPlanSha256: null,
      newComponentPlanJsonPath: null,
      newComponentPlanSha256: null,
      reportHtmlPath: null,
      screenshotsDir: '/aa/…/screenshots',
    },
    audit: { schemaVersion: 1, run: { runId: 'r2-run', targetUrl }, findingCount: 0 },
    targetUrl,
    findings: [],
    fixPlan: { schemaVersion: 1, runId: 'r2-run', updatedAt: null, entries: [] },
    fixEntries: [],
    fixFindings: [],
    decisionCounts: { fix: 0, skip: 0, keep_for_review: 0, undecided: 0 },
    droppedUnknownFindingIds: [],
    newComponentPlan: null,
    registry: fakeRegistry(),
    warnings: [],
  };
}

describe('runR2 — real Chromium capture', () => {
  it('returns a still-usable live session, a populated fingerprint, and real before-tiles/composite files', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r2page`;
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, makeR1(url));
    try {
      // The page/context are handed back OPEN (§6.7's hydration note) — still usable after runR2 returns.
      expect(await session.page.title()).toBe('r2 fixture');
      expect(session.context.pages()).toContain(session.page);

      expect(session.capture.httpStatus).toBe(200);
      expect(session.capture.canonical.pageUrl).toBe(url);
      expect(session.originalHtml).toBeNull(); // set by C2, not R2
      expect(session.mapping).toBeNull();

      expect(session.captureFingerprint.domHash).toMatch(/^[0-9a-f]{64}$/);
      expect(session.captureFingerprint.viewport).toEqual({ width: 1440, height: 900 });
      expect(session.captureFingerprint.renderingPolicyHash).toMatch(/^[0-9a-f]{64}$/);

      expect(session.before.tiles.length).toBeGreaterThan(0);
      expect(session.before.truncated).toBe(false);
      for (const tile of session.before.tiles) expect(existsSync(tile.path)).toBe(true);
      expect(session.before.composite).not.toBeNull();
      expect(existsSync(session.before.composite!.path)).toBe(true);
      expect(session.before.composite!.path).toBe(paths.beforePng);
    } finally {
      await session.release();
    }
  }, 60_000);

  it('produces a STABLE fingerprint across two independent captures of the unchanged page', async () => {
    const pathsA = freshPaths();
    await ensureRedesignDirs(pathsA);
    const url = `${server.origin}/r2page`;

    const sessionA = await runR2({ pool, politeness: new Politeness(0), paths: pathsA }, makeR1(url));
    const fpA = sessionA.captureFingerprint;
    await sessionA.release();

    const pathsB = freshPaths('r2-project', 'r2-run-b');
    await ensureRedesignDirs(pathsB);
    const sessionB = await runR2({ pool, politeness: new Politeness(0), paths: pathsB }, makeR1(url));
    const fpB = sessionB.captureFingerprint;
    await sessionB.release();

    expect(captureFingerprintsEqual(fpA, fpB)).toBe(true);
    expect(fpA.domHash).toBe(fpB.domHash);
    expect(fpA.stylesheets).toEqual(fpB.stylesheets);
  }, 60_000);

  it('release() closes the context and is idempotent', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r2page`;
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, makeR1(url));
    await session.release();
    await expect(session.release()).resolves.toBeUndefined(); // idempotent per the CaptureSession contract
  }, 60_000);
});
