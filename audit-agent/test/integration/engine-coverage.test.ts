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
import type { Finding, PageResult } from '../../src/skills/s0-result-contract.ts';

/**
 * The shared engine's coverage, END TO END on one generic page (real Chromium, the real Design
 * System, no-api mode — nothing from any real site): B1 section bounds, B2 detection and sampling,
 * B4 foundation rules, B5 completeness. Every shape here has been a real gap on a real audit:
 *   - a multi-row grid whose later rows were silently sampled away,
 *   - a sticky scroll stage whose overflowing list lay outside every section's y-range,
 *   - a non-interactive "Phase 1" badge no rule ever reached,
 *   - repeated non-interactive (testimonial) cards,
 *   - plain captions B5 logged as "capture failed" and counted as unresolvable,
 *   - a large listing B2 sampled and B5 then quietly re-captured in full.
 * Then the same page is re-audited: the same engine, the same answers, history working.
 */

const n = (k: number) => Array.from({ length: k }, (_, i) => i + 1);
const html = `<!doctype html><style>
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#111;background:#fff}
h2{font-family:'Noto Serif',serif;font-weight:300;font-size:31.248px;letter-spacing:-0.01em;margin:0 0 16px}
h3{font-family:'Noto Serif',serif;font-weight:300;font-size:18px;margin:0 0 6px}
section{padding:40px}
.badge{display:inline-block;width:57px;height:28px;box-sizing:border-box;border:1px solid rgb(176,31,36);border-radius:6px;background:rgba(176,31,36,.1);color:rgb(87,62,105);font-size:12px;padding:4px 8px}
.plain{display:inline-block;font-size:12px;color:#555;margin-right:12px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.feature{padding:16px;border:1px solid #e5e0de;height:120px}
.quote{display:inline-block;vertical-align:top;width:320px;height:200px;box-sizing:border-box;padding:24px;border:1px solid #ddd;border-radius:12px;margin-right:16px}
.stage{position:sticky;top:0;height:420px;overflow:hidden;max-width:1200px;margin:0 auto}
.item{height:110px}
.rcard{display:inline-block;width:200px;height:60px;border:1px solid #d9d1ce;padding:12px;margin:8px;color:#111;text-decoration:none}
</style><main>
<section aria-label="Approach"><h2>Our Approach</h2><div class="badge">Phase 1</div> <span class="plain">Updated weekly</span><span class="plain">Source: public filings</span><span class="plain">120+</span></section>
<section aria-label="Features"><h2>Why choose us</h2><div class="grid">${n(9).map((i) => `<div class="feature"><h3>Feature number ${i}</h3><p>Supporting copy ${i}.</p></div>`).join('')}</div></section>
<section aria-label="Testimonials"><h2>What clients say</h2><div class="quote">Great work from the team. A. Client</div><div class="quote">Clear findings, delivered fast. B. Client</div><div class="quote">We would hire them again. C. Client</div></section>
<section style="height:2400px;padding:0"><div class="stage"><h2 style="padding-top:40px">Our Differentiators</h2><div>${n(8).map((i) => `<div class="item"><h3>Differentiator number ${i}</h3><p>Why it matters ${i}.</p></div>`).join('')}</div></div></section>
<section aria-label="Reports"><h2>Latest reports</h2>${n(14).map((i) => `<a class="rcard" href="/r/${i}">Report number ${i}</a>`).join('')} <a href="https://example.org/partner" style="color:#555">Partner site</a></section>
<section aria-label="Closing"><h2>Talk to us</h2><p>Reach out any time.</p></section>
</main>`;

let dir: string;
let db: ReturnType<typeof openDb>;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let first: PageResult;
let again: PageResult;
let noBaseline: PageResult;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-engine-coverage-'));
  db = openDb(join(dir, 'audit.db'));
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  server = await startLocalServer({ '/': { body: html } });
  const config = loadConfig();
  const registry = await loadDsRegistry(config.designSystemPath);
  const deps = (id: string) => ({ db, pool, registry, config, aiMode: 'no-api' as const, llm: new DisabledLlmClient(), politeness: new Politeness(0), evidenceRoot: join(dir, `shots-${id}`) });
  first = await auditPage(server.origin + '/', deps('1'), { runId: 'engine-coverage-1' });
  again = await auditPage(server.origin + '/', deps('2'), { runId: 'engine-coverage-2' });
  noBaseline = await auditPage(server.origin + '/', deps('3'), { runId: 'engine-coverage-3', noBaseline: true });
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Which stage captured the finding's element: B5's recovery stamps its own elIds `…-recovered-N`. */
const capturedBy = (f: Finding) => (/recovered/.test(f.quality.evidence.find((e) => e.kind === 'computed-style')?.ref ?? '') ? 'B5' : 'B2');
const byLabel = (page: PageResult, re: RegExp) => page.findings.filter((f) => re.test(f.component.productionLabel));
/** Headings only: a repeated surfaced block (a feature card) carries its text as its label too, so a heading is told apart by TYPE. */
// Every audited element with this label, whatever role B2 gave it: a short, small heading-tagged text is a LABEL (typed paragraph, audited on
// the foundation rules) rather than a SectionHeading — these tests are about COVERAGE (every row audited, none sampled away), not the type.
const headingsLike = (page: PageResult, re: RegExp) => page.findings.filter((f) => (f.component.productionType === 'section-heading' || f.component.productionType === 'paragraph') && re.test(f.component.productionLabel));

