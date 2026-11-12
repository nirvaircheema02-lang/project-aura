import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { openDb } from '../../src/db/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { DisabledLlmClient } from '../../src/llm/provider.ts';
import { auditPage } from '../../src/agents/page-graph.ts';
import { renderRun } from '../../src/dashboard/views/render.ts';
import { buildAuditData } from '../../src/agents/c2-json-writer/index.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import type { Finding, PageResult } from '../../src/skills/s0-result-contract.ts';

/**
 * Nearest typography match, END TO END: a real Chromium audit of a page in no-api mode against the
 * real Design System. The permanent rule (not a per-page fix): a heading is audited against the DS
 * heading size NEAREST its rendered size — 31.25px / 1.953rem for a 32px h2, not level 2's 39.06px
 * because the tag is h2 — and the finding shows Actual / Closest DS value / Difference / DS source
 * while saying the element stays an h2. Sections differ in height so the page is never mistaken for
 * a grid of identical cards.
 */

const html = `<!doctype html><style>
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#111;background:#fff}
section{padding:40px}
h1,h2,h3{font-family:'Noto Serif',Georgia,serif;font-weight:300;margin:0 0 12px}
#reported{font-size:32px;letter-spacing:0.48px;line-height:48px}
#thirtyeight{font-size:38px}
#exactl2{font-size:39.056px;letter-spacing:-0.015em}
#exactl3{font-size:31.248px;letter-spacing:-0.01em}
</style><main>
<section aria-label="Reported" style="height:180px"><h2 id="reported">Find Your Survey's Sweet Spot</h2><p>Plain copy under the heading.</p></section>
<section aria-label="Thirty eight" style="height:230px"><h3 id="thirtyeight">Reach anyone anywhere</h3><p>A different amount of supporting copy sits here so this block is its own size.</p><p>Second paragraph.</p></section>
<section aria-label="Exact level two" style="height:290px"><h2 id="exactl2">Our approach to research</h2><p>Copy.</p><p>More copy.</p><p>Even more copy.</p></section>
<section aria-label="Exact level three" style="height:350px"><h2 id="exactl3">Questions we get asked</h2><p>Copy.</p><p>More copy.</p><p>Even more copy.</p><p>And a fourth.</p></section>
</main>`;

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let db: ReturnType<typeof openDb>;
let dir: string;
let result: PageResult;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-typography-'));
  db = openDb(join(dir, 'audit.db'));
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  server = await startLocalServer({ '/': { body: html } });
  const config = loadConfig();
  result = await auditPage(server.origin + '/', { db, pool, registry: await loadDsRegistry(config.designSystemPath), config, aiMode: 'no-api', llm: new DisabledLlmClient(), politeness: new Politeness(0), evidenceRoot: join(dir, 'screenshots') }, { runId: 'typography-nearest' });
}, 180000);
afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const heading = (label: string): Finding => {
  const f = result.findings.filter((x) => x.component.productionType === 'section-heading' && x.component.productionLabel === label);
  expect(f, `exactly one section-heading finding for "${label}"`).toHaveLength(1);
  return f[0]!;
};
const fontSize = (f: Finding) => f.comparison.properties?.find((p) => p.property === 'font-size');

