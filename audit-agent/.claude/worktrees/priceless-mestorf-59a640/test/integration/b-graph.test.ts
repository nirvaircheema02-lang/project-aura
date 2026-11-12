import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { openDb, type Database } from '../../src/db/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { BrowserPool, type RenderingPolicy } from '../../src/t-layer/browser.ts';
import { policyVersionFor } from '../../src/graph/run-metadata.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { auditPage } from '../../src/agents/page-graph.ts';
import { effectiveTokenMap } from '../../src/ds/catalog.ts';
import type { PageResult } from '../../src/skills/s0-result-contract.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { ScriptedLlmClient } from '../helpers/scripted-llm.ts';
import { KNOWN_WRONG_PAGE } from '../helpers/known-wrong-page.ts';

/**
 * End-to-end single-page audit (build sequence step 4) through the real
 * engine, real Chromium, the real Design System registry and the real
 * deterministic comparator — with a scripted stand-in for Claude, since AI
 * judgment cannot be exercised without credentials.
 *
 * The page is built with KNOWN-WRONG values measured against the real DS:
 * the hero CTA is 44px tall where the DS's effective --button-height-md is
 * 48px (the exact 26-token override D3 resolves), so a real deviation must
 * be found by measurement, not by the script.
 */

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let db: Database;
let registry: DsRegistry;
let dir: string;
let result: PageResult | undefined;
let llm: ScriptedLlmClient;

