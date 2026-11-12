import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runR2 } from '../../src/agents/r2-capture-original/index.ts';
import { runR4 } from '../../src/agents/r4-apply-render/index.ts';
import type { AppliedEdit, CaptureSession, R1Output, R3Output } from '../../src/agents/types.ts';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { ensureRedesignDirs, redesignPaths, type RedesignPaths } from '../../src/output/redesign-store.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { fakeRegistry } from '../helpers/fixture-audit-run.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * runR4 against a real, live page: the plan's edits must actually land in the DOM (read back
 * via getComputedStyle, not just trusted from the return value), and a second iteration
 * replaying the SAME (findingId, property) edit must reuse the recorded `previousValue`
 * rather than re-measuring the already-mutated live value (§7.5's idempotency rule).
 */

const FIXTURE_PAGE = `<!doctype html><html><head><title>r4 fixture</title><link rel="canonical" href="/r4page">
<style>body{margin:0} .btn{padding-left:12px;font-weight:400;background:#eeeeee}</style>
</head><body><main>
<button data-fra-element="btn1" class="btn">Sign up</button>
</main></body></html>`;

let server: Awaited<ReturnType<typeof startLocalServer>>;
let pool: BrowserPool;
let roots: string[] = [];

beforeAll(async () => {
  server = await startLocalServer({ '/r4page': { body: FIXTURE_PAGE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FraR4Test/0.1' });
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
  const root = mkdtempSync(join(tmpdir(), 'fra-r4-'));
  roots.push(root);
  return redesignPaths(root, 'r4-project', 'r4-run');
}

function makeR1(targetUrl: string): R1Output {
  return {
    sourceRun: {
      auditAgentRepoRoot: '/aa',
      projectName: 'r4-project',
      runId: 'r4-run',
      displayName: 'R4 Fixture Run',
      targetUrl,
      runDir: '/aa/projects/r4-project/runs/r4-run',
      dataJsonPath: '/aa/…/data.json',
      dataJsonSha256: 'd',
      fixPlanJsonPath: null,
      fixPlanSha256: null,
      newComponentPlanJsonPath: null,
      newComponentPlanSha256: null,
      reportHtmlPath: null,
      screenshotsDir: '/aa/…/screenshots',
    },
    audit: { schemaVersion: 1, run: { runId: 'r4-run', targetUrl }, findingCount: 1 },
    targetUrl,
    findings: [],
    fixPlan: { schemaVersion: 1, runId: 'r4-run', updatedAt: null, entries: [] },
    fixEntries: [],
    fixFindings: [],
    decisionCounts: { fix: 1, skip: 0, keep_for_review: 0, undecided: 0 },
    droppedUnknownFindingIds: [],
    newComponentPlan: null,
    registry: fakeRegistry(),
    warnings: [],
  };
}

function styleEdit(overrides: Partial<TargetedEdit> & { property: string; value: string }): TargetedEdit {
  return {
    findingId: 'f1',
    selector: '[data-fra-element="btn1"]',
    expectedMatches: 1,
    kind: 'style',
    removeValue: null,
    dsComponent: null,
    dsVariant: null,
    dsToken: null,
    rationale: 'test edit',
    confidence: 0.9,
    ...overrides,
  };
}

function planOf(edits: TargetedEdit[], iteration: number): R3Output {
  return { iteration, plan: { edits, unaddressed: [] }, chunks: 1, usage: null };
}

/** R4 now verifies (§security) that every edit's selector stays within ITS OWN finding's mapped stamp — real tests need a real mapping entry for that, same as C2 would have produced. */
function attachMapping(session: CaptureSession, findingId: string, elementId: string): void {
  session.mapping = {
    entries: [
      {
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
      },
    ],
    unmapped: [],
    conflicts: [],
    usage: null,
  };
}

describe('runR4 — real DOM edits', () => {
  it('blocks prohibited CTA fills and alignment changes in resumed/manual plans before changing the DOM', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const r1 = makeR1(`${server.origin}/r4page`);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    attachMapping(session, 'f1', 'btn1');
    try {
      const before = await session.page.locator('.btn').getAttribute('style');
      const edits = [styleEdit({ property: 'background', value: 'var(--composition-gradient-brand-dark-shimmer)' }), styleEdit({ property: 'text-align', value: 'left' })];
      const result = await runR4({ paths }, { r1, session, plan: planOf(edits, 1), iteration: 1, previousApplied: [] });
      expect(result.applied.every((a) => !a.applied && a.error?.startsWith('Project redesign policy:'))).toBe(true);
      expect(await session.page.locator('.btn').getAttribute('style')).toBe(before);
      expect(await session.page.locator('.btn').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(238, 238, 238)');
    } finally {
      await session.release();
    }
  }, 60_000);
  it('applies edits to the live page, records matched/applied/previousValue, and writes after-tiles/composite', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const r1 = makeR1(`${server.origin}/r4page`);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    attachMapping(session, 'f1', 'btn1');
    try {
      const edits = [styleEdit({ property: 'padding-left', value: '28px' }), styleEdit({ property: 'font-weight', value: '500' })];
      const plan = planOf(edits, 1);

      const result = await runR4({ paths, log: () => {} }, { r1, session, plan, iteration: 1, previousApplied: [] });

      expect(result.iteration).toBe(1);
      expect(result.applied).toHaveLength(2);
      for (const a of result.applied) {
        expect(a.matched).toBe(1);
        expect(a.applied).toBe(true);
        expect(a.error).toBeNull();
      }
      expect(result.applied[0]!.previousValue).toBe('12px');
      expect(result.applied[1]!.previousValue).toBe('400');

      // Read the LIVE DOM back — not just the return value — to prove the edit really landed.
      const live = await session.page.locator('[data-fra-element="btn1"]').evaluate((el) => {
        const cs = getComputedStyle(el);
        return { paddingLeft: cs.getPropertyValue('padding-left'), fontWeight: cs.getPropertyValue('font-weight') };
      });
      expect(live.paddingLeft).toBe('28px');
      expect(live.fontWeight).toBe('500');

      expect(result.after.tiles.length).toBeGreaterThan(0);
      for (const tile of result.after.tiles) expect(existsSync(tile.path)).toBe(true);
      expect(result.after.composite).not.toBeNull();
      expect(existsSync(result.after.composite!.path)).toBe(true);
      expect(result.after.composite!.path).toBe(paths.afterPng);
    } finally {
      await session.release();
    }
  }, 60_000);

  it('reports a not-applied outcome, never guessing, when the selector matches the wrong count', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const r1 = makeR1(`${server.origin}/r4page`);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    attachMapping(session, 'f1', 'btn1');
    try {
      // A descendant selector that stays within finding f1's own stamp (btn1) — passes the
      // §security containment check, so this genuinely exercises applyEdit's own "matched 0"
      // handling rather than being rejected one layer earlier for an unrelated reason.
      const badEdit = styleEdit({ property: 'color', value: 'red', selector: '[data-fra-element="btn1"] .no-such-child' });
      const result = await runR4({ paths, log: () => {} }, { r1, session, plan: planOf([badEdit], 1), iteration: 1, previousApplied: [] });
      expect(result.applied[0]!.matched).toBe(0);
      expect(result.applied[0]!.applied).toBe(false);
      expect(result.applied[0]!.error).toContain('matched 0 element');
    } finally {
      await session.release();
    }
  }, 60_000);

  it('iteration 2 replaying the same edit reuses the recorded previousValue and does not double-apply the CSS rule (§7.5)', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const r1 = makeR1(`${server.origin}/r4page`);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    attachMapping(session, 'f1', 'btn1');
    try {
      const edit = styleEdit({ property: 'padding-left', value: '28px' });
      const iter1 = await runR4({ paths, log: () => {} }, { r1, session, plan: planOf([edit], 1), iteration: 1, previousApplied: [] });
      expect(iter1.applied[0]!.previousValue).toBe('12px');

      const ruleCountAfterIter1 = await session.page.evaluate(() => (document.getElementById('fra-injected-edits') as HTMLStyleElement).sheet!.cssRules.length);
      expect(ruleCountAfterIter1).toBe(1);

      // Same edit re-planned in iteration 2 (e.g. R3 re-emitting it because R5 hadn't yet verified it).
      const previousApplied: AppliedEdit[] = iter1.applied;
      const iter2 = await runR4({ paths, log: () => {} }, { r1, session, plan: planOf([edit], 2), iteration: 2, previousApplied });

      // The idempotency key: previousValue is REPLAYED from iteration 1, never re-measured off
      // the already-mutated live value (which is now "28px" — reusing that would corrupt the
      // revert history into thinking the edit's baseline was its own new value).
      expect(iter2.applied[0]!.previousValue).toBe('12px');
      expect(iter2.applied[0]!.applied).toBe(true);

      // The injected stylesheet rule was replaced in place, never duplicated.
      const ruleCountAfterIter2 = await session.page.evaluate(() => (document.getElementById('fra-injected-edits') as HTMLStyleElement).sheet!.cssRules.length);
      expect(ruleCountAfterIter2).toBe(1);

      const live = await session.page.locator('[data-fra-element="btn1"]').evaluate((el) => getComputedStyle(el).getPropertyValue('padding-left'));
      expect(live).toBe('28px');
    } finally {
      await session.release();
    }
  }, 60_000);

  it('regression: two edits of the SAME finding with property=null (kind=text and kind=class both always have property=null) do not collide on replay — each keeps its OWN previousValue', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const r1 = makeR1(`${server.origin}/r4page`);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    attachMapping(session, 'f1', 'btn1');
    try {
      const textEdit: TargetedEdit = { findingId: 'f1', selector: '[data-fra-element="btn1"]', expectedMatches: 1, kind: 'text', property: null, value: 'New Label', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 0.9 };
      const classEdit: TargetedEdit = { findingId: 'f1', selector: '[data-fra-element="btn1"]', expectedMatches: 1, kind: 'class', property: null, value: 'is-active', removeValue: 'btn', dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 0.9 };

      const iter1 = await runR4({ paths, log: () => {} }, { r1, session, plan: planOf([textEdit, classEdit], 1), iteration: 1, previousApplied: [] });
      expect(iter1.applied[0]!.previousValue).toBe('Sign up'); // textEdit's original textContent
      expect(iter1.applied[1]!.previousValue).toBe('btn'); // classEdit's original className — NOT "Sign up"

      const iter2 = await runR4({ paths, log: () => {} }, { r1, session, plan: planOf([textEdit, classEdit], 2), iteration: 2, previousApplied: iter1.applied });
      // The bug: keying replay lookup only by (findingId, property) would find the FIRST
      // property=null record for BOTH edits, handing classEdit the textEdit's previousValue.
      expect(iter2.applied[0]!.previousValue).toBe('Sign up');
      expect(iter2.applied[1]!.previousValue).toBe('btn');
    } finally {
      await session.release();
    }
  }, 60_000);

  it('§security regression: refuses an edit whose selector targets an element OUTSIDE the finding\'s own mapped stamp — never applied, even though the target element genuinely exists', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const r1 = makeR1(`${server.origin}/r4page`);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    attachMapping(session, 'f1', 'btn1'); // finding f1 is mapped to btn1 — NOT body
    try {
      const escapingEdit = styleEdit({ property: 'background-color', value: 'red', selector: 'body' });
      const result = await runR4({ paths, log: () => {} }, { r1, session, plan: planOf([escapingEdit], 1), iteration: 1, previousApplied: [] });

      expect(result.applied[0]!.applied).toBe(false);
      expect(result.applied[0]!.error).toMatch(/does not stay within finding f1's own stamped element/);
      const bodyBg = await session.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bodyBg).not.toBe('rgb(255, 0, 0)'); // never actually applied to the live page
    } finally {
      await session.release();
    }
  }, 60_000);

  it('§security regression: refuses an edit for a findingId with no mapping entry at all — never applied against an unverifiable target', async () => {
    const paths = freshPaths();
    await ensureRedesignDirs(paths);
    const r1 = makeR1(`${server.origin}/r4page`);
    const session = await runR2({ pool, politeness: new Politeness(0), paths }, r1);
    session.mapping = { entries: [], unmapped: [], conflicts: [], usage: null }; // no mapping for 'ghost-finding' at all
    try {
      const ghostEdit = styleEdit({ findingId: 'ghost-finding', property: 'color', value: 'red' });
      const result = await runR4({ paths, log: () => {} }, { r1, session, plan: planOf([ghostEdit], 1), iteration: 1, previousApplied: [] });

      expect(result.applied[0]!.applied).toBe(false);
      expect(result.applied[0]!.error).toMatch(/has no mapping entry/);
    } finally {
      await session.release();
    }
  }, 60_000);
});
