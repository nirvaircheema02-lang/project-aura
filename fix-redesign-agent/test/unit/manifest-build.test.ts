import { describe, expect, it } from 'vitest';
import type { CaptureSession, IterationRecord, R1Output, R6Input } from '../../src/agents/types.ts';
import { buildComponentManifest } from '../../src/manifest/build.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';
import { fakeRegistry, makeFinding } from '../helpers/fixture-audit-run.ts';

/**
 * R6 orchestration (§8.6, Decision Log #16): the manifest covers EVERY mapped element on the
 * page, changed or not — not only the ones a fix touched. Local fixtures only (not imported
 * from pipeline.test.ts), per this file's own R1Output/CaptureSession/IterationRecord shapes.
 */

const TARGET_URL = 'http://127.0.0.1/fixture'; // matches makeFinding()'s default location.url

function mappingEntry(findingId: string, sectionId: string): MappingEntry {
  return {
    element: `el-${findingId.slice(0, 4)}`,
    stamp: `el-${findingId.slice(0, 4)}`,
    findingIds: [findingId],
    signature: '086f80596222341f87d033768e43e63f',
    instanceIndex: null,
    instanceCount: 1,
    sectionId,
    scope: 'content',
    resolution: { method: 'objective', confidence: 'confirmed', checks: { geometry: true, identity: true, text: true, classFingerprint: null, passedCount: 3 }, candidatesConsidered: 1 },
    drift: { class: 'identical', auditBox: null, liveBox: null, styleDeltas: [], note: '' },
    affordances: { tagName: 'button', role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false },
    dsReference: { dsComponent: 'Button', dsFile: 'core-v2/src/atoms/Button.tsx', dsVariant: 'primary · md · light', sourceExcerpt: null, basis: 'finding-match' },
  };
}

function r1Output(): R1Output {
  const findingA = makeFinding({ findingId: 'a'.repeat(32), section: 'Hero' });
  const findingB = makeFinding({ findingId: 'b'.repeat(32), section: 'Hero', label: 'Talk to us' });
  const baseOtherPage = makeFinding({ findingId: 'z'.repeat(32) });
  const findingOtherPage = { ...baseOtherPage, location: { ...baseOtherPage.location, url: 'https://example.com/other-page' } };
  const findings = [findingA, findingB, findingOtherPage];
  const fixEntries = [{ findingId: 'a'.repeat(32), decision: 'fix' as const, decidedAt: '2026-09-17T10:00:00.000Z', decidedBy: 'reviewer@example.com', note: null, source: 'html-report' as const }];
  return {
    sourceRun: {
      auditAgentRepoRoot: '/aa',
      projectName: 'example.com-page',
      runId: 'page-audit',
      displayName: 'Page Audit',
      targetUrl: TARGET_URL,
      runDir: '/aa/projects/example.com-page/runs/page-audit',
      dataJsonPath: '/aa/.../data.json',
      dataJsonSha256: 'd',
      fixPlanJsonPath: '/aa/.../fix-plan.json',
      fixPlanSha256: 'f',
      newComponentPlanJsonPath: null,
      newComponentPlanSha256: null,
      reportHtmlPath: null,
      screenshotsDir: '/aa/.../screenshots',
    },
    audit: { schemaVersion: 1, run: { runId: 'page-audit', targetUrl: TARGET_URL }, findingCount: findings.length },
    targetUrl: TARGET_URL,
    findings,
    fixPlan: { schemaVersion: 1, runId: 'page-audit', updatedAt: null, entries: fixEntries },
    fixEntries,
    fixFindings: [findingA],
    decisionCounts: { fix: 1, skip: 0, keep_for_review: 0, undecided: 1 },
    droppedUnknownFindingIds: [],
    newComponentPlan: null,
    registry: fakeRegistry(),
    warnings: [],
  };
}

function fakeSession(): CaptureSession {
  return {
    page: {} as CaptureSession['page'],
    context: {} as CaptureSession['context'],
    observer: {} as CaptureSession['observer'],
    capture: {} as CaptureSession['capture'],
    before: { tiles: [], totalHeight: 0, truncated: false, composite: null },
    viewport: { width: 1440, height: 900 },
    captureFingerprint: { domHash: 'h', stylesheets: [], fonts: [], assets: [], viewport: { width: 1440, height: 900 }, renderingPolicyHash: 'r' },
    originalHtml: null,
    mapping: { entries: [mappingEntry('a'.repeat(32), 'hero'), mappingEntry('b'.repeat(32), 'hero')], unmapped: [], conflicts: [], usage: null },
    release: async () => {},
  };
}

