import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { alreadyAccountedFor, attemptRecovery, coverageErrors, emptyVerificationReport, markNeedsReview, MAX_CORRECTIVE_LOOPS, recheckPropertyCompleteness, recoverMissingComponents, repeatedBlockCandidates, verifyCompleteness, verifyFamilySearch, type RecoveryOps, type VerificationReport } from '../../src/agents/b5-visual-verifier/completeness.ts';
import { dsIndex, type DsIndex } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import type { B4Output, DetectedComponent, DsMatch, PageSession } from '../../src/agents/types.ts';
import type { AriaElement, ElementFingerprint } from '../../src/t-layer/element-registry.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';

/**
 * B5 completeness verification: the final recheck before a page's results are finalized.
 * `recheckPropertyCompleteness` needs only `session.registry` (for `buildFoundationContext`) — no
 * live page — so it is tested directly here, fast and pure. The "missing component"/"wrong
 * identity" paths need a real page (`captureComponent` stamps and reads the live DOM) and are
 * covered by the real-browser suite (test/integration/no-api-audit.test.ts, plus the live audit
 * run against kenresearch.com/survey that originally found and confirmed this fix).
 */

let registry: DsRegistry;
let index: DsIndex;
beforeAll(async () => {
  registry = await loadDsRegistry(loadConfig().designSystemPath);
  index = await dsIndex(registry);
});

const fingerprint: ElementFingerprint = { structuralPath: 'div', role: 'generic', box: { x: 0, y: 0, width: 57, height: 28 } } as unknown as ElementFingerprint;

function badgeComponent(over: Partial<DetectedComponent> = {}): DetectedComponent {
  return {
    elId: 'e1', ref: 'e1', sectionId: 's5', sectionName: 'Our Approach', captureState: 'default+expanded-disclosures',
    componentType: 'badge', label: 'Phase 1', domSignals: [], visualSignals: '', instanceGroupKey: 's5::badge',
    detectionConfidence: 0.45, confidenceOutOfContract: false, fingerprint, signature: 'sig1',
    style: { connected: true, raw: { 'border-top-left-radius': '6px', 'border-top-right-radius': '6px', 'border-bottom-right-radius': '6px', 'border-bottom-left-radius': '6px', 'border-top-width': '1px', 'border-top-style': 'solid', 'border-top-color': 'rgb(176, 31, 36)', 'background-color': 'rgba(176, 31, 36, 0.1)' }, rootFontSizePx: 16, box: { width: 57, height: 28 } },
    containsPlaceholder: false, screenshots: { element: null, context: null }, evidenceClipped: false, href: null,
    domFacts: { tag: 'div', classes: [], roleAttr: null, cursor: 'auto', text: 'Phase 1', hasSvg: false, hasImg: false, ownText: true, childElementCount: 0, style: { backgroundColor: 'rgba(176, 31, 36, 0.1)', backgroundImage: 'none', borderTopWidth: '1px', borderTopStyle: 'solid', paddingLeft: '8px', paddingTop: '4px', color: 'rgb(87, 62, 105)', fontSize: '12px', fontWeight: '400', display: 'block', opacity: '1', visibility: 'visible', textTransform: 'none', letterSpacing: 'normal' }, box: { x: 299, y: 3170, width: 57, height: 28 } },
    findingId: 'f1',
    ...over,
  };
}

/**
 * `cleanClassification` is what the finding would show BEFORE any violation is found — UNVERIFIED
 * (matched, nothing compared yet), the real-world shape of "first pass missed it" (a finding B4
 * already decided WAS worth auditing, just came up empty on this particular check) — never
 * NEW_COMPONENT/DS_CANDIDATE, which `recheckPropertyCompleteness` deliberately skips (B6's
 * territory, not a foundation-rule gap).
 */
