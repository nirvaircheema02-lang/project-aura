import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { openDb } from '../../src/db/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { runCoverageQa } from '../../src/agents/b7-coverage-qa/index.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { withFirstPass, type LivePipelineDeps } from '../helpers/live-pipeline.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';
import type { B4Output } from '../../src/agents/types.ts';

/**
 * ROLE-FIRST typography, end to end (real Chromium, the real Design System, no-api mode). A page with the cases from a real audit:
 *   - two cards whose titles are <p> 18px/500 over 14px copy        → CARD TITLE: the DS card-title contract (R4.3.5: 20px, DM Sans 500)
 *   - an <h2> "Pain Points" at 16px (a diagram label)               → LABEL: foundation rules like body text; 16px is a DS size → MATCH
 *   - a plain paragraph at 18px and a caption at 12px               → generic R1.3: neither is a DS size
 * And a clean text element says FOUNDATION checks passed (not "matches the Design System"), its property table shows the verified
 * properties as verified, and B7's independent role check agrees with B2.
 */

const css = `
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#0a0a0a;background:#fff}
section{padding:40px}
h2,p{margin:0}
.card{border:1px solid #ddd;width:200px;float:left;margin:12px;padding:12px}
.ct{font:500 18px/28px 'DM Sans',Arial,sans-serif;margin:0 0 8px}
.cd{font:400 14px/22px 'DM Sans',Arial,sans-serif}
.clear{clear:both}
`;
const html = `<!doctype html><html><head><style>${css}</style></head><body><main>
<section aria-label="Impact" style="min-height:700px">
  <h2 style="font:300 32px 'Noto Serif',Georgia,serif;margin-bottom:24px">What’s Impacting Your Dealers</h2>
  <h2 style="font:400 16px 'DM Sans',Arial,sans-serif;margin-bottom:24px">Pain Points</h2>
  <div class="card"><p class="ct">What It Means for the Brand</p><p class="cd">Overstocking ties up capital while understocking leads to missed sales and dealer frustration.</p></div>
  <div class="card"><p class="ct">How Ken Solves It</p><p class="cd">Identify inventory pressure points and act on them early with dealer-level data.</p></div>
  <div class="clear"></div>
  <p style="font:400 18px/28px 'DM Sans',Arial,sans-serif;margin-top:24px;width:420px">A plain paragraph of body copy set at eighteen pixels, which is not a step of the DS type scale.</p>
  <p style="font:400 16px/26px 'DM Sans',Arial,sans-serif;margin-top:16px;width:420px">A plain paragraph of body copy set at the DS base size of sixteen pixels.</p>
  <p style="font:400 12px/18px 'DM Sans',Arial,sans-serif;margin-top:16px;width:420px">Source: a twelve pixel caption, which is not a DS size either.</p>
</section>
<section aria-label="Because every voice deserves to be heard" style="min-height:300px;background:#f5f5fd">
  <h2 style="font:300 32px 'Noto Serif',Georgia,serif;margin-bottom:24px">Because every voice deserves to be heard</h2>
  <h3 style="font:400 14px/20px 'DM Sans',Arial,sans-serif;letter-spacing:.48px;color:#737373;cursor:pointer;margin:0 0 12px">Employee Engagement</h3>
  <h3 style="font:400 14px/20px 'DM Sans',Arial,sans-serif;letter-spacing:.48px;color:#737373;cursor:pointer;margin:0 0 12px">Customer Satisfaction Surveys</h3>
</section>
<section aria-label="FAQs" style="min-height:300px">
  <h2 style="font:300 32px 'Noto Serif',Georgia,serif;margin-bottom:24px">Frequently asked questions</h2>
  <h3 style="font:500 18px/26px 'DM Sans',Arial,sans-serif;color:#0a0a0a;cursor:pointer;margin:0 0 16px;width:700px">How do I know which survey is right for my business?</h3>
  <h3 style="font:500 16px/24px 'DM Sans',Arial,sans-serif;color:#0a0a0a;cursor:pointer;margin:0 0 16px;width:700px">Can we use our own audience or database for the survey?</h3>
  <h3 style="font:500 14px/20px 'DM Sans',Arial,sans-serif;color:#0a0a0a;cursor:pointer;margin:0 0 16px;width:700px">Does a compact fourteen pixel question also pass the check?</h3>
</section></main></body></html>`;

