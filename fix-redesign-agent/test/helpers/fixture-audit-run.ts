import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, FixPlan, FixPlanEntry } from '../../src/audit-link/index.ts';
import type { DsRegistry } from '../../src/ds/d2-registry/index.ts';

/**
 * Builds a FAKE audit-agent repo root in a temp dir — `package.json` (name: audit-agent) plus
 * `projects/<project>/runs/<run>/{run.json,data.json,fix-plan.json}` in audit-agent's own
 * layout — so R1 and the pipeline can be tested without touching the real audit-agent tree
 * and without a child process. Shapes follow the real contracts (S0 finding, Part 1 fix plan).
 */

export function makeFinding(overrides: { findingId: string; section?: string; label?: string; classification?: Finding['classification']; mismatches?: Finding['comparison']['mismatches'] }): Finding {
  return {
    identity: {
      auditId: 'audit-fixture-run',
      runId: 'fixture-run',
      findingId: overrides.findingId,
      timestamp: '2026-09-16T07:15:34.996Z',
      dsRegistryVersion: 'e'.repeat(64),
      policyVersion: 's8-bands-0.85/0.5+ai-no-api+browser-chromium@153.0.8010.12+playwright@1.63.0',
    },
    location: { url: 'http://127.0.0.1/fixture', pageId: '139240056fa7aa01', pageName: 'fixture', templateFamily: null, section: overrides.section ?? 'Header', captureState: 'default' },
    component: { productionType: 'button', productionLabel: overrides.label ?? 'Sign up', dsComponent: 'Button', dsVariant: 'primary · md · light', signature: '086f80596222341f87d033768e43e63f' },
    classification: overrides.classification ?? 'INCORRECT',
    comparison: {
      mismatches: overrides.mismatches ?? [
        { property: 'padding-left', actual: '12px', expected: '28px', expectedToken: '--button-px-md', comparison: 'length-px', delta: -16 },
        { property: 'font-weight', actual: '400', expected: '500', expectedToken: '--font-weight-medium', comparison: 'exact', delta: -100 },
      ],
      ruleViolations: [],
    },
    quality: { severity: 'HIGH', confidence: 0.95, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [{ kind: 'computed-style', ref: 'el-1', note: null, box: { x: 10, y: 20, width: 100, height: 40 } }], visualVerdict: 'NOT_CHECKED' },
    action: { recommendation: 'Use the DS Button primary md padding and weight tokens.', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: overrides.classification ?? 'INCORRECT', delta: 'NEW_ISSUE', previousRunId: null },
  };
}

export function makeFixPlanEntry(findingId: string, decision: FixPlanEntry['decision'] = 'fix'): FixPlanEntry {
  return { findingId, decision, decidedAt: '2026-09-17T10:00:00.000Z', decidedBy: 'reviewer@example.com', note: null, source: 'html-report' };
}

export interface FixtureRunOptions {
  projectName?: string;
  runId?: string;
  displayName?: string;
  targetUrl?: string;
  findings?: Finding[];
  /** `null` = write no fix-plan.json at all. */
  fixPlan?: FixPlan | null;
  /** Extra top-level keys in data.json (C2 writes many); proves pass-through. */
  extraData?: Record<string, unknown>;
}

export interface FixtureRun {
  auditAgentRepoRoot: string;
  projectName: string;
  runId: string;
  displayName: string;
  targetUrl: string;
  runDir: string;
  dataJsonPath: string;
  fixPlanJsonPath: string;
  findings: Finding[];
}

export function writeFixtureAuditRun(root: string, opts: FixtureRunOptions = {}): FixtureRun {
  const projectName = opts.projectName ?? '127.0.0.1-fixture';
  const runId = opts.runId ?? 'fixture-run';
  const displayName = opts.displayName ?? 'Fixture Run';
  const targetUrl = opts.targetUrl ?? 'http://127.0.0.1/fixture';
  const findings = opts.findings ?? [makeFinding({ findingId: 'a'.repeat(32) }), makeFinding({ findingId: 'b'.repeat(32), section: 'Hero', label: 'Talk to us' }), makeFinding({ findingId: 'c'.repeat(32), section: 'Footer', label: 'Subscribe', classification: 'DEVIATION' })];
  const runDir = join(root, 'projects', projectName, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'audit-agent', private: true }));
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId, displayName, targetUrl, mode: 'single-page', createdAt: '2026-09-16T07:14:45.168Z' }, null, 2));
  const data = {
    schemaVersion: 1,
    run: { runId, auditId: `audit-${runId}`, mode: 'single-page', startedAt: '2026-09-16T07:14:45.170Z', dsRegistryVersion: 'e'.repeat(64), policyVersion: 'p', targetUrl, aiMode: 'no-api' },
    statusCounts: { MATCH: 0, DEVIATION: 1, INCORRECT: 2 },
    findings,
    ...(opts.extraData ?? {}),
  };
  const dataJsonPath = join(runDir, 'data.json');
  writeFileSync(dataJsonPath, JSON.stringify(data, null, 2));
  const fixPlanJsonPath = join(runDir, 'fix-plan.json');
  if (opts.fixPlan !== null) {
    const plan: FixPlan = opts.fixPlan ?? { schemaVersion: 1, runId, updatedAt: '2026-09-17T10:05:00.000Z', entries: [makeFixPlanEntry('a'.repeat(32), 'fix'), makeFixPlanEntry('b'.repeat(32), 'skip'), makeFixPlanEntry('c'.repeat(32), 'fix')] };
    writeFileSync(fixPlanJsonPath, JSON.stringify(plan, null, 2));
  }
  return { auditAgentRepoRoot: root, projectName, runId, displayName, targetUrl, runDir, dataJsonPath, fixPlanJsonPath, findings };
}

/** A resolver that answers like `find-run` would for this fixture — no child process. */
export function fixtureResolver(run: FixtureRun) {
  return async () => ({ run: { projectName: run.projectName, runId: run.runId, displayName: run.displayName, targetUrl: run.targetUrl, runDir: run.runDir }, warnings: [] as string[] });
}

/** A stand-in DS registry with just the fields R1's summary reads — the real loader is covered by test/integration/ds-registry.test.ts. */
export function fakeRegistry(): DsRegistry {
  return {
    designSystemPath: '/fake/design-system',
    loadedAt: Date.now(),
    version: { dsRegistryVersion: 'f'.repeat(64), tokensHash: '1'.repeat(64), componentsHash: '2'.repeat(64), advisory: { tokensPackageVersion: '0.1.0', coreV2PackageVersion: '0.1.0' }, findings: [] },
    tokens: { sourceTokens: [{ name: '--button-px-md' }] },
    components: { totalTsxFiles: 1 },
    rules: {},
    allFindings: [],
  } as unknown as DsRegistry;
}
