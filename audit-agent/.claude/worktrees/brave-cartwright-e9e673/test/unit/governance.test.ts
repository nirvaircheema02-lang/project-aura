import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Database } from '../../src/db/index.ts';
import { claimRun, createRun, createCheckpoint, decideCheckpoint, getRun, recoverStaleRuns } from '../../src/graph/state.ts';
import { runGraph, resumeGraph, type GraphDefinition } from '../../src/graph/engine.ts';
import { initTracing, spansForRun } from '../../src/tracing/index.ts';
import { escalateTimedOutGates, pendingGates } from '../../src/graph/gate-timeout.ts';
import { escalationFor, isCalibrationSample } from '../../src/skills/s8-confidence-escalation-policy.ts';
import { applyHistory, pageResultsFromDb, recordAuditHistory, writeFindings } from '../../src/skills/s7-audit-state-history.ts';
import { TerminalError } from '../../src/graph/retry.ts';
import { scoreCompliance, type Finding } from '../../src/skills/s0-result-contract.ts';

/**
 * Step 10 — the governance/observability layer: §2.6 tracing, S8 calibration
 * sampling, and §4.2's gate-timeout-to-fallback. All cross-cutting: none of it
 * required a change to an agent.
 */

const noSleep = async () => {};
let db: Database;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-gov-'));
  db = openDb(join(dir, 'test.db'));
  initTracing(db);
  createRun(db, { run_id: 'run-1', run_type: 'single-page', url: 'https://www.kenresearch.com/x', ds_registry_version: 'v', policy_version: 'p' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('§2.6 execution tracing', () => {
  it('records one span per node, keyed to the run, without any agent knowing about tracing', async () => {
    const graph: GraphDefinition = {
      start: 'a',
      nodes: { a: async () => 1, b: async (_c, n: number) => n + 1 },
      executionTypes: { a: 'deterministic', b: 'ai' },
      edges: [{ type: 'sequential', from: 'a', to: 'b' }],
    };
    await runGraph(db, 'run-1', graph, undefined, noSleep);

    const spans = spansForRun(db, 'run-1');
    expect(spans.map((s) => s.node_id)).toEqual(['a', 'b']);
    expect(spans.every((s) => s.status === 'OK')).toBe(true);
    expect(spans.every((s) => s.ended_at !== null && s.ended_at >= s.started_at)).toBe(true);
  });

  it('records EVERY retry attempt as its own span, so a retry is visible as a retry', async () => {
    let attempts = 0;
    const graph: GraphDefinition = {
      start: 'flaky',
      nodes: {
        flaky: async () => {
          attempts++;
          if (attempts < 3) throw new Error('transient');
          return 'ok';
        },
      },
      executionTypes: { flaky: 'deterministic' }, // 3 attempts
      edges: [],
    };
    await runGraph(db, 'run-1', graph, undefined, noSleep);

    const spans = spansForRun(db, 'run-1').filter((s) => s.node_id === 'flaky');
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.attempt_number)).toEqual([1, 2, 3]);
    expect(spans.map((s) => s.status)).toEqual(['ERROR', 'ERROR', 'OK']);
  });

  it('a failed span carries the error, giving NODE_FAILURE escalations a diagnostic trail', async () => {
    const graph: GraphDefinition = {
      start: 'dead',
      nodes: { dead: async () => { throw new TerminalError('404 — page genuinely gone'); } },
      executionTypes: { dead: 'deterministic' },
      edges: [],
    };
    await runGraph(db, 'run-1', graph, undefined, noSleep);

    const span = spansForRun(db, 'run-1').find((s) => s.node_id === 'dead');
    expect(span?.status).toBe('ERROR');
    expect(span?.error_detail).toContain('404');
    const escalation = db.prepare("SELECT detail_json FROM escalation_queue WHERE run_id = ? AND reason = 'NODE_FAILURE'").get('run-1') as { detail_json: string };
    expect(JSON.parse(escalation.detail_json).error).toContain('404');
  });
});

