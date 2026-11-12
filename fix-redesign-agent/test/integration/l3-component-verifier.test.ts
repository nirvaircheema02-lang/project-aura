import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { runL3 } from '../../src/agents/l3-component-verifier/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import type { ComponentSpec } from '../../src/library/types.ts';
import type { Affordances } from '../../src/mapping/types.ts';

/**
 * `runL3`'s deterministic half shells out for real to the DS repo's own `pnpm run
 * typecheck|lint|verify` (`ds-checks.ts::runDsChecks` — `runL3` calls it with no exec
 * override, so there is no way to fake this through `L3Deps`) — a real subprocess, same
 * tier as `ds-registry.test.ts`'s D5 checker-script shell-outs. The acceptance-check test
 * additionally drives a real Playwright page, same tier as `t-layer-browser.test.ts`.
 */

const roots: string[] = [];
function makeDsRepo(scripts: { typecheck?: string; lint?: string; verify?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'fra-l3-'));
  roots.push(root);
  const dsRepoPath = join(root, 'design-system');
  mkdirSync(join(dsRepoPath, 'core-v2'), { recursive: true });
  writeFileSync(
    join(dsRepoPath, 'core-v2/package.json'),
    JSON.stringify({ name: 'ds-fixture', private: true, scripts: { typecheck: scripts.typecheck ?? 'exit 0', lint: scripts.lint ?? 'exit 0', verify: scripts.verify ?? 'exit 0' } }),
  );
  return dsRepoPath;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function componentSpec(overrides: Partial<ComponentSpec> = {}): ComponentSpec {
  return {
    schemaVersion: 1,
    componentId: 'card-abcd1234',
    patternId: 'pattern-1',
    resolution: 'new',
    updateTarget: null,
    name: 'Card',
    category: 'molecules',
    scope: 'page-local',
    scopeEvidenceMissing: false,
    reference: { source: 'live-capture', priorRunId: null, elementStamp: 'e1', cropPath: null },
    anatomy: 'card — 1 instance',
    variantAxes: [],
    tokens: [],
    statesObserved: ['default'],
    statesToDesign: ['hover'],
    postFixPrerequisite: null,
    writeSet: ['core-v2/src/molecules/Card.tsx', 'core-v2/src/molecules/Card.stories.tsx'],
    declaredSharedChanges: { barrelEntries: [], tokenAdditions: [] },
    dependsOn: { findings: [], components: [] },
    constraints: [],
    ...overrides,
  };
}

