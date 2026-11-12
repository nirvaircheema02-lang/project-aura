import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { openDb, type Database } from '../../src/db/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { auditPage } from '../../src/agents/page-graph.ts';
import { LISTING_SAMPLE_LIMIT } from '../../src/agents/b2-component-detector/index.ts';
import { isNotCompared, type PageResult } from '../../src/skills/s0-result-contract.ts';
import type { LlmClient, LlmRequest, LlmResponse } from '../../src/llm/client.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { ScriptedLlmClient } from '../helpers/scripted-llm.ts';
import { KNOWN_WRONG_PAGE } from '../helpers/known-wrong-page.ts';

/**
 * The scripted stand-in only ever answers perfectly. A real model does not:
 * it echoes ref syntax, skips items in a long list, names components that do
 * not exist, cites rules that do not exist, and occasionally answers 90 for a
 * 0..1 confidence. Each of these, before the pre-run review, silently
 * produced a WRONG finding (a false MATCH, a phantom CRITICAL, a confident
 * "new component" that is really a DS Button) or an empty audit. This runs
 * the real graph with exactly those misbehaviours injected.
 */

type Json = Record<string, any>;

class PerturbingLlmClient implements LlmClient {
  private readonly base = new ScriptedLlmClient();
  readonly calls: Array<{ nodeId: string; prompt: string }> = [];
  private readonly perturb: (req: LlmRequest<unknown>, data: Json, callIndex: number) => Json;

  constructor(perturb: (req: LlmRequest<unknown>, data: Json, callIndex: number) => Json) {
    this.perturb = perturb;
  }

  async structured<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const { data, usage } = await this.base.structured(req);
    const index = this.calls.filter((c) => c.nodeId === req.nodeId).length;
    this.calls.push({ nodeId: req.nodeId, prompt: req.prompt });
    return { data: this.perturb(req as LlmRequest<unknown>, structuredClone(data) as Json, index) as T, usage };
  }
}

/** Finds the ref of the line carrying `label="…"` in a B3/B4/B6 prompt. */
const refFor = (prompt: string, label: string) => prompt.match(new RegExp(`ref=(e\\d+)[^\\n]*label="${label}`))?.[1];

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let db: Database;
let dir: string;
let result: PageResult;
let llm: PerturbingLlmClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-misbehave-'));
  const config = loadConfig();
  const registry = await loadDsRegistry(config.designSystemPath);
  db = openDb(join(dir, 'audit.db'));
  server = await startLocalServer({ '/market-entry': { body: KNOWN_WRONG_PAGE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();

  llm = new PerturbingLlmClient((req, data, callIndex) => {
    switch (req.nodeId) {
      case 'B1':
        // Echoed syntax on every root ref.
        for (const s of data.sections) s.rootRef = `[ref=${s.rootRef}]`;
        return data;
      case 'B2':
        // Echoed syntax, plus one ref that exists nowhere on the page.
        for (const c of data.components) c.ref = `ref=${c.ref}`;
        if (callIndex === 0) data.components.push({ ref: 'e99999', componentType: 'button', label: 'Phantom', domSignals: [], visualSignals: '', instanceGroupKey: '', confidence: 0.9 });
        return data;
      case 'B3': {
        const decorative = refFor(req.prompt, 'Decorative red accent');
        const reports = refFor(req.prompt, 'Reports');
        const cardTwo = refFor(req.prompt, 'Report card two');
        data.matches = data.matches
          // "Report card two" is left out — in the first call AND the follow-up.
          .filter((m: Json) => m.ref !== cardTwo)
          .map((m: Json) => {
            if (m.ref === reports) return { ...m, dsComponent: 'Link', dsVariant: null, confidence: 0.9 }; // not a catalog component
            if (m.ref === decorative) return { ...m, dsComponent: 'Button (atoms)', confidence: 90 }; // decorated name, 0..100 scale
            return { ...m, ref: ` ${m.ref.toUpperCase()} ` };
          });
        return data;
      }
      case 'B4': {
        const book = refFor(req.prompt, 'Book discovery call');
        const decorative = refFor(req.prompt, 'Decorative red accent');
        data.components = data.components
          .filter((c: Json) => c.ref !== book) // omitted from every B4 call
          .map((c: Json) =>
            c.ref === decorative
              ? {
                  ...c,
                  ruleViolations: [
                    { ruleId: 'Rule R1.2', title: 'Brand Red is for CTAs ONLY', why: 'decorative use of brand red', confidence: 0.9 },
                    { ruleId: 'R9.9', title: 'Invented', why: 'a rule the DS does not have', confidence: 0.95 },
                  ],
                }
              : c,
          );
        return data;
      }
      case 'B5': {
        // Two visual remarks on the measured 44px CTA: a hedged CRITICAL and a trusted HIGH.
        const cta = req.prompt.match(/^ref=(e\d+) classification=DEVIATION issue="[^"]*height: actual 44px/m)?.[1];
        if (cta) {
          data.additionalIssues.push(
            { ref: cta, issueType: 'overlap', description: 'possibly overlaps the heading', severity: 'CRITICAL', confidence: 0.3 },
            { ref: cta, issueType: 'truncation', description: 'label clipped at the right edge', severity: 'HIGH', confidence: 0.7 },
          );
        }
        return data;
      }
      default:
        return data;
    }
  });

  result = await auditPage(
    `${server.origin}/market-entry`,
    { db, registry, aiMode: 'anthropic-api', llm, config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'evidence') },
    { runId: 'run-misbehave-1' },
  );
}, 180_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