describe('§4.2 gate timeout → fallback reviewer', () => {
  it('escalates a timed-out gate but leaves it PENDING — never auto-approved or auto-rejected', () => {
    createCheckpoint(db, 'run-1', 'publish_confirmation', -1_000); // already past its timeout
    const timedOut = escalateTimedOutGates(db);

    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toMatchObject({ runId: 'run-1', name: 'publish_confirmation', escalated: true });

    const checkpoint = db.prepare('SELECT status FROM checkpoints WHERE run_id = ? AND name = ?').get('run-1', 'publish_confirmation') as { status: string };
    expect(checkpoint.status).toBe('PENDING'); // the decision is still a human's to make

    const escalation = db.prepare("SELECT detail_json FROM escalation_queue WHERE run_id = ? AND finding_id = 'gate-timeout:publish_confirmation'").get('run-1') as { detail_json: string };
    expect(JSON.parse(escalation.detail_json).kind).toBe('GATE_TIMEOUT');
  });

  it('escalates once, not once per check — a gate left over a weekend produces one queue item', () => {
    createCheckpoint(db, 'run-1', 'scope_confirmation', -1_000);
    escalateTimedOutGates(db);
    escalateTimedOutGates(db);
    const second = escalateTimedOutGates(db);
    expect(second[0]?.escalated).toBe(false);
    const count = db.prepare("SELECT COUNT(*) as n FROM escalation_queue WHERE finding_id = 'gate-timeout:scope_confirmation'").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('does not escalate a gate that is still within its timeout', () => {
    createCheckpoint(db, 'run-1', 'scope_confirmation', 60_000);
    expect(escalateTimedOutGates(db)).toEqual([]);
    expect(pendingGates(db)[0]).toMatchObject({ runId: 'run-1', name: 'scope_confirmation', timedOut: false });
  });

  it('a timed-out gate still resumes normally once a human finally decides', async () => {
    const graph: GraphDefinition = {
      start: 'a',
      nodes: { a: async (_c, n: number) => n, b: async (_c, n: number) => n * 2 },
      executionTypes: { a: 'deterministic', b: 'deterministic' },
      edges: [{ type: 'gate', from: 'a', to: 'b', name: 'publish_confirmation', timeoutMs: -1_000 }],
    };
    const paused = await runGraph(db, 'run-1', graph, 21, noSleep);
    expect(paused.kind).toBe('paused');

    escalateTimedOutGates(db);
    // Still paused after the timeout: the run waits for a person, it does not proceed.
    expect((await resumeGraph(db, 'run-1', graph, 'a', 21, noSleep)).kind).toBe('paused');

    decideCheckpoint(db, 'run-1', 'publish_confirmation', 'APPROVED', 'fallback@kenresearch.com');
    const resumed = await resumeGraph(db, 'run-1', graph, 'a', 21, noSleep);
    expect(resumed).toEqual({ kind: 'complete', result: 42 });
    expect(getRun(db, 'run-1')?.status).toBe('COMPLETE');
  });
});

describe('resume after a restart reads finished pages back from SQLite', () => {
  /**
   * The gap this closes: a run paused at the Publish Gate and resumed in a NEW
   * process has an empty in-memory collector. Without this, A4 would consolidate
   * zero pages and report a fully-audited site as having audited nothing.
   */
  function finding(pageId: string, classification: Finding['classification'], findingId: string): Finding {
    return {
      identity: { auditId: 'audit-1', runId: 'run-1', findingId, timestamp: '2026-09-11T10:00:00.000Z', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1' },
      location: { url: `https://www.kenresearch.com/${pageId}`, pageId, pageName: pageId.toUpperCase(), templateFamily: 'Consulting', section: 'Hero', captureState: 'default' },
      component: { productionType: 'button', productionLabel: 'CTA', dsComponent: 'Button', dsVariant: 'primary', signature: `sig-${findingId}` },
      classification,
      comparison: { mismatches: [], ruleViolations: [] },
      quality: { severity: 'LOW', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
      action: { recommendation: 'x', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
      history: { previousStatus: null, currentStatus: classification, delta: null, previousRunId: null },
    };
  }

  it('restores every page of the run, with its compliance rescored from the stored findings', () => {
    writeFindings(db, [
      finding('p1', 'MATCH', 'f1'),
      finding('p1', 'DEVIATION', 'f2'),
      finding('p2', 'MATCH', 'f3'),
    ]);
    recordAuditHistory(db, { pageId: 'p1', runId: 'run-1', domHash: 'dom-1', dsRegistryVersion: 'ds-hash' });

    const restored = pageResultsFromDb(db, 'run-1');
    expect(restored.map((p) => p.pageId).sort()).toEqual(['p1', 'p2']);

    const p1 = restored.find((p) => p.pageId === 'p1')!;
    expect(p1.findings).toHaveLength(2);
    expect(p1.compliance.compliancePercent).toBe(50); // 1 MATCH ÷ (1 MATCH + 1 DEVIATION)
    expect(p1.templateFamily).toBe('Consulting'); // survives the restart, so A4 can group by family
    expect(p1.domHash).toBe('dom-1');
  });

  it('restores only this run\'s pages, never a previous run\'s', () => {
    writeFindings(db, [finding('p1', 'MATCH', 'f1'), { ...finding('p9', 'MATCH', 'f9'), identity: { ...finding('p9', 'MATCH', 'f9').identity, runId: 'run-0' } }]);
    expect(pageResultsFromDb(db, 'run-1').map((p) => p.pageId)).toEqual(['p1']);
  });

  it('returns nothing rather than throwing when a run finished no pages at all', () => {
    expect(pageResultsFromDb(db, 'run-1')).toEqual([]);
  });
});

describe('S7 re-audit deltas (stable element ids)', () => {
  function f(runId: string, findingId: string, classification: Finding['classification'], signature: string, label: string, reasons: string[] = [], previousStatus: Finding['classification'] | null = null): Finding {
    return {
      identity: { auditId: 'a', runId, findingId, timestamp: '2026-09-11T10:00:00.000Z', dsRegistryVersion: 'ds', policyVersion: 'p' },
      location: { url: 'https://www.kenresearch.com/p1', pageId: 'p1', pageName: 'P1', templateFamily: null, section: `section of ${label}`, captureState: 'default' },
      component: { productionType: 'button', productionLabel: label, dsComponent: 'Button', dsVariant: 'primary', signature },
      classification,
      comparison: { mismatches: classification === 'DEVIATION' ? [{ property: 'height', actual: '44px', expected: '48px', expectedToken: '--button-height-md', comparison: 'length-px', delta: -4 }] : [], ruleViolations: [] },
      quality: { severity: 'LOW', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: reasons.length ? 'QUEUED' : 'NONE', escalationReasons: reasons, evidence: [], visualVerdict: 'NOT_CHECKED' },
      action: { recommendation: 'x', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
      history: { previousStatus, currentStatus: classification, delta: null, previousRunId: null },
    };
  }
  const NC = ['NOT_COMPARED', 'MODEL_OMITTED'];
  let clock = 1;
  function baseline(runId: string, findings: Finding[]) {
    if (!getRun(db, runId)) createRun(db, { run_id: runId, run_type: 'full-site', url: `https://www.kenresearch.com/${runId}`, ds_registry_version: 'v', policy_version: 'p' });
    writeFindings(db, findings);
    db.prepare('INSERT INTO audit_history (page_id, run_id, dom_hash, ds_registry_version, completed_at) VALUES (?, ?, ?, ?, ?)').run('p1', runId, 'd', 'ds', clock++);
  }

  it('a status change is a delta on ONE finding: DEVIATION → MATCH is RESOLVED, MATCH → DEVIATION is a REGRESSION', () => {
    baseline('run-0', [f('run-0', 'el-A', 'DEVIATION', 'sig-A', 'CTA A'), f('run-0', 'el-B', 'MATCH', 'sig-B', 'CTA B')]);
    const out = applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-A', 'MATCH', 'sig-A', 'CTA A'), f('run-1', 'el-B', 'DEVIATION', 'sig-B', 'CTA B')]);
    expect(out).toHaveLength(2); // no phantom rows
    expect(out.find((x) => x.identity.findingId === 'el-A')?.history.delta).toBe('RESOLVED');
    expect(out.find((x) => x.identity.findingId === 'el-B')?.history.delta).toBe('REGRESSION');
  });

  it('an issue whose element is gone is RESOLVED with its OWN component, flagged absent, and never scored', async () => {
    baseline('run-0', [f('run-0', 'el-A', 'DEVIATION', 'sig-A', 'CTA A'), f('run-0', 'el-B', 'MATCH', 'sig-B', 'CTA B'), f('run-0', 'el-C', 'DEVIATION', 'sig-C', 'CTA C')]);
    const out = applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-B', 'MATCH', 'sig-B', 'CTA B'), f('run-1', 'el-C', 'DEVIATION', 'sig-C', 'CTA C')]);
    const gone = out.find((x) => x.identity.findingId === 'el-A')!;
    expect(gone.history).toMatchObject({ delta: 'RESOLVED', absentThisRun: true, previousStatus: 'DEVIATION' });
    expect(gone.component.productionLabel).toBe('CTA A');
    expect(gone.action.recommendation).toContain('Button: height');
    // Scored on what is actually on the page: 1 MATCH / (1 MATCH + 1 DEVIATION) — the gone element adds nothing.
    const { buildAuditData } = await import('../../src/agents/c2-json-writer/index.ts');
    const page = { runId: 'run-1', pageId: 'p1', url: 'u', pageName: 'P1', templateFamily: null, domHash: 'd', dsRegistryVersion: 'ds', policyVersion: 'p', findings: out, compliance: scoreCompliance(out), coverage: { sectionsAnalyzed: 1, componentsDetected: 2, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] }, capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 } };
    const data = buildAuditData({ runId: 'run-1', auditId: 'a', mode: 'single-page', startedAt: 't', targetUrl: 'u', pages: [page], failedPages: [] });
    expect(data.websiteSummary.compliancePercent).toBe(50);
    expect(data.websiteSummary.componentsChecked).toBe(2);
    expect(data.reAudit.resolved).toBe(1);
    expect(data.componentSummary.reduce((n, r) => n + r.instances, 0)).toBe(2);
  });

  it('a component that could not be compared keeps its prior issue — flagged, not hidden and not "fixed"', () => {
    baseline('run-0', [f('run-0', 'el-A', 'DEVIATION', 'sig-A', 'CTA A'), f('run-0', 'el-A2', 'DEVIATION', 'sig-A', 'CTA A twin')]);
    const out = applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-A', 'MATCH', 'sig-A', 'CTA A', NC)]);
    const a = out.find((x) => x.identity.findingId === 'el-A')!;
    expect(a.history).toMatchObject({ previousStatus: 'DEVIATION', delta: null });
    expect(a.quality.escalationReasons).toContain('PRIOR_ISSUE_UNVERIFIED');
    // A sibling with the SAME signature that really is gone is still reported resolved.
    expect(out.find((x) => x.identity.findingId === 'el-A2')?.history.delta).toBe('RESOLVED');
  });

  it('DEVIATION → not compared → DEVIATION reads STILL OPEN, not a new issue', () => {
    baseline('run-0', [f('run-0', 'el-A', 'DEVIATION', 'sig-A', 'CTA A')]);
    baseline('run-1', applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-A', 'MATCH', 'sig-A', 'CTA A', NC)]));
    const out = applyHistory(db, 'p1', 'run-2', [f('run-2', 'el-A', 'DEVIATION', 'sig-A', 'CTA A')]);
    expect(out.find((x) => x.identity.findingId === 'el-A')?.history).toMatchObject({ previousStatus: 'DEVIATION', delta: 'STILL_OPEN' });
  });

  // Third-pass review: B4 and B6 share one element id, and B3's routing can flip between runs.
  it('a component first routed to B6 and matched later is a NEW ISSUE, never a regression', () => {
    baseline('run-0', [f('run-0', 'el-N', 'NEW_COMPONENT', 'sig-N', 'Card N'), f('run-0', 'el-D', 'DS_CANDIDATE', 'sig-D', 'Card D')]);
    const out = applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-N', 'DEVIATION', 'sig-N', 'Card N'), f('run-1', 'el-D', 'INCORRECT', 'sig-D', 'Card D')]);
    expect(out.find((x) => x.identity.findingId === 'el-N')?.history).toMatchObject({ previousStatus: 'NEW_COMPONENT', delta: 'NEW_ISSUE' });
    expect(out.find((x) => x.identity.findingId === 'el-D')?.history).toMatchObject({ previousStatus: 'DS_CANDIDATE', delta: 'NEW_ISSUE' });
  });

  it('an open issue on an element routed to B6 this run stays attached as PRIOR_ISSUE_UNVERIFIED — never RESOLVED — and survives a third run', () => {
    baseline('run-0', [f('run-0', 'el-X', 'DEVIATION', 'sig-X', 'CTA X')]);
    const run1 = applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-X', 'NEW_COMPONENT', 'sig-X', 'CTA X')]);
    const x = run1.find((y) => y.identity.findingId === 'el-X')!;
    expect(run1).toHaveLength(1); // no absent-RESOLVED record either: the element is on the page
    expect(x.history).toMatchObject({ previousStatus: 'DEVIATION', delta: null });
    expect(x.quality.escalationReasons).toContain('PRIOR_ISSUE_UNVERIFIED');
    expect(x.quality.escalationStatus).toBe('QUEUED');
    baseline('run-1', run1);
    const run2 = applyHistory(db, 'p1', 'run-2', [f('run-2', 'el-X', 'DEVIATION', 'sig-X', 'CTA X')]);
    expect(run2.find((y) => y.identity.findingId === 'el-X')?.history).toMatchObject({ previousStatus: 'DEVIATION', delta: 'STILL_OPEN' });
  });

  it('a compliant component routed to B6 has no knowable delta; a B6 record never carries a MATCH forward', () => {
    baseline('run-0', [f('run-0', 'el-M', 'MATCH', 'sig-M', 'CTA M')]);
    const run1 = applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-M', 'NEW_COMPONENT', 'sig-M', 'CTA M')]);
    expect(run1[0]!.history).toMatchObject({ previousStatus: 'MATCH', delta: null });
    expect(run1[0]!.quality.escalationReasons).not.toContain('PRIOR_ISSUE_UNVERIFIED');
    baseline('run-1', run1);
    const run2 = applyHistory(db, 'p1', 'run-2', [f('run-2', 'el-M', 'DEVIATION', 'sig-M', 'CTA M')]);
    expect(run2[0]!.history.delta).toBe('NEW_ISSUE');
  });

  it('an element that was gone and is back is judged afresh — the RESOLVED record is not a compliant baseline', () => {
    baseline('run-0', [f('run-0', 'el-G', 'DEVIATION', 'sig-G', 'CTA G')]);
    const run1 = applyHistory(db, 'p1', 'run-1', []);
    expect(run1[0]!.history).toMatchObject({ delta: 'RESOLVED', absentThisRun: true });
    baseline('run-1', run1);
    const run2 = applyHistory(db, 'p1', 'run-2', [f('run-2', 'el-G', 'DEVIATION', 'sig-G', 'CTA G')]);
    expect(run2[0]!.history).toMatchObject({ previousStatus: null, delta: 'NEW_ISSUE' });
  });

  describe('a changed comparison baseline is never read as a page change', () => {
    const withBaseline = (x: Finding, change: { ds?: string; policy?: string; variant?: string }): Finding => ({
      ...x,
      identity: { ...x.identity, dsRegistryVersion: change.ds ?? x.identity.dsRegistryVersion, policyVersion: change.policy ?? x.identity.policyVersion },
      component: { ...x.component, dsVariant: change.variant ?? x.component.dsVariant },
    });

    it('MATCH → DEVIATION across a Design System edit is a NEW ISSUE, labelled with why', () => {
      baseline('run-0', [f('run-0', 'el-A', 'MATCH', 'sig-A', 'CTA A')]);
      const out = applyHistory(db, 'p1', 'run-1', [withBaseline(f('run-1', 'el-A', 'DEVIATION', 'sig-A', 'CTA A'), { ds: 'ds-2' })]);
      expect(out[0]!.history.delta).toBe('NEW_ISSUE');
      expect(out[0]!.history.baselineChanged?.join(' ')).toMatch(/Design System changed since run run-0/);
    });

    it('DEVIATION → MATCH across a browser / policy bump is not claimed as RESOLVED', () => {
      baseline('run-0', [f('run-0', 'el-A', 'DEVIATION', 'sig-A', 'CTA A')]);
      const out = applyHistory(db, 'p1', 'run-1', [withBaseline(f('run-1', 'el-A', 'MATCH', 'sig-A', 'CTA A'), { policy: 'p-chromium@154' })]);
      expect(out[0]!.history.delta).toBeNull();
      expect(out[0]!.history.baselineChanged?.join(' ')).toMatch(/audit policy \/ browser changed/);
    });

    it('MATCH → DEVIATION against a DIFFERENT DS variant is a NEW ISSUE (B3 matched differently)', () => {
      baseline('run-0', [f('run-0', 'el-A', 'MATCH', 'sig-A', 'CTA A')]);
      const out = applyHistory(db, 'p1', 'run-1', [withBaseline(f('run-1', 'el-A', 'DEVIATION', 'sig-A', 'CTA A'), { variant: 'ghost' })]);
      expect(out[0]!.history.delta).toBe('NEW_ISSUE');
      expect(out[0]!.history.baselineChanged?.join(' ')).toMatch(/compared against Button\/ghost this run, Button\/primary/);
    });

    it('with the baseline unchanged, MATCH → DEVIATION is still a REGRESSION — the guard only fires on a real change', () => {
      baseline('run-0', [f('run-0', 'el-A', 'MATCH', 'sig-A', 'CTA A')]);
      const out = applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-A', 'DEVIATION', 'sig-A', 'CTA A')]);
      expect(out[0]!.history.delta).toBe('REGRESSION');
      expect(out[0]!.history.baselineChanged).toBeUndefined();
    });

    // Third-pass review CH-1: the guard must not be defeated by an UNDECIDED run sitting between
    // the measured baseline and the next measured run — exactly the upgrade path Decision Log #31
    // describes (anthropic-api once, then no-api, whose different matching strategy can leave an
    // element undecided for a run before it is measured again).
    it('a mode switch straddling an intervening undecided run is still caught — never a false REGRESSION or RESOLVED', () => {
      // run-0 measured MATCH under anthropic-api's policy.
      baseline('run-0', [withBaseline(f('run-0', 'el-A', 'MATCH', 'sig-A', 'CTA A'), { policy: 'p-anthropic-api' })]);
      // run-1: no-api could not decide it (NEEDS_REVIEW) — the DIRECT prior record is now undecided,
      // under no-api's OWN policy (different from run-0's).
      const run1 = applyHistory(db, 'p1', 'run-1', [withBaseline(f('run-1', 'el-A', 'NEEDS_REVIEW', 'sig-A', 'CTA A'), { policy: 'p-no-api' })]);
      expect(run1[0]!.history).toMatchObject({ previousStatus: 'MATCH', delta: null });
      // The carried baseline still points at run-0 (the run that actually measured MATCH) — not run-1.
      expect(run1[0]!.history.baselineOf).toMatchObject({ runId: 'run-0', policyVersion: 'p-anthropic-api' });
      baseline('run-1', run1);

      // run-2: measured again, DEVIATION, under the SAME policy as run-1 (no-api). A check against
      // the DIRECT prior (run-1) alone would see NO policy change and wrongly publish REGRESSION;
      // the real baseline (run-0) DID change policy, so this must be NEW_ISSUE instead.
      const run2 = applyHistory(db, 'p1', 'run-2', [withBaseline(f('run-2', 'el-A', 'DEVIATION', 'sig-A', 'CTA A'), { policy: 'p-no-api' })]);
      expect(run2[0]!.history.delta).toBe('NEW_ISSUE');
      expect(run2[0]!.history.baselineChanged?.join(' ')).toMatch(/audit policy \/ browser changed since run run-0/);

      // Symmetric RESOLVED-direction check: a bad baseline, undecided in between, fixed later under
      // a still-different policy from the ORIGINAL baseline must not be claimed as RESOLVED.
      baseline('run-0b', [withBaseline(f('run-0b', 'el-B', 'INCORRECT', 'sig-B', 'CTA B'), { policy: 'p-anthropic-api' })]);
      const run1b = applyHistory(db, 'p1', 'run-1b', [withBaseline(f('run-1b', 'el-B', 'NEEDS_REVIEW', 'sig-B', 'CTA B'), { policy: 'p-no-api' })]);
      baseline('run-1b', run1b);
      const run2b = applyHistory(db, 'p1', 'run-2b', [withBaseline(f('run-2b', 'el-B', 'MATCH', 'sig-B', 'CTA B'), { policy: 'p-no-api' })]);
      expect(run2b[0]!.history.delta).toBeNull();
      expect(run2b[0]!.history.baselineChanged?.join(' ')).toMatch(/audit policy \/ browser changed since run run-0b/);
    });

    it('every output says so: C2 counts it, and the dashboard, Excel and Figma label it', async () => {
      baseline('run-0', [f('run-0', 'el-A', 'MATCH', 'sig-A', 'CTA A'), f('run-0', 'el-B', 'DEVIATION', 'sig-B', 'CTA B'), f('run-0', 'el-C', 'DEVIATION', 'sig-C', 'CTA C')]);
      const out = applyHistory(db, 'p1', 'run-1', [
        withBaseline(f('run-1', 'el-A', 'DEVIATION', 'sig-A', 'CTA A'), { ds: 'ds-2' }),
        withBaseline(f('run-1', 'el-B', 'MATCH', 'sig-B', 'CTA B', NC), { ds: 'ds-2' }),
        withBaseline(f('run-1', 'el-C', 'NEW_COMPONENT', 'sig-C', 'CTA C'), { ds: 'ds-2' }),
      ]);
      const { buildAuditData } = await import('../../src/agents/c2-json-writer/index.ts');
      const page = { runId: 'run-1', pageId: 'p1', url: 'u', pageName: 'P1', templateFamily: null, domHash: 'd', dsRegistryVersion: 'ds-2', policyVersion: 'p', findings: out, compliance: scoreCompliance(out), coverage: { sectionsAnalyzed: 1, componentsDetected: 3, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] }, capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 } };
      const data = buildAuditData({ runId: 'run-1', auditId: 'a', mode: 'single-page', startedAt: '2026-09-11T10:00:00.000Z', targetUrl: 'u', pages: [page], failedPages: [] });
      expect(data.reAudit).toMatchObject({ regressions: 0, resolved: 0, newIssues: 1, unverified: 2 });
      expect(data.reAudit.baselineChanges).toEqual([{ note: expect.stringMatching(/^Design System changed since run run-0/), findings: 1 }]);

      // Figma 07 keeps the two unverified prior issues — they have no delta but must not vanish.
      const { buildPublishPlan } = await import('../../src/figma/publish-plan.ts');
      const history = buildPublishPlan(data, 'test').pages['07 Re-Audit History'];
      expect(history.rows.map((r) => r[3])).toEqual(expect.arrayContaining(['NEW_ISSUE (baseline changed)', 'prior DEVIATION unverified', 'prior DEVIATION unverified']));
      expect(history.tiles.find((t) => t.label === 'Prior issues unverified')?.value).toBe('2');

      // Excel 04 says which prior issue rides unverified on a not-compared row.
      const { writeExcelReport } = await import('../../src/agents/c1-excel-reporter/index.ts');
      const ExcelJS = (await import('exceljs')).default;
      const xlsx = join(dir, 'r.xlsx');
      await writeExcelReport(xlsx, data);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(xlsx);
      const sheet = wb.getWorksheet('04 All Findings')!;
      const header = (sheet.getRow(1).values as unknown[]).indexOf('Re-audit');
      const labels = sheet.getColumn(header).values.slice(2).map(String);
      expect(labels).toEqual(expect.arrayContaining(['NEW_ISSUE (baseline changed)', 'prior DEVIATION unverified']));

      // The dashboard shows the run-level change and the per-finding label.
      const { renderRun } = await import('../../src/dashboard/views/render.ts');
      const html = renderRun('proj', data, '/evidence');
      expect(html).toMatch(/The comparison baseline changed since that run/);
      expect(html).toMatch(/2 prior issue\(s\) not re-verified/);
      expect(html).toContain('NEW_ISSUE (baseline changed)');
    });
  });

  it('the dashboard never lists a gone element as a MATCH: its MATCH rows agree with C2', async () => {
    baseline('run-0', [f('run-0', 'el-A', 'DEVIATION', 'sig-A', 'CTA A'), f('run-0', 'el-B', 'MATCH', 'sig-B', 'CTA B')]);
    const out = applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-B', 'MATCH', 'sig-B', 'CTA B')]);
    const { buildAuditData } = await import('../../src/agents/c2-json-writer/index.ts');
    const page = { runId: 'run-1', pageId: 'p1', url: 'u', pageName: 'P1', templateFamily: null, domHash: 'd', dsRegistryVersion: 'ds', policyVersion: 'p', findings: out, compliance: scoreCompliance(out), coverage: { sectionsAnalyzed: 1, componentsDetected: 1, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] }, capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 } };
    const data = buildAuditData({ runId: 'run-1', auditId: 'a', mode: 'single-page', startedAt: '2026-09-11T10:00:00.000Z', targetUrl: 'u', pages: [page], failedPages: [] });
    const { renderRun } = await import('../../src/dashboard/views/render.ts');
    const html = renderRun('proj', data, '/evidence');
    const rowsWith = (status: string) => html.match(new RegExp(`<tr data-classification="${status}"`, 'g'))?.length ?? 0;
    expect(rowsWith('MATCH')).toBe(data.websiteSummary.match);
    expect(rowsWith('RESOLVED')).toBe(1);
    expect(html).toContain('RESOLVED — not on page');
  });

  // Third-pass review OUT-1 + OUT-2: a sampled listing must be visible somewhere in every
  // output, and "Resolved" (S7's record of a gone element) must never carry the same bare label
  // as "resolved" (data.reAudit.resolved, an actually fixed issue) — they are different numbers.
  it('a sampled listing is visible in every output, and the two different "resolved" numbers are never confused', async () => {
    // el-A: really fixed since run-0 (DEVIATION -> MATCH) — data.reAudit.resolved counts this.
    // el-B: gone since run-0 — S7's absentThisRun RESOLVED record, a DIFFERENT count.
    baseline('run-0', [f('run-0', 'el-A', 'DEVIATION', 'sig-A', 'CTA A'), f('run-0', 'el-B', 'DEVIATION', 'sig-B', 'CTA B'), f('run-0', 'el-C', 'MATCH', 'sig-C', 'CTA C')]);
    const out = applyHistory(db, 'p1', 'run-1', [f('run-1', 'el-A', 'MATCH', 'sig-A', 'CTA A'), f('run-1', 'el-C', 'MATCH', 'sig-C', 'CTA C')]);
    const { buildAuditData } = await import('../../src/agents/c2-json-writer/index.ts');
    const page = {
      runId: 'run-1',
      pageId: 'p1',
      url: 'u',
      pageName: 'P1',
      templateFamily: null,
      domHash: 'd',
      dsRegistryVersion: 'ds',
      policyVersion: 'p',
      findings: out,
      compliance: scoreCompliance(out),
      coverage: {
        sectionsAnalyzed: 1,
        componentsDetected: 2,
        excludedPersonalized: 0,
        excludedOffDomain: 0,
        sampledListings: [{ section: 'Footer · nav-link like "Home"', sampled: 5, totalObserved: 29 }],
        unexpandedStates: [],
        droppedRefs: [],
        truncation: [],
      },
      capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
    };
    const data = buildAuditData({ runId: 'run-1', auditId: 'a', mode: 'single-page', startedAt: '2026-09-11T10:00:00.000Z', targetUrl: 'u', pages: [page], failedPages: [] });

    // The two counts are genuinely different — the scenario the bug needed to be reachable at
    // all. reAudit.resolved counts every RESOLVED delta (el-A really fixed AND el-B's own
    // absent-element record, which S7 also gives a RESOLVED delta); statusCounts.RESOLVED counts
    // only the absent-element records themselves — a narrower, DIFFERENT number, never the same
    // bare label.
    expect(data.reAudit.resolved).toBe(2); // el-A really fixed, el-B gone (both carry delta RESOLVED)
    expect(data.statusCounts?.RESOLVED).toBe(1); // only el-B's own absent-element record
    expect(data.coverageSummary.sampledListings).toEqual([{ pageUrl: 'u', section: 'Footer · nav-link like "Home"', sampled: 5, totalObserved: 29 }]);

    const { renderRun } = await import('../../src/dashboard/views/render.ts');
    const html = renderRun('proj', data, '/evidence');
    expect(html).toMatch(/<div class="n">1<\/div><div class="l">Resolved — not on page<\/div>/);
    expect(html).toMatch(/<div class="n">2<\/div><div class="l">Resolved since last run<\/div>/);
    expect(html).toContain('Footer · nav-link like &quot;Home&quot;');
    expect(html).toMatch(/5 of 29 audited/);

    const { buildWorkbook } = await import('../../src/agents/c1-excel-reporter/index.ts');
    const wb = await buildWorkbook(data);
    const values = new Map<string, unknown>();
    wb.getWorksheet('01 Executive Summary')!.eachRow((row, i) => {
      if (i > 1) values.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    expect(values.get('Resolved — not on page (history only, not the same as fixed)')).toBe(1);
    expect(values.get('Re-audit — resolved')).toBe(2);
    expect(String(values.get('Listings sampled (not fully enumerated)'))).toContain('5 of 29 audited');

    const { buildPublishPlan } = await import('../../src/figma/publish-plan.ts');
    const plan = buildPublishPlan(data, 'test');
    const overview = Object.fromEntries(plan.pages['00 Overview'].tiles.map((t) => [t.label, t.value]));
    expect(overview['Resolved — not on page']).toBe('1');
    expect(overview['Resolved since last run']).toBe('2');
    expect(overview).not.toHaveProperty('Resolved'); // the ambiguous bare label must be gone
  });
});

describe('interrupted runs never hold the one-active-run guard forever', () => {
  it('a RUNNING run whose process is gone is marked FAILED, with a note, and the target can be audited again', () => {
    // run-1 (from beforeEach) is owned by THIS process — it must be left alone.
    createRun(db, { run_id: 'run-dead', run_type: 'single-page', url: 'https://www.kenresearch.com/y', ds_registry_version: 'v', policy_version: 'p' });
    db.prepare('UPDATE runs SET owner_pid = 999999 WHERE run_id = ?').run('run-dead');
    // Before recovery the §2.5 guard refuses a second run against the same target.
    expect(() => createRun(db, { run_id: 'run-next', run_type: 'single-page', url: 'https://www.kenresearch.com/y', ds_registry_version: 'v', policy_version: 'p' })).toThrow(/already RUNNING/);

    const recovered = recoverStaleRuns(db, (pid) => pid !== 999999);
    expect(recovered.map((r) => r.runId)).toEqual(['run-dead']);
    expect(getRun(db, 'run-dead')?.status).toBe('FAILED');
    expect(getRun(db, 'run-1')?.status).toBe('RUNNING');
    const note = db.prepare("SELECT detail_json FROM escalation_queue WHERE run_id = 'run-dead'").get() as { detail_json: string };
    expect(JSON.parse(note.detail_json).error).toContain('is gone or has stopped responding');

    expect(() => createRun(db, { run_id: 'run-next', run_type: 'single-page', url: 'https://www.kenresearch.com/y', ds_registry_version: 'v', policy_version: 'p' })).not.toThrow();
  });

  it('a run paused at a gate is not "stale" — pausing is not failing', () => {
    createRun(db, { run_id: 'run-paused', run_type: 'full-site', url: 'https://www.kenresearch.com/', ds_registry_version: 'v', policy_version: 'p' });
    db.prepare("UPDATE runs SET owner_pid = 999999, status = 'AWAITING_SCOPE_CONFIRMATION' WHERE run_id = ?").run('run-paused');
    expect(recoverStaleRuns(db, () => false).map((r) => r.runId)).not.toContain('run-paused');
    expect(getRun(db, 'run-paused')?.status).toBe('AWAITING_SCOPE_CONFIRMATION');
  });

  it('wrapping a node failure keeps its failure class, so a TERMINAL page is not re-audited', async () => {
    const { PageAuditError } = await import('../../src/agents/page-graph.ts');
    const { classify } = await import('../../src/graph/retry.ts');
    const wrapped = new PageAuditError('B4', new TerminalError('B4: bad request — invalid schema'));
    expect(wrapped.nodeId).toBe('B4');
    expect(wrapped.message).toBe('B4: bad request — invalid schema'); // never 'B4: B4: …'
    expect(classify(wrapped)).toBe('TERMINAL');
  });
});

describe('gates and run ownership (second-pass review)', () => {
  it('resuming while the gate is still undecided puts the run back into its AWAITING state', async () => {
    const graph: GraphDefinition = {
      start: 'a',
      nodes: { a: async (_c, n: number) => n, b: async (_c, n: number) => n },
      executionTypes: { a: 'deterministic', b: 'deterministic' },
      edges: [{ type: 'gate', from: 'a', to: 'b', name: 'publish_confirmation', timeoutMs: 60_000 }],
    };
    await runGraph(db, 'run-1', graph, 1, noSleep);
    db.prepare("UPDATE runs SET status = 'RUNNING' WHERE run_id = 'run-1'").run(); // what a resume sets before routing
    expect((await resumeGraph(db, 'run-1', graph, 'a', 1, noSleep)).kind).toBe('paused');
    expect(getRun(db, 'run-1')?.status).toBe('AWAITING_PUBLISH_CONFIRMATION'); // not left RUNNING for recovery to fail
  });

  it('a gate can be decided once, and only if it is pending', () => {
    createCheckpoint(db, 'run-1', 'scope_confirmation', 60_000);
    expect(decideCheckpoint(db, 'run-1', 'scope_confirmation', 'APPROVED', 'a')).toBe(true);
    expect(decideCheckpoint(db, 'run-1', 'scope_confirmation', 'REJECTED', 'b')).toBe(false); // already decided
    expect(decideCheckpoint(db, 'run-1', 'publish_confirmation', 'APPROVED', 'a')).toBe(false); // never opened
    expect(decideCheckpoint(db, 'no-such-run', 'scope_confirmation', 'APPROVED', 'a')).toBe(false);
  });

  it('a resume claims the run atomically, with THIS process as owner — a second claim fails', () => {
    db.prepare("UPDATE runs SET status = 'AWAITING_SCOPE_CONFIRMATION', owner_pid = 999999 WHERE run_id = 'run-1'").run();
    expect(claimRun(db, 'run-1', ['AWAITING_SCOPE_CONFIRMATION'])).toBe(true);
    expect(getRun(db, 'run-1')).toMatchObject({ status: 'RUNNING', owner_pid: process.pid });
    expect(claimRun(db, 'run-1', ['AWAITING_SCOPE_CONFIRMATION'])).toBe(false);
  });

  it('a live PID that has stopped beating is stale (PID reuse); a fresh beat is not', () => {
    createRun(db, { run_id: 'run-silent', run_type: 'single-page', url: 'https://www.kenresearch.com/silent', ds_registry_version: 'v', policy_version: 'p' });
    db.prepare('UPDATE runs SET owner_pid = 424242, heartbeat_at = ? WHERE run_id = ?').run(Date.now() - 10 * 60_000, 'run-silent');
    createRun(db, { run_id: 'run-busy', run_type: 'single-page', url: 'https://www.kenresearch.com/busy', ds_registry_version: 'v', policy_version: 'p' });
    db.prepare('UPDATE runs SET owner_pid = 434343, heartbeat_at = ? WHERE run_id = ?').run(Date.now(), 'run-busy');
    const recovered = recoverStaleRuns(db, () => true).map((r) => r.runId);
    expect(recovered).toContain('run-silent');
    expect(recovered).not.toContain('run-busy');
  });

  it('a wrapped HTTP 4xx stays TERMINAL and keeps its status', async () => {
    const { PageAuditError } = await import('../../src/agents/page-graph.ts');
    const { classify } = await import('../../src/graph/retry.ts');
    const wrapped = new PageAuditError('B2', Object.assign(new Error('413 request_too_large'), { status: 413 }));
    expect(classify(wrapped)).toBe('TERMINAL');
    expect(wrapped.status).toBe(413);
    expect(classify(new PageAuditError('B2', Object.assign(new Error('529 overloaded'), { status: 529 })))).toBe('RETRYABLE');
  });
});

// Third-pass review OUT-6: an older data.json — written before needsReview/unverified arrays,
// statusCounts, or coverageSummary.sampledListings existed — must still render in the dashboard
// and the Excel report rather than crash on a missing field, and its review queue must never be
// falsely empty just because the newer arrays aren't there.
describe('legacy data.json (predates statusCounts/needsReview/unverified/coverageSummary.sampledListings)', () => {
  it('renders and reports without throwing, and recomputes the review queue from findings', async () => {
    const { buildAuditData } = await import('../../src/agents/c2-json-writer/index.ts');
    const findings: Finding[] = [
      { identity: { auditId: 'a', runId: 'run-1', findingId: 'f-nr', timestamp: 't', dsRegistryVersion: 'd', policyVersion: 'p' }, location: { url: 'u', pageId: 'p1', pageName: 'P1', templateFamily: null, section: 's', captureState: 'default' }, component: { productionType: 'button', productionLabel: 'B', dsComponent: null, dsVariant: null, signature: 'sig-nr' }, classification: 'NEEDS_REVIEW', comparison: { mismatches: [], ruleViolations: [] }, quality: { severity: 'INFO', confidence: 0.3, confidenceBand: 'LOW', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' }, action: { recommendation: 'r', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null }, history: { previousStatus: null, currentStatus: 'NEEDS_REVIEW', delta: null, previousRunId: null } },
      { identity: { auditId: 'a', runId: 'run-1', findingId: 'f-uv', timestamp: 't', dsRegistryVersion: 'd', policyVersion: 'p' }, location: { url: 'u', pageId: 'p1', pageName: 'P1', templateFamily: null, section: 's', captureState: 'default' }, component: { productionType: 'button', productionLabel: 'C', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig-uv' }, classification: 'MATCH', comparison: { mismatches: [], ruleViolations: [] }, quality: { severity: 'INFO', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: ['NOT_COMPARED'], evidence: [], visualVerdict: 'NOT_CHECKED' }, action: { recommendation: 'r', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null }, history: { previousStatus: null, currentStatus: 'MATCH', delta: null, previousRunId: null } },
    ] as Finding[];
    const page = {
      runId: 'run-1', pageId: 'p1', url: 'u', pageName: 'P1', templateFamily: null, domHash: 'd', dsRegistryVersion: 'ds', policyVersion: 'p', findings,
      compliance: scoreCompliance(findings),
      coverage: { sectionsAnalyzed: 1, componentsDetected: 2, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
      capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
    };
    const fresh = buildAuditData({ runId: 'run-1', auditId: 'a', mode: 'single-page', startedAt: '2026-09-14T10:00:00.000Z', targetUrl: 'u', pages: [page], failedPages: [] });

    // Simulate a data.json written by an older version of this codebase: strip every field
    // added after the base ComplianceScore/coverage shape existed, exactly as a real file on
    // disk from before those fields shipped would come back from JSON.parse.
    const legacy = JSON.parse(JSON.stringify(fresh));
    delete legacy.statusCounts;
    delete legacy.needsReview;
    delete legacy.unverified;
    delete legacy.websiteSummary.needsReview;
    delete legacy.websiteSummary.unverified;
    for (const c of legacy.componentSummary) delete c.needsReview;
    for (const p of legacy.pageSummary) delete p.compliance.needsReview;
    delete legacy.coverageSummary.sampledListings;

    const { renderRun } = await import('../../src/dashboard/views/render.ts');
    let html = '';
    expect(() => {
      html = renderRun('proj', legacy, '/evidence');
    }).not.toThrow();
    // The review queue is recomputed from the findings themselves, not left empty.
    expect(html).not.toContain('Nothing needs review in this run.');
    expect(html.match(/class="rv"/g)?.length).toBe(2); // the NEEDS_REVIEW finding AND the not-compared MATCH

    const { writeExcelReport } = await import('../../src/agents/c1-excel-reporter/index.ts');
    const { mkdtempSync: mkdtemp, rmSync: rm } = await import('node:fs');
    const { tmpdir: tmp } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const outDir = mkdtemp(joinPath(tmp(), 'audit-agent-legacy-'));
    try {
      await expect(writeExcelReport(joinPath(outDir, 'r.xlsx'), legacy)).resolves.not.toThrow();
    } finally {
      rm(outDir, { recursive: true, force: true });
    }
  });
});
