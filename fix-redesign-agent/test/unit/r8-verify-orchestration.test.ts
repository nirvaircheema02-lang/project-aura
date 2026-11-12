import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitTargetStatuses, verifyAttempt, type VerifyAttemptSteps } from '../../src/agents/r8-react-preview/index.ts';
import { compareDesign } from '../../src/fidelity/compare.ts';
import type { FidelityReport, PreserveResult } from '../../src/fidelity/types.ts';
import type { PreviewVerification } from '../../src/preview/types.ts';
import type { Exemption } from '../../src/resolution/schema.ts';
import { writeResolution } from '../../src/resolution/store.ts';
import { base, cap, resolutionOf, sec, target } from '../helpers/fidelity-captures.ts';

/**
 * R8's verification is an ORDERED hand-off, and nothing browser-driven is needed to pin it: fidelity FIRST (the preserve decisions are judged on its
 * evidence), then the preserve evaluation on that report, then the preview verification fed those results — and the targets' statuses written to
 * resolved-targets.json are exactly verification.targetResults, so the two files cannot disagree.
 */

const report = (): FidelityReport => compareDesign({ baseline: base([sec()]), observed: cap([sec()]), exemptions: [], now: () => new Date(0) });
const preserveResult = (targetId: string): PreserveResult => ({ targetId, findingId: 'F1', property: 'color', state: 'default', verification: 'preserved-verified', detail: 'compared equal', reason: 'preserved-verified', evidence: [] });
const verification = (over: Partial<PreviewVerification> = {}): PreviewVerification => ({
  schemaVersion: 1, generatedAt: 't', url: 'http://x', mode: 'full-page', expectedSectionIds: [], renderedSectionIds: [], checks: [], findings: [], interactions: [], unavailable: [], simulated: [],
  summary: { passed: 0, failed: 0, notChecked: 0, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass', ...over,
});

describe('verifyAttempt — the order of R8\'s verification', () => {
  it('fidelity, then the preserve evaluation on THAT report, then the preview verification with THOSE results', async () => {
    const calls: string[] = [];
    const fidelity = report();
    const preserve = [preserveResult('t1')];
    const v = verification();
    const exemptions: Exemption[] = [{ findingId: 'F1', property: 'color', part: 'self', state: 'default', viewport: 'any', targetId: 't1', reason: 'r' }];
    const resolution = resolutionOf(target());
    const steps: VerifyAttemptSteps = {
      fidelity: async (ex) => { calls.push('fidelity'); expect(ex).toBe(exemptions); return fidelity; },
      preserve: (input) => { calls.push('preserve'); expect(input.report).toBe(fidelity); expect(input.exemptions).toBe(exemptions); expect(input.resolution).toBe(resolution); return preserve; },
      preview: async (results) => { calls.push('preview'); expect(results).toBe(preserve); return v; },
    };
    const out = await verifyAttempt(steps, { resolution, baseline: null, overrideSectionIds: new Set(['x']), exemptions });
    expect(calls).toEqual(['fidelity', 'preserve', 'preview']);
    expect(out.verification).toBe(v);
    expect(out.fidelity).toBe(fidelity);
  });

  it('a failing fidelity step stops the hand-off: the preview is never verified on stale or missing preserve results', async () => {
    const calls: string[] = [];
    const steps: VerifyAttemptSteps = {
      fidelity: async () => { calls.push('fidelity'); throw new Error('capture failed'); },
      preserve: () => { calls.push('preserve'); return []; },
      preview: async () => { calls.push('preview'); return verification(); },
    };
    await expect(verifyAttempt(steps, { resolution: null, baseline: null, overrideSectionIds: new Set(), exemptions: [] })).rejects.toThrow('capture failed');
    expect(calls).toEqual(['fidelity']);
  });

  it('the override section ids reach the preserve evaluation', async () => {
    let seen: ReadonlySet<string> | undefined;
    const ids = new Set(['hero']);
    await verifyAttempt({ fidelity: async () => report(), preserve: (i) => { seen = i.overrideSectionIds; return []; }, preview: async () => verification() }, { resolution: null, baseline: null, overrideSectionIds: ids, exemptions: [] });
    expect(seen).toBe(ids);
  });
});

describe('commitTargetStatuses — resolved-targets.json carries exactly verification.targetResults', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

  it('every target result lands on its target (measured and preserve decisions alike), untouched targets stay, and the file written equals the in-memory result', async () => {
    dir = await mkdtemp(join(tmpdir(), 'r8-commit-'));
    const path = join(dir, 'resolved-targets.json');
    const resolution = resolutionOf(target({ id: 't1' }), target({ id: 't2', findingId: 'F2' }), target({ id: 't3', findingId: 'F3' }));
    const v = verification({ targetResults: [
      { targetId: 't1', findingId: 'F1', verification: 'preserved-verified', detail: 'compared equal on 2 element(s)' },
      { targetId: 't2', findingId: 'F2', verification: 'failed', detail: 'color changed although it was preserved' },
    ] });
    await commitTargetStatuses(resolution, v, (r) => writeResolution(path, r));

    const onDisk = JSON.parse(await readFile(path, 'utf8')) as typeof resolution;
    for (const r of v.targetResults!) {
      const t = onDisk.targets.find((x) => x.id === r.targetId)!;
      expect(t.status.verification).toBe(r.verification);
      expect(t.status.verificationDetail).toBe(r.detail);
    }
    expect(onDisk.targets.find((x) => x.id === 't3')!.status.verification).toBe('not-run'); // no result: never promoted
    expect(onDisk.targets.map((t) => t.status)).toEqual(resolution.targets.map((t) => t.status));
  });

  it('writes nothing without a resolution, and nothing is promoted by a verification without target results', async () => {
    let writes = 0;
    await commitTargetStatuses(null, verification({ targetResults: [{ targetId: 't1', findingId: 'F1', verification: 'preserved-verified', detail: 'x' }] }), async () => { writes++; });
    expect(writes).toBe(0);
    const resolution = resolutionOf(target());
    await commitTargetStatuses(resolution, verification(), async () => { writes++; });
    expect(writes).toBe(1);
    expect(resolution.targets[0]!.status.verification).toBe('not-run');
  });
});