// One finding per component (B5 visual remarks ride on the element's own finding).
const byLabel = (label: string) => result.findings.filter((f) => f.component.productionLabel === label && f.history.delta !== 'RESOLVED');

describe('ref syntax a real model echoes back', () => {
  it('B1 `[ref=eN]` and B2 `ref=eN` still resolve — the audit is not silently empty', () => {
    expect(result.coverage.sectionsAnalyzed).toBeGreaterThan(0);
    expect(result.coverage.componentsDetected).toBeGreaterThan(0);
    expect(byLabel('Talk to a Strategy Expert')).toHaveLength(1);
  });

  it('a hallucinated ref is recorded as dropped, not silently ignored', () => {
    expect(result.coverage.droppedRefs).toEqual(expect.arrayContaining([expect.objectContaining({ node: 'B2', ref: 'e99999' })]));
  });
});

describe('B4 leaving a component out never yields a free MATCH', () => {
  it('the omitted component is NOT_COMPARED: queued for a human, flagged as model-omitted', () => {
    const [book] = byLabel('Book discovery call');
    expect(book).toBeDefined();
    expect(book!.quality.escalationStatus).toBe('QUEUED');
    expect(book!.quality.escalationReasons).toEqual(expect.arrayContaining(['NOT_COMPARED', 'MODEL_OMITTED']));
    expect(book!.quality.confidenceBand).toBe('LOW');
    expect(book!.action.recommendation).toMatch(/^Comparison incomplete:/);
    // The follow-up ask happened before giving up.
    expect(llm.calls.filter((c) => c.nodeId === 'B4').length).toBeGreaterThanOrEqual(2);
  });

  it('…and is excluded from the compliance score rather than counted as compliant', () => {
    expect(result.compliance.notCompared).toBeGreaterThanOrEqual(1);
    const compared = result.findings.filter((f) => ['MATCH', 'DEVIATION', 'INCORRECT'].includes(f.classification) && !isNotCompared(f));
    const matches = compared.filter((f) => f.classification === 'MATCH').length;
    expect(result.compliance.compliancePercent).toBe(Math.round((matches / compared.length) * 1000) / 10);
  });

  it('the measured 44px deviation is still caught alongside all of this', () => {
    const [cta] = byLabel('Talk to a Strategy Expert');
    expect(cta!.classification).toBe('DEVIATION');
    expect(cta!.comparison.mismatches.some((m) => m.property === 'height' && m.actual === '44px')).toBe(true);
  });
});

