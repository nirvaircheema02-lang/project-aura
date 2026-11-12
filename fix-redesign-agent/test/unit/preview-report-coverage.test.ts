import { describe, expect, it } from 'vitest';
import type { CorrectionSummary } from '../../src/agents/types.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import type { FidelityReport } from '../../src/fidelity/types.ts';
import { requiredChecksOpen } from '../../src/preview/correct.ts';
import { renderPreviewMd } from '../../src/preview/report.ts';
import type { PreviewVerification } from '../../src/preview/types.ts';
import { base, cap, sec, sticky } from '../helpers/fidelity-captures.ts';

/** PREVIEW.md must never say a preview is fully verified while a required check is unverified, and must show what was verified, failed and unverified. */

// a finished verification has its fidelity comparison on record (without any, the status is INCOMPLETE - see preview-status-review-fixes.test.ts)
const fidelityPass = { id: 'fidelity.design-state', group: 'fidelity' as const, name: 'Design, state and composition are preserved', status: 'pass' as const, detail: '0 regression(s)' };
const v = (over: Partial<PreviewVerification> = {}): PreviewVerification => ({
  schemaVersion: 1, generatedAt: 't', url: 'http://127.0.0.1:4400/', mode: 'full-page', expectedSectionIds: ['s'], renderedSectionIds: ['s'], checks: [fidelityPass], findings: [], interactions: [], unavailable: [], simulated: [],
  summary: { passed: 4, failed: 0, notChecked: 1, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass', ...over,
});
const g = { sectionIds: ['s'], generatedSections: ['s'], overriddenSections: [], sourceHash: 'h', assets: { written: 0, downloaded: 0, failed: [], remoteLeft: [] }, islandsMounted: 0 };

const dead = sticky([false, false, false, false, false]);
const incomplete = (): FidelityReport => compareDesign({ baseline: base([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), observed: cap([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), exemptions: [] });
const complete = (): FidelityReport => compareDesign({ baseline: base([sec({ sectionId: 'ok' })]), observed: cap([sec({ sectionId: 'ok' })]), exemptions: [] });
const correction = (f: FidelityReport, over: Partial<CorrectionSummary['required']> = {}): CorrectionSummary => {
  const open = requiredChecksOpen(v(), f, null);
  return { stopReason: 'passed', budgetReason: null, cycles: [], open: [], plannerFeedback: [], corrections: { stateGuards: [], droppedEdits: [], droppedIslands: [] }, verifications: 1, required: { satisfied: open.length === 0, open, ...over } };
};
const md = (f: FidelityReport, c: CorrectionSummary, verification = v()) => renderPreviewMd({ runId: 'run', v: verification, g, source: '/tmp/preview', fidelity: f, correction: c });

describe('PREVIEW.md with an unverified required check', () => {
  it('never prints "Every required check holds", names INCOMPLETE, and lists the unverified check with section, viewport, element and reason', () => {
    const f = incomplete();
    const out = md(f, correction(f));
    expect(out).not.toMatch(/Every required check holds/);
    expect(out).toMatch(/\*\*INCOMPLETE\*\*/);
    expect(out).toMatch(/### Coverage/);
    expect(out).toMatch(/\| sticky \|/);
    expect(out).toMatch(/### Required checks not verified/);
    expect(out).toMatch(/s \(desktop\).*sticky.*sticky-no-comparable-position/s);
    expect(out).toMatch(/Required checks still open/);
  });

  it('the headline carries the not-verified count', () => {
    const f = incomplete();
    expect(md(f, correction(f))).toMatch(/1 required check\(s\) NOT verified/);
  });

  it('never prints the "holds" line from a satisfied flag alone: a non-pass fidelity verdict contradicts it', () => {
    const f = incomplete();
    expect(md(f, correction(f, { satisfied: true, open: [] }))).not.toMatch(/Every required check holds/);
  });

  it('a complete, passing comparison still prints it, with the Coverage table and no not-verified count', () => {
    const f = complete();
    const out = md(f, correction(f));
    expect(out).toMatch(/Every required check holds/);
    expect(out).toMatch(/### Coverage/);
    expect(out).not.toMatch(/NOT verified/);
  });

  it('names the states this verifier does not capture, including sibling / non-descendant hover effects and the pseudo-element limit', () => {
    const f = complete();
    const out = md(f, correction(f));
    expect(out).toMatch(/Not captured by this verifier:.*:hover \+ \.x, :hover ~ \.x/s);
    expect(out).toMatch(/::marker, ::placeholder/);
  });

  it('discloses what was sampled', () => {
    const f = compareDesign({ baseline: base([sec({ sectionId: 'ok', eligible: { hover: 30, focusVisible: 12 }, coverage: { hover: { attempted: 20, captured: 20 }, focusVisible: { attempted: 12, captured: 12 } } } as never)]), observed: cap([sec({ sectionId: 'ok' })]), exemptions: [] });
    expect(md(f, correction(f))).toMatch(/sampled 20 of 30 element\(s\) \(controls and the elements findings name\) for hover, 12 of 12 for keyboard focus/);
  });

  it('prints the preserved-properties summary when the verification carries one', () => {
    const f = complete();
    const out = md(f, correction(f), v({ preserve: { total: 6, verified: 3, failed: 1, unverified: 2, reasons: [{ reason: 'not measured by the verifier', count: 2 }], worst: [{ targetId: 't9', findingId: 'F1', property: 'width', state: 'default', verification: 'failed', detail: 'the used width changed from 200px to 260px' }] } }));
    expect(out).toMatch(/### Preserved properties/);
    expect(out).toMatch(/3 preserved-verified, 1 changed, 2 unverified/);
    expect(out).toMatch(/not measured by the verifier.*2/);
    expect(out).toMatch(/width.*the used width changed from 200px to 260px/);
  });
});
