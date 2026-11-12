import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPublishPlan, FIGMA_PAGES, type PublishPlan } from '../../src/figma/publish-plan.ts';
import { buildPublishInstruction, FIGMA_CONTRACT_VERSION, mergePublishedNodes } from '../../src/figma/prompt-contract.ts';
import { parsePublishedNodes, publishToFigma } from '../../src/figma/publish.ts';
import { buildAuditData, type AuditData } from '../../src/agents/c2-json-writer/index.ts';
import { ensureRunDirs, loadOrCreateProject, runPaths, type ProjectFile, type RunPaths } from '../../src/output/run-store.ts';
import type { Finding, PageResult } from '../../src/skills/s0-result-contract.ts';

/**
 * C3 without touching Figma. Everything up to the tool call — the publish
 * plan, the pinned instruction, idempotent node bookkeeping, and the two
 * verified blockers' handling — is deterministic and tested here. The live
 * write is gated on credentials that v1 explicitly does not have.
 */

let data: AuditData;
let dir: string;
let paths: RunPaths;
let project: ProjectFile;

const finding = (over: Partial<Finding> & { classification: Finding['classification'] }): Finding => ({
  identity: { auditId: 'a', runId: 'run-1', findingId: `f-${over.classification}-${(over.component?.signature ?? 's')}`, timestamp: '2026-09-11T10:00:00.000Z', dsRegistryVersion: 'dsver', policyVersion: 'p1' },
  location: { url: 'https://www.kenresearch.com/a', pageId: 'p1', pageName: 'A', templateFamily: 'Consulting', section: 'Hero', captureState: 'default' },
  component: { productionType: 'button', productionLabel: 'CTA', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig-1' },
  comparison: { mismatches: [], ruleViolations: [] },
  quality: { severity: 'LOW', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
  action: { recommendation: 'Fix it', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
  history: { previousStatus: null, currentStatus: over.classification, delta: null, previousRunId: null },
  ...over,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-c3-'));
  const findings: Finding[] = [
    finding({ classification: 'MATCH' }),
    finding({
      classification: 'DEVIATION',
      quality: {
        severity: 'MEDIUM', confidence: 0.8, confidenceBand: 'MEDIUM', escalationStatus: 'NONE', escalationReasons: [], visualVerdict: 'CONFIRMED',
        evidence: [{ kind: 'element-screenshot', ref: '/runs/r/screenshots/p1/el-1-element.png', note: null, box: { x: 24, y: 320, width: 222, height: 44 } }],
      },
      comparison: { mismatches: [{ property: 'height', actual: '44px', expected: '48px', expectedToken: '--button-height-md', comparison: 'length-px', delta: -4 }], ruleViolations: [] },
    }),
    finding({
      classification: 'INCORRECT',
      component: { productionType: 'button', productionLabel: 'Decorative', dsComponent: 'Button', dsVariant: 'brand', signature: 'sig-2' },
      quality: {
        severity: 'CRITICAL', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'QUEUED', escalationReasons: ['CALIBRATION_SAMPLE'], visualVerdict: 'CONFIRMED',
        evidence: [{ kind: 'element-screenshot', ref: '/runs/r/screenshots/p1/el-2-element.png', note: null, box: { x: 300, y: 320, width: 180, height: 48 } }],
      },
      comparison: { mismatches: [], ruleViolations: [{ ruleId: 'R1.2', title: 'Brand red is CTA-only', why: 'decorative use' }] },
      history: { previousStatus: 'MATCH', currentStatus: 'INCORRECT', delta: 'REGRESSION', previousRunId: 'run-0' },
    }),
    finding({ classification: 'DS_CANDIDATE', component: { productionType: 'card', productionLabel: 'Report card', dsComponent: null, dsVariant: null, signature: 'sig-3' }, action: { recommendation: 'Add to DS', rootCauseRef: null, dsCandidateNote: 'repeated 3x', registryUpdateRef: 'cand-sig-3' } }),
  ];

  const page: PageResult = {
    runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'd',
    dsRegistryVersion: 'dsver', policyVersion: 'p1', findings,
    compliance: { match: 1, deviation: 1, incorrect: 1, newComponent: 0, dsCandidate: 1, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 33.3 },
    coverage: { sectionsAnalyzed: 2, componentsDetected: 4, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
    capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
  };

  data = buildAuditData({ runId: 'run-1', auditId: 'a', mode: 'single-page', startedAt: '2026-09-11T10:00:00.000Z', targetUrl: 'https://www.kenresearch.com/a', pages: [page], failedPages: [] });
  paths = runPaths(join(dir, 'projects'), 'kenresearch-a', 'run-1');
  await ensureRunDirs(paths);
  project = await loadOrCreateProject(paths, { targetUrl: data.run.targetUrl, mode: 'single-page', figmaTeamPlanKey: 'team::1364202946001928079' });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('C3 publish plan', () => {
  it('plans every Figma page, including 07 Re-Audit History and 08 Needs Review', () => {
    const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
    expect(Object.keys(plan.pages)).toEqual([...FIGMA_PAGES]);
    const history = plan.pages['07 Re-Audit History'].tiles;
    expect(history.map((t) => t.label)).toEqual(['New issues', 'Still open', 'Resolved', 'Regressions', 'Prior issues unverified', 'Baseline changed']);
    // A first run has no prior issues to carry and no baseline to have changed.
    expect(history.slice(4).map((t) => t.value)).toEqual(['0', 'no']);
  });

  it('carries C2\'s numbers through unchanged — C3 renders, it never recomputes', () => {
    const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
    const tiles = Object.fromEntries(plan.pages['00 Overview'].tiles.map((t) => [t.label, t.value]));
    expect(tiles.Compliance).toBe(`${data.websiteSummary.compliancePercent}%`);
    expect(tiles.Match).toBe(String(data.websiteSummary.match));
    expect(tiles.Incorrect).toBe(String(data.websiteSummary.incorrect));
    expect(tiles['Unverified']).toBe(String(data.websiteSummary.unverified));
    expect(tiles['Needs review']).toBe(String(data.websiteSummary.needsReview));
    // …and the per-row tables carry it too, from the same C2 rows.
    expect(plan.pages['04 Component Audit'].headers).toContain('Unverified');
    const col = plan.pages['04 Component Audit'].headers.indexOf('Unverified');
    expect(plan.pages['04 Component Audit'].rows.map((r) => r[col])).toEqual(data.componentSummary.map((c) => String(c.notCompared)));
    expect(plan.pages['01 Template Summary'].headers).toContain('Unverified');
    expect(plan.pages['04 Component Audit'].rows).toHaveLength(data.componentSummary.length);
  });

  it('numbers issue markers from MEASURED element geometry, and pairs each with its card', () => {
    const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
    const frame = plan.pageAudits[0]!;
    expect(frame.markers.map((m) => m.number)).toEqual([1, 2]);
    expect(frame.markers[0]!.box).toEqual({ x: 24, y: 320, width: 222, height: 44 });
    expect(frame.cards.map((c) => c.number)).toEqual([1, 2]);
    expect(frame.cards[0]!.actualVsExpected).toContain('44px → expected 48px (--button-height-md)');
    // MATCH findings are not issues and get no marker.
    expect(frame.cards.every((c) => c.status !== 'MATCH')).toBe(true);
  });

  it('records the deferred image delivery explicitly instead of shipping blank images', () => {
    const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
    expect(plan.imageDelivery.status).toBe('deferred-unresolved-spike');
    expect(plan.imageDelivery.wouldUpload.length).toBeGreaterThan(0);
    expect(plan.imageDelivery.note).toContain('blank');
  });

  it('is deterministic — the same data produces byte-identical plans', () => {
    expect(JSON.stringify(buildPublishPlan(data, FIGMA_CONTRACT_VERSION))).toBe(JSON.stringify(buildPublishPlan(data, FIGMA_CONTRACT_VERSION)));
  });
});

describe('C3 pinned instruction and idempotent republish', () => {
  it('instructs a first publish to create, and returns a version-pinned contract', () => {
    const instruction = buildPublishInstruction(buildPublishPlan(data, FIGMA_CONTRACT_VERSION), project);
    expect(instruction.contractVersion).toBe(FIGMA_CONTRACT_VERSION);
    expect(instruction.prompt).toContain('This is the first publish');
    expect(instruction.system).toContain('RENDERER, not an auditor');
    // The tool-contract prohibitions must be stated, not assumed.
    expect(instruction.system).toContain('createImageAsync');
    expect(instruction.system).toContain('setCurrentPageAsync');
  });

  it('instructs a republish to MUTATE known node ids rather than create duplicates (§2.5 rule 5)', () => {
    const republished: ProjectFile = {
      ...project,
      figmaFileKey: 'abc123',
      figmaNodes: { pages: { '00 Overview': '1:2' }, frames: { p1: '3:4' }, markers: {}, imageHashes: {} },
    };
    const instruction = buildPublishInstruction(buildPublishPlan(data, FIGMA_CONTRACT_VERSION), republished);
    expect(instruction.prompt).toContain('This is a REPUBLISH');
    expect(instruction.prompt).toContain('existing page node id: 1:2 — MUTATE this page');
    expect(instruction.prompt).toContain('existing frame node id: 3:4 — MUTATE it');
    expect(instruction.prompt).toContain('resolve it with getNodeByIdAsync');
  });

  it('merges returned node ids into the project without losing previously known ones', () => {
    const start: ProjectFile = { ...project, figmaNodes: { pages: { '00 Overview': '1:2' }, frames: {}, markers: {}, imageHashes: {} } };
    const merged = mergePublishedNodes(start, { pages: { '01 Template Summary': '5:6' }, frames: { p1: '7:8' } });
    expect(merged.figmaNodes.pages).toEqual({ '00 Overview': '1:2', '01 Template Summary': '5:6' });
    expect(merged.figmaNodes.frames).toEqual({ p1: '7:8' });
  });

  it('parses the returned node map out of a reply that also contains prose', () => {
    const nodes = parsePublishedNodes('Created the pages.\n{"pages":{"00 Overview":"1:2"},"frames":{"p1":"3:4"},"markers":{"f-1":"5:6"}}\nDone.');
    expect(nodes.pages).toEqual({ '00 Overview': '1:2' });
    expect(nodes.markers).toEqual({ 'f-1': '5:6' });
  });

  // ── third-pass review OUT-3: a table over the 200-row publish cap must say so, not silently drop rows ──
  it('a table past the 200-row cap states an accurate shown-of-total count and names what was dropped', () => {
    const bigPlan: PublishPlan = {
      ...buildPublishPlan(data, FIGMA_CONTRACT_VERSION),
      pages: {
        ...buildPublishPlan(data, FIGMA_CONTRACT_VERSION).pages,
        '04 Component Audit': { tiles: [], headers: ['DS component'], rows: Array.from({ length: 250 }, (_, i) => [`Component-${i}`]) },
      },
    };
    const instruction = buildPublishInstruction(bigPlan, project);
    expect(instruction.prompt).toContain('rows (200 of 250):');
    expect(instruction.prompt).toContain('50 more row(s) not published (table capped at 200 rows)');
    expect(instruction.prompt).toContain('Component-199'); // the 200th row is published…
    expect(instruction.prompt).not.toContain('Component-200'); // …the 201st is not.
  });

  it('a table under the cap states the count with no "more rows" note', () => {
    const instruction = buildPublishInstruction(buildPublishPlan(data, FIGMA_CONTRACT_VERSION), project);
    const componentRowCount = data.componentSummary.length;
    expect(instruction.prompt).toContain(`rows (${componentRowCount} of ${componentRowCount}):`);
    expect(instruction.prompt).not.toContain('more row(s) not published');
  });
});

describe('C3 publish outcomes (the two verified blockers)', () => {
  it('refuses to publish when the project has no Figma file, with an actionable reason', async () => {
    const { outcome } = await publishToFigma(data, project, paths, { invoke: async () => '{}' });
    expect(outcome.status).toBe('no-figma-file');
    expect('detail' in outcome && outcome.detail).toContain('projectId');
  });

  it('reports the known headless-auth blocker clearly instead of hanging or faking success', async () => {
    const withFile: ProjectFile = { ...project, figmaFileKey: 'abc123' };
    const { outcome } = await publishToFigma(data, withFile, paths, {
      invoke: async () => {
        throw new Error('Failed to authenticate: OAuth session expired and could not be refreshed');
      },
    });
    expect(outcome.status).toBe('unavailable');
    expect('detail' in outcome && outcome.detail).toContain('out-of-scope-for-v1');
  });

  it('persists returned node ids to project.json on a successful publish, so the next run updates the same file', async () => {
    const withFile: ProjectFile = { ...project, figmaFileKey: 'abc123' };
    const { outcome, project: saved } = await publishToFigma(data, withFile, paths, {
      invoke: async () => '{"pages":{"00 Overview":"1:2"},"frames":{"p1":"3:4"},"markers":{}}',
    });
    expect(outcome.status).toBe('published');
    expect(saved.figmaNodes.pages['00 Overview']).toBe('1:2');
    const onDisk = JSON.parse(await readFile(paths.projectFile, 'utf-8')) as ProjectFile;
    expect(onDisk.figmaNodes.frames.p1).toBe('3:4');
  });

  // ── third-pass review MS-3/OUT-5: the calling SESSION's mode gates the write too, not just the file ──
  it('a no-api SESSION refuses to publish even when the run being published was audited in anthropic-api mode', async () => {
    const apiAudited = { ...data, run: { ...data.run, aiMode: 'anthropic-api' as const } };
    const withFile: ProjectFile = { ...project, figmaFileKey: 'abc123' };
    const { outcome } = await publishToFigma(apiAudited, withFile, paths, { mode: 'no-api' });
    expect(outcome.status).toBe('unavailable');
    expect('detail' in outcome && outcome.detail).toMatch(/This session is configured AI_MODE=no-api/);
    expect('detail' in outcome && outcome.detail).toMatch(/audited in anthropic-api mode/);
  });

  it('a matching anthropic-api session and an anthropic-api-audited run publish normally', async () => {
    const apiAudited = { ...data, run: { ...data.run, aiMode: 'anthropic-api' as const } };
    const withFile: ProjectFile = { ...project, figmaFileKey: 'abc123' };
    const { outcome } = await publishToFigma(apiAudited, withFile, paths, { mode: 'anthropic-api', invoke: async () => '{"pages":{},"frames":{},"markers":{}}' });
    expect(outcome.status).toBe('published');
  });
});
