import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/index.ts';
import { getRun } from '../../src/graph/state.ts';
import { projectNameFor, runPaths } from '../../src/output/run-store.ts';
import type { AuditData } from '../../src/agents/c2-json-writer/index.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { startScriptedMessagesApi } from '../helpers/mock-messages-api.ts';
import { KNOWN_WRONG_PAGE } from '../helpers/known-wrong-page.ts';

/**
 * The exact command step 11 runs — `audit-page <url>` as a real child process,
 * with the real AnthropicLlmClient — pointed at a local scripted Messages API
 * via ANTHROPIC_BASE_URL, and at an isolated data directory so nothing lands
 * in the real audit history. Covers the three ways a run ends: completed,
 * failed at a node, and interrupted mid-call.
 */

const REPO = join(import.meta.dirname, '..', '..');
let site: Awaited<ReturnType<typeof startLocalServer>>;
let dataDir: string;

beforeAll(async () => {
  site = await startLocalServer({
    '/market-entry': { body: KNOWN_WRONG_PAGE },
    // A page whose head script never answers: navigation is still pending when Ctrl-C lands.
    '/stuck': { body: '<!doctype html><html><head><script src="/never.js"></script></head><body><h1>Stuck</h1></body></html>' },
    '/never.js': { hang: true },
  });
  dataDir = mkdtempSync(join(tmpdir(), 'audit-agent-e2e-'));
});