let dir: string;
let deps: LivePipelineDeps;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
const url = (path: string) => `${server.origin}${path}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-roles-'));
  const config = loadConfig();
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  server = await startLocalServer({ '/roles': { body: html } });
  deps = { db: openDb(join(dir, 'audit.db')), registry: await loadDsRegistry(config.designSystemPath), config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'shots') };
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  deps?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const find = (findings: Finding[], label: RegExp): Finding => {
  const f = findings.find((x) => label.test(x.component.productionLabel));
  if (!f) throw new Error(`no finding labelled ${label} (have: ${findings.map((x) => x.component.productionLabel.slice(0, 30)).join(' | ')})`);
  return f;
};

describe('a page audited role-first', () => {
  let out: B4Output;
  let roleGaps: string[] = [];
  let gatePassed = false;

  beforeAll(async () => {
    await withFirstPass(url('/roles'), deps, async (session, firstPass) => {
      const result = await runCoverageQa(session, firstPass);
      out = result.state;
      roleGaps = result.records.filter((r) => r.gap?.type === 'role').map((r) => `${r.raw.text}: ${r.gap?.detail}`);
      gatePassed = result.ledger.gate.passed && result.ledger.gate.unaccounted === 0;
    });
  }, 400_000);

  it('B7\'s independent role check agrees with B2 on every text (no role gap), and the Coverage Gate passes', () => {
    expect(roleGaps).toEqual([]);
    expect(gatePassed).toBe(true);
  });

  it('both card titles are CARD TITLES: judged by the card-title contract — 18px → 20px (R4.3.5) — not matched to SectionHeading and not passed as "on the scale"', () => {
    for (const label of [/^What It Means for the Brand$/, /^How Ken Solves It$/]) {
      const f = find(out.findings, label);
      expect(f.component.productionType).toBe('paragraph');
      expect(f.component.dsComponent).toBeNull();
      expect(f.quality.evidence.some((e) => e.ref === 'role' && /^heading role: card-title/.test(e.note ?? ''))).toBe(true);
      expect(f.comparison.ruleViolations.map((v) => [v.ruleId])).toEqual([['R4.3']]);
      expect(f.comparison.ruleViolations[0]?.why).toMatch(/card title set at 18px — R4\.3\.5/);
      expect(f.classification).toBe('INCORRECT'); // a measured rule breach, exactly like the generic R1.3
      expect(f.comparison.basis).toBe('foundation-only');
    }
  });

  it('"Pain Points" is a LABEL: 16px is a DS size, so it is a MATCH on the foundation rules — never recommended 31.25px, never a SectionHeading', () => {
    const f = find(out.findings, /^Pain Points$/);
    expect(f.component.productionType).toBe('paragraph');
    expect(f.component.dsComponent).toBeNull();
    expect(f.classification).toBe('MATCH');
    expect(f.comparison.mismatches).toEqual([]);
    expect(f.quality.evidence.some((e) => e.ref === 'role' && /^heading role: label/.test(e.note ?? ''))).toBe(true);
    expect(f.action.recommendation).not.toMatch(/31\.25|SectionHeading|1\.953rem/);
  });

  it('a MATCH on foundations SAYS so: foundation checks passed, no DS component compared — and the property table agrees with the verified evidence', () => {
    const f = find(out.findings, /^Pain Points$/);
    expect(f.comparison.basis).toBe('foundation-only');
    expect(f.action.recommendation).toMatch(/^No foundation issues found — typeface \(R1\.4\), size \(R1\.3\), colour \(R1\.1 \/ R1\.2\) verified\./);
    expect(f.action.recommendation).toContain('this is not a component match');
    expect(f.action.recommendation).not.toContain('implementation matches the Design System');
    const note = f.quality.evidence.find((e) => e.kind === 'computed-style')?.note ?? '';
    expect(note).toMatch(/^Foundation checks only — 3 verified \(font-family, font-size, color\); no Design System component was matched or compared$/);
    // the table: the three verified properties are verified MATCH rows (with the DS value), never "Not resolved / Not verified"
    const rows = new Map((f.comparison.properties ?? []).map((p) => [p.property, p]));
    for (const prop of ['font-family', 'font-size', 'color']) {
      expect(rows.get(prop)?.status, prop).toBe('MATCH');
      expect(rows.get(prop)?.note, prop).toMatch(/^Verified against R1\./);
    }
    expect(rows.get('font-size')).toMatchObject({ expected: '1rem', expectedToken: '--text-sm' });
  });

  it('an FAQ question is judged by the DS AccordionItem (16px/500): 18px → 16px, 14px accepted, never SectionHeading, never 31.25px — and a clickable 14px index entry is a label that passes the foundation rules', () => {
    const wrong = find(out.findings, /^How do I know which survey is right for my business\?$/);
    expect(wrong.component.productionType).toBe('paragraph');
    expect(wrong.component.dsComponent).toBeNull();
    expect(wrong.quality.evidence.some((e) => e.ref === 'role' && /^heading role: question/.test(e.note ?? ''))).toBe(true);
    expect(wrong.comparison.ruleViolations.map((v) => v.ruleId)).toEqual(['R1.3']);
    expect(wrong.comparison.ruleViolations[0]?.why).toMatch(/AccordionItem question is --text-sm \(16px\).*closest: 16px/);
    expect(JSON.stringify(wrong)).not.toMatch(/31\.25|1\.953rem|SectionHeading\/level/);
    expect(wrong.classification).not.toBe('MATCH');
    const right = find(out.findings, /^Can we use our own audience or database for the survey\?$/);
    expect(right.classification).toBe('MATCH');
    expect(right.comparison.basis).toBe('foundation-only');
    const compact = find(out.findings, /^Does a compact fourteen pixel question/);
    expect(compact.classification).toBe('MATCH'); // 14px is a documented R1.3 compact-text exception
    expect(compact.comparison.ruleViolations).toEqual([]);
    const idx = find(out.findings, /^Employee Engagement$/);
    expect(idx.component.productionType).toBe('paragraph');
    expect(idx.quality.evidence.some((e) => e.ref === 'role' && /^heading role: label/.test(e.note ?? ''))).toBe(true);
    expect(idx.classification).toBe('MATCH');
    expect(JSON.stringify(idx)).not.toMatch(/31\.25|1\.953rem/);
  });

  it('plain 18px body text is off the DS scale (legacy --text-md): INCORRECT-grade R1.3, nearest 20px — and 16px body text MATCHES', () => {
    const eighteen = find(out.findings, /^A plain paragraph of body copy set at eighteen/);
    expect(eighteen.comparison.ruleViolations.map((v) => [v.ruleId, v.why.includes('it equals --text-md, a legacy remap token')])).toEqual([['R1.3', true]]);
    expect(eighteen.classification).not.toBe('MATCH');
    const sixteen = find(out.findings, /^A plain paragraph of body copy set at the DS base size/);
    expect(sixteen.classification).toBe('MATCH');
    expect(sixteen.comparison.basis).toBe('foundation-only');
  });

  it('a 12px caption is not a DS size (the documented micro size is 11px): R1.3, nearest 12.8px', () => {
    const f = find(out.findings, /^Source: a twelve pixel caption/);
    expect(f.comparison.ruleViolations.map((v) => v.ruleId)).toEqual(['R1.3']);
    expect(f.comparison.ruleViolations[0]?.why).toMatch(/font-size 12px is not a step of the Design System type scale \(closest: 12\.8px, 0\.8px away\)/);
    expect(f.classification).not.toBe('MATCH');
  });
});