describe('B2 + B1: a repeated group is audited in full unless it is a real listing', () => {
  it('a multi-row grid of 9 feature headings: every row is audited — none is sampled away', () => {
    expect(headingsLike(first, /^Feature number/)).toHaveLength(9);
    expect(first.coverage.sampledListings.some((s) => /Feature number/.test(s.section))).toBe(false);
  });

  it('a sticky scroll stage whose list overflows its own box: all 8 items are audited, including the ones below the stage', () => {
    const items = headingsLike(first, /^Differentiator number/);
    expect(items).toHaveLength(8);
    expect(items.every((f) => capturedBy(f) === 'B2')).toBe(true); // B1 assigned them; B2's first pass audited them
    const section = first.sections?.find((s) => s.name === 'Our Differentiators');
    expect(section?.note).toContain('lie outside this section\'s y-range but inside its own subtree');
    expect(section?.note).toContain('offered to B2 with it');
  });

  it('no element is left behind as "never offered to B2" — B1 either owns it, or it is its own section', () => {
    expect(first.sections?.some((s) => s.note.includes('never offered to B2'))).toBe(false);
  });
});

describe('B2 sampling still bounds a REAL listing — and B5 does not undo it', () => {
  it('14 identical report links: 5 are audited and the report says exactly that (5 of 14)', () => {
    expect(byLabel(first, /^Report number/)).toHaveLength(5);
    expect(first.coverage.sampledListings).toEqual([expect.objectContaining({ sampled: 5, totalObserved: 14 })]);
  });

  it('B5 recovers none of the 9 left out — sampling is policy, not a gap', () => {
    expect(byLabel(first, /^Report number/).every((f) => capturedBy(f) === 'B2')).toBe(true);
  });

  it('an off-domain utility link B2 excluded on purpose stays excluded (not re-captured by B5)', () => {
    expect(byLabel(first, /Partner site/)).toHaveLength(0);
    expect(first.coverage.excludedOffDomain).toBe(1);
  });
});

describe('B2 badge detection + B4 radius and decorative-colour rules, on an element that is not interactive', () => {
  const badge = () => byLabel(first, /Phase 1/)[0]!;

  it('the non-interactive "Phase 1" badge is found by B2\'s first pass, not missed', () => {
    expect(badge()).toBeDefined();
    expect(badge().component.productionType).toBe('badge');
    expect(capturedBy(badge())).toBe('B2');
  });

  it('it is an existing DS component — the Badge family — never a new one: B3 found it by identity, B4 audits it against the Badge\'s full contract', () => {
    expect(badge().component.dsComponent).toBe('Badge');
    expect(badge().component.dsVariant).toBeTruthy();
    expect(badge().review?.node).not.toBe('B6');
    expect(['NEW_COMPONENT', 'DS_CANDIDATE', 'NEEDS_REVIEW']).not.toContain(badge().classification);
  });

  it('its 6px radius is not on the DS radius scale → judged against the matched component: the Badge variant\'s own 5px (--radius-button), exact variant value first, never a generic "use a token"', () => {
    const radius = badge().comparison.mismatches.find((m) => m.property === 'border-top-left-radius')!;
    expect(radius.actual).toBe('6px');
    expect(radius.expected).toBe('5px');
    expect(radius.expectedToken).toBe('--radius-button');
    expect(badge().comparison.ruleViolations.some((v) => v.ruleId === 'R3.6')).toBe(false); // the exact variant contract wins over the generic scale step
    expect(badge().action.recommendation).not.toMatch(/use a DS radius token/i);
  });

  it('its brand-red border and fill on a non-CTA element are forbidden decoration (R1.2)', () => {
    const decoration = badge().comparison.ruleViolations.find((v) => v.ruleId === 'R1.2')!;
    expect(decoration.why).toContain('brand red used decoratively on a non-CTA badge');
    expect(badge().classification).toBe('INCORRECT');
  });
});