function badgeFinding(ruleViolations: Finding['comparison']['ruleViolations'] = [], cleanClassification: Finding['classification'] = 'UNVERIFIED'): Finding {
  const classification = ruleViolations.length > 0 ? 'INCORRECT' : cleanClassification;
  return {
    identity: { auditId: 'a1', runId: 'r1', findingId: 'f1', timestamp: new Date().toISOString(), dsRegistryVersion: registry.version.dsRegistryVersion, policyVersion: 'test' },
    location: { url: 'https://example.test/', pageId: 'p1', pageName: 'https://example.test/', templateFamily: null, section: 'Our Approach', sectionId: 's5', captureState: 'default+expanded-disclosures' },
    component: { productionType: 'badge', productionLabel: 'Phase 1', dsComponent: null, dsVariant: null, signature: 'sig1' },
    classification,
    comparison: { mismatches: [], ruleViolations, properties: [], coverageNotes: [] },
    quality: { severity: ruleViolations.length > 0 ? 'LOW' : 'INFO', confidence: 0.45, confidenceBand: 'LOW', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
    action: { recommendation: 'test', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: classification, delta: null, previousRunId: null },
  } as Finding;
}

const minimalInput = (components: DetectedComponent[], findings: Finding[]): B4Output => ({
  sections: [], ariaElements: [], domHash: '', tiles: [],
  coverage: { sectionsAnalyzed: 0, componentsDetected: components.length, excludedPersonalized: 0, excludedOffDomain: 0, unexpandedStates: [], droppedRefs: [], truncation: [], sampledListings: [] },
  components,
  matches: new Map(),
  matched: [],
  unmatched: [],
  findings,
});

describe('3 & 6. property completeness: a first-pass gap is caught and routed to B4; a clean finding never loops', () => {
  it('REGRESSION 3: a finding whose first pass missed R3.6/R1.2 (simulating a past B4 bug) is corrected on recheck', async () => {
    const report: VerificationReport = emptyVerificationReport();
    const input = minimalInput([badgeComponent()], [badgeFinding([])]); // first pass recorded ZERO violations — the gap
    const session = { registry } as unknown as PageSession;
    const [corrected] = await recheckPropertyCompleteness(session, input, report);
    expect(corrected?.comparison.ruleViolations.map((v) => v.ruleId).sort()).toEqual(['R1.2', 'R3.6']);
    expect(corrected?.classification).toBe('INCORRECT');
    expect(report.propertiesCorrected).toBeGreaterThan(0);
    expect(report.actions.some((a) => a.stage === 'B4' && a.outcome === 'resolved')).toBe(true);
  });

  it('a finding that ALREADY shows the correct violations triggers zero corrective actions — the loop exits at iteration 1', async () => {
    const report: VerificationReport = emptyVerificationReport();
    const complete = badgeFinding([
      { ruleId: 'R3.6', title: 'Border Radius Decision Table', why: 'border-radius 6px is not on the Design System radius scale', severity: 'LOW' },
      { ruleId: 'R1.2', title: 'Brand Red is for CTAs ONLY', why: 'brand red used decoratively', severity: 'CRITICAL' },
    ]);
    const input = minimalInput([badgeComponent()], [complete]);
    const session = { registry } as unknown as PageSession;
    const [result] = await recheckPropertyCompleteness(session, input, report);
    expect(report.actions).toEqual([]);
    expect(report.propertiesCorrected).toBe(0);
    expect(result?.comparison.ruleViolations).toHaveLength(2); // unchanged
  });

  it('a DS_CANDIDATE/NEW_COMPONENT/NEEDS_REVIEW finding is never rechecked — foundation rules apply only once a component is being audited as itself', async () => {
    const report: VerificationReport = emptyVerificationReport();
    const input = minimalInput([badgeComponent()], [badgeFinding([], 'NEW_COMPONENT')]);
    const session = { registry } as unknown as PageSession;
    await recheckPropertyCompleteness(session, input, report);
    expect(report.actions).toEqual([]); // NEW_COMPONENT is skipped outright, never "corrected" into INCORRECT
  });

  it('a subtitle-candidate match is never rechecked — B4 deliberately runs no foundation check for it (ambiguous heading-vs-paragraph role)', async () => {
    const report: VerificationReport = emptyVerificationReport();
    const component = badgeComponent({ domFacts: { ...badgeComponent().domFacts!, tag: 'h2' } });
    const finding = badgeFinding([]);
    finding.classification = 'UNVERIFIED';
    const input = minimalInput([component], [finding]);
    input.matches.set('e1', { dsComponent: 'SectionHeading', dsFile: 'atoms/SectionHeading.tsx', dsVariant: 'subtitle candidate', contextSlot: 'subtitle', confidence: 0.55, rationale: '', unanswered: false, confidenceOutOfContract: false });
    const session = { registry } as unknown as PageSession;
    await recheckPropertyCompleteness(session, input, report);
    expect(report.actions).toEqual([]);
  });
});

describe('7. loop limit: never more than MAX_CORRECTIVE_LOOPS, verifyCompleteness never throws or hangs', () => {
  it('MAX_CORRECTIVE_LOOPS is exactly 2 — the hard cap the spec requires', () => {
    expect(MAX_CORRECTIVE_LOOPS).toBe(2);
  });

  it('verifyCompleteness with no sections to recover and a clean finding completes instantly with an empty report (no page access needed)', async () => {
    const input = minimalInput([badgeComponent()], [
      badgeFinding([{ ruleId: 'R3.6', title: 'Border Radius Decision Table', why: 'x', severity: 'LOW' }, { ruleId: 'R1.2', title: 'Brand Red is for CTAs ONLY', why: 'y', severity: 'CRITICAL' }]),
    ]);
    const session = { registry } as unknown as PageSession; // session.page is never touched: zero sections
    const { output, report } = await verifyCompleteness(session, input);
    expect(output.findings).toHaveLength(1);
    expect(report.componentsRecovered).toBe(0);
    expect(report.actions).toEqual([]);
    expect(report.needsReview).toEqual([]);
  });
});

describe('repeatedBlockCandidates — the testimonial-card shape (large, non-interactive, repeated siblings)', () => {
  const card = (ref: string, x: number): AriaElement => ({ ref, role: 'generic', name: '', line: `- generic [ref=${ref}] [box=${x},0,300,424]`, depth: 2, parentRef: 'ewrap', box: { x, y: 0, width: 300, height: 424 } });

  it('two or more same-size siblings at card-scale area are flagged as one group', () => {
    const groups = repeatedBlockCandidates([card('e1', 0), card('e2', 320), card('e3', 640)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('a single one-off large block (no same-size sibling) is never flagged — "repeated" is the signal, not just "large"', () => {
    const lone = card('e1', 0);
    const differentSize: AriaElement = { ref: 'e2', role: 'generic', name: '', line: '- generic [ref=e2] [box=320,0,500,600]', depth: 2, parentRef: 'ewrap', box: { x: 320, y: 0, width: 500, height: 600 } };
    expect(repeatedBlockCandidates([lone, differentSize])).toEqual([]);
  });

  it('small elements (below CARD_MIN_AREA) are never flagged, however many identical siblings exist', () => {
    const small = (ref: string, x: number): AriaElement => ({ ref, role: 'generic', name: '', line: `- generic [ref=${ref}] [box=${x},0,40,20]: Phase`, depth: 2, parentRef: 'ewrap', box: { x, y: 0, width: 40, height: 20 } });
    expect(repeatedBlockCandidates([small('e1', 0), small('e2', 50), small('e3', 100)])).toEqual([]);
  });
});

// ── What B5 may count as an ERROR ─────────────────────────────────────────────────────────────────
// A plain caption B5 considered and legitimately did not audit used to be logged as "missing component:
// capture failed after 2 attempts" and counted as an unresolvable element reference. Four outcomes are
// kept apart now; only a capture failure or a reference that no longer resolves is an error.

describe('B5 recovery outcomes — valid exclusions are not errors; only true failures are', () => {
  const stubFacts = badgeComponent().domFacts!;
  // Engine r3: visible plain text is body text and is audited (a paragraph); what stays a valid
  // exclusion is an element that is not rendered at all.
  const plainFacts = { ...stubFacts, text: 'Updated weekly', style: { ...stubFacts.style, backgroundColor: 'rgba(0, 0, 0, 0)', borderTopWidth: '0px', borderTopStyle: 'none', opacity: '0' } };
  const caption: AriaElement = { ref: 'e10', role: 'generic', name: '', line: '- generic [ref=e10] [box=40,40,90,16]: Updated weekly', depth: 2, parentRef: 'eW', box: { x: 40, y: 40, width: 90, height: 16 } };
  const wrapper: AriaElement = { ref: 'eW', role: 'generic', name: '', line: '- generic [ref=eW] [box=0,0,1440,400]:', depth: 1, parentRef: null, box: { x: 0, y: 0, width: 1440, height: 400 } };
  const section = { id: 's1', name: 'Facts', kind: 'content', rootRef: 'eW', personalized: false, isListing: false, note: '', box: { x: 0, y: 0, width: 1440, height: 400 } };
  const inputOf = (decidedRefs?: string[]): B4Output => ({ ...minimalInput([], []), sections: [section], ariaElements: [wrapper, caption], ...(decidedRefs ? { decidedRefs } : {}) });

  /** A page whose reference reads are scripted: `reads` answers the 1st, 2nd… evaluate call on any locator; after the script it throws (detached). */
  function fakeSession(reads: Array<'facts' | 'throw'>, facts: unknown) {
    let calls = 0;
    const session = {
      registry,
      page: {
        viewportSize: () => ({ width: 1440, height: 900 }),
        locator: () => ({
          evaluate: async () => {
            const step = reads[calls++] ?? 'throw';
            if (step === 'throw') throw new Error('element detached');
            return facts;
          },
        }),
      },
    } as unknown as PageSession;
    return { session, calls: () => calls };
  }

  it('a caption that is not rendered is a VALID NON-CANDIDATE: excluded, decided on the first read, and never an error', async () => {
    const { session } = fakeSession(['facts'], plainFacts);
    const report = emptyVerificationReport();
    await recoverMissingComponents(session, inputOf(), report);
    expect(report.excluded.map((x) => x.ref)).toEqual(['e10']);
    expect(report.excluded[0]?.reason).toContain('not an audit candidate');
    expect(report.captureFailures).toEqual([]);
    expect(report.unresolvedRefs).toEqual([]);
    expect(report.actions).toEqual([]); // not a corrective action either
    expect(coverageErrors(report)).toEqual([]);
  });

  it('a reference that no longer resolves on any attempt is genuinely UNRESOLVED — an error, with its own reason', async () => {
    const { session, calls } = fakeSession([], plainFacts); // every read throws
    const report = emptyVerificationReport();
    await recoverMissingComponents(session, inputOf(), report);
    expect(report.unresolvedRefs.map((x) => x.ref)).toEqual(['e10']);
    expect(report.unresolvedRefs[0]?.reason).toContain('no longer resolves');
    expect(report.excluded).toEqual([]);
    expect(report.captureFailures).toEqual([]);
    expect(coverageErrors(report).map((x) => x.ref)).toEqual(['e10']);
    expect(calls()).toBe(MAX_CORRECTIVE_LOOPS); // never a third attempt
  });

  it('a real candidate whose evidence capture fails is a CAPTURE FAILURE — an error, distinct from "unresolved"', async () => {
    // First read succeeds (a bordered, filled badge), then the element detaches while its evidence is captured.
    const { session } = fakeSession(['facts'], stubFacts);
    const report = emptyVerificationReport();
    await recoverMissingComponents(session, inputOf(), report);
    expect(report.captureFailures.map((x) => x.ref)).toEqual(['e10']);
    expect(report.captureFailures[0]?.reason).toContain('evidence capture failed');
    expect(report.unresolvedRefs).toEqual([]);
    expect(report.excluded).toEqual([]);
    expect(coverageErrors(report).map((x) => x.ref)).toEqual(['e10']);
  });

  it('a ref B2 already DECIDED about (sampled out, excluded, merged, not a candidate…) is never re-attempted — B5 does not undo B2\'s policies', async () => {
    const { session, calls } = fakeSession(['facts'], stubFacts);
    const report = emptyVerificationReport();
    await recoverMissingComponents(session, inputOf(['e10']), report);
    expect(calls()).toBe(0); // the page was not touched for it
    expect(report.elementsConsidered).toBe(1); // only the (never-attempted) section wrapper — the decided caption is not a gap
    expect(report.excluded).toEqual([]);
    expect(coverageErrors(report)).toEqual([]);
    expect(alreadyAccountedFor(inputOf(['e10', 'e11'])).has('e11')).toBe(true);
  });

  it('attemptRecovery: a transient failure on the first read is retried once and recovers; attempts never exceed the cap on any path', async () => {
    const recovered = { ...badgeComponent(), ref: 'e10' };
    let reads = 0;
    const ops: RecoveryOps = {
      readFacts: async () => (++reads === 1 ? null : stubFacts),
      classify: () => ({ componentType: 'badge', label: 'Phase 1', domSignals: [], visualSignals: '', confidence: 0.45, instanceGroupKey: 'k' }),
      capture: async () => recovered,
    };
    const outcome = await attemptRecovery(caption, ops);
    expect(outcome).toMatchObject({ kind: 'recovered', loop: 2 });

    let capturesTried = 0;
    const failing: RecoveryOps = { ...ops, readFacts: async () => stubFacts, capture: async () => { capturesTried++; return null; } };
    expect((await attemptRecovery(caption, failing)).kind).toBe('capture-failed');
    expect(capturesTried).toBe(MAX_CORRECTIVE_LOOPS);
  });

  it('only capture failures and unresolved references reach the coverage error list — excluded and needs-review items never do', () => {
    const report = emptyVerificationReport();
    report.excluded.push({ ref: 'a', sectionId: 's1', reason: 'plain caption' });
    report.needsReview.push({ ref: 'b', sectionId: 's1', reason: 'uncertain DS mapping' });
    report.captureFailures.push({ ref: 'c', sectionId: 's1', reason: 'capture failed' });
    report.unresolvedRefs.push({ ref: 'd', sectionId: 's1', reason: 'no longer resolves' });
    expect(coverageErrors(report).map((x) => x.ref)).toEqual(['c', 'd']);
  });
});


// ── DS-matching coverage: was the right family searched? ─────────────────────────────────────────────
// B3 records which family it searched and on what basis (`DsMatch.search`). B5 verifies that record
// against the family the DS names for the element's type — without it "was the right search performed?"
// could not be checked at all.

describe('verifyFamilySearch — the recorded B3 answer against the family the DS names for the type', () => {
  const badge = { componentType: 'badge' };
  const answer = (over: Partial<DsMatch>): DsMatch => ({ dsComponent: 'Badge', dsFile: 'atoms/Badge.tsx', dsVariant: 'pill · sm · neutral', confidence: 0.55, rationale: '', unanswered: false, confidenceOutOfContract: false, ...over });
  const badgeFamily = { ruleId: 'R4.6', files: ['atoms/Badge.tsx'], deep: [] as string[] };

  it('a consistent answer verifies — matched by family identity, or left to B6 after the family was searched', () => {
    expect(verifyFamilySearch(badge, answer({ search: { family: badgeFamily, basis: 'family-identity' } }), index)).toEqual({ ok: true });
    expect(verifyFamilySearch(badge, answer({ dsComponent: null, dsFile: null, dsVariant: null, confidence: 0, search: { family: badgeFamily, basis: 'undecided' } }), index)).toEqual({ ok: true });
  });

  it('no record of a search is not a verified search — for a matched answer AND for one left for B6', () => {
    for (const match of [answer({}), answer({ dsComponent: null, dsFile: null, dsVariant: null, confidence: 0 })]) {
      const verdict = verifyFamilySearch(badge, match, index);
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.reason).toContain('no record that the R4.6 family');
    }
  });

  it('a record of the WRONG family, or a component outside the family with no class evidence, is a wrong match', () => {
    const wrongFamily = verifyFamilySearch(badge, answer({ search: { family: { ruleId: 'R4.1', files: ['atoms/Button.tsx'], deep: [] }, basis: 'rule-fit' } }), index);
    expect(!wrongFamily.ok && wrongFamily.reason).toContain('the DS names the R4.6 family');
    const outside = verifyFamilySearch(badge, answer({ dsComponent: 'Button', dsFile: 'atoms/Button.tsx', search: { family: badgeFamily, basis: 'family-identity' } }), index);
    expect(!outside.ok && outside.reason).toContain('not in the R4.6 family');
  });

  it('but an element BUILT FROM another DS component (class evidence) and a context slot are legitimate answers outside the type\'s family', () => {
    expect(verifyFamilySearch(badge, answer({ dsComponent: 'Button', dsFile: 'atoms/Button.tsx', search: { family: badgeFamily, basis: 'class-fingerprint' } }), index)).toEqual({ ok: true });
    expect(verifyFamilySearch({ componentType: 'section-heading' }, answer({ dsComponent: 'SectionHeading', dsFile: 'atoms/SectionHeading.tsx', search: { family: { ruleId: 'R4.8', files: ['atoms/SectionHeading.tsx'], deep: [] }, basis: 'context-slot' } }), index)).toEqual({ ok: true });
  });

  it('a type the DS names NO family for has nothing to verify — B6 is the right place for it', () => {
    expect(verifyFamilySearch({ componentType: 'tabs' }, answer({ dsComponent: null, dsFile: null, dsVariant: null, confidence: 0 }), index)).toEqual({ ok: true });
  });

  it('the deeper family counts as the family: a component of the badge family found by the deeper search is not a wrong match', () => {
    const deep = verifyFamilySearch(badge, answer({ dsComponent: 'FilterChip', dsFile: 'atoms/FilterChip.tsx', search: { family: { ...badgeFamily, deep: ['atoms/FilterChip.tsx'] }, basis: 'family-identity' } }), index);
    expect(deep).toEqual({ ok: true });
  });
});

// ── Unresolved after the cap → NEEDS_REVIEW, never dropped ────────────────────────────────────────────

describe('B5 settles what it could not resolve — NEEDS_REVIEW, never dropped, never retried a third time', () => {
  const stubFacts = badgeComponent().domFacts!;
  const candidate: AriaElement = { ref: 'e10', role: 'generic', name: '', line: '- generic [ref=e10] [box=40,40,90,16]: Phase 1', depth: 2, parentRef: 'eW', box: { x: 40, y: 40, width: 90, height: 16 } };
  const wrapper: AriaElement = { ref: 'eW', role: 'generic', name: '', line: '- generic [ref=eW] [box=0,0,1440,400]:', depth: 1, parentRef: null, box: { x: 0, y: 0, width: 1440, height: 400 } };
  const section = { id: 's1', name: 'Facts', kind: 'content', rootRef: 'eW', personalized: false, isListing: false, note: '', box: { x: 0, y: 0, width: 1440, height: 400 } };

  /** A page that reads the element once (a bordered, filled badge) and then detaches it while its evidence is captured. */
  function detachingSession() {
    let calls = 0;
    return {
      registry, aiMode: 'no-api', auditId: 'a1', runId: 'r1', pageId: 'p1', url: 'https://example.test/', templateFamily: null,
      capture: { canonical: { pageUrl: 'https://example.test/' }, renderSettled: { settled: true }, renderingPolicy: { channel: 'chromium', browserVersion: '1.0.0.0', playwrightVersion: '1.0.0' } },
      page: {
        viewportSize: () => ({ width: 1440, height: 900 }),
        locator: () => ({ evaluate: async () => { if (calls++ === 0) return stubFacts; throw new Error('element detached'); } }),
      },
    } as unknown as PageSession;
  }

  it('an element that could not be captured is NOT dropped: it becomes a NEEDS_REVIEW finding with its reason and its accessibility-tree line — and stays in the coverage error list', async () => {
    const input: B4Output = { ...minimalInput([], []), sections: [section], ariaElements: [wrapper, candidate] };
    const { output, report } = await verifyCompleteness(detachingSession(), input);
    expect(coverageErrors(report).map((x) => x.ref)).toEqual(['e10']); // still an explicit, counted failure
    const finding = output.findings.find((f) => f.review?.node === 'B5');
    expect(finding).toBeDefined();
    expect(finding!.classification).toBe('NEEDS_REVIEW');
    expect(finding!.review?.status).toBe('NEEDS_REVIEW');
    expect(finding!.review?.reason).toContain(`${MAX_CORRECTIVE_LOOPS} attempts`);
    expect(finding!.component.productionLabel).toBe('Phase 1');
    expect(finding!.component.productionType).toBe('badge');
    expect(finding!.quality.escalationStatus).toBe('QUEUED');
    expect(finding!.quality.evidence).toEqual([expect.objectContaining({ kind: 'aria-line', ref: candidate.line })]);
    expect(report.markedNeedsReview.map((x) => x.ref)).toEqual(['e10']);
    expect(report.needsReview.map((x) => x.ref)).toEqual(['e10']);
    expect(report.passes).toBeLessThanOrEqual(MAX_CORRECTIVE_LOOPS);
  });

  it('markNeedsReview: a measured breach keeps its classification and gains the review; a clean or unverified result becomes NEEDS_REVIEW', () => {
    const breach = markNeedsReview(badgeFinding([{ ruleId: 'R1.2', title: 't', why: 'w', severity: 'CRITICAL' }]), 'could not settle');
    expect(breach.classification).toBe('INCORRECT');
    expect(breach.review).toMatchObject({ status: 'NEEDS_REVIEW', node: 'B5' });
    expect(breach.quality.escalationReasons).toContain('NEEDS_REVIEW');
    const unverified = markNeedsReview(badgeFinding([], 'UNVERIFIED'), 'could not settle');
    expect(unverified.classification).toBe('NEEDS_REVIEW');
    expect(unverified.history.currentStatus).toBe('NEEDS_REVIEW');
    expect(markNeedsReview(unverified, 'again')).toBe(unverified); // idempotent
  });
});
