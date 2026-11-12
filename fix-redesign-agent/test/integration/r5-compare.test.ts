import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runR2 } from '../../src/agents/r2-capture-original/index.ts';
import { runR4 } from '../../src/agents/r4-apply-render/index.ts';
import { runR5 } from '../../src/agents/r5-compare/index.ts';
import type { R1Output, R3Output } from '../../src/agents/types.ts';
import { ScriptedLlmClient } from '../../src/llm/provider.ts';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';
import { ensureRedesignDirs, redesignPaths, type RedesignPaths } from '../../src/output/redesign-store.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { AwaitingJudgmentError } from '../../src/judgment/types.ts';
import { fakeRegistry, makeFinding } from '../helpers/fixture-audit-run.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * runR5 combining tier (a) deterministic re-measurement (real computed-style reads) with tier
 * (b) one batched vision call (ScriptedLlmClient), plus the structural diff reading a real
 * before/after DOM. Two focused scenarios: a vision NOT_FIXED verdict downgrading an
 * otherwise-passing tier-(a) check, and a genuine interactive-element loss caught structurally.
 */

const FIXTURE_PAGE = `<!doctype html><html><head><title>r5 fixture</title><link rel="canonical" href="/r5page">
<style>body{margin:0} .btn{color:#000000;padding:8px 16px}</style>
</head><body><main>
<button data-fra-element="btn1" class="btn">Sign up</button>
<button data-fra-element="btn2" class="btn">Talk to us</button>
</main></body></html>`;

// Used only by the dedicated structural-baseline bug test below: an EXTERNAL, relative
// stylesheet hides one button by CSS alone (no inline style, so a broken baseline can't see it).
const EXTERNAL_CSS = `.hidden-by-css{display:none}`;
const FIXTURE_PAGE_EXTERNAL_CSS = `<!doctype html><html><head><title>r5 external-css fixture</title><link rel="canonical" href="/r5page-external-css">
<link rel="stylesheet" href="/r5-style.css">
</head><body><main>
<button data-fra-element="btn-visible">Sign up</button>
<button data-fra-element="btn-hidden" class="hidden-by-css">Always hidden by CSS</button>
</main></body></html>`;

let server: Awaited<ReturnType<typeof startLocalServer>>;
let pool: BrowserPool;
let roots: string[] = [];

