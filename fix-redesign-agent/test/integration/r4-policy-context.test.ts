import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { runR4 } from '../../src/agents/r4-apply-render/index.ts';
import type { CaptureSession, R1Output, R3Output } from '../../src/agents/types.ts';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { ensureRedesignDirs, redesignPaths } from '../../src/output/redesign-store.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { cleanupDsFixtures, makeDsDir, MINI_DS_TOKENS } from '../helpers/ds-colour-fixture.ts';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Reference lane round 3: R4 repeats the edit guard for resumed / manual plans, and the guard needs the DS index to recognise an alias of the target's colour
 * (R4 passed none, so the alias feature was dead code in production), and a selector LIST after the stamp must not reach applyEdit.
 */

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); cleanupDsFixtures(); });

const target = (): ResolvedTarget => ({
  id: 'c', findingId: 'f1', property: 'border-top-color', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
  audit: { status: 'NOT-LISTED', actual: null, expected: null, expectedToken: null, note: null, source: null }, reason: 'missing-ds-treatment', outcome: 'resolved-target',
  target: { value: 'rgba(0, 0, 0, 0.08)', comparison: 'color-deltaE', token: '--border-card' },
  provenance: { kind: 'approved-project-pattern', ds: null, reference: null, evidence: [] }, decisionReason: 'mapped', route: 'css-edit', acceptance: [],
  status: { design: 'resolved', implementation: 'not-started', verification: 'not-run', implementationDetail: null, verificationDetail: null },
});
const resolution: ResolutionFile = { schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets: [target()], noTargetFindings: [], notes: [] };
const styleEdit = (over: Partial<TargetedEdit>): TargetedEdit => ({
  findingId: 'f1', selector: '[data-fra-element="card"]', expectedMatches: 1, kind: 'style', property: 'border-top-color', value: 'var(--semantic-hairline-soft)', removeValue: null,
  dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 1, ...over,
});

async function run(edit: TargetedEdit, designSystemPath: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'fra-r4-ctx-'));
  const page = await (await browser.newContext()).newPage();
  try {
    await page.setContent('<style>:root{--semantic-hairline-soft:rgba(0,0,0,.08)}</style><div data-fra-element="card" style="border:2px solid blue">c</div><div id="o" style="border:2px solid blue">o</div>');
    const paths = redesignPaths(root, 'p', 'r');
    await ensureRedesignDirs(paths);
    const session = { page, mapping: { entries: [{ element: 'card', stamp: 'card', findingIds: ['f1'], affordances: { tagName: 'div', role: null }, dsReference: { dsComponent: null } }], unmapped: [], conflicts: [], usage: null } } as unknown as CaptureSession;
    const plan: R3Output = { iteration: 1, plan: { edits: [edit], unaddressed: [] }, chunks: 1, usage: null };
    const out = await runR4({ paths, ...(designSystemPath ? { designSystemPath } : {}) }, { resolution, r1: { fixFindings: [] } as unknown as R1Output, session, plan, iteration: 1, previousApplied: [] });
    const colours = await page.evaluate(() => ['[data-fra-element="card"]', '#o'].map((s) => getComputedStyle(document.querySelector(s)!).borderTopColor));
    return { applied: out.applied[0]!, colours };
  } finally {
    await page.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('runR4 hands the DS index to the policy', () => {
  it('without a Design System an alias of the target\'s colour cannot be shown to be one: refused, nothing painted', async () => {
    const { applied, colours } = await run(styleEdit({}), undefined);
    expect(applied.applied).toBe(false);
    expect(applied.error).toMatch(/^Project redesign policy:.*no DS index is available/);
    expect(colours[0]).toBe('rgb(0, 0, 255)');
  });

  it('with the Design System an equal-valued alias is applied', async () => {
    const ds = makeDsDir({ 'tokens/build/tokens.css': MINI_DS_TOKENS });
    const { applied, colours } = await run(styleEdit({}), ds);
    expect(applied.error).toBeNull();
    expect(applied.applied).toBe(true);
    expect(colours[0]).toBe('rgba(0, 0, 0, 0.08)');
  });

  it('with the Design System a DS token that is NOT the target\'s colour is still refused, and so is a page custom property', async () => {
    const ds = makeDsDir({ 'tokens/build/tokens.css': MINI_DS_TOKENS });
    for (const value of ['var(--semantic-ink-strong)', 'var(--page-raw)']) {
      const { applied, colours } = await run(styleEdit({ value }), ds);
      expect(applied.applied, value).toBe(false);
      expect(applied.error).toMatch(/^Project redesign policy:/);
      expect(colours[0]).toBe('rgb(0, 0, 255)');
    }
  });
});

describe('runR4 refuses a selector list after the stamp', () => {
  it('"<stamp> , #o" with expectedMatches 2 changes neither element', async () => {
    const ds = makeDsDir({ 'tokens/build/tokens.css': MINI_DS_TOKENS });
    const { applied, colours } = await run(styleEdit({ selector: '[data-fra-element="card"] , #o', expectedMatches: 2, property: 'border-top-width', value: '9px' }), ds);
    expect(applied.applied).toBe(false);
    expect(applied.error).toMatch(/does not stay within/);
    expect(colours).toEqual(['rgb(0, 0, 255)', 'rgb(0, 0, 255)']);
  });
});
