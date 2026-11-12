import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { openDb } from '../../src/db/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { decideMatch } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import { runB6 } from '../../src/agents/b6-new-component-evaluator/index.ts';
import { MAX_CORRECTIVE_LOOPS, unaccountedElements, verifyCompleteness, type VerificationOps, type VerificationReport } from '../../src/agents/b5-visual-verifier/completeness.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { withFirstPass, type LivePipelineDeps } from '../helpers/live-pipeline.ts';
import type { NodeContext } from '../../src/graph/engine.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent, DsMatch, PageSession } from '../../src/agents/types.ts';

/**
 * The recovery loop END TO END on one generic page — the real B1 → B2 → B3 → B4 nodes in a real browser
 * against the real Design System, then B5 on exactly what it receives. The rule under test:
 *
 *   an element B5 recovers or re-routes takes the SAME path a first-pass element takes —
 *   B2 classifies → B3 searches the DS family → B4 (a family exists) | B6 (none does) → B5 verifies,
 *   in at most 2 passes, and whatever is still unresolved is NEEDS_REVIEW.
 *
 * Gaps B2/B3/B4 would leave are made the way a real gap is made — a component B2 "missed" is removed
 * from B4's output, B3's answer is replaced by a wrong one, a finding loses a property — and B5 is asked
 * to catch them.
 */

const n = (k: number) => Array.from({ length: k }, (_, i) => i + 1);
const html = `<!doctype html><style>
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#111;background:#fff}
h2{font-family:'Noto Serif',serif;font-weight:300;font-size:31.248px;letter-spacing:-0.01em;margin:0 0 16px}
section{padding:40px}
.pill{display:inline-block;height:24px;box-sizing:border-box;border:1px solid #cfc7c3;border-radius:9999px;background:#f5f2f1;color:#333;font-size:11px;padding:2px 12px;margin-left:8px}
.badge{display:inline-block;width:57px;height:28px;box-sizing:border-box;border:1px solid rgb(176,31,36);border-radius:6px;background:rgba(176,31,36,.1);color:rgb(87,62,105);font-size:12px;padding:4px 8px}
.card{display:inline-block;vertical-align:top;width:320px;height:200px;box-sizing:border-box;padding:24px;border:1px solid #ddd;border-radius:12px;margin-right:16px}
.col{display:inline-block;vertical-align:top;width:320px;height:200px;box-sizing:border-box;padding:24px;margin-right:16px}
.tab{cursor:pointer;font:16px 'DM Sans',sans-serif;color:#000;padding:8px 16px;border:0;background:transparent}
</style><main>
<section aria-label="Status"><h2>Status</h2><div class="badge">Phase 1</div><div class="pill">In review</div></section>
<section aria-label="Voices"><h2>What clients say</h2>${['Great work from the team. A. Client', 'Clear findings, delivered fast. B. Client', 'We would hire them again. C. Client'].map((t) => `<div class="card">${t}</div>`).join('')}<div class="card" style="cursor:pointer">A clickable card, detected by B2 itself. D. Client</div></section>
<section aria-label="Columns"><h2>Plain columns</h2>${n(3).map((i) => `<div class="col">Plain layout column ${i} with some words</div>`).join('')}</section>
<section aria-label="Views"><div role="tablist"><button role="tab" class="tab">Overview</button><button role="tab" class="tab">Method</button><button role="tab" class="tab">Pricing</button></div></section>
</main>`;

let dir: string;
let deps: LivePipelineDeps;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let url: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-b5-routing-'));
  const config = loadConfig();
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  server = await startLocalServer({ '/': { body: html } });
  url = `${server.origin}/`;
  deps = { db: openDb(join(dir, 'audit.db')), registry: await loadDsRegistry(config.designSystemPath), config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'shots') };
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  deps?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ctxOf = (session: PageSession): NodeContext => ({ db: session.db, runId: session.runId, sleep: async () => {} });
const byLabel = (findings: Finding[], re: RegExp) => findings.filter((f) => re.test(f.component.productionLabel));
const isRecoveredFinding = (f: Finding) => /recovered/.test(f.quality.evidence.find((e) => e.kind === 'computed-style')?.ref ?? '');
const componentOf = (b4: B4Output, label: RegExp): DetectedComponent => {
  const c = b4.components.find((x) => label.test(x.label));
  if (!c) throw new Error(`no component labelled ${label}`);
  return c;
};

