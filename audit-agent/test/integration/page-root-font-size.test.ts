import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { openDb } from '../../src/db/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { withCapturedPage } from '../../src/t-layer/capture.ts';
import { extractComputedStyle, readRootFontSizePx } from '../../src/t-layer/computed-style.ts';
import { DisabledLlmClient } from '../../src/llm/provider.ts';
import { auditPage } from '../../src/agents/page-graph.ts';
import { buildAuditData } from '../../src/agents/c2-json-writer/index.ts';
import { buildWorkbook } from '../../src/agents/c1-excel-reporter/index.ts';
import { buildPublishPlan } from '../../src/figma/publish-plan.ts';
import { FIGMA_CONTRACT_VERSION } from '../../src/figma/prompt-contract.ts';
import { renderRun } from '../../src/dashboard/views/render.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import type { Finding, PageResult } from '../../src/skills/s0-result-contract.ts';

/**
 * The report's px beside an expected `rem` value is the rem length × the page's MEASURED root font
 * size — never an assumed 16px. Proven END TO END against real Chromium, no fakes:
 *
 *   page capture measures the root → PageResult.capture → data.json pageSummary[].rootFontSizePx
 *   → the HTML report, the Figma plan and the Excel report each convert with THEIR page's root,
 *
 * and the root a report converts with is the very root the audit compared with (B4's own nearest-size
 * annotation, written from the per-element measurement, shows the same px). Two pages with different
 * roots sit in ONE run, so a single global root cannot pass.
 */

/** The same heading page the nearest-typography audit uses: an h2 whose rendered size sits near a DS size. */
const pageHtml = (rootAttr: string, reportedPx: number) => `<!doctype html><html${rootAttr}><style>
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#111;background:#fff}
section{padding:40px}
h1,h2,h3{font-family:'Noto Serif',Georgia,serif;font-weight:300;margin:0 0 12px}
#reported{font-size:${reportedPx}px;letter-spacing:0.48px;line-height:48px}
#thirtyeight{font-size:38px}
</style><main>
<section aria-label="Reported" style="height:180px"><h2 id="reported">Find Your Survey's Sweet Spot</h2><p>Plain copy under the heading.</p></section>
<section aria-label="Thirty eight" style="height:230px"><h3 id="thirtyeight">Reach anyone anywhere</h3><p>A different amount of supporting copy sits here so this block is its own size.</p><p>Second paragraph.</p></section>
</main>`;

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let db: ReturnType<typeof openDb>;
let dir: string;
let registry: Awaited<ReturnType<typeof loadDsRegistry>>;
const politeness = new Politeness(0);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-root-font-'));
  db = openDb(join(dir, 'audit.db'));
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  server = await startLocalServer({
    '/default-root': { body: pageHtml('', 32) },
    '/root-20': { body: pageHtml(' style="font-size:20px"', 40) },
    '/root-percent': { body: pageHtml(' style="font-size:62.5%"', 20) },
  });
  registry = await loadDsRegistry(loadConfig().designSystemPath);
}, 120000);
afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the page capture measures the root font size the page really has', () => {
  it('16px by default, 20px for `html{font-size:20px}`, 10px for the `62.5%` convention — and the per-element measurement B3/B4 use agrees', async () => {
    for (const [path, expected] of [['/default-root', 16], ['/root-20', 20], ['/root-percent', 10]] as const) {
      const { rootFontSizePx, perElement } = await withCapturedPage(pool, politeness, server.origin + path, async (page, capture) => {
        const style = await extractComputedStyle(page.locator('#reported'));
        return { rootFontSizePx: capture.rootFontSizePx, perElement: style.connected ? style.rootFontSizePx : null };
      });
      expect(rootFontSizePx, path).toBe(expected);
      expect(perElement, `${path}: the page-level read and the per-element read are one measurement`).toBe(rootFontSizePx);
    }
  }, 60000);

  it('is read with the expression the per-element extraction uses, on a live page', async () => {
    const measured = await pool.withIsolatedPage(async (page) => {
      await page.goto(server.origin + '/root-20');
      return readRootFontSizePx(page);
    });
    expect(measured).toBe(20);
  }, 30000);

  it('a page that cannot be read gives null — never a thrown error, never a made-up size', async () => {
    const broken = { evaluate: async () => { throw new Error('Target page, context or browser has been closed'); } } as unknown as Page;
    await expect(readRootFontSizePx(broken)).resolves.toBeNull();
  });
});

