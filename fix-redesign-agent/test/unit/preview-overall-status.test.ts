import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CorrectionSummary, R8Output } from '../../src/agents/types.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { fidelityCheckOf, fidelitySummaryOf } from '../../src/fidelity/coverage.ts';
import type { FidelityReport } from '../../src/fidelity/types.ts';
import { g2Reason } from '../../src/pipeline.ts';
import { requiredChecksOpen } from '../../src/preview/correct.ts';
import { checkG2Approval } from '../../src/preview/g2-guard.ts';
import { renderPreviewMd } from '../../src/preview/report.ts';
import { applyOverallStatus, cliVerificationLines, requiredGapsOf, settleStatus, statusHeadline, statusOf } from '../../src/preview/status.ts';
import type { PreviewCheck, PreviewVerification } from '../../src/preview/types.ts';
import { writePreviewStatus } from '../../src/preview/verify.ts';
import { readStatus, statusLine as chromeStatusLine } from '../../templates/react-preview/src/runtime/status.ts';
import { base, cap, resolutionOf, sec, sticky, target } from '../helpers/fidelity-captures.ts';

/**
 * The OVERALL preview status: PASS only when every required check is verified, FAIL when a required check fails, INCOMPLETE when nothing
 * required failed but required evidence is missing. Optional / disclosed limitations stay apart. Every surface reads the same status.
 */

