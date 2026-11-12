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
import { startLocalServer } from '../helpers/local-server.ts';
import type { PageResult } from '../../src/skills/s0-result-contract.ts';

/**
 * The reported badge, END TO END: a real Chromium audit (no-api mode, the real Design System) of a
 * page containing the exact reported shape — a non-interactive "Phase 01"-style badge with an
 * off-scale radius and a decorative brand-red border, which B2 never offered as a candidate before
 * the fix (test/unit/b2-badge-detection.test.ts covers the detection in isolation; this proves the
 * FULL B1→B2→B3→B4→B5 pipeline finds it, matches it honestly and measures it). B2's first pass now
 * catches it, so B5 has nothing to recover here and must not duplicate it; B5's own recovery
 * (repeated non-interactive cards, outcomes, the 2-attempt cap) is covered in
 * test/unit/b5-completeness.test.ts and test/integration/engine-coverage.test.ts.
 */

const html = `<!doctype html><style>
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#111;background:#fff}
section{padding:40px}
h2{margin:0 0 16px}
.badge{display:inline-block;width:57px;height:28px;box-sizing:border-box;border:1px solid rgb(176,31,36);border-radius:6px;background:rgba(176,31,36,.1);color:rgb(87,62,105);font-size:12px;padding:4px 8px}
</style><main>
<section aria-label="Approach"><h2>Our Approach</h2><div class="badge">Phase 1</div></main>`;

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let db: ReturnType<typeof openDb>;
let dir: string;
let result: PageResult;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-b5-verify-'));
  db = openDb(join(dir, 'audit.db'));
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  server = await startLocalServer({ '/': { body: html } });
  const config = loadConfig();
  result = await auditPage(
    server.origin + '/',
    { db, pool, registry: await loadDsRegistry(config.designSystemPath), config, aiMode: 'no-api', llm: new DisabledLlmClient(), politeness: new Politeness(0), evidenceRoot: join(dir, 'screenshots') },
    { runId: 'b5-verify-regression' },
  );
}, 180_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('REGRESSION 4 & 5: a non-interactive badge is detected by B2\'s first pass, matched by B3 and measured by B4', () => {
  it('the badge is a real finding — not silently absent — with productionType "badge"', () => {
    const badge = result.findings.find((f) => f.component.productionType === 'badge' && f.component.productionLabel.includes('Phase'));
    expect(badge).toBeDefined();
  });

  it('REGRESSION 4: the DS HAS a Badge family — B3 maps the badge to it (identity before compliance), so it is audited against that component and never sent to B6 as a "new component"', () => {
    const badge = result.findings.find((f) => f.component.productionType === 'badge')!;
    expect(badge.component.dsComponent).toBe('Badge');
    expect(badge.component.dsVariant).toBeTruthy(); // the closest existing variant
    expect(badge.review?.node).not.toBe('B6');
    expect(['NEW_COMPONENT', 'DS_CANDIDATE', 'NEEDS_REVIEW']).not.toContain(badge.classification);
  });

  it('REGRESSION 5 (and the exact reported bug): the badge is measured and flagged — radius 6px → the Badge variant\'s own 5px, brand-red border on a non-CTA element (R1.2)', () => {
    const badge = result.findings.find((f) => f.component.productionType === 'badge')!;
    expect(badge.classification).toBe('INCORRECT');
    // The forbidden decoration stays a rule violation (it is a prohibition, not a value to match)…
    expect(badge.comparison.ruleViolations.map((v) => v.ruleId)).toEqual(['R1.2']);
    // …and the off-scale radius is now judged against the matched component's own contract: exact variant value first (R3.6's nearest step is only the backstop).
    const radius = badge.comparison.mismatches.find((m) => m.property === 'border-top-left-radius')!;
    expect(radius.actual).toBe('6px');
    expect(radius.expectedToken).toBe('--radius-button');
    expect(radius.expected).toBe('5px');
  });

  it('the badge carries real evidence — a stamped element, a screenshot, a measured box — never a synthesized placeholder', () => {
    const badge = result.findings.find((f) => f.component.productionType === 'badge')!;
    expect(badge.quality.evidence.some((e) => e.kind === 'element-screenshot')).toBe(true);
    expect(badge.quality.evidence.some((e) => e.kind === 'computed-style')).toBe(true);
  });
});

describe('6. clean findings do not loop unnecessarily (real pipeline, not just the unit-level mock)', () => {
  it('the section heading "Our Approach" — a normal, already-covered element — needed no B5 recovery at all', () => {
    const heading = result.findings.find((f) => f.component.productionType === 'section-heading' && f.component.productionLabel === 'Our Approach');
    expect(heading).toBeDefined();
    // It was captured by B2's ordinary first pass (a real heading role) — its elId never carries
    // the "-recovered-" marker B5's recovery path stamps onto anything IT captured.
    expect(result.findings.filter((f) => f.component.productionType === 'section-heading').length).toBe(1); // not duplicated by a second pass
  });
});
