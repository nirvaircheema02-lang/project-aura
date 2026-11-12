import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkG2Approval } from '../../src/preview/g2-guard.ts';
import type { PreviewVerification } from '../../src/preview/types.ts';

const verification = (verdict: 'pass' | 'fail', failedIds: string[] = []): PreviewVerification => ({
  schemaVersion: 1, generatedAt: '', url: 'http://127.0.0.1:4400/', mode: 'selected-sections', expectedSectionIds: [], renderedSectionIds: [],
  // a finished verification has its fidelity comparison on record (without any, the status is INCOMPLETE and G2 would also list that)
  checks: [{ id: 'fidelity.design-state', group: 'fidelity' as const, name: 'Design, state and composition are preserved', status: 'pass' as const, detail: '0 regression(s)' }, ...failedIds.map((id) => ({ id, group: 'scope' as const, name: `check ${id}`, status: 'fail' as const, detail: `detail of ${id}` }))],
  findings: [], interactions: [], unavailable: [], simulated: [],
  summary: { passed: 0, failed: failedIds.length, notChecked: 0, findingsVerified: 0, findingsTotal: 0, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict,
});
const opts = { acceptPreviewFailures: false, note: null as string | null, verificationPath: '/run/preview/verification.json', redesignRunId: 'run-1' };

describe('G2 approval guard — a visual approval needs a produced, verified preview', () => {
  it('refuses when no preview verification exists (static export is never a substitute)', () => {
    const r = checkG2Approval(null, opts);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.lines.join('\n')).toMatch(/static export is not an acceptable substitute/);
  });
  it('refuses a failed verification and names the failed checks', () => {
    const r = checkG2Approval(verification('fail', ['scope.forbidden', 'content.hero.text']), opts);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.lines.join('\n')).toMatch(/scope.forbidden|check scope.forbidden/);
    expect(r.ok === false && r.lines.join('\n')).toMatch(/--accept-preview-failures/);
  });
  it('allows it only when the reviewer explicitly accepts, and records the failed checks in the note', () => {
    const r = checkG2Approval(verification('fail', ['scope.forbidden']), { ...opts, acceptPreviewFailures: true, note: 'looks fine to me' });
    expect(r).toEqual({ ok: true, note: 'looks fine to me · ACCEPTED FAILED PREVIEW CHECKS: scope.forbidden' });
  });
  it('a passing verification approves with the reviewer\'s own note untouched', () => {
    expect(checkG2Approval(verification('pass'), { ...opts, note: 'ok' })).toEqual({ ok: true, note: 'ok' });
  });
});

describe('CLI contract', () => {
  const cli = join(import.meta.dirname, '../../src/cli/index.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { encoding: 'utf8', timeout: 60_000 });

  it('a real redesign run without --mode is refused: Run ID/Name + Mode is the startup input', () => {
    const r = run('redesign', '--run-id', 'whatever');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--mode is required/);
    expect(r.stderr).toMatch(/Run ID\/Run Name \+ Mode/);
  }, 60_000);
  it('rejects an unknown mode', () => {
    const r = run('redesign', '--run-id', 'whatever', '--mode', 'everything');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/"everything"/);
  }, 60_000);
  it('exposes the React preview as a first-class command', () => {
    const r = run('preview', '--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--regenerate/);
    expect(r.stdout).toMatch(/--stop/);
  }, 60_000);
});