function iterationsFixture(): IterationRecord[] {
  return [
    {
      iteration: 1,
      plan: {
        iteration: 1,
        chunks: 1,
        usage: null,
        plan: {
          edits: [
            { findingId: 'a'.repeat(32), selector: '#a', expectedMatches: 1, kind: 'style', property: 'padding-left', value: '28px', removeValue: null, dsComponent: null, dsVariant: null, dsToken: '--button-px-md', rationale: 'close the padding mismatch', confidence: 0.9 },
          ],
          unaddressed: [{ findingId: 'b'.repeat(32), reason: 'no safe targeted edit exists on this DOM' }],
        },
      },
      applied: {
        iteration: 1,
        after: { tiles: [], totalHeight: 0, truncated: false, composite: null },
        applied: [
          {
            edit: { findingId: 'a'.repeat(32), selector: '#a', expectedMatches: 1, kind: 'style', property: 'padding-left', value: '28px', removeValue: null, dsComponent: null, dsVariant: null, dsToken: '--button-px-md', rationale: 'close the padding mismatch', confidence: 0.9 },
            matched: 1,
            applied: true,
            previousValue: '12px',
            error: null,
          },
        ],
      },
      validation: {
        iteration: 1,
        checks: [{ findingId: 'a'.repeat(32), fixed: true, detail: 'padding now matches', measured: [] }],
        structural: { ok: true, lostInteractive: [], lostText: [], note: '' },
        vision: 'NOT_CHECKED',
        visionIssues: [],
        visionVerdicts: null,
        overall: 'PASS',
        failedChecks: [],
        usage: null,
      },
    },
  ];
}

describe('buildComponentManifest', () => {
  it('covers EVERY mapped element on the page, not only the one that was fixed (Decision Log #16)', async () => {
    const input: R6Input = { r1: r1Output(), session: fakeSession(), iterations: iterationsFixture(), otherRunDataJsonPaths: [] };
    const manifest = await buildComponentManifest({ auditAgentRepoRoot: '/aa', plausibilityBar: 0.85, otherRunDataJsonPaths: [] }, input);

    // both 'a' (fixed) and 'b' (untouched) are present — only findings on the OTHER page are excluded.
    expect(manifest.components.map((c) => c.findingId).sort()).toEqual(['a'.repeat(32), 'b'.repeat(32)].sort());
    expect(manifest.counts.findings).toBe(2);
    expect(manifest.counts.otherPageFindings).toBe(1);
  });

  it('reflects each finding\'s own redesign/fixPlan state independently', async () => {
    const input: R6Input = { r1: r1Output(), session: fakeSession(), iterations: iterationsFixture(), otherRunDataJsonPaths: [] };
    const manifest = await buildComponentManifest({ auditAgentRepoRoot: '/aa', plausibilityBar: 0.85, otherRunDataJsonPaths: [] }, input);
    const a = manifest.components.find((c) => c.findingId === 'a'.repeat(32))!;
    const b = manifest.components.find((c) => c.findingId === 'b'.repeat(32))!;

    expect(a.fixPlan.decision).toBe('fix');
    expect(a.redesign).toMatchObject({ requested: true, planned: true, applied: true, verified: true });
    expect(a.location).toMatchObject({ located: true, stamp: 'el-aaaa', method: 'objective' });

    expect(b.fixPlan.decision).toBe('undecided');
    expect(b.redesign).toMatchObject({ requested: false, planned: false, applied: false, verified: false, unaddressedReason: 'no safe targeted edit exists on this DOM' });
  });

  it('assembles tokens from BOTH the audit mismatch (source: mismatch) and the applied edit (source: edit), never dropping either', async () => {
    const input: R6Input = { r1: r1Output(), session: fakeSession(), iterations: iterationsFixture(), otherRunDataJsonPaths: [] };
    const manifest = await buildComponentManifest({ auditAgentRepoRoot: '/aa', plausibilityBar: 0.85, otherRunDataJsonPaths: [] }, input);
    const a = manifest.components.find((c) => c.findingId === 'a'.repeat(32))!;

    expect(a.tokens.filter((t) => t.source === 'mismatch')).toHaveLength(2); // the fixture finding's two default mismatches, both carrying an expectedToken
    const editTokens = a.tokens.filter((t) => t.source === 'edit');
    expect(editTokens).toEqual([{ token: '--button-px-md', property: 'padding-left', source: 'edit', value: '28px' }]);
  });

  it('groups mapped findings into sections by mapping.json\'s sectionId', async () => {
    const input: R6Input = { r1: r1Output(), session: fakeSession(), iterations: iterationsFixture(), otherRunDataJsonPaths: [] };
    const manifest = await buildComponentManifest({ auditAgentRepoRoot: '/aa', plausibilityBar: 0.85, otherRunDataJsonPaths: [] }, input);

    expect(manifest.sections).toHaveLength(1);
    expect(manifest.sections[0]).toMatchObject({ sectionId: 'hero', scope: 'content', excludedReason: null });
    expect(new Set(manifest.sections[0]!.memberFindingIds)).toEqual(new Set(['a'.repeat(32), 'b'.repeat(32)]));
  });

  it('skips cross-run lookups entirely when deps.otherRunDataJsonPaths is empty — every component reuse falls back to single/repeated-on-page', async () => {
    const input: R6Input = { r1: r1Output(), session: fakeSession(), iterations: iterationsFixture(), otherRunDataJsonPaths: [] };
    const manifest = await buildComponentManifest({ auditAgentRepoRoot: '/aa', plausibilityBar: 0.85, otherRunDataJsonPaths: [] }, input);
    for (const c of manifest.components) {
      expect(c.crossRun.sightings).toEqual([]);
      expect(c.crossRun.reuse).not.toBe('multi-page');
    }
  });
});