beforeAll(async () => {
  server = await startLocalServer({
    '/r5page': { body: FIXTURE_PAGE },
    '/r5page-external-css': { body: FIXTURE_PAGE_EXTERNAL_CSS },
    '/r5-style.css': { body: EXTERNAL_CSS, headers: { 'content-type': 'text/css' } },
  });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FraR5Test/0.1' });
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
  const root = mkdtempSync(join(tmpdir(), 'fra-r5-'));
  roots.push(root);
  return redesignPaths(root, 'r5-project', 'r5-run');
}

function makeR1(targetUrl: string, findings: R1Output['findings']): R1Output {
  return {
    sourceRun: {
      auditAgentRepoRoot: '/aa',
      projectName: 'r5-project',
      runId: 'r5-run',
      displayName: 'R5 Fixture Run',
      targetUrl,
      runDir: '/aa/projects/r5-project/runs/r5-run',
      dataJsonPath: '/aa/…/data.json',
      dataJsonSha256: 'd',
      fixPlanJsonPath: null,
      fixPlanSha256: null,
      newComponentPlanJsonPath: null,
      newComponentPlanSha256: null,
      reportHtmlPath: null,
      screenshotsDir: '/aa/…/screenshots',
    },
    audit: { schemaVersion: 1, run: { runId: 'r5-run', targetUrl }, findingCount: findings.length },
    targetUrl,
    findings,
    fixPlan: { schemaVersion: 1, runId: 'r5-run', updatedAt: null, entries: [] },
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
    affordances: { tagName: 'button', role: null, href: null, type: null, tabIndex: null, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: null, formAssociated: false },
    dsReference: { dsComponent: null, dsFile: null, dsVariant: null, sourceExcerpt: null, basis: 'none' },
  };
}

function styleEdit(findingId: string, selector: string, property: string, value: string): TargetedEdit {
  return { findingId, selector, expectedMatches: 1, kind: 'style', property, value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'test edit', confidence: 0.9 };
}

function planOf(edits: TargetedEdit[]): R3Output {
  return { iteration: 1, plan: { edits, unaddressed: [] }, chunks: 1, usage: null };
}

describe('runR5 — real measurement + real DOM structural diff + scripted vision', () => {
  it('never reports a policy-refused edit fixed even if another edit applied and vision approves', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const finding = makeFinding({ findingId: 'a'.repeat(32), mismatches: [] });
    const r1 = makeR1(`${server.origin}/r5page`, [finding]);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [mappingEntry('btn1', finding.identity.findingId)], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content();
      const plan = planOf([
        styleEdit(finding.identity.findingId, '[data-fra-element="btn1"]', 'padding-left', '28px'),
        styleEdit(finding.identity.findingId, '[data-fra-element="btn1"]', 'background', 'black'),
      ]);
      const applied = await runR4({ paths }, { r1, session, plan, iteration: 1, previousApplied: [] });
      const llm = new ScriptedLlmClient({ R5: [{ verdicts: [{ findingId: finding.identity.findingId, verdict: 'FIXED', confidence: 1, reasoning: 'looks fine' }], regressions: [], overall: 'CONFIRMED' }] });
      const result = await runR5({ llm }, { r1, session, plan, applied, iteration: 1 });
      expect(applied.applied.map((a) => a.applied)).toEqual([true, false]);
      expect(result.checks[0]!.fixed).toBe(false);
      expect(result.checks[0]!.detail).toContain('Project redesign policy:');
      expect(result.overall).not.toBe('PASS');
      expect(llm.requests[0]!.prompt).toContain('sticky pin/release');
    } finally {
      await session.release();
    }
  }, 60_000);
  it('an R1.4 typeface finding is fixed only when the visible text is actually set in a design-system typeface', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const finding = makeFinding({ findingId: 'd'.repeat(32), mismatches: [] });
    finding.comparison.ruleViolations = [{ ruleId: 'R1.4', title: 'Two-Font Pairing (Serif + Sans)', why: 'set in "manrope" (Manrope) — not a Design System typeface' }];
    const r1 = makeR1(`${server.origin}/r5page`, [finding]);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [mappingEntry('btn1', finding.identity.findingId)], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content();
      // the visible text lives in a child that sets its own font family: an edit on the stamped element alone cannot reach it
      await session.page.evaluate(() => { const b = document.querySelector('[data-fra-element="btn1"]')!; b.innerHTML = '<span style="font-family:Manrope,sans-serif">Sign up</span>'; });
      const plan = planOf([styleEdit(finding.identity.findingId, '[data-fra-element="btn1"]', 'font-family', "'DM Sans', sans-serif")]);
      const applied = await runR4({ paths, log: () => {} }, { r1, session, plan, iteration: 1, previousApplied: [] });
      expect(applied.applied[0]!.applied).toBe(true);
      const confirmed = () => new ScriptedLlmClient({ R5: [{ verdicts: [], regressions: [], overall: 'CONFIRMED' }] });
      const reached = await runR5({ llm: confirmed(), log: () => {} }, { r1, session, plan, applied, iteration: 1 });
      expect(reached.checks[0]!.fixed).toBe(false);
      expect(reached.checks[0]!.detail).toMatch(/still set in manrope/);
      // a descendant edit (allowed by R3's selector rule) reaches the text
      const plan2 = planOf([styleEdit(finding.identity.findingId, '[data-fra-element="btn1"] span', 'font-family', "'DM Sans', sans-serif")]);
      const applied2 = await runR4({ paths, log: () => {} }, { r1, session, plan: plan2, iteration: 2, previousApplied: applied.applied });
      const fixed = await runR5({ llm: confirmed(), log: () => {} }, { r1, session, plan: plan2, applied: applied2, iteration: 2, previousApplied: applied.applied });
      expect(fixed.checks[0]).toMatchObject({ fixed: true });
    } finally {
      await session.release();
    }
  }, 60_000);
  it('a later iteration that plans nothing new keeps the credit for edits applied in an earlier iteration', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const rule = makeFinding({ findingId: 'b'.repeat(32), mismatches: [] });
    const measured = makeFinding({
      findingId: 'c'.repeat(32),
      mismatches: [{ property: 'color', actual: 'rgb(0, 0, 0)', expected: '#b01f24', expectedToken: '--color-ken-red', comparison: 'color-deltaE', delta: null }],
    });
    const r1 = makeR1(`${server.origin}/r5page`, [rule, measured]);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [mappingEntry('btn1', rule.identity.findingId), mappingEntry('btn2', measured.identity.findingId)], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content();
      // iteration 1 applies an edit for each finding
      const plan1 = planOf([
        styleEdit(rule.identity.findingId, '[data-fra-element="btn1"]', 'font-weight', '500'),
        styleEdit(measured.identity.findingId, '[data-fra-element="btn2"]', 'color', '#b01f24'),
      ]);
      const applied1 = await runR4({ paths, log: () => {} }, { r1, session, plan: plan1, iteration: 1, previousApplied: [] });
      expect(applied1.applied.every((a) => a.applied)).toBe(true);
      // iteration 2 re-plans nothing for them (everything is still on the live page)
      const plan2: R3Output = { iteration: 2, plan: { edits: [], unaddressed: [] }, chunks: 1, usage: null };
      const applied2 = await runR4({ paths, log: () => {} }, { r1, session, plan: plan2, iteration: 2, previousApplied: applied1.applied });
      expect(applied2.applied).toHaveLength(0);
      const confirmed = () => new ScriptedLlmClient({ R5: [{ verdicts: [], regressions: [], overall: 'CONFIRMED' }] });

      const withHistory = await runR5({ llm: confirmed(), log: () => {} }, { r1, session, plan: plan2, applied: applied2, iteration: 2, previousApplied: applied1.applied });
      expect(withHistory.checks.map((c) => [c.findingId, c.fixed])).toEqual([[rule.identity.findingId, true], [measured.identity.findingId, true]]);
      expect(withHistory.overall).toBe('PASS');

      // the rule-only finding (nothing to measure) is only known to be addressed through the earlier iteration's edit
      const withoutHistory = await runR5({ llm: confirmed(), log: () => {} }, { r1, session, plan: plan2, applied: applied2, iteration: 2 });
      expect(withoutHistory.checks.find((c) => c.findingId === rule.identity.findingId)!.fixed).toBe(false);
    } finally {
      await session.release();
    }
  }, 60_000);
  it('a vision NOT_FIXED verdict downgrades an otherwise-passing tier-(a) check', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r5page`;
    const finding = makeFinding({
      findingId: 'a'.repeat(32),
      mismatches: [{ property: 'color', actual: 'rgb(0, 0, 0)', expected: '#b01f24', expectedToken: '--color-ken-red', comparison: 'color-deltaE', delta: null }],
    });
    const r1 = makeR1(url, [finding]);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [mappingEntry('btn1', finding.identity.findingId)], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content();

      const edit = styleEdit(finding.identity.findingId, '[data-fra-element="btn1"]', 'color', '#b01f24');
      const plan = planOf([edit]);
      const applied = await runR4({ paths, log: () => {} }, { r1, session, plan, iteration: 1, previousApplied: [] });
      expect(applied.applied[0]!.applied).toBe(true);

      const llm = new ScriptedLlmClient({
        R5: [{ verdicts: [{ findingId: finding.identity.findingId, verdict: 'NOT_FIXED', confidence: 0.8, reasoning: 'still looks off in the screenshot' }], regressions: [], overall: 'UNCERTAIN' }],
      });

      const result = await runR5({ llm, log: () => {} }, { r1, session, plan, applied, iteration: 1 });

      expect(llm.requests).toHaveLength(1); // the ONE batched vision call
      const check = result.checks.find((c) => c.findingId === finding.identity.findingId)!;
      // Tier (a)'s own raw measurement genuinely passed (real computed-style read)…
      expect(check.measured[0]!.matches).toBe(true);
      // …but the vision verdict overrides it: fixed is never left true under a NOT_FIXED verdict.
      expect(check.fixed).toBe(false);
      expect(check.detail).toContain('NOT_FIXED');
      expect(result.vision).toBe('UNCERTAIN');
      expect(result.overall).not.toBe('PASS');
      expect(result.failedChecks.some((f) => f.includes(finding.identity.findingId))).toBe(true);
    } finally {
      await session.release();
    }
  }, 60_000);

  /**
   * §judgmentProvider regression: R5's vision sub-step is wrapped in a try/catch that downgrades
   * ANY failure to `vision: 'NOT_CHECKED'` (§8.9 — "preserve deterministic checks, prevent a
   * fabricated pass"). Before this fix that catch-all also swallowed an `AwaitingJudgmentError`
   * (claude-session mode's checkpoint signal) exactly like a real vision failure — silently
   * turning a pending Session Agent judgment into a permanent NOT_CHECKED instead of pausing the
   * run. `runR5` must re-throw it unchanged so `pipeline.ts` can checkpoint instead.
   */
  it('an AwaitingJudgmentError from the vision call is NEVER downgraded to NOT_CHECKED — it propagates so the pipeline can checkpoint', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r5page`;
    const finding = makeFinding({
      findingId: 'a'.repeat(32),
      mismatches: [{ property: 'color', actual: 'rgb(0, 0, 0)', expected: '#b01f24', expectedToken: '--color-ken-red', comparison: 'color-deltaE', delta: null }],
    });
    const r1 = makeR1(url, [finding]);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [mappingEntry('btn1', finding.identity.findingId)], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content();

      const edit = styleEdit(finding.identity.findingId, '[data-fra-element="btn1"]', 'color', '#b01f24');
      const plan = planOf([edit]);
      const applied = await runR4({ paths, log: () => {} }, { r1, session, plan, iteration: 1, previousApplied: [] });

      const pending = new AwaitingJudgmentError('R5', 'deadbeefdeadbeef', join(paths.judgmentsDir, 'deadbeefdeadbeef.bundle.json'));
      const llm = { structured: async () => { throw pending; } };

      await expect(runR5({ llm, log: () => {} }, { r1, session, plan, applied, iteration: 1 })).rejects.toBe(pending);
    } finally {
      await session.release();
    }
  }, 60_000);

  it('the structural diff reads the real live DOM: an interactive element hidden by an edit is caught as lost', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r5page`;
    const r1 = makeR1(url, []); // no findings in scope — isolates the structural check from tier (a)/(b)
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      // Still needs a real mapping entry for the edit's OWN finding — R4 now verifies (§security)
      // that every edit's selector stays within its own finding's mapped stamp; r1.fixFindings
      // staying empty is what actually isolates this from tier (a)/(b), not an absent mapping.
      session.mapping = { entries: [mappingEntry('btn2', 'unrelated-edit')], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content(); // captured while btn2 is still visible

      // Simulate a third-party script regression. R4 now refuses unrequested display edits.
      await session.page.locator('[data-fra-element="btn2"]').evaluate((el) => (el as HTMLElement).style.display = 'none');
      const plan = planOf([]);
      const applied = await runR4({ paths, log: () => {} }, { r1, session, plan, iteration: 1, previousApplied: [] });

      const llm = new ScriptedLlmClient({}); // no vision call expected: checks.length === 0
      const result = await runR5({ llm, log: () => {} }, { r1, session, plan, applied, iteration: 1 });

      expect(llm.requests).toHaveLength(0);
      expect(result.structural.ok).toBe(false);
      expect(result.structural.lostInteractive.some((d) => d.toLowerCase().includes('button'))).toBe(true);
      expect(result.overall).toBe('FAIL');
      expect(result.failedChecks.some((f) => f.startsWith('structural: interactive element lost'))).toBe(true);
    } finally {
      await session.release();
    }
  }, 60_000);

  /**
   * Regression test for a real, now-fixed bug, same root cause as the one documented in
   * r7-assemble-output.test.ts: `captureBaselineFromHtml` (src/agents/r5-compare/structural.ts)
   * opened a page via `context.newPage()` — never navigated — then called `setContent(html)`
   * immediately, so `document.baseURI` was `about:blank` and an external RELATIVE stylesheet
   * on the audited page never loaded on the baseline, even though the SAME stylesheet loaded
   * fine on the real "after" page (session.page, which did navigate). A button hidden purely
   * by external CSS was therefore reported as unstyled/VISIBLE in the "before" snapshot and
   * correctly hidden in "after" — a false "interactive element lost". Fixed by
   * `html/temp-page.ts`'s `openStandinPage`, which gives the baseline page the real origin via
   * a locally-fulfilled navigation before `setContent` (see r7-assemble-output.test.ts for the
   * full mechanism and why a bare `<base href>` isn't enough).
   */
  it('the structural baseline is unaffected by an element that was ALWAYS hidden by an external stylesheet', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const url = `${server.origin}/r5page-external-css`;
    const r1 = makeR1(url, []);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    try {
      session.mapping = { entries: [], unmapped: [], conflicts: [], usage: null };
      session.originalHtml = await session.page.content();

      // No edits at all — the live page is left exactly as captured; nothing should be flagged.
      const plan = planOf([]);
      const applied = await runR4({ paths, log: () => {} }, { r1, session, plan, iteration: 1, previousApplied: [] });

      const llm = new ScriptedLlmClient({});
      const result = await runR5({ llm, log: () => {} }, { r1, session, plan, applied, iteration: 1 });

      expect(result.structural.ok).toBe(true);
      expect(result.structural.lostInteractive).toEqual([]);
    } finally {
      await session.release();
    }
  }, 60_000);
});
