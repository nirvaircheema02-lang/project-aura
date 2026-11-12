import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config/index.ts';
import { openDb } from '../src/db/index.ts';
import { loadDsRegistry } from '../src/ds/d2-registry/index.ts';
import { BrowserPool } from '../src/t-layer/browser.ts';
import { Politeness } from '../src/t-layer/politeness.ts';
import { auditPage } from '../src/agents/page-graph.ts';
import { describeRenderingEngine } from '../src/graph/run-metadata.ts';
import { ScriptedLlmClient } from '../test/helpers/scripted-llm.ts';
import { startMockMessagesApi, WireCheckedLlmClient } from '../test/helpers/mock-messages-api.ts';

/**
 * PREFLIGHT — not an audit. Runs the complete single-page pipeline against a
 * REAL page (real browser, real capture, real B1–B6 request construction,
 * real SDK over HTTP) but answers every model call from the scripted
 * stand-in via a local Messages API stand-in. No credential, no spend.
 *
 * What it proves: the exact requests a real run will send for THIS page are
 * valid and inside API limits, and how big they are. What it does not prove:
 * anything about findings — the answers are scripted, so nothing it produces
 * may be reported as an audit result. Output goes to a scratch directory and a
 * scratch database, never to projects/ or audit-agent.db, so it cannot leak
 * into re-audit history.
 *
 *   node --experimental-strip-types scripts/preflight-wire.ts <url> <scratch-dir>
 */

const [url, outArg] = process.argv.slice(2);
if (!url || !outArg) {
  console.error('usage: preflight-wire.ts <url> <scratch-dir>');
  process.exit(2);
}
const outDir = resolve(outArg);
if (outDir.startsWith(resolve('projects'))) {
  console.error('refusing to write a preflight into projects/ — it is not an audit result');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const OPUS_5_INPUT_USD_PER_MTOK = 5;
const OPUS_5_OUTPUT_USD_PER_MTOK = 25;

const config = loadConfig();
const registry = await loadDsRegistry(config.designSystemPath);
const db = openDb(join(outDir, 'preflight.db'));
const api = await startMockMessagesApi();
const pool = new BrowserPool({ channel: config.browserChannel, userAgentProduct: config.politeness.userAgentProduct, contactEmail: config.politeness.contactEmail });
await pool.start();
const rendering = describeRenderingEngine(pool.renderingPolicy()); // read while the browser is up

const started = Date.now();
let outcome: 'completed' | string = 'completed';
let pageSummary: Record<string, unknown> = {};
try {
  const result = await auditPage(
    url,
    {
      db,
      registry,
      // The preflight measures the anthropic-api path's real requests — it is that mode by definition.
      aiMode: 'anthropic-api',
      llm: new WireCheckedLlmClient(api, new ScriptedLlmClient(), config.anthropicModel),
      config,
      pool,
      politeness: new Politeness(config.politeness.minNavigationIntervalMs),
      evidenceRoot: join(outDir, 'evidence'),
    },
    { runId: `preflight-${started}` },
  );
  pageSummary = {
    canonicalUrl: result.url,
    httpStatus: result.capture.httpStatus,
    renderSettled: result.capture.settled,
    console: result.capture.consoleSummary,
    criticalNetworkFailures: result.capture.criticalFailures,
    sectionsAnalyzed: result.coverage.sectionsAnalyzed,
    componentsDetected: result.coverage.componentsDetected,
    unexpandedStates: result.coverage.unexpandedStates.length,
    excludedOffDomain: result.coverage.excludedOffDomain,
    droppedRefs: result.coverage.droppedRefs,
    truncation: result.coverage.truncation,
  };
} catch (err) {
  outcome = `FAILED: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
} finally {
  await pool.stop().catch(() => {});
  await api.close();
  db.close();
}

const rows = api.checks.map((c) => ({
  node: c.node,
  images: c.images.length,
  largestImage: c.images.length ? c.images.map((i) => `${i.width}×${i.height}`).sort((a, b) => Number(b.split('×')[1]) - Number(a.split('×')[1]))[0] : '—',
  bodyKB: Math.round(c.bodyBytes / 1024),
  estInputTokens: c.estimatedInputTokens,
  maxTokens: c.maxTokens,
  effort: c.effort,
  problems: c.problems,
}));
const totalInput = rows.reduce((n, r) => n + r.estInputTokens, 0);
const problems = rows.flatMap((r) => r.problems.map((p) => `${r.node}: ${p}`));

const report = {
  kind: 'PREFLIGHT — scripted answers, NOT an audit result',
  url,
  outcome,
  durationSeconds: Math.round((Date.now() - started) / 1000),
  rendering,
  page: pageSummary,
  requests: rows,
  totals: {
    requests: rows.length,
    estimatedInputTokens: totalInput,
    estimatedInputCostUsd: Number(((totalInput / 1e6) * OPUS_5_INPUT_USD_PER_MTOK).toFixed(3)),
    note: `Output (including adaptive thinking) is not predictable offline; each 10k output tokens adds $${((10_000 / 1e6) * OPUS_5_OUTPUT_USD_PER_MTOK).toFixed(2)}.`,
  },
  problems,
};
writeFileSync(join(outDir, 'preflight-report.json'), JSON.stringify(report, null, 2));

console.log(`PREFLIGHT (scripted answers — not an audit) · ${url}`);
console.log(`outcome: ${outcome} · ${report.durationSeconds}s · ${rendering}`);
console.log('page:', JSON.stringify(pageSummary));
console.log('\nnode  imgs  largest       body KB  est.input tok  max_tokens  effort');
for (const r of rows) {
  console.log(`${r.node.padEnd(5)} ${String(r.images).padStart(4)}  ${String(r.largestImage).padEnd(12)} ${String(r.bodyKB).padStart(8)}  ${String(r.estInputTokens).padStart(13)}  ${String(r.maxTokens).padStart(10)}  ${r.effort ?? '—'}`);
}
console.log(`\n${rows.length} requests · ~${totalInput.toLocaleString()} input tokens · ~$${report.totals.estimatedInputCostUsd} input at Opus 5 list price`);
console.log(problems.length ? `\nLIMIT PROBLEMS (${problems.length}):\n  ${problems.join('\n  ')}` : '\nNo request exceeded any API limit.');
console.log(`\nreport: ${join(outDir, 'preflight-report.json')}`);