describe('two pages with different roots in one run: each report converts with ITS page\'s root', () => {
  let pageA: PageResult; // root 16, h2 32px → level 3 (1.953rem)
  let pageB: PageResult; // root 20, h2 40px → level 3 (1.953rem)
  let data: ReturnType<typeof buildAuditData>;
  let snapshot: string;

  const deps = () => ({ db, pool, registry, config: loadConfig(), aiMode: 'no-api' as const, llm: new DisabledLlmClient(), politeness, evidenceRoot: join(dir, 'screenshots') });
  const heading = (page: PageResult): Finding => {
    const f = page.findings.filter((x) => x.component.productionType === 'section-heading' && x.component.productionLabel === "Find Your Survey's Sweet Spot");
    expect(f, 'exactly one reported heading finding').toHaveLength(1);
    return f[0]!;
  };

  beforeAll(async () => {
    pageA = await auditPage(server.origin + '/default-root', deps(), { runId: 'root-a' });
    pageB = await auditPage(server.origin + '/root-20', deps(), { runId: 'root-b' });
    data = buildAuditData({ runId: 'root-run', auditId: 'root-run', mode: 'full-site', startedAt: '2026-10-07T10:00:00.000Z', targetUrl: server.origin, pages: [pageA, pageB], failedPages: [] });
    snapshot = JSON.stringify(data);
  }, 180000);

  it('records the measured root with each page — in the page result and in data.json\'s pageSummary', () => {
    expect(pageA.capture.rootFontSizePx).toBe(16);
    expect(pageB.capture.rootFontSizePx).toBe(20);
    expect(data.pageSummary.find((p) => p.pageId === pageA.pageId)?.rootFontSizePx).toBe(16);
    expect(data.pageSummary.find((p) => p.pageId === pageB.pageId)?.rootFontSizePx).toBe(20);
  });

  it('the audit itself compared at that root: both headings are level 3 / 1.953rem, and B4\'s own annotation shows the px of THAT page', () => {
    const a = heading(pageA);
    const b = heading(pageB);
    for (const f of [a, b]) {
      expect(f.component).toMatchObject({ dsComponent: 'SectionHeading', dsVariant: 'level 3' });
      expect(f.comparison.mismatches.find((m) => m.property === 'font-size')).toMatchObject({ expected: '1.953rem' });
    }
    expect(a.action.recommendation).toContain('font-size: 32px → 1.953rem (31.25px — the closest DS size, 0.75px away)');
    expect(b.action.recommendation).toContain('font-size: 40px → 1.953rem (39.06px — the closest DS size, 0.94px away)');
  });

  it('the HTML report: each finding\'s summary, detail and property table show the px of its own page — 31.25px at 16px, 39.06px at 20px', () => {
    const html = renderRun('Root font size', data, '/screenshots');
    const row = (f: Finding) => {
      const chunk = html.split('<div class="frow"').find((c) => c.includes(`data-finding-id="${f.identity.findingId}"`));
      expect(chunk, 'the finding\'s row').toBeDefined();
      return chunk as string;
    };
    const a = row(heading(pageA));
    const b = row(heading(pageB));
    expect(a).toContain('font-size: 32px → 1.953rem (31.25px)'); // the compact summary
    expect(a).toContain('<dd class="mono">1.953rem (31.25px)'); // the detail Expected field
    expect(a).not.toContain('39.06px');
    expect(b).toContain('font-size: 40px → 1.953rem (39.06px)');
    expect(b).toContain('<dd class="mono">1.953rem (39.06px)');
    expect(b).toContain('<td class="mono">1.953rem (39.06px)'); // the property comparison table
    expect(b).not.toContain('31.25px');
  });

  it('the Figma plan: each page\'s marker card quotes the px of its own page', () => {
    const plan = buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
    const bullets = (page: PageResult) => plan.pageAudits.find((p) => p.key === page.pageId)!.markerGroups.flatMap((g) => g.bullets);
    expect(bullets(pageA)).toContain('font-size: 32px → 1.953rem (31.25px)');
    expect(bullets(pageB)).toContain('font-size: 40px → 1.953rem (39.06px)');
    const cardLines = (page: PageResult) => plan.pageAudits.find((p) => p.key === page.pageId)!.cards.map((c) => c.actualVsExpected).join('\n');
    expect(cardLines(pageA)).toContain('font-size: 32px → expected 1.953rem (31.25px)');
    expect(cardLines(pageB)).toContain('font-size: 40px → expected 1.953rem (39.06px)');
    // The same heading's size is never drawn with the OTHER page's root…
    expect(cardLines(pageA)).not.toContain('font-size: 32px → expected 1.953rem (39.06px)');
    expect(cardLines(pageB)).not.toContain('font-size: 40px → expected 1.953rem (31.25px)');
    // …and the audit's OWN nearest match already ran at each page's root, so the display agrees with it: a 38px h3 is
    // level 3 on the 20px page (1.953rem × 20 = 39.06px) but level 2 on the 16px page (2.441rem × 16 = 39.06px).
    expect(cardLines(pageB)).toContain('font-size: 38px → expected 1.953rem (39.06px)');
    expect(cardLines(pageA)).toContain('font-size: 38px → expected 2.441rem (39.06px)');
  });

  it('the Excel report: the Expected column carries the px of the finding\'s own page', async () => {
    const wb = await buildWorkbook(data);
    const sheet = wb.getWorksheet('04 All Findings')!;
    const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    const col = (name: string) => header.indexOf(name);
    const rows = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
    const expectedFor = (page: PageResult) => {
      const r = rows.find((x) => String(x.getCell(col('URL')).value) === page.url && String(x.getCell(col('Property')).value) === 'font-size' && String(x.getCell(col('Production component')).value).includes("Find Your Survey's Sweet Spot"));
      expect(r, `a font-size row for ${page.url}`).toBeDefined();
      return String(r!.getCell(col('Expected')).value);
    };
    expect(expectedFor(pageA)).toBe('1.953rem (31.25px)');
    expect(expectedFor(pageB)).toBe('1.953rem (39.06px)');
  });

  it('display only: rendering every surface changed nothing the audit stored', () => {
    renderRun('Root font size', data, '/screenshots');
    buildPublishPlan(data, FIGMA_CONTRACT_VERSION);
    expect(JSON.stringify(data)).toBe(snapshot);
    const stored = heading(pageB).comparison.mismatches.find((m) => m.property === 'font-size')!;
    expect(stored.expected).toBe('1.953rem'); // the DS value, as the DS wrote it
    expect(heading(pageB).action.recommendation).toContain('font-size: 40px → 1.953rem (39.06px — the closest DS size, 0.94px away)');
  });

  it('a run written BEFORE the root was recorded has none: it falls back to the browser default (the only case a root is ever assumed)', () => {
    const legacy = JSON.parse(snapshot) as typeof data;
    for (const p of legacy.pageSummary) delete p.rootFontSizePx;
    const html = renderRun('Root font size', legacy, '/screenshots');
    const b = html.split('<div class="frow"').find((c) => c.includes(`data-finding-id="${heading(pageB).identity.findingId}"`))!;
    expect(b).toContain('font-size: 40px → 1.953rem (31.25px)'); // 1.953 × the 16px default
  });
});