const v = (over: Partial<PreviewVerification> = {}): PreviewVerification => ({
  schemaVersion: 1, generatedAt: 't', url: 'http://127.0.0.1:4400/', mode: 'full-page', expectedSectionIds: ['s'], renderedSectionIds: ['s'], checks: [], findings: [], interactions: [], unavailable: [], simulated: [],
  summary: { passed: 4, failed: 0, notChecked: 0, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass', ...over,
});
const g = { sectionIds: ['s'], generatedSections: ['s'], overriddenSections: [], sourceHash: 'h', assets: { written: 0, downloaded: 0, failed: [], remoteLeft: [] }, islandsMounted: 0 };

const dead = sticky([false, false, false, false, false]);
/** A real comparison whose only gap is an unreachable sticky trace: nothing regressed, one required check cannot be verified. */
const stickyUnreachable = (): FidelityReport => compareDesign({ baseline: base([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), observed: cap([sec({ sectionId: 'ok' }), sec({ sticky: [dead] })]), exemptions: [] });
const allVerified = (): FidelityReport => compareDesign({ baseline: base([sec({ sectionId: 'ok' })]), observed: cap([sec({ sectionId: 'ok' })]), exemptions: [] });
const regressing = (): FidelityReport => compareDesign({ baseline: base([sec({ sectionId: 'ok' })]), observed: cap([sec({ sectionId: 'ok', elements: [sec().elements[0]!, { ...sec().elements[1]!, style: { color: 'rgb(255, 0, 0)' } }] })]), exemptions: [] });

const unverifiedPreserve = () => resolutionOf(target({ id: 'p1', status: { design: 'preserved', implementation: 'not-applicable', verification: 'unverified', implementationDetail: null, verificationDetail: 'not measured by the verifier: margin-top' } }));
const failedTarget = () => target({ id: 't9', outcome: 'resolved-target', target: { value: '8px', comparison: 'length-px', token: null }, status: { design: 'resolved', implementation: 'applied', verification: 'failed', implementationDetail: null, verificationDetail: 'rendered 4px' } });

/** What R8 does at the end: the fidelity check joins the checks, then the status is settled from fidelity + targets. */
function settled(f: FidelityReport | null, resolution = null as ReturnType<typeof resolutionOf> | null, over: Partial<PreviewVerification> = {}) {
  const ver = v(over);
  if (f) ver.checks.unshift(fidelityCheckOf(f));
  const gaps = settleStatus(ver, f, resolution);
  if (f) ver.fidelity = fidelitySummaryOf(f, gaps.map((x) => x.text));
  return ver;
}

describe('the overall status', () => {
  it('an unreachable sticky trace is INCOMPLETE, never PASS - and the individual check stays not-checked', () => {
    const f = stickyUnreachable();
    expect(f.verdict).toBe('incomplete');
    const ver = settled(f);
    expect(ver.verdict).toBe('incomplete');
    expect(ver.status).toMatchObject({ verdict: 'incomplete', failedRequired: 0, unverifiedRequired: 1 });
    expect(ver.status!.gaps).toHaveLength(1);
    expect(ver.status!.gaps[0]).toMatchObject({ kind: 'unverified', family: 'fidelity:sticky' });
    expect(ver.status!.gaps[0]!.text).toMatch(/sticky/);
    // the verified results are kept intact: the fidelity check is still not-checked, nothing was rewritten to pass or fail
    expect(ver.checks.find((c) => c.id === 'fidelity.design-state')!.status).toBe('not-checked');
  });

  it('an unverified required preservation / state check is INCOMPLETE', () => {
    const ver = settled(allVerified(), unverifiedPreserve());
    expect(ver.verdict).toBe('incomplete');
    expect(ver.status).toMatchObject({ failedRequired: 0, unverifiedRequired: 1 });
    expect(ver.status!.gaps[0]).toMatchObject({ kind: 'unverified', family: 'preserve' });
    expect(ver.status!.gaps[0]!.text).toMatch(/1 preserve decision\(s\) could not be verified/);
  });

  it('a gate that did not run (interaction parity, preserve check, contrast) is required evidence missing: INCOMPLETE', () => {
    const parity: PreviewCheck = { id: 'interaction.parity', group: 'interaction', name: 'Interactions behave as on the original page', status: 'not-checked', detail: 'the original page\'s behaviour was not captured for this run' };
    const ver = settled(allVerified(), null, { checks: [parity] });
    expect(ver.verdict).toBe('incomplete');
    expect(ver.status!.gaps[0]).toMatchObject({ kind: 'unverified', family: 'check:interaction.parity' });
    expect(ver.checks[ver.checks.length - 1]!.status).toBe('not-checked');
  });

  it('an informational not-checked check (orphan content, inherited contrast) is DISCLOSED, not required: PASS', () => {
    const info: PreviewCheck[] = [
      { id: 'scope.no-orphan-content', group: 'scope', name: 'No orphan content', status: 'not-checked', detail: '1 unowned block(s)' },
      { id: 'contrast.inherited', group: 'contrast', name: 'Inherited text below AA', status: 'not-checked', detail: '3 run(s) below AA, inherited' },
    ];
    const ver = settled(allVerified(), null, { checks: info, unavailable: ['hover menu is not reproduced'] });
    expect(ver.verdict).toBe('pass');
    expect(ver.status).toMatchObject({ verdict: 'pass', failedRequired: 0, unverifiedRequired: 0, gaps: [] });
    expect(ver.status!.disclosed.join('\n')).toMatch(/1 unowned block/);
    expect(ver.status!.disclosed.join('\n')).toMatch(/inherited/);
    expect(ver.status!.disclosed.join('\n')).toMatch(/1 behaviour\(s\) of the original page are not reproduced/);
  });

  it('a required FAILURE plus incomplete checks is FAIL, with BOTH disclosed', () => {
    const f = regressing();
    expect(f.verdict).toBe('fail');
    const ver = settled(f, resolutionOf(failedTarget(), unverifiedPreserve().targets[0]!));
    expect(ver.verdict).toBe('fail');
    expect(ver.status!.failedRequired).toBeGreaterThanOrEqual(2);
    expect(ver.status!.unverifiedRequired).toBeGreaterThanOrEqual(1);
    const kinds = ver.status!.gaps.map((x) => x.kind);
    expect(kinds).toContain('failed');
    expect(kinds).toContain('unverified');
    // failures are listed first, so a cap can never hide them behind unverified items
    expect(kinds.indexOf('unverified')).toBeGreaterThan(kinds.lastIndexOf('failed'));
    expect(statusHeadline(ver.status!)).toMatch(/^FAIL - \d+ required check\(s\) failed, \d+ not verified$/);
  });

  it('a failed fidelity check next to unverified coverage is FAIL with both', () => {
    const f = { ...regressing(), coverage: { ...regressing().coverage!, requiredUnverified: 2 } };
    const ver = settled(f);
    expect(ver.verdict).toBe('fail');
    expect(ver.status!.gaps.map((x) => x.kind).sort()).toEqual(expect.arrayContaining(['failed', 'unverified']));
    expect(ver.status!.unverifiedRequired).toBe(2);
  });

  it('every required check verified is PASS with no gaps', () => {
    const ver = settled(allVerified());
    expect(ver.verdict).toBe('pass');
    expect(ver.status).toMatchObject({ verdict: 'pass', failedRequired: 0, unverifiedRequired: 0, gaps: [], gapsTruncated: 0 });
    expect(statusHeadline(ver.status!)).toMatch(/^PASS/);
  });

  it('requiredChecksOpen is exactly the gap texts, and is empty exactly when the verdict is PASS', () => {
    for (const [f, r] of [[stickyUnreachable(), null], [allVerified(), unverifiedPreserve()], [allVerified(), null], [regressing(), null]] as const) {
      const ver = settled(f, r);
      expect(requiredChecksOpen(ver, f, r)).toEqual(requiredGapsOf(ver, f, r).map((x) => x.text));
      expect(requiredChecksOpen(ver, f, r).length === 0).toBe(ver.verdict === 'pass');
    }
  });

  it('applyOverallStatus is idempotent and caps the gap list with a count of the rest', () => {
    const ver = v();
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: i < 2 ? 'failed' as const : 'unverified' as const, family: `x:${i}`, text: `gap ${i}` }));
    applyOverallStatus(ver, many);
    const first = JSON.stringify(ver);
    applyOverallStatus(ver, many);
    expect(JSON.stringify(ver)).toBe(first);
    expect(ver.status!.gaps).toHaveLength(12);
    expect(ver.status!.gapsTruncated).toBe(8);
    expect(ver.status!.gaps[0]!.kind).toBe('failed');
    expect(ver.status).toMatchObject({ failedRequired: 2, unverifiedRequired: 18 });
  });
});