describe('B5: repeated non-interactive cards are recovered; plain captions are not errors', () => {
  it('the three non-interactive testimonial cards B2 never offers are recovered by B5 and audited as cards', () => {
    const cards = first.findings.filter((f) => f.component.productionType === 'card' && f.location.section === 'Testimonials');
    expect(cards).toHaveLength(3);
    expect(cards.every((f) => capturedBy(f) === 'B5')).toBe(true);
  });

  it('a recovered card takes the SAME path a detected card does — B3 finds the existing Card family, B4 audits it: an existing-component deviation, never B6 and never a bare UNVERIFIED', () => {
    const cards = first.findings.filter((f) => f.component.productionType === 'card' && f.location.section === 'Testimonials');
    for (const card of cards) {
      expect(card.component.dsComponent).toBe('Card');
      expect(card.component.dsVariant).toBeTruthy();
      expect(card.classification).toBe('DEVIATION'); // 12px radius / border colour against Card's own contract
      expect(card.review?.node).not.toBe('B6');
      expect(card.comparison.mismatches.some((m) => /radius/.test(m.property))).toBe(true);
      expect(card.quality.evidence.some((e) => e.kind === 'ds-source' && /Card System/.test(e.note ?? ''))).toBe(true);
    }
  });

  it('every repeated, surfaced feature block is a recovered card too — and nothing else in B5\'s reach vanished: each is audited or accounted for', () => {
    const features = first.findings.filter((f) => f.component.productionType === 'card' && f.location.section === 'Features');
    expect(features).toHaveLength(9);
    expect(features.every((f) => f.component.dsComponent === 'Card')).toBe(true);
  });

  it('a repeated block with NO card surface (the sticky stage\'s plain list rows) is a layout column — excluded with its reason, not guessed into a card and not an error', () => {
    expect(first.findings.some((f) => f.component.productionType === 'card' && /Differentiator/.test(f.component.productionLabel))).toBe(false);
    expect(first.coverage.droppedRefs).toEqual([]);
  });

  it('plain captions and stat numbers ("Updated weekly", "120+") are audited as body text / stats (engine r3) and create NO droppedRefs', () => {
    expect(first.coverage.droppedRefs).toEqual([]);
    const text = first.findings.filter((f) => /Updated weekly|120\+|Source: public filings/.test(f.component.productionLabel));
    expect(text.length).toBeGreaterThan(0);
    expect(text.every((f) => f.component.productionType === 'paragraph' || f.component.productionType === 'stat')).toBe(true);
    expect(text.every((f) => f.component.dsComponent === null && f.classification !== 'NEW_COMPONENT' && f.classification !== 'DS_CANDIDATE')).toBe(true); // foundation-only: never a B6 new-component question
  });
});

describe('re-audit: the same page again, same engine, same answers, history working', () => {
  it('finds exactly what the first audit found', () => {
    expect(again.findings.length).toBe(first.findings.length);
    expect(headingsLike(again, /^Feature number/)).toHaveLength(9);
    expect(headingsLike(again, /^Differentiator number/)).toHaveLength(8);
    expect(byLabel(again, /^Report number/)).toHaveLength(5);
    expect(again.coverage.droppedRefs).toEqual([]);
    expect(again.coverage.sampledListings).toEqual(first.coverage.sampledListings);
  });

  it('carries the badge forward as a still-open issue and the compliant headings as unchanged', () => {
    expect(byLabel(again, /Phase 1/)[0]?.history.delta).toBe('STILL_OPEN');
    expect(byLabel(again, /^Our Approach/)[0]?.history.delta).toBe('UNCHANGED_COMPLIANT');
  });
});

describe('--no-baseline: a page\'s first canonical audit compares against NO earlier run', () => {
  it('no finding carries a previous run, status or delta — although earlier runs of this page exist in the database', () => {
    expect(noBaseline.findings.length).toBeGreaterThan(0);
    expect(noBaseline.findings.every((f) => f.history.previousRunId === null && f.history.previousStatus === null && f.history.delta === null)).toBe(true);
    // the default behaviour is untouched: the run before it DID get a baseline
    expect(again.findings.some((f) => f.history.previousRunId === 'engine-coverage-1')).toBe(true);
  });

  it('only the history differs — the same findings, classifications, severities and coverage as the default re-audit', () => {
    const strip = (r: PageResult) => r.findings.map((f) => [f.identity.findingId, f.classification, f.quality.severity, f.component.productionType, f.component.dsComponent, f.comparison.mismatches.length, f.comparison.ruleViolations.length]).sort();
    expect(strip(noBaseline)).toEqual(strip(again));
    expect(noBaseline.coverage.sampledListings).toEqual(again.coverage.sampledListings);
    expect(noBaseline.coverage.droppedRefs).toEqual(again.coverage.droppedRefs);
  });
});