/** B2's first pass missing these components: they, their B3 answer and their findings are gone, and B2 never "decided" about them either. */
function withoutComponents(b4: B4Output, drop: DetectedComponent[]): B4Output {
  const refs = new Set(drop.map((c) => c.ref));
  const ids = new Set(drop.map((c) => c.findingId));
  return {
    ...b4,
    components: b4.components.filter((c) => !refs.has(c.ref)),
    matched: b4.matched.filter((c) => !refs.has(c.ref)),
    unmatched: b4.unmatched.filter((c) => !refs.has(c.ref)),
    matches: new Map([...b4.matches].filter(([ref]) => !refs.has(ref))),
    findings: b4.findings.filter((f) => !ids.has(f.identity.findingId)),
    decidedRefs: (b4.decidedRefs ?? []).filter((ref) => !refs.has(ref)),
  };
}

describe('the natural flow — B2 finds what it finds, B5 recovers what it cannot see', () => {
  let b4: B4Output;
  let out: B4Output;
  let report: VerificationReport;
  let allFindings: Finding[];

  beforeAll(async () => {
    await withFirstPass(url, deps, async (session, firstPass) => {
      b4 = firstPass;
      const verified = await verifyCompleteness(session, firstPass);
      out = verified.output;
      report = verified.report;
      // …and the B6 node that follows B5 in the graph, over what B5 left it.
      allFindings = (await runB6(ctxOf(session), { ...out, session })).findings;
    });
  }, 300_000);

  it('B2 itself finds the two non-interactive badges and the clickable card — B5 has nothing to recover for them and must not duplicate them', () => {
    expect(b4.components.filter((c) => c.componentType === 'badge').map((c) => c.label).sort()).toEqual(['In review', 'Phase 1']);
    expect(b4.components.some((c) => c.componentType === 'card' && /clickable card/.test(c.label))).toBe(true);
    expect(report.componentsRecovered).toBe(3); // only the three non-interactive testimonial cards
    expect(allFindings.filter((f) => f.component.productionType === 'badge')).toHaveLength(2);
  });

  it('recovered badge ⇒ the existing Badge family: audited by B4 against Badge\'s full contract, never B6, and its wrong styling is an existing-component deviation', () => {
    const badges = allFindings.filter((f) => f.component.productionType === 'badge');
    for (const badge of badges) {
      expect(badge.component.dsComponent).toBe('Badge');
      expect(badge.component.dsVariant).toBeTruthy();
      expect(['DEVIATION', 'INCORRECT']).toContain(badge.classification);
      expect(badge.review?.node).not.toBe('B6');
      expect(badge.comparison.properties?.length).toBeGreaterThan(10); // the full contract, not a couple of foundation rules
      for (const property of ['border-top-left-radius', 'color', 'padding-left']) {
        expect(badge.comparison.properties?.some((p) => p.property === property), `Badge contract covers ${property}`).toBe(true);
      }
    }
  });

  it('recovered card ⇒ the SAME route as a detected card: B3 → the Card family → B4. Identical styling, identical answer', () => {
    const recovered = allFindings.filter((f) => f.component.productionType === 'card' && isRecoveredFinding(f) && f.location.section === 'Voices');
    const detected = allFindings.find((f) => f.component.productionType === 'card' && /clickable card/.test(f.component.productionLabel))!;
    expect(recovered).toHaveLength(3);
    expect(detected.component.dsComponent).toBe('Card');
    for (const card of recovered) {
      expect(card.component.dsComponent).toBe(detected.component.dsComponent);
      expect(card.component.dsVariant).toBe(detected.component.dsVariant);
      expect(card.classification).toBe(detected.classification);
      expect(card.comparison.mismatches.map((m) => m.property).sort()).toEqual(detected.comparison.mismatches.map((m) => m.property).sort());
    }
    expect(report.routedToB4.length).toBeGreaterThanOrEqual(3);
    expect(report.routedToB6).toEqual([]); // nothing B5 recovered lacked a family
  });

  it('wrong styling on an existing component stays an existing-component deviation — never NEW_COMPONENT, DS_CANDIDATE or NEEDS_REVIEW', () => {
    for (const f of allFindings.filter((x) => ['badge', 'card'].includes(x.component.productionType))) {
      expect(f.component.dsComponent, f.component.productionLabel).not.toBeNull();
      expect(['NEW_COMPONENT', 'DS_CANDIDATE', 'NEEDS_REVIEW']).not.toContain(f.classification);
    }
  });

  it('ONLY a genuine no-family pattern reaches B6: the tabs (the DS names no family for tabs) — and nothing else does', () => {
    const b6 = allFindings.filter((f) => f.review?.node === 'B6' || f.classification === 'DS_CANDIDATE' || f.classification === 'NEW_COMPONENT');
    expect(b6.length).toBeGreaterThan(0);
    expect(b6.every((f) => f.component.productionType === 'tabs')).toBe(true);
    expect(out.unmatched.every((c) => c.componentType === 'tabs')).toBe(true);
  });

  it('a repeated block with no card surface is a layout column: excluded WITH its reason — not a card, not a failure', () => {
    const columns = report.excluded.filter((x) => x.type === 'card');
    expect(columns.length).toBe(3);
    expect(columns.every((x) => /layout column/.test(x.reason))).toBe(true);
    expect(allFindings.some((f) => /Plain layout column/.test(f.component.productionLabel))).toBe(false);
    expect(report.captureFailures).toEqual([]);
    expect(report.unresolvedRefs).toEqual([]);
  });

  it('nothing silently disappears: every candidate is a component, decided by B2, excluded with a reason, or a reported failure — and every component has its finding', () => {
    expect(unaccountedElements(out, report)).toEqual([]);
    for (const c of out.components) {
      const hasFinding = allFindings.some((f) => f.identity.findingId === c.findingId);
      expect(hasFinding, `finding for ${c.componentType} "${c.label}"`).toBe(true);
    }
    // each finding is for exactly one element
    const ids = allFindings.map((f) => f.identity.findingId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(report.passes).toBeLessThanOrEqual(MAX_CORRECTIVE_LOOPS);
  });
});

describe('B5 catches a MISSED ELEMENT — and routes it like any other (B2 → B3 → B4)', () => {
  it('a badge B2\'s first pass did not select is recovered, classified by B2, matched to the existing Badge family by B3, and audited by B4', async () => {
    await withFirstPass(url, deps, async (session, firstPass) => {
      const pill = componentOf(firstPass, /^In review$/);
      const missed = withoutComponents(firstPass, [pill]);
      const { output, report } = await verifyCompleteness(session, missed);
      const recovered = output.components.find((c) => /^In review$/.test(c.label))!;
      expect(recovered).toBeDefined();
      expect(recovered.elId).toContain('-recovered-');
      expect(recovered.componentType).toBe('badge'); // B2's classification, from its visible structure
      expect(recovered.structural).toBe(true);
      const match = output.matches.get(recovered.ref)!;
      expect(match.dsComponent).toBe('Badge'); // B3's family search
      expect(match.search?.basis).toBe('family-identity');
      const finding = output.findings.find((f) => f.identity.findingId === recovered.findingId)!;
      expect(finding.component.dsComponent).toBe('Badge'); // B4's audit
      expect(finding.comparison.properties?.length).toBeGreaterThan(10);
      expect(output.matched.some((c) => c.ref === recovered.ref)).toBe(true);
      expect(report.routedToB4.some((x) => x.ref === recovered.ref)).toBe(true);
      expect(report.routedToB6).toEqual([]);
      expect(report.actions.filter((a) => a.ref === recovered.ref).map((a) => a.stage)).toEqual(['B2', 'B3', 'B4']);
      expect(unaccountedElements(output, report)).toEqual([]);
    });
  }, 300_000);
});

describe('B5 routes to B6 ONLY when B3 finds no existing family — and B6 sees the element once', () => {
  it('a recovered card for which no family exists is evaluated by B6\'s own evaluation (not B4, not a bare UNVERIFIED), and the B6 node does not evaluate it again', async () => {
    await withFirstPass(url, deps, async (session, firstPass) => {
      // B3 as it would answer if the Design System had no card family at all.
      const noCardFamily: VerificationOps['decide'] = (component, index, registry, viewportWidth, page) => {
        if (component.componentType !== 'card') return decideMatch(component, index, registry, viewportWidth, page);
        return { dsComponent: null, dsFile: null, dsVariant: null, confidence: 0, rationale: 'deterministic: no Design System family represents it', unanswered: false, confidenceOutOfContract: false, possibleMatches: [], undecidedReason: 'no Design System family represents it', search: { family: { ruleId: 'R4.3', files: ['atoms/Card.tsx'], deep: [] }, basis: 'undecided' } } satisfies DsMatch;
      };
      const { output, report } = await verifyCompleteness(session, firstPass, { decide: noCardFamily });
      const recoveredCards = output.components.filter((c) => c.componentType === 'card' && c.elId.includes('-recovered-'));
      expect(recoveredCards).toHaveLength(3);
      expect(report.routedToB6.map((x) => x.ref).sort()).toEqual(recoveredCards.map((c) => c.ref).sort());
      expect(report.routedToB4.filter((x) => recoveredCards.some((c) => c.ref === x.ref))).toEqual([]);
      for (const c of recoveredCards) {
        const finding = output.findings.find((f) => f.identity.findingId === c.findingId)!;
        expect(finding.component.dsComponent).toBeNull();
        expect(finding.review?.node).toBe('B6'); // B6's evaluation, with B3's reason and the possible matches
        expect(['NEEDS_REVIEW', 'DS_CANDIDATE', 'INCORRECT']).toContain(finding.classification);
        expect(output.unmatched.some((u) => u.ref === c.ref)).toBe(false); // the B6 NODE must not see it again
      }
      expect(report.actions.filter((a) => a.stage === 'B6').length).toBe(3);
      const after = (await runB6(ctxOf(session), { ...output, session })).findings;
      const ids = after.map((f) => f.identity.findingId);
      expect(new Set(ids).size).toBe(ids.length); // one finding per element, whoever evaluated it
    });
  }, 300_000);
});

describe('B5 catches a WRONG MATCH — and re-asks B3', () => {
  it('a component whose B3 answer is a wrong family with no record of a search is re-matched to the right family and its finding rebuilt by B4', async () => {
    await withFirstPass(url, deps, async (session, firstPass) => {
      const pill = componentOf(firstPass, /^In review$/);
      const wrong: DsMatch = { dsComponent: 'Button', dsFile: 'atoms/Button.tsx', dsVariant: 'primary · md', confidence: 0.6, rationale: 'a stale answer', unanswered: false, confidenceOutOfContract: false };
      const input: B4Output = { ...firstPass, matches: new Map([...firstPass.matches, [pill.ref, wrong]]) };
      const { output, report } = await verifyCompleteness(session, input);
      expect(report.rematched.map((r) => r.ref)).toEqual([pill.ref]);
      expect(report.rematched[0]?.reason).toContain('no record that the R4.6 family');
      expect(output.matches.get(pill.ref)?.dsComponent).toBe('Badge');
      const finding = output.findings.find((f) => f.identity.findingId === pill.findingId)!;
      expect(finding.component.dsComponent).toBe('Badge');
      expect(output.findings.filter((f) => f.identity.findingId === pill.findingId)).toHaveLength(1); // replaced, not duplicated
      expect(output.matched.filter((c) => c.ref === pill.ref)).toHaveLength(1);
    });
  }, 300_000);

  it('an element B3 left UNMATCHED although its family exists (no search on record) is verified, re-asked and moved to B4 — the B6 node never gets an existing component', async () => {
    await withFirstPass(url, deps, async (session, firstPass) => {
      const badge = componentOf(firstPass, /^Phase 1$/);
      const undecided: DsMatch = { dsComponent: null, dsFile: null, dsVariant: null, confidence: 0, rationale: 'a stale answer', unanswered: false, confidenceOutOfContract: false, undecidedReason: 'too little evidence' };
      const input: B4Output = {
        ...firstPass,
        matches: new Map([...firstPass.matches, [badge.ref, undecided]]),
        matched: firstPass.matched.filter((c) => c.ref !== badge.ref),
        unmatched: [...firstPass.unmatched, badge],
        findings: firstPass.findings.filter((f) => f.identity.findingId !== badge.findingId),
      };
      const { output, report } = await verifyCompleteness(session, input);
      expect(output.unmatched.some((c) => c.ref === badge.ref)).toBe(false);
      expect(output.matched.some((c) => c.ref === badge.ref)).toBe(true);
      expect(output.findings.find((f) => f.identity.findingId === badge.findingId)?.component.dsComponent).toBe('Badge');
      expect(report.rematched.some((r) => r.ref === badge.ref)).toBe(true);
    });
  }, 300_000);
});

describe('B5 catches a MISSED PROPERTY — and routes it to B4', () => {
  it('a finding that lost properties of its matched component\'s contract is restored by B4 re-running its comparison', async () => {
    await withFirstPass(url, deps, async (session, firstPass) => {
      const badge = componentOf(firstPass, /^Phase 1$/);
      const original = firstPass.findings.find((f) => f.identity.findingId === badge.findingId)!;
      expect(original.comparison.mismatches.length).toBeGreaterThan(3);
      const gutted: Finding = { ...original, classification: 'MATCH', comparison: { ...original.comparison, properties: original.comparison.properties?.filter((p) => !/radius|padding/.test(p.property)), mismatches: original.comparison.mismatches.filter((m) => !/radius|padding/.test(m.property)), ruleViolations: [] } };
      const input: B4Output = { ...firstPass, findings: firstPass.findings.map((f) => (f.identity.findingId === badge.findingId ? gutted : f)) };
      const { output, report } = await verifyCompleteness(session, input);
      const restored = output.findings.find((f) => f.identity.findingId === badge.findingId)!;
      expect(report.propertiesCorrected).toBeGreaterThan(0);
      expect(report.actions.some((a) => a.stage === 'B4' && a.ref === badge.ref && /not shown by the first pass/.test(a.reason))).toBe(true);
      expect(restored.comparison.mismatches.map((m) => m.property).sort()).toEqual(original.comparison.mismatches.map((m) => m.property).sort());
      expect(restored.comparison.ruleViolations.map((v) => v.ruleId)).toEqual(original.comparison.ruleViolations.map((v) => v.ruleId));
      expect(restored.classification).toBe(original.classification);
    });
  }, 300_000);
});

describe('the loop is bounded — at most 2 passes, then NEEDS_REVIEW', () => {
  it('a B3 that never settles is asked at most MAX_CORRECTIVE_LOOPS times per element, then the element is marked NEEDS_REVIEW with the reason — never a third attempt, never a hang', async () => {
    await withFirstPass(url, deps, async (session, firstPass) => {
      const pill = componentOf(firstPass, /^In review$/);
      const asked: string[] = [];
      // A stubborn B3: the same record-less wrong answer, every time it is asked about that element.
      const stubborn: VerificationOps['decide'] = (component, index, registry, viewportWidth, page) => {
        if (component.ref !== pill.ref) return decideMatch(component, index, registry, viewportWidth, page);
        asked.push(component.ref);
        return { dsComponent: 'Button', dsFile: 'atoms/Button.tsx', dsVariant: 'primary · md', confidence: 0.6, rationale: 'still wrong', unanswered: false, confidenceOutOfContract: false };
      };
      const wrong: DsMatch = { dsComponent: 'Button', dsFile: 'atoms/Button.tsx', dsVariant: 'primary · md', confidence: 0.6, rationale: 'a stale answer', unanswered: false, confidenceOutOfContract: false };
      const input: B4Output = { ...firstPass, matches: new Map([...firstPass.matches, [pill.ref, wrong]]) };
      const { output, report } = await verifyCompleteness(session, input, { decide: stubborn });
      expect(asked).toHaveLength(MAX_CORRECTIVE_LOOPS); // exactly the cap
      expect(report.rematched.filter((r) => r.ref === pill.ref)).toHaveLength(MAX_CORRECTIVE_LOOPS);
      expect(report.passes).toBeLessThanOrEqual(MAX_CORRECTIVE_LOOPS);
      expect(report.markedNeedsReview.some((m) => m.ref === pill.ref)).toBe(true);
      const finding = output.findings.find((f) => f.identity.findingId === pill.findingId)!;
      expect(finding.review?.status).toBe('NEEDS_REVIEW');
      expect(finding.review?.node).toBe('B5');
      expect(finding.review?.reason).toContain(`${MAX_CORRECTIVE_LOOPS} corrective passes`);
      expect(finding.quality.escalationStatus).toBe('QUEUED');
    });
  }, 300_000);

  it('a clean page makes ONE verification pass and corrects nothing', async () => {
    await withFirstPass(url, deps, async (session, firstPass) => {
      // The cards are already recovered (and the columns excluded) in a previous call; here nothing is left to find.
      const first = await verifyCompleteness(session, firstPass);
      const again = await verifyCompleteness(session, first.output);
      expect(again.report.passes).toBe(1);
      expect(again.report.componentsRecovered).toBe(0);
      expect(again.report.propertiesCorrected).toBe(0);
      expect(again.report.rematched).toEqual([]);
    });
  }, 300_000);
});