describe('R8 joins its own checks before the status is settled', () => {
  it('a failed R8-level check (scope diverges from the pipeline scope) makes the verdict FAIL - exactly as the explicit override it replaces did', () => {
    const f = allVerified();
    const ver = settled(f, null, { checks: [{ id: 'scope.matches-run-scope', group: 'scope', name: 'scope', status: 'fail', detail: 'derived a, resolved b' }] });
    expect(ver.verdict).toBe('fail');
    expect(ver.status).toMatchObject({ verdict: 'fail', failedRequired: 1 });
    expect(ver.status!.gaps[0]).toMatchObject({ kind: 'failed', family: 'checks' });
  });

  it('no fidelity report at all (no baseline) is unverified required evidence: INCOMPLETE, never PASS', () => {
    const ver = settled(null);
    expect(ver.verdict).toBe('incomplete');
    expect(ver.status!.gaps[0]).toMatchObject({ kind: 'unverified', family: 'fidelity:not-compared' });
  });
});

describe('the G2 reason leads with the overall status', () => {
  const reasonFor = (ver: PreviewVerification) => g2Reason({ outcome: 'PASS', r8: { url: 'http://127.0.0.1:4400/', verification: ver, fidelity: null, correction: null } as unknown as R8Output, unresolved: 0, unverifiedResolved: 0, reviewIndex: '/r.html' });

  it('INCOMPLETE and FAIL are named with the counts; PASS stays plain', () => {
    expect(reasonFor(settled(stickyUnreachable()))).toMatch(/React preview INCOMPLETE \(1 required check\(s\) not verified\) at http/);
    const failing = settled({ ...regressing(), coverage: { ...regressing().coverage!, requiredUnverified: 2 } });
    expect(reasonFor(failing)).toContain(`React preview FAIL (${failing.status!.failedRequired} required check(s) failed, 2 not verified) at http`);
    expect(failing.status!.failedRequired).toBe(regressing().summary.regressions);
    const plain = reasonFor(settled(allVerified()));
    expect(plain).toContain('React preview PASS at http');
    expect(plain).not.toContain('NOT fully verified');
  });

  it('an older verification.json whose fidelity was not-checked is not called PASS at G2', () => {
    const old = v({ checks: [{ id: 'fidelity.design-state', group: 'fidelity', name: 'n', status: 'not-checked', detail: 'INCOMPLETE - required 37/40 verified, 0 failed, 3 unverified: sticky 3' }] });
    expect(reasonFor(old)).toMatch(/React preview INCOMPLETE/);
  });
});