describe('rules must exist', () => {
  it('"Rule R1.2" normalizes to a real rule; an invented "R9.9" is noted, never published as a violation', () => {
    const [decorative] = byLabel('Decorative red accent');
    expect(decorative!.classification).toBe('INCORRECT');
    expect(decorative!.comparison.ruleViolations.map((r) => r.ruleId)).toEqual(['R1.2']);
    expect(decorative!.quality.evidence.some((e) => e.note?.includes('unrecognized rule id "R9.9"'))).toBe(true);
  });

  it('a 0..100 confidence is not trusted — it escalates as out-of-contract instead of reading as HIGH', () => {
    const [decorative] = byLabel('Decorative red accent');
    expect(decorative!.quality.escalationReasons).toContain('OUT_OF_CONTRACT_CONFIDENCE');
    expect(decorative!.quality.confidence).toBeLessThanOrEqual(1);
  });
});

describe('B3 answers are resolved against the catalog', () => {
  it('"Link" is not a DS component, so it is not a match — and never becomes CTALink by substring', () => {
    const [reports] = byLabel('Reports');
    expect(reports).toBeDefined();
    expect(['NEW_COMPONENT', 'DS_CANDIDATE']).toContain(reports!.classification);
    expect(reports!.component.dsComponent).toBeNull();
    // An unusable name is an answer that could not be used — asked again, then escalated,
    // never a confident "new component" with a governance proposal filed.
    expect(reports!.quality.escalationReasons).toContain('MODEL_OMITTED');
    expect(reports!.quality.confidence).toBeLessThanOrEqual(0.3);
    expect(reports!.action.registryUpdateRef).toBeNull();
  });

  it('a ref B3 never answered is not a confident "new component": low confidence, escalated, no governance proposal', () => {
    const [cardTwo] = byLabel('Report card two');
    expect(cardTwo).toBeDefined();
    expect(cardTwo!.quality.escalationReasons).toContain('MODEL_OMITTED');
    expect(cardTwo!.quality.confidence).toBeLessThanOrEqual(0.3);
    expect(cardTwo!.action.registryUpdateRef).toBeNull();
    expect(cardTwo!.action.dsCandidateNote).toContain('B3 returned no DS match');
    expect(llm.calls.filter((c) => c.nodeId === 'B3')).toHaveLength(2); // asked once more before giving up
  });
});

describe('B5 visual remarks (third-pass review)', () => {
  it('a doubtful remark never raises severity; a trusted one does — and caps confidence at its own', () => {
    const [cta] = byLabel('Talk to a Strategy Expert');
    expect(cta!.comparison.mismatches.map((m) => m.property)).toEqual(expect.arrayContaining(['visual:overlap', 'visual:truncation']));
    // The hedged 0.3 "possible overlap" did not make a 4px deviation CRITICAL…
    expect(cta!.quality.severity).toBe('HIGH');
    // …the trusted 0.7 remark raised it to HIGH, and the finding claims no more confidence than that remark.
    expect(cta!.quality.confidence).toBeLessThanOrEqual(0.7);
    expect(cta!.quality.escalationReasons).toContain('VISUAL_UNCERTAIN');
    expect(cta!.quality.escalationStatus).toBe('QUEUED');
  });
});

