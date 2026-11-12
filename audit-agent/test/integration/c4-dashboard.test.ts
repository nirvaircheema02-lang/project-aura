import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildDashboard, SERVICE_ID } from '../../src/dashboard/server.ts';
import { evidenceRelativePath } from '../../src/dashboard/views/render.ts';
import { probeDashboard } from '../../src/dashboard/lifecycle.ts';
import { buildAuditData, type AuditData } from '../../src/agents/c2-json-writer/index.ts';
import type { Finding, PageResult } from '../../src/skills/s0-result-contract.ts';
import { describeRenderingEngine } from '../../src/graph/run-metadata.ts';

/**
 * C4 ↔ C2 parity (Decision Log #19) plus the read-only guarantee. The
 * dashboard's rendered numbers are asserted against the SAME data.json it
 * reads — never against Excel or Figma, because two outputs agreeing with
 * each other while both disagreeing with C2 must still fail.
 */

let app: FastifyInstance;
let dir: string;
let data: AuditData;
let dataJsonPath: string;

const finding = (over: Partial<Finding> & { classification: Finding['classification'] }): Finding => ({
  identity: { auditId: 'a', runId: 'run-1', findingId: `f-${over.classification}-${Math.random().toString(36).slice(2, 8)}`, timestamp: '2026-09-11T10:00:00.000Z', dsRegistryVersion: 'dshash1234567890', policyVersion: 'p1' },
  location: { url: 'https://www.kenresearch.com/a', pageId: 'p1', pageName: 'A', templateFamily: 'Consulting', section: 'Hero', captureState: 'default' },
  component: { productionType: 'button', productionLabel: 'Talk to a Strategy Expert', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig-1' },
  comparison: { mismatches: [], ruleViolations: [] },
  quality: { severity: 'LOW', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
  action: { recommendation: 'Do the thing', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
  history: { previousStatus: null, currentStatus: over.classification, delta: null, previousRunId: null },
  ...over,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-c4-'));
  const runDir = join(dir, 'projects', 'kenresearch.com-a', 'runs', 'run-1');
  mkdirSync(join(runDir, 'screenshots'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'kenresearch.com-a', 'project.json'), JSON.stringify({ targetUrl: 'https://www.kenresearch.com/a' }));
  // A real PNG so the evidence route serves actual bytes.
  writeFileSync(
    join(runDir, 'screenshots', 'hero-cta.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );

  const findings: Finding[] = [
    finding({ classification: 'MATCH' }),
    finding({
      classification: 'DEVIATION',
      quality: { severity: 'MEDIUM', confidence: 0.78, confidenceBand: 'MEDIUM', escalationStatus: 'QUEUED', escalationReasons: ['PLACEHOLDER_VALUE'], evidence: [{ kind: 'element-screenshot', ref: join(runDir, 'screenshots', 'hero-cta.png'), note: null }], visualVerdict: 'CONFIRMED' },
      comparison: { mismatches: [{ property: 'height', actual: '44px', expected: '48px', expectedToken: '--button-height-md', comparison: 'length-px', delta: -4 }], ruleViolations: [] },
    }),
    finding({
      classification: 'INCORRECT',
      quality: { severity: 'CRITICAL', confidence: 0.91, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'CONFIRMED' },
      comparison: { mismatches: [], ruleViolations: [{ ruleId: 'R1.2', title: 'Brand red is CTA-only', why: 'decorative use' }] },
    }),
    finding({ classification: 'DS_CANDIDATE', component: { productionType: 'card', productionLabel: 'Report card', dsComponent: null, dsVariant: null, signature: 'sig-card' }, action: { recommendation: 'Consider adding', rootCauseRef: null, dsCandidateNote: 'repeated 3x', registryUpdateRef: 'cand-sig-card' } }),
  ];

  const page: PageResult = {
    runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting',
    domHash: 'd', dsRegistryVersion: 'dshash1234567890', policyVersion: 'p1', findings,
    compliance: { match: 1, deviation: 1, incorrect: 1, newComponent: 0, dsCandidate: 1, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 33.3 },
    coverage: { sectionsAnalyzed: 4, componentsDetected: 4, excludedPersonalized: 1, excludedOffDomain: 2, sampledListings: [], unexpandedStates: [{ kind: 'tab', label: 'New This Week', reason: 'mutually exclusive state' }], droppedRefs: [], truncation: [] },
    capture: { settled: true, httpStatus: 200, consoleSummary: '17 messages, 17 suppressed', criticalFailures: 0 },
  };

  data = buildAuditData({
    runId: 'run-1',
    auditId: 'a',
    mode: 'single-page',
    startedAt: '2026-09-11T10:00:00.000Z',
    targetUrl: 'https://www.kenresearch.com/a',
    pages: [page],
    failedPages: [],
    renderingPolicy: {
      engine: 'chromium',
      channel: 'chromium',
      browserVersion: '141.0.7390.37',
      playwrightVersion: '1.63.0',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
      userAgent: 'Mozilla/5.0 Chrome/141.0.7390.37 KenResearchDSAudit/0.1',
    },
  });
  dataJsonPath = join(runDir, 'data.json');
  writeFileSync(dataJsonPath, JSON.stringify(data, null, 2));

  app = await buildDashboard({ projectsRoot: join(dir, 'projects') });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('C4 dashboard — routes', () => {
  it('identifies itself on /health so the launcher can tell "already running" from "someone else\'s port"', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: SERVICE_ID, ok: true });
  });

  it('serves one URL per project and per run (Decision Log #20 routing)', async () => {
    expect((await app.inject({ url: '/' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/projects/kenresearch.com-a' })).statusCode).toBe(200);
    const run = await app.inject({ url: '/projects/kenresearch.com-a/runs/run-1' });
    expect(run.statusCode).toBe(200);
    expect(run.headers['content-type']).toContain('text/html');
  });

  it('resolves a run whose project slug exceeds find-my-way\'s default 100-char param limit (regression: projectNameFor has no length cap, so a deep real-world URL — e.g. a long industry-reports slug — silently 404\'d with no indication why)', async () => {
    const longSlug = 'kenresearch.com-' + 'industry-reports-malaysia-industrial-packaging-pallets-supply-chain-packaging-solutions-market';
    expect(longSlug.length).toBeGreaterThan(100);
    const runDir = join(dir, 'projects', longSlug, 'runs', 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'data.json'), JSON.stringify(data));
    const res = await app.inject({ url: `/projects/${longSlug}/runs/run-1` });
    expect(res.statusCode).toBe(200);
  });

  it('rejects path traversal in project and run ids', async () => {
    // An encoded segment reaches the handler and is rejected by validation;
    // a literal `..` is normalized away by the router before routing. Either
    // way the request is refused and never resolves outside the projects root.
    expect((await app.inject({ url: '/projects/..%2F..%2Fetc/runs/run-1' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/projects/kenresearch.com-a/runs/..' })).statusCode).not.toBe(200);
    expect((await app.inject({ url: '/evidence/../../../etc/passwd' })).statusCode).not.toBe(200);
  });

  it('404s a run with no data.json instead of rendering an empty page as if it were a result', async () => {
    expect((await app.inject({ url: '/projects/kenresearch.com-a/runs/nonexistent' })).statusCode).toBe(404);
  });

  it('serves evidence screenshots as real image bytes', async () => {
    const res = await app.inject({ url: '/evidence/kenresearch.com-a/runs/run-1/screenshots/hero-cta.png' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(1, 4).toString()).toBe('PNG');
  });

  /**
   * Regression: real runs nest evidence per page
   * (`screenshots/<pageId>/<el>-element.png`). An earlier version rendered only
   * the basename, so every image 404'd when viewed against a real run.
   */
  it('links nested per-page evidence paths, not just the basename', async () => {
    expect(evidenceRelativePath('/abs/projects/p/runs/r/screenshots/pageid123/s0-3-element.png')).toBe('pageid123/s0-3-element.png');
    expect(evidenceRelativePath('/abs/projects/p/runs/r/screenshots/flat.png')).toBe('flat.png');
    expect(evidenceRelativePath('/not/an/evidence/path.png')).toBeNull();

    mkdirSync(join(dir, 'projects', 'kenresearch.com-a', 'runs', 'run-1', 'screenshots', 'page9'), { recursive: true });
    writeFileSync(
      join(dir, 'projects', 'kenresearch.com-a', 'runs', 'run-1', 'screenshots', 'page9', 'nested.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    );
    const res = await app.inject({ url: '/evidence/kenresearch.com-a/runs/run-1/screenshots/page9/nested.png' });
    expect(res.statusCode).toBe(200);
  });

  /**
   * The live dashboard and the standalone report render from the same renderRun, so the dashboard
   * must also choose evidence by what is VISIBLE in it — otherwise a hidden element's flat crop is
   * an empty box on this surface while the standalone file shows a real screenshot.
   */
  it('chooses evidence by what is visible, like the standalone report: a hidden element\'s flat crop yields to its context shot', async () => {
    const { PNG } = await import('pngjs');
    const runDir = join(dir, 'projects', 'kenresearch.com-a', 'runs', 'run-vis');
    mkdirSync(join(runDir, 'screenshots', 'p1'), { recursive: true });
    const png = (width: number, height: number, ink?: { x: number; y: number; w: number; h: number }): Buffer => {
      const img = new PNG({ width, height });
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const inside = ink && x >= ink.x && x < ink.x + ink.w && y >= ink.y && y < ink.y + ink.h;
          const o = (y * width + x) * 4;
          img.data[o] = inside ? 30 : 255;
          img.data[o + 1] = inside ? 80 : 255;
          img.data[o + 2] = inside ? 160 : 255;
          img.data[o + 3] = 255;
        }
      }
      return PNG.sync.write(img);
    };
    const flatRef = join(runDir, 'screenshots', 'p1', 'hidden-element.png');
    const ctxRef = join(runDir, 'screenshots', 'p1', 'hidden-context.png');
    writeFileSync(flatRef, png(12, 50)); // one flat colour: nothing to see
    writeFileSync(ctxRef, png(200, 120, { x: 20, y: 30, w: 120, h: 40 }));
    const hidden = finding({
      classification: 'DEVIATION',
      component: { productionType: 'link', productionLabel: 'Explore Now', dsComponent: null, dsVariant: null, signature: 'sig-hidden' },
      quality: {
        severity: 'LOW', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], visualVerdict: 'NOT_CHECKED',
        evidence: [
          { kind: 'element-screenshot', ref: flatRef, note: null, box: { x: 0, y: 0, width: 12, height: 50 } },
          { kind: 'context-screenshot', ref: ctxRef, note: null, box: { x: 0, y: 0, width: 200, height: 120 } },
        ],
      },
    });
    const page: PageResult = {
      runId: 'run-vis', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'd', dsRegistryVersion: 'dshash1234567890', policyVersion: 'p1', findings: [hidden],
      compliance: { match: 0, deviation: 1, incorrect: 0, newComponent: 0, dsCandidate: 0, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 0 },
      coverage: { sectionsAnalyzed: 1, componentsDetected: 1, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
      capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
    };
    writeFileSync(join(runDir, 'data.json'), JSON.stringify(buildAuditData({ runId: 'run-vis', auditId: 'a', mode: 'single-page', startedAt: '2026-10-06T10:00:00.000Z', targetUrl: 'https://www.kenresearch.com/a', pages: [page], failedPages: [] })));

    const res = await app.inject({ url: '/projects/kenresearch.com-a/runs/run-vis' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('p1/hidden-context.png');
    expect(res.body).not.toContain('p1/hidden-element.png');
    expect(res.body).toContain('class="evidence-note"');
    // The same file the dashboard now points at is served as real image bytes.
    const served = await app.inject({ url: '/evidence/kenresearch.com-a/runs/run-vis/screenshots/p1/hidden-context.png' });
    expect(served.statusCode).toBe(200);
  });
});

describe('C4 ↔ C2 parity — rendered numbers come from data.json, not a recomputation', () => {
  it('the API route returns C2\'s data byte-for-byte equivalent', async () => {
    const res = await app.inject({ url: '/projects/kenresearch.com-a/runs/run-1/api/data' });
    expect(res.json()).toEqual(JSON.parse(readFileSync(dataJsonPath, 'utf-8')));
  });

  it('every headline figure on the page matches C2 exactly', async () => {
    const html = (await app.inject({ url: '/projects/kenresearch.com-a/runs/run-1' })).body;
    const s = data.websiteSummary;
    expect(html).toContain(`${s.compliancePercent}%`);
    // Each summary card renders its number next to its label.
    for (const [label, value] of [
      ['Match', s.match],
      ['Deviation', s.deviation],
      ['Incorrect', s.incorrect],
      ['DS candidates', s.dsCandidate],
      ['Unverified', s.unverified],
      ['Needs review', s.needsReview],
      ['Components checked', s.componentsChecked],
      ['Awaiting review', s.escalationsQueued],
    ] as Array<[string, number]>) {
      const card = new RegExp(`<div class="n">${value}</div><div class="l">${label}</div>`);
      expect(html, `card "${label}" should show ${value}`).toMatch(card);
    }
  });

  it('shows the exact browser build from C2\'s run metadata', async () => {
    const html = (await app.inject({ url: '/projects/kenresearch.com-a/runs/run-1' })).body;
    expect(html).toContain(describeRenderingEngine(data.run.renderingPolicy!));
  });

  it('renders every finding, with the measured actual/expected and its DS token', async () => {
    const html = (await app.inject({ url: '/projects/kenresearch.com-a/runs/run-1' })).body;
    // v3: findings render as compact <div class="frow" data-classification="..."> cards, not <tr>.
    const rowCount = (html.match(/<div class="frow" data-classification=/g) ?? []).length;
    expect(rowCount).toBe(data.findings.length);
    expect(html).toContain('44px');
    expect(html).toContain('48px');
    expect(html).toContain('--button-height-md');
    expect(html).toContain('R1.2');
  });

  it('exposes severity as a filterable attribute; confidence band and review state remain visible (in the expanded detail) but are no longer separate filters, per the v3 filter simplification', async () => {
    const html = (await app.inject({ url: '/projects/kenresearch.com-a/runs/run-1' })).body;
    expect(html).toContain('data-severity="CRITICAL"');
    // Confidence/Review-State filters were removed deliberately (v3) — their values still render,
    // inside each finding's collapsible detail, just not as dedicated data-* filter attributes.
    expect(html).not.toContain('data-band=');
    expect(html).not.toContain('data-escalation=');
    expect(html).toContain('MEDIUM'); // the confidence band, still shown in the detail view
    expect(html).toContain('QUEUED'); // the escalation status, still shown in the detail view
    expect(html).toContain('PLACEHOLDER_VALUE');
    for (const heading of ['Summary', 'Findings', 'Global issues', 'Components', 'Pages', 'New components']) {
      expect(html).toContain(heading);
    }
  });

  it('surfaces coverage boundaries rather than hiding them', async () => {
    const html = (await app.inject({ url: '/projects/kenresearch.com-a/runs/run-1' })).body;
    expect(html).toContain('1 personalized section(s) excluded');
    expect(html).toContain('2 off-domain link(s) excluded');
    expect(html).toContain('1 unexpanded state(s)');
  });

  it('never writes to the run directory while serving (read-only guarantee)', async () => {
    const before = statSync(dataJsonPath).mtimeMs;
    await app.inject({ url: '/projects/kenresearch.com-a/runs/run-1' });
    await app.inject({ url: '/projects/kenresearch.com-a/runs/run-1/api/data' });
    expect(statSync(dataJsonPath).mtimeMs).toBe(before);
    // And there is no route that mutates anything.
    const mutating = app.printRoutes().match(/(POST|PUT|PATCH|DELETE)/g);
    expect(mutating).toBeNull();
  });
});

describe('dashboard lifecycle (Decision Log #20)', () => {
  it('probing a closed port reports closed rather than assuming ours', async () => {
    expect(await probeDashboard(59_999, 300)).toBe('closed');
  });
});

describe('coverage across every page, from C2 (second-pass review: dashboard showed page 1 only)', () => {
  it('a drop on page 2 is in C2\'s run summary and in the dashboard', async () => {
    const { renderRun } = await import('../../src/dashboard/views/render.ts');
    const base = JSON.parse(JSON.stringify(data)) as AuditData;
    const page1 = { runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'd', dsRegistryVersion: 'v', policyVersion: 'p', findings: [], compliance: base.pageSummary[0]!.compliance, coverage: { sectionsAnalyzed: 2, componentsDetected: 3, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] }, capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 } };
    const page2 = { ...page1, pageId: 'p2', url: 'https://www.kenresearch.com/b', coverage: { ...page1.coverage, droppedRefs: [{ node: 'B2', ref: 'e561', reason: '"carousel slide" no longer resolvable' }], truncation: [{ what: 'section "Footer" screenshot', detail: 'not visible' }] } };
    const multi = buildAuditData({ runId: 'run-2', auditId: 'a', mode: 'full-site', startedAt: 't', targetUrl: 'https://www.kenresearch.com/', pages: [page1, page2], failedPages: [] });
    expect(multi.coverageSummary.droppedRefs).toEqual([{ pageUrl: 'https://www.kenresearch.com/b', node: 'B2', ref: 'e561', reason: '"carousel slide" no longer resolvable' }]);
    expect(multi.coverageSummary.sectionsAnalyzed).toBe(4);
    const html = renderRun('kenresearch.com', multi, '/evidence/x');
    expect(html).toContain('1 unresolvable element reference(s)');
    expect(html).toContain('e561');
    expect(html).toContain('https://www.kenresearch.com/b');
  });
});

describe('the launcher never reuses a stale dashboard (second-pass review)', () => {
  it('a copy of OUR server built from older code is stopped and replaced, not reused', async () => {
    const { spawn } = await import('node:child_process');
    const { ensureDashboardRunning } = await import('../../src/dashboard/lifecycle.ts');
    const { createServer } = await import('node:net');
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    const projects = join(dir, 'projects');
    // A stand-in for a dashboard left running from before a code change: right service id, old build.
    const stale = spawn(process.execPath, ['-e', `require('http').createServer((q, r) => { r.setHeader('content-type','application/json'); r.end(JSON.stringify({ service: '${SERVICE_ID}', build: 'old-build', projectsRoot: ${JSON.stringify(projects)}, pid: process.pid, ok: true })); }).listen(${port}, '127.0.0.1');`], { stdio: 'ignore' });
    const staleExit = new Promise<number | null>((r) => stale.on('exit', (code, signal) => r(signal === 'SIGTERM' ? 0 : code)));
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await probeDashboard(port, 300)) !== 'ours') await new Promise((r) => setTimeout(r, 100));

    const state = await ensureDashboardRunning({ port, projectsRoot: projects, repoRoot: join(import.meta.dirname, '..', '..') });
    try {
      expect(state.status).toBe('restarted');
      expect('detail' in state ? state.detail : '').toContain('older code');
      expect(await staleExit).toBe(0); // the stale one was stopped
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { build: string; pid: number };
      expect(health.build).not.toBe('old-build');
    } finally {
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.json().catch(() => null)) as { pid?: number } | null;
      if (health?.pid) process.kill(health.pid, 'SIGTERM');
      stale.kill('SIGKILL');
    }
  }, 60_000);
});