function withStoriesFile(dsRepoPath: string, spec: ComponentSpec): void {
  const storiesFile = spec.writeSet.find((f) => f.endsWith('.stories.tsx'))!;
  const abs = join(dsRepoPath, 'core-v2/src', storiesFile.replace(/^core-v2\/src\//, ''));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'export default { title: "molecules/Card" };\n');
}

const buttonAffordances: Affordances = { tagName: 'button', role: null, href: null, type: 'button', tabIndex: 0, ariaExpanded: null, ariaControls: null, ariaHaspopup: null, disabled: false, cursor: 'pointer', formAssociated: false };

describe('runL3 — page: null (components-only run, the L3Deps.page required→nullable regression)', () => {
  it('returns empty acceptance checks and does NOT throw when there is no live page context, even with a selector and affordances given', async () => {
    const dsRepoPath = makeDsRepo();
    const spec = componentSpec();
    withStoriesFile(dsRepoPath, spec);

    const result = await runL3({ dsRepoPath, page: null, viewports: [{ width: 375, height: 800 }], capturedViewport: { width: 1440, height: 900 }, captureStates: ['hover', 'focus'] }, spec, 'button.cta', buttonAffordances);

    // A non-null selector/affordances alone must not trigger acceptance checks — `page: null` does.
    expect(result.acceptance).toEqual([]);
    expect(result.dsChecks).toMatchObject({ typecheck: true, lint: true, verify: true, storyBuild: true });
    expect(result.visionVerdict).toBe('NOT_CHECKED');
    expect(result.status).toBe('PASS'); // ds checks ok, no acceptance results at all so nothing is proposed/missing
    expect(result.failedChecks).toEqual([]);
  }, 30_000);

  it('a failing DS typecheck script (real non-zero exit) fails the whole node — status FAIL, the failure named in failedChecks', async () => {
    const dsRepoPath = makeDsRepo({ typecheck: 'exit 1' });
    const spec = componentSpec();
    withStoriesFile(dsRepoPath, spec);

    const result = await runL3({ dsRepoPath, page: null, viewports: [], capturedViewport: { width: 1440, height: 900 }, captureStates: [] }, spec, null, null);

    expect(result.dsChecks.typecheck).toBe(false);
    expect(result.status).toBe('FAIL');
    expect(result.failedChecks.some((f) => f.startsWith('typecheck:'))).toBe(true);
  }, 30_000);

  it('no stories file at the declared path fails storyBuild even when typecheck/lint/verify all pass', async () => {
    const dsRepoPath = makeDsRepo();
    const spec = componentSpec(); // withStoriesFile is deliberately NOT called — nothing written at the stories path
    const result = await runL3({ dsRepoPath, page: null, viewports: [], capturedViewport: { width: 1440, height: 900 }, captureStates: [] }, spec, null, null);
    expect(result.dsChecks.storyBuild).toBe(false);
    expect(result.status).toBe('FAIL');
    expect(result.failedChecks.some((f) => f.startsWith('story:'))).toBe(true);
  }, 30_000);
});

describe('runL3 — acceptance checks against a real live page (§9.5)', () => {
  let pool: BrowserPool;
  let server: Awaited<ReturnType<typeof startLocalServer>>;
  let page: Page;

  const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>t</title>
<style>body{margin:0;padding:24px;font-family:system-ui,sans-serif}
#cta{background:#000;color:#fff;padding:8px 16px;border:1px solid #000;cursor:pointer;font-size:16px}
#cta:focus{outline:3px solid #1a73e8}</style></head>
<body><button id="cta">Contact us</button></body></html>`;

  it('runs real acceptance checks and classifies evidence per §9.5 — an unrequested viewport is `proposed`, an uncaptured state is `missing-evidence`, and either alone prevents PASS', async () => {
    server = await startLocalServer({ '/p': { body: PAGE_HTML } });
    pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
    await pool.start();
    const context = await pool.newIsolatedContext();
    page = await context.newPage();
    await page.goto(`${server.origin}/p`, { waitUntil: 'domcontentloaded' });

    const dsRepoPath = makeDsRepo();
    const spec = componentSpec();
    withStoriesFile(dsRepoPath, spec);

    const capturedViewport = { width: 1440, height: 900 };
    const result = await runL3(
      { dsRepoPath, page, viewports: [{ width: 375, height: 800 }], capturedViewport, captureStates: ['hover', 'focus'] }, // 'active' and 'disabled' deliberately left uncaptured
      spec,
      '#cta',
      buttonAffordances,
    );

    expect(result.dsChecks).toMatchObject({ typecheck: true, lint: true, verify: true, storyBuild: true });
    expect(result.acceptance.length).toBeGreaterThan(0);

    const byClass = (c: 'observed' | 'missing-evidence' | 'proposed') => result.acceptance.filter((a) => a.evidenceClass === c);
    expect(byClass('proposed')).toEqual([expect.objectContaining({ area: 'responsive', check: expect.stringContaining('375×800') })]);
    expect(byClass('missing-evidence').map((a) => a.check).sort()).toEqual(['active state styling', 'disabled state styling']);
    expect(byClass('observed').length).toBeGreaterThan(0);

    // §9.5: any `proposed` (or `missing-evidence`) result blocks PASS outright, however the
    // observed checks measured — even though DS checks are all green here.
    expect(result.status).toBe('PARTIAL');

    // A couple of the real, observed measurements against the live element:
    const contrast = result.acceptance.find((a) => a.check.startsWith('text contrast'));
    expect(contrast).toMatchObject({ evidenceClass: 'observed', passed: true }); // #000 on #fff-ish button is well over 4.5:1
    const name = result.acceptance.find((a) => a.check === 'role and accessible name present');
    expect(name).toMatchObject({ evidenceClass: 'observed', passed: true, detail: expect.stringContaining('Contact us') });
    const reachable = result.acceptance.find((a) => a.check === 'reachable in document order');
    expect(reachable).toMatchObject({ evidenceClass: 'observed', passed: true });
  }, 60_000);

  afterAll(async () => {
    await pool?.stop();
    await server?.close();
  });
});