describe('S0 contract holds for every finding', () => {
  it('every confidence is within 0..1', () => {
    for (const f of result.findings) {
      expect(f.quality.confidence).toBeGreaterThanOrEqual(0);
      expect(f.quality.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('B2 is idempotent under retry', () => {
  it('a stale data-audit-el stamp left by a failed attempt does not break the next attempt', async () => {
    // Plants exactly what a failed first attempt leaves behind: an element already
    // stamped with the id the retry will assign to a DIFFERENT element.
    const stale = KNOWN_WRONG_PAGE.replace('<footer aria-label="Footer">', '<footer aria-label="Footer" data-audit-el="s0-0">');
    const local = await startLocalServer({ '/stale': { body: stale } });
    const staleDb = openDb(join(dir, 'stale.db'));
    try {
      const config = loadConfig();
      const page = await auditPage(
        `${local.origin}/stale`,
        { db: staleDb, registry: await loadDsRegistry(config.designSystemPath), aiMode: 'anthropic-api', llm: new ScriptedLlmClient(), config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'stale-evidence') },
        { runId: 'run-stale-1' },
      );
      expect(page.coverage.componentsDetected).toBeGreaterThan(0);
      expect(page.findings.length).toBeGreaterThan(0);
      // Per-element fail-closed would ALSO keep the node alive — by silently losing the
      // element that collided with the stale stamp. The stamps must be cleared, so nothing is lost.
      expect(page.coverage.droppedRefs.filter((d) => d.reason.includes('no longer resolvable'))).toEqual([]);
    } finally {
      staleDb.close();
      await local.close();
    }
  }, 120_000);
});

describe('element identity and listing groups are page-correct (third-pass review)', () => {
  // The stand-in's B1 cites every outline line, including the page-root wrapper — which would
  // put every element in one page-sized section. A real model divides the page; so does this.
  const sectioned = () =>
    new PerturbingLlmClient((req, data) => {
      if (req.nodeId === 'B1') data.sections = data.sections.filter((section: Json) => !/^generic section/.test(section.name));
      return data;
    });

  async function auditHtml(name: string, html: string) {
    const local = await startLocalServer({ [`/${name}`]: { body: html } });
    const localDb = openDb(join(dir, `${name}.db`));
    try {
      const config = loadConfig();
      const page = await auditPage(
        `${local.origin}/${name}`,
        { db: localDb, registry: await loadDsRegistry(config.designSystemPath), aiMode: 'anthropic-api', llm: sectioned(), config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, `${name}-evidence`) },
        { runId: `run-${name}` },
      );
      const stored = localDb.prepare('SELECT finding_id, classification FROM findings WHERE run_id = ?').all(`run-${name}`) as Array<{ finding_id: string; classification: string }>;
      return { page, stored };
    } finally {
      localDb.close();
      await local.close();
    }
  }

  it('two sections\' same-named groups are separate listings: nothing is sampled out across sections, and the cap still holds within a real listing', async () => {
    const cards = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `<div class="card">${prefix} card ${i + 1}</div>`).join('');
    // Only a repeated group of at least LISTING_MIN_ITEMS (12) — or one in a section B1 flags as a listing — is
    // sampled; a smaller repeated group (here 7) is page structure and is audited in full, so no later row is skipped.
    const html = `<!doctype html><html><head><style>.card{cursor:pointer;border:1px solid #d9d1ce;padding:16px;margin:8px;width:200px}</style></head><body>
      <section aria-label="Consulting services">${cards(4, 'Service')}</section>
      <section aria-label="Research reports">${cards(4, 'Report')}</section>
      <section aria-label="Insights">${cards(7, 'Insight')}</section>
      <section aria-label="Case studies">${cards(14, 'Case')}</section></body></html>`;
    const { page } = await auditHtml('groups', html);
    const count = (prefix: string) => page.findings.filter((f) => f.component.productionLabel.startsWith(`${prefix} card`)).length;
    expect(count('Service')).toBe(4);
    expect(count('Report')).toBe(4);
    expect(count('Insight')).toBe(7); // under the listing threshold: every member audited, none sampled out
    expect(count('Case')).toBe(LISTING_SAMPLE_LIMIT);
    expect(page.coverage.sampledListings).toEqual([{ section: 'Case studies · scripted-card', sampled: LISTING_SAMPLE_LIMIT, totalObserved: 14 }]);
  }, 120_000);

  it('two elements under duplicate ids get two findings — in the report AND in SQLite', async () => {
    const html = `<!doctype html><html><head><style>
      .cta { background: #b01f24; color: #fff; border: 0; padding: 0 24px; }
      </style></head><body>
      <section aria-label="Top promo"><div id="promo"><button type="button" class="cta" style="height:44px">Talk to us</button></div></section>
      <section aria-label="Bottom promo"><div id="promo"><button type="button" class="cta" style="height:48px">Talk to us</button></div></section>
      </body></html>`;
    const { page, stored } = await auditHtml('dupe-ids', html);
    const promos = page.findings.filter((f) => f.component.productionLabel === 'Talk to us');
    expect(promos).toHaveLength(2);
    expect(new Set(promos.map((f) => f.identity.findingId)).size).toBe(2);
    expect(promos.map((f) => f.classification).sort()).toEqual(['DEVIATION', 'MATCH']);
    // SQLite holds exactly what the report publishes — nothing replaced by a colliding id.
    expect(stored.filter((r) => promos.some((f) => f.identity.findingId === r.finding_id)).map((r) => r.classification).sort()).toEqual(['DEVIATION', 'MATCH']);
    expect(stored).toHaveLength(page.findings.length);
  }, 120_000);
});