const PAGE = KNOWN_WRONG_PAGE;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-bgraph-'));
  const config = loadConfig();
  registry = await loadDsRegistry(config.designSystemPath);
  db = openDb(join(dir, 'audit.db'));
  server = await startLocalServer({ '/market-entry': { body: PAGE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  llm = new ScriptedLlmClient();

  result = await auditPage(
    `${server.origin}/market-entry`,
    { db, registry, aiMode: 'anthropic-api', llm, config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'evidence') },
    { runId: 'run-b-graph-1' },
  );
}, 180_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('B graph — single-page audit end to end', () => {
  it('runs every B node exactly once, batched per page rather than per component', () => {
    const nodes = llm.calls.map((c) => c.nodeId);
    expect(nodes.filter((n) => n === 'B1')).toHaveLength(1);
    expect(nodes.filter((n) => n === 'B3')).toHaveLength(1);
    expect(nodes.filter((n) => n === 'B4')).toHaveLength(1);
    expect(nodes.filter((n) => n === 'B6')).toHaveLength(1);
    expect(nodes.filter((n) => n === 'B2').length).toBeGreaterThan(0); // one call per section
  });

  it('detects the 44px-vs-48px deviation by MEASUREMENT against the real DS token', () => {
    const tokens = effectiveTokenMap(registry, 'editorial-light');
    expect(tokens.get('--button-height-md')).toBe('48px'); // the real effective override, not tokens.css's 40px

    const heightDeviation = result!.findings.find(
      (f) => f.classification === 'DEVIATION' && f.comparison.mismatches.some((m) => m.property === 'height'),
    );
    expect(heightDeviation).toBeDefined();
    const mismatch = heightDeviation!.comparison.mismatches.find((m) => m.property === 'height')!;
    expect(mismatch.actual).toBe('44px');
    expect(mismatch.expected).toBe('48px');
    expect(mismatch.expectedToken).toBe('--button-height-md');
    expect(mismatch.delta).toBe(-4);
    expect(mismatch.comparison).toBe('length-px');
  });

  it('passes the correctly-sized button as MATCH (no false positive on the compliant control)', () => {
    const match = result!.findings.find((f) => f.classification === 'MATCH' && f.component.productionLabel.includes('Book discovery'));
    expect(match).toBeDefined();
    expect(match!.comparison.mismatches).toEqual([]);
  });

  it('classifies a rule violation as INCORRECT with CRITICAL severity, not as a DEVIATION', () => {
    const incorrect = result!.findings.find((f) => f.classification === 'INCORRECT');
    expect(incorrect).toBeDefined();
    expect(incorrect!.comparison.ruleViolations[0]?.ruleId).toBe('R1.2');
    expect(incorrect!.quality.severity).toBe('CRITICAL'); // brand-identity rule → top severity per S5
  });

  it('routes unmatched components to B6 and proposes a deduped DS candidate for the repeated card', () => {
    const candidates = result!.findings.filter((f) => f.classification === 'DS_CANDIDATE');
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.action.registryUpdateRef).toBeTruthy();

    // Three identical cards → ONE governance proposal, not three (§2.5 rule 3 dedup).
    const cardFindings = result!.findings.filter((f) => f.component.productionLabel.startsWith('Report card'));
    expect(cardFindings).toHaveLength(3);
    expect(new Set(cardFindings.map((f) => f.action.registryUpdateRef)).size).toBe(1);
    // ...and each card is still its OWN finding: pattern identity dedupes proposals,
    // element identity (finding_id) stays distinct so each instance is separately reportable.
    expect(new Set(cardFindings.map((f) => f.identity.findingId)).size).toBe(3);

    const proposals = db.prepare('SELECT candidate_ref, status, proposed_by FROM registry_update_requests').all() as Array<{
      candidate_ref: string;
      status: string;
      proposed_by: string;
    }>;
    // One proposal per distinct repeated pattern (the cards, and the two identical nav links).
    expect(proposals.length).toBe(new Set(candidates.map((f) => f.action.registryUpdateRef)).size);
    expect(proposals.every((p) => p.status === 'PROPOSED' && p.proposed_by === 'B6')).toBe(true);
  });

  it('excludes the off-domain utility link from detection scope', () => {
    expect(result!.coverage.excludedOffDomain).toBeGreaterThan(0);
    expect(result!.findings.some((f) => f.component.productionLabel === 'IT Support')).toBe(false);
  });

  it('escalates the component holding an unresolved "0+" placeholder', () => {
    const placeholderFinding = result!.findings.find((f) => f.quality.escalationReasons.includes('PLACEHOLDER_VALUE'));
    expect(placeholderFinding).toBeDefined();
    expect(placeholderFinding!.quality.escalationStatus).toBe('QUEUED');
  });

  it('attaches B5 visual-only problems to the element\'s own finding — one finding per component', () => {
    const visual = result!.findings.find((f) => f.comparison.mismatches.some((m) => m.property.startsWith('visual:')));
    expect(visual).toBeDefined();
    expect(visual!.quality.visualVerdict).toBe('CONFIRMED');
    // The visual remark rides on a finding that was already a measured DEVIATION/INCORRECT…
    expect(visual!.comparison.mismatches.some((m) => !m.property.startsWith('visual:')) || visual!.comparison.ruleViolations.length > 0).toBe(true);
    // …so visual remarks can never inflate the compliance denominator.
    const scored = result!.findings.filter((f) => f.history.delta !== 'RESOLVED');
    expect(new Set(scored.map((f) => f.quality.evidence.find((e) => e.kind === 'computed-style')?.ref)).size).toBe(scored.length);
  });

  it('writes every S0 finding to SQLite with its full payload, and queues escalations', () => {
    const rows = db.prepare('SELECT finding_id, classification, payload_json FROM findings WHERE run_id = ?').all('run-b-graph-1') as Array<{
      finding_id: string;
      classification: string;
      payload_json: string;
    }>;
    expect(rows.length).toBe(result!.findings.length);
    const payload = JSON.parse(rows[0]!.payload_json);
    // Every S0 field group from v1.0 §12 is present.
    for (const group of ['identity', 'location', 'component', 'classification', 'comparison', 'quality', 'action', 'history']) {
      expect(payload).toHaveProperty(group);
    }
    const queued = db.prepare("SELECT COUNT(*) as n FROM escalation_queue WHERE run_id = ?").get('run-b-graph-1') as { n: number };
    expect(queued.n).toBe(result!.findings.filter((f) => f.quality.escalationStatus === 'QUEUED').length);
  });

  it('computes compliance with NEW_COMPONENT/DS_CANDIDATE excluded from the denominator (v1.0 §13)', () => {
    const c = result!.compliance;
    const denominator = c.match + c.deviation + c.incorrect;
    expect(denominator).toBeGreaterThan(0);
    expect(c.compliancePercent).toBe(Math.round((c.match / denominator) * 1000) / 10);
    expect(c.dsCandidate + c.newComponent).toBeGreaterThan(0); // present, but not scored
  });

  it('records the run, the DS registry version and a DOM hash for re-audit memoization', () => {
    const run = db.prepare('SELECT status, ds_registry_version FROM runs WHERE run_id = ?').get('run-b-graph-1') as {
      status: string;
      ds_registry_version: string;
    };
    expect(run.status).toBe('COMPLETE');
    expect(run.ds_registry_version).toBe(registry.version.dsRegistryVersion);
    const history = db.prepare('SELECT dom_hash FROM audit_history WHERE page_id = ?').get(result!.pageId) as { dom_hash: string };
    expect(history.dom_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the locked engine and its EXACT version in run metadata, and stamps it on every finding', () => {
    const run = db.prepare('SELECT policy_version, rendering_policy_json FROM runs WHERE run_id = ?').get('run-b-graph-1') as {
      policy_version: string;
      rendering_policy_json: string;
    };
    const rendering = JSON.parse(run.rendering_policy_json) as RenderingPolicy;
    const live = pool.renderingPolicy();
    expect(rendering.engine).toBe('chromium');
    expect(rendering.browserVersion).toBe(live.browserVersion);
    expect(rendering.playwrightVersion).toBe(live.playwrightVersion);
    expect(run.policy_version).toBe(policyVersionFor(live, 'anthropic-api'));
    expect(run.policy_version).toContain(`@${live.browserVersion}`);
    // One policy for the whole page: a finding produced under a different engine
    // build would otherwise look like a regression on the next run.
    expect(result!.policyVersion).toBe(run.policy_version);
    expect(new Set(result!.findings.map((f) => f.identity.policyVersion))).toEqual(new Set([run.policy_version]));
  });
});