afterAll(async () => {
  await site?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

let childPid: number | undefined;

/**
 * The anthropic-api path is opt-in (Decision Log #31), so the tests of that path set
 * AI_MODE explicitly; `noApi` runs with NO credential at all and AI_MODE unset — the
 * v1 default — while ANTHROPIC_BASE_URL still points at a counting stand-in, so any
 * request that slipped out would be seen.
 */
function runCli(args: string[], baseURL: string, opts: { noApi?: boolean; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_BASE_URL: baseURL, AUDIT_AGENT_DATA_DIR: dataDir };
    if (opts.noApi) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.AI_MODE;
    } else {
      env.ANTHROPIC_API_KEY = 'e2e-offline-not-a-real-key';
      env.AI_MODE = 'anthropic-api';
    }
    Object.assign(env, opts.env);
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/cli/index.ts', ...args], { cwd: REPO, env });
    childPid = child.pid;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const runStatus = (runId: string) => {
  const db = openDb(join(dataDir, 'audit-agent.db'));
  try {
    return getRun(db, runId)?.status;
  } finally {
    db.close();
  }
};

describe('audit-page, end to end through the real client', () => {
  it('completes, records the exact engine, and writes C2 + C1', async () => {
    const api = await startScriptedMessagesApi('answer');
    const url = `${site.origin}/market-entry`;
    const { code, stdout, stderr } = await runCli(['audit-page', url, '--run-id', 'e2e-ok', '--no-dashboard'], api.baseURL);
    await api.close();

    expect(stderr).not.toMatch(/FAILED/);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Run e2e-ok · single-page/);
    expect(stdout).toMatch(/Engine Playwright Chromium \d+\.\d+\.\d+\.\d+ \(channel chromium, Playwright \d+\.\d+\.\d+\)/);
    // Components on the page — never a count that includes S7's history records for gone elements.
    expect(stdout).toMatch(/\d+ components checked · compliance/);

    const paths = runPaths(join(dataDir, 'projects'), projectNameFor(url), 'e2e-ok');
    const data = JSON.parse(readFileSync(paths.dataJson, 'utf-8')) as AuditData;
    expect(data.run.renderingPolicy?.engine).toBe('chromium');
    expect(data.run.policyVersion).toContain(`@${data.run.renderingPolicy?.browserVersion}`);
    expect(data.findings.length).toBeGreaterThan(0);
    expect(existsSync(paths.reportXlsx)).toBe(true);
    // Third-pass review OUT-4: C3's deterministic publish plan is persisted for every run, even
    // though no CLI command publishes it yet — the exact structure a future publish would send.
    expect(existsSync(paths.figmaPlanJson)).toBe(true);
    const plan = JSON.parse(readFileSync(paths.figmaPlanJson, 'utf-8')) as { runId: string; contractVersion: string; pageAudits: Array<{ markerGroups: unknown[] }> };
    expect(plan.runId).toBe('e2e-ok');
    // The curated, deduplicated interactive-marker set (Decision Log #32) is part of the SAME
    // persisted plan — automatic for every run, never a manual per-file Figma edit.
    expect(Array.isArray(plan.pageAudits[0]?.markerGroups)).toBe(true);
    // The per-page tile composite geometry (sticky-header auto-detection) is also automatic.
    expect(existsSync(paths.figmaCompositePlanJson)).toBe(true);
    const compositePlan = JSON.parse(readFileSync(paths.figmaCompositePlanJson, 'utf-8')) as Record<string, { headerHeightPx: number; blocks: unknown[] }>;
    expect(Object.values(compositePlan).length).toBeGreaterThan(0);
    for (const perPage of Object.values(compositePlan)) {
      expect(perPage.headerHeightPx).toBeGreaterThanOrEqual(0);
      expect(perPage.blocks.length).toBeGreaterThan(0);
    }
    // A self-contained HTML sibling of report.xlsx — real evidence embedded, not linked.
    expect(existsSync(paths.reportHtml)).toBe(true);
    const html = readFileSync(paths.reportHtml, 'utf-8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toMatch(/src="\/screenshots\//);
    expect(plan.contractVersion).toBe('figma-layout-v4');
    // P1: the ordered Figma write (figma/publish-ops.ts) is also automatic for every run —
    // NOT a completed Figma deliverable by itself, but never left for a human to derive by hand.
    expect(existsSync(paths.figmaOpsJson)).toBe(true);
    const opsPlan = JSON.parse(readFileSync(paths.figmaOpsJson, 'utf-8')) as { ops: Array<{ op: string }>; coverageGaps: unknown[] };
    expect(opsPlan.ops.length).toBeGreaterThan(0);
    expect(opsPlan.ops.some((o) => o.op === 'EnsureFile')).toBe(true);

    // Every AI node went over the wire, validly.
    expect([...new Set(api.checks.map((c) => c.node))]).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
    expect(api.checks.flatMap((c) => c.problems)).toEqual([]);
    expect(runStatus('e2e-ok')).toBe('COMPLETE');
  }, 180_000);

  it('a node failure still writes a report that SAYS it failed, names the node, and exits non-zero', async () => {
    const api = await startScriptedMessagesApi('fail');
    const url = `${site.origin}/market-entry`;
    const { code, stderr } = await runCli(['audit-page', url, '--run-id', 'e2e-fail', '--no-dashboard'], api.baseURL);
    await api.close();

    expect(code).toBe(1);
    expect(stderr).toMatch(/Run e2e-fail FAILED at B1: /);
    expect(stderr).toMatch(/pnpm run agent trace e2e-fail/);
    const data = JSON.parse(readFileSync(runPaths(join(dataDir, 'projects'), projectNameFor(url), 'e2e-fail').dataJson, 'utf-8')) as AuditData;
    expect(data.failedPages[0]?.reason).toMatch(/^failed at B1: /);
    expect(data.websiteSummary.pagesAudited).toBe(0);
    expect(runStatus('e2e-fail')).toBe('FAILED');
    // A 400 is TERMINAL: one request, no retry burned on a request that cannot succeed.
    expect(api.checks).toHaveLength(1);
  }, 180_000);

  it('Ctrl-C mid-call marks the run FAILED — it never stays RUNNING to block the next audit', async () => {
    const api = await startScriptedMessagesApi('hold');
    const url = `${site.origin}/market-entry`;
    let sent = false;
    const pending = runCli(['audit-page', url, '--run-id', 'e2e-interrupt', '--no-dashboard'], api.baseURL);
    // Interrupt once the first model call is actually in flight.
    const timer = setInterval(() => {
      if (!sent && childPid && api.received > 0) {
        sent = true;
        clearInterval(timer);
        process.kill(childPid, 'SIGINT');
      }
    }, 100);
    const { code, stderr } = await pending;
    clearInterval(timer);
    await api.close();

    expect(sent).toBe(true);
    expect(code).toBe(130);
    expect(stderr).toMatch(/Interrupted \(SIGINT\) — run e2e-interrupt marked FAILED/);
    expect(runStatus('e2e-interrupt')).toBe('FAILED');
    // …and it leaves a report that says so, so the dashboard never shows "no data yet".
    const data = JSON.parse(readFileSync(runPaths(join(dataDir, 'projects'), projectNameFor(url), 'e2e-interrupt').dataJson, 'utf-8')) as AuditData;
    expect(data.failedPages[0]?.reason).toBe('interrupted (SIGINT)');
  }, 180_000);

  it('Ctrl-C while the browser is still navigating exits 130 cleanly — no closed-database crash', async () => {
    const api = await startScriptedMessagesApi('answer');
    const url = `${site.origin}/stuck`;
    let sent = false;
    const pending = runCli(['audit-page', url, '--run-id', 'e2e-interrupt-nav', '--no-dashboard'], api.baseURL);
    // Interrupt once the browser has asked for the script that never answers.
    const timer = setInterval(() => {
      if (!sent && childPid && site.hits.includes('/never.js')) {
        sent = true;
        clearInterval(timer);
        process.kill(childPid, 'SIGINT');
      }
    }, 50);
    const { code, stderr } = await pending;
    clearInterval(timer);
    await api.close();

    expect(sent).toBe(true);
    expect(stderr).not.toMatch(/TypeError|database connection is not open/);
    expect(code).toBe(130);
    expect(stderr).toMatch(/Interrupted \(SIGINT\) — run e2e-interrupt-nav marked FAILED/);
    // Interrupted before capture finished, the run row may not exist yet — but it is never left RUNNING.
    expect(runStatus('e2e-interrupt-nav')).not.toBe('RUNNING');
    // The report says INTERRUPTED — not overwritten by the browser closing under the audit.
    const data = JSON.parse(readFileSync(runPaths(join(dataDir, 'projects'), projectNameFor(url), 'e2e-interrupt-nav').dataJson, 'utf-8')) as AuditData;
    expect(data.failedPages[0]?.reason).toBe('interrupted (SIGINT)');
    expect(api.received).toBe(0);
  }, 180_000);

  // ── Decision Log #31: the v1 default runs with no credential and makes no model call ──
  it('no-api (the default): starts with NO Anthropic credential, completes a real audit, makes ZERO model calls', async () => {
    const api = await startScriptedMessagesApi('answer');
    const url = `${site.origin}/market-entry`;
    const { code, stdout, stderr } = await runCli(['audit-page', url, '--run-id', 'e2e-no-api', '--no-dashboard'], api.baseURL, { noApi: true });
    await api.close();

    expect(stderr).not.toMatch(/FAILED|credential|ANTHROPIC_API_KEY/);
    expect(code).toBe(0);
    expect(stdout).toMatch(/AI mode no-api \(deterministic — no model API calls\)/);
    expect(stdout).toMatch(/Model API calls: 0 \(AI mode no-api\)/);
    expect(api.received).toBe(0); // nothing reached the (stand-in) Messages API

    const data = JSON.parse(readFileSync(runPaths(join(dataDir, 'projects'), projectNameFor(url), 'e2e-no-api').dataJson, 'utf-8')) as AuditData;
    expect(data.run.aiMode).toBe('no-api');
    expect(data.run.policyVersion).toContain('+ai-no-api+');
    expect(data.findings.length).toBeGreaterThan(0);
    expect(data.statusCounts).toBeDefined();
    const noApiPaths = runPaths(join(dataDir, 'projects'), projectNameFor(url), 'e2e-no-api');
    expect(existsSync(noApiPaths.reportXlsx)).toBe(true);
    expect(existsSync(noApiPaths.figmaPlanJson)).toBe(true); // the plan needs no model call, in any AI mode (OUT-4)
    expect(existsSync(noApiPaths.reportHtml)).toBe(true); // the standalone report also needs no model call, in any AI mode
    expect(runStatus('e2e-no-api')).toBe('COMPLETE');
  }, 180_000);

  it('anthropic-api is disabled unless configured: asked for without a credential, it refuses to start — nothing runs', async () => {
    const api = await startScriptedMessagesApi('answer');
    const url = `${site.origin}/market-entry`;
    const { code, stderr } = await runCli(['audit-page', url, '--run-id', 'e2e-api-no-key', '--no-dashboard'], api.baseURL, { noApi: true, env: { AI_MODE: 'anthropic-api' } });
    await api.close();
    expect(code).toBe(1);
    expect(stderr).toMatch(/AI_MODE=anthropic-api needs ANTHROPIC_API_KEY/);
    expect(api.received).toBe(0);
    expect(runStatus('e2e-api-no-key')).toBeUndefined();
  }, 60_000);

  it('reusing a run id is refused BEFORE anything is overwritten', async () => {
    const api = await startScriptedMessagesApi('answer');
    const url = `${site.origin}/market-entry`;
    const dataJson = runPaths(join(dataDir, 'projects'), projectNameFor(url), 'e2e-ok').dataJson;
    const before = readFileSync(dataJson, 'utf-8');
    const { code, stderr } = await runCli(['audit-page', url, '--run-id', 'e2e-ok', '--no-dashboard'], api.baseURL);
    await api.close();
    expect(code).toBe(1);
    expect(stderr).toMatch(/Run e2e-ok already exists \(COMPLETE\)/);
    expect(readFileSync(dataJson, 'utf-8')).toBe(before);
    expect(api.received).toBe(0); // refused before the browser or the model was touched
  }, 60_000);
});