describe('every surface reports the same status', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const correctionOf = (ver: PreviewVerification, f: FidelityReport, r: Parameters<typeof requiredChecksOpen>[2]): CorrectionSummary => {
    const open = requiredChecksOpen(ver, f, r);
    return { stopReason: 'passed', budgetReason: null, cycles: [], open: [], plannerFeedback: [], corrections: { stateGuards: [], droppedEdits: [], droppedIslands: [] }, verifications: 1, required: { satisfied: open.length === 0, open } };
  };

  it('verification.json, pv-status.json, PREVIEW.md, the CLI lines, the preview UI and the G2 note agree on verdict, counts and gaps', async () => {
    const f = stickyUnreachable();
    const resolution = unverifiedPreserve();
    const ver = settled(f, resolution);
    expect(ver.verdict).toBe('incomplete');
    const s = ver.status!;
    expect(s.unverifiedRequired).toBe(2); // 1 sticky trace + 1 preserve decision

    const dir = mkdtempSync(join(tmpdir(), 'pv-status-'));
    dirs.push(dir);
    await writePreviewStatus(dir, 'run-1', 'full-page', ver);
    const pv = JSON.parse(readFileSync(join(dir, 'public', 'pv-status.json'), 'utf8'));
    const json = JSON.parse(JSON.stringify(ver));
    // verification.json and pv-status.json carry the same verdict, counts and gaps
    for (const out of [json.status, pv]) expect(out).toMatchObject({ verdict: 'incomplete', failedRequired: 0, unverifiedRequired: 2, gaps: s.gaps, gapsTruncated: 0, disclosed: s.disclosed });
    expect(json.verdict).toBe('incomplete');
    expect(pv.runId).toBe('run-1');

    const md = renderPreviewMd({ runId: 'run-1', v: ver, g, source: '/tmp/preview', fidelity: f, correction: correctionOf(ver, f, resolution) });
    expect(md).toMatch(/\*\*Verification:\*\* INCOMPLETE - 2 required check\(s\) not verified/);
    expect(md).not.toMatch(/Verification:\*\* PASS/);
    expect(md).not.toMatch(/Every required check holds/);
    for (const gap of s.gaps) expect(md).toContain(gap.text);

    const cli = cliVerificationLines(ver).join('\n');
    expect(cli).toMatch(/Verification: {2}INCOMPLETE - 2 required check\(s\) not verified/);
    for (const gap of s.gaps) expect(cli).toContain(gap.text.slice(0, 80));

    // the preview's own status reader shows the same words from the file the UI fetches
    const ui = readStatus(pv)!;
    expect(chromeStatusLine(ui)).toBe(`Verification: ${statusHeadline(s)}`);
    expect(ui.gaps.map((x) => x.text)).toEqual(s.gaps.map((x) => x.text));

    // G2: an INCOMPLETE verdict is approvable (the user's decision), and the note names every accepted unverified requirement
    const g2 = checkG2Approval(ver, { acceptPreviewFailures: false, note: null, verificationPath: '/v.json', redesignRunId: 'r' });
    expect(g2.ok).toBe(true);
    const note = g2.ok ? (g2.note ?? '') : '';
    expect(note).toMatch(/ACKNOWLEDGED UNVERIFIED REQUIRED CHECKS: 2 required check\(s\) not verified/);
    for (const gap of s.gaps) expect(note).toContain(gap.text.slice(0, 80));
    expect(note).not.toMatch(/ACCEPTED FAILED/);
  });

  it('a FAIL records both the accepted failures and the accepted unverified requirements; without --accept-preview-failures it is refused', () => {
    const f = { ...regressing(), coverage: { ...regressing().coverage!, requiredUnverified: 1 } };
    const ver = settled(f);
    const opts = { acceptPreviewFailures: false, note: 'seen', verificationPath: '/v.json', redesignRunId: 'r' };
    const refused = checkG2Approval(ver, opts);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.lines.join('\n')).toMatch(/--accept-preview-failures/);
    const accepted = checkG2Approval(ver, { ...opts, acceptPreviewFailures: true });
    const note = accepted.ok ? (accepted.note ?? '') : '';
    expect(note).toMatch(/^seen · ACCEPTED FAILED PREVIEW CHECKS: fidelity\.design-state/);
    expect(note).toMatch(/ACKNOWLEDGED UNVERIFIED REQUIRED CHECKS: 1 required check\(s\) not verified/);
  });

  it('PASS: nothing is added to the G2 note and PREVIEW.md says PASS', () => {
    const f = allVerified();
    const ver = settled(f);
    expect(checkG2Approval(ver, { acceptPreviewFailures: false, note: 'ok', verificationPath: '/v.json', redesignRunId: 'r' })).toEqual({ ok: true, note: 'ok' });
    const md = renderPreviewMd({ runId: 'run-1', v: ver, g, source: '/tmp/preview', fidelity: f, correction: correctionOf(ver, f, null) });
    expect(md).toMatch(/\*\*Verification:\*\* PASS/);
    expect(md).toMatch(/Every required check holds/);
  });
});