describe('an h2 rendered at 32px (the reported finding): nearest DS size, semantic tag untouched', () => {
  it('is audited against level 3 — 31.25px / 1.953rem — not level 2 / 2.441rem', () => {
    const f = heading("Find Your Survey's Sweet Spot");
    expect(f.component).toMatchObject({ dsComponent: 'SectionHeading', dsVariant: 'level 3' });
    expect(f.classification).toBe('DEVIATION');
    expect(fontSize(f)).toMatchObject({ actual: '32px', expected: '1.953rem', status: 'DIFFERENT', source: 'atoms/SectionHeading.tsx' });
    const m = f.comparison.mismatches.find((x) => x.property === 'font-size')!;
    expect(m).toMatchObject({ actual: '32px', expected: '1.953rem', comparison: 'length-px' });
    expect(m.delta).toBeCloseTo(0.75, 2); // 32 − 31.248: the difference the finding states
  });

  it('shows Actual / Closest DS value / Difference / DS source on the font-size row', () => {
    const note = fontSize(heading("Find Your Survey's Sweet Spot"))!.note!;
    expect(note).toContain('Closest DS size: 31.25px / 1.953rem (level 3)');
    expect(note).toContain('0.75px from the rendered 32px');
    expect(note).toContain('The element is an h2 and stays one');
    expect(note).toContain('level 3 is only its closest visual size, not a reason to change its HTML level');
  });

  it('recommends 1.953rem and says the HTML level stays — it never asks for an h3', () => {
    const rec = heading("Find Your Survey's Sweet Spot").action.recommendation;
    expect(rec).toContain('Source: atoms/SectionHeading.tsx (level 3).');
    expect(rec).toContain('font-size: 32px → 1.953rem (31.25px — the closest DS size, 0.75px away)');
    expect(rec).toContain('The element is an h2 and stays one');
    expect(rec).not.toContain('2.441rem');
    expect(rec).not.toMatch(/\bh3\b/);
  });

  it('every other property is compared against the SAME level — letter-spacing is level 3\'s −0.01em, not level 2\'s −0.015em', () => {
    const f = heading("Find Your Survey's Sweet Spot");
    expect(f.comparison.properties?.find((p) => p.property === 'letter-spacing')).toMatchObject({ expected: '-0.01em', status: 'DIFFERENT' });
    expect(f.comparison.properties?.find((p) => p.property === 'font-weight')).toMatchObject({ actual: '300', status: 'MATCH' });
    expect(f.comparison.properties?.some((p) => p.expected === '2.441rem' || p.expected === '-0.015em')).toBe(false);
  });

  it('a 0.75px drift is a small deviation, not the 7px one the old level-2 comparison reported', () => {
    expect(heading("Find Your Survey's Sweet Spot").quality.severity).toBe('LOW');
  });

  it('keeps an auditable record in the evidence: every DS size considered, and what settled the choice', () => {
    const note = heading("Find Your Survey's Sweet Spot").quality.evidence.find((e) => e.kind === 'ds-source' && e.note?.startsWith('nearest typography match'))?.note;
    expect(note).toContain('rendered 32px → level 3 31.25px / 1.953rem, 0.75px away');
    expect(note).toContain('level 3 31.25px (0.75px away) · level 2 39.06px (7.06px away) · level 1 48.83px (16.83px away)');
    expect(note).toContain('settled by the nearest size');
    expect(note).toContain('Semantic tag h2 unchanged.');
  });
});

describe('the same rule for every heading, whatever its tag', () => {
  it('an h3 at 38px is audited against level 2 (2.441rem, 1.06px away) — and stays an h3', () => {
    const f = heading('Reach anyone anywhere');
    expect(f.component.dsVariant).toBe('level 2');
    expect(fontSize(f)).toMatchObject({ actual: '38px', expected: '2.441rem', status: 'DIFFERENT' });
    expect(fontSize(f)?.note).toContain('The element is an h3 and stays one');
    expect(f.action.recommendation).toContain('font-size: 38px → 2.441rem (39.06px — the closest DS size, 1.06px away)');
  });

  it('an h2 rendered at EXACTLY level 2\'s size is preserved: level 2, font-size matches, no override and no note', () => {
    const f = heading('Our approach to research');
    expect(f.component.dsVariant).toBe('level 2');
    expect(fontSize(f)).toMatchObject({ actual: '39.056px', expected: '2.441rem', status: 'MATCH', note: null });
    expect(f.classification).toBe('MATCH');
  });

  it('an h2 rendered at exactly level 3\'s size is a MATCH against level 3 — it used to be a 7px deviation from level 2', () => {
    const f = heading('Questions we get asked');
    expect(f.component.dsVariant).toBe('level 3');
    expect(fontSize(f)).toMatchObject({ actual: '31.248px', expected: '1.953rem', status: 'MATCH' });
    expect(fontSize(f)?.note).toContain('Matches level 3, the nearest DS size (31.25px / 1.953rem)');
    expect(fontSize(f)?.note).toContain('The element is an h2 and stays one');
    expect(f.classification).toBe('MATCH');
    expect(f.comparison.mismatches).toEqual([]);
  });
});

describe('the standalone / dashboard report shows it', () => {
  it('prints the closest DS value, the difference and the keep-the-tag sentence in the finding detail', () => {
    const data = buildAuditData({ runId: 'typography-nearest', auditId: 'typography-nearest', mode: 'single-page', startedAt: '2026-10-06', targetUrl: server.origin, pages: [result], failedPages: [] });
    const markup = renderRun('Typography', data, '/screenshots');
    expect(markup).toContain('Closest DS size: 31.25px / 1.953rem (level 3) — 0.75px from the rendered 32px.');
    expect(markup).toContain('font-size: 32px → 1.953rem (31.25px — the closest DS size, 0.75px away)');
    expect(markup).toContain('The element is an h2 and stays one');
  });
});