describe('files written before the status existed', () => {
  it('an old verification.json whose fidelity check was not-checked is INCOMPLETE, never upgraded to PASS', () => {
    const old = v({ checks: [{ id: 'fidelity.design-state', group: 'fidelity', name: 'n', status: 'not-checked', detail: 'INCOMPLETE - required 37/40 verified, 0 failed, 3 unverified: sticky 3' }] });
    expect(old.status).toBeUndefined();
    expect(statusOf(old)).toMatchObject({ verdict: 'incomplete', unverifiedRequired: 1 });
    expect(cliVerificationLines(old)[0]).toMatch(/INCOMPLETE - 1 required check\(s\) not verified/);
    const md = renderPreviewMd({ runId: 'r', v: old, g, source: '/tmp/p' });
    expect(md).toMatch(/\*\*Verification:\*\* INCOMPLETE/);
  });

  it('an old verification.json with only the fidelity summary derives the same words', () => {
    const old = v({ fidelity: { verdict: 'incomplete', requiredTotal: 40, requiredVerified: 37, requiredFailed: 0, requiredUnverified: 3, actionable: 2, byDesign: 1, open: ['design/state fidelity is INCOMPLETE: 3 of 40 required check(s) not verified'] } });
    expect(statusOf(old)).toMatchObject({ verdict: 'incomplete', unverifiedRequired: 3 });
  });

  it('an old failed file stays FAIL; an old clean file stays PASS; a stored status is never better than the top-level verdict', () => {
    expect(statusOf(v({ verdict: 'fail', checks: [{ id: 'scope.x', group: 'scope', name: 'n', status: 'fail', detail: 'd' }] })).verdict).toBe('fail');
    // an old clean file is PASS when its fidelity comparison is on record; with no fidelity evidence at all it is INCOMPLETE (preview-status-review-fixes.test.ts)
    expect(statusOf(v({ checks: [{ id: 'fidelity.design-state', group: 'fidelity', name: 'n', status: 'pass', detail: '0 regression(s)' }] })).verdict).toBe('pass');
    const ver = settled(allVerified());
    ver.verdict = 'fail';
    expect(statusOf(ver).verdict).toBe('fail');
  });

  it('the preview UI reads an old pv-status.json (verdict only, or pending) without the new fields', () => {
    expect(readStatus({ runId: 'r', mode: 'full-page', sections: ['a'], simulated: [], unavailable: [], verdict: 'pass' })).toMatchObject({ verdict: 'pass', gaps: [], failedRequired: 0 });
    expect(chromeStatusLine(readStatus({ runId: 'r', mode: 'full-page', sections: ['a'], simulated: [], unavailable: [], verdict: null })!)).toBe('Verification: pending');
    expect(readStatus(null)).toBeNull();
    expect(readStatus('nonsense')).toBeNull();
  });
});
