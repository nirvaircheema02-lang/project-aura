import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertAuditAgentRepo, findRunArgs, parseFindRunStdout, resolveAuditRun, type ExecFn } from '../../src/audit-link/find-run.ts';
import { TerminalError } from '../../src/retry.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-findrun-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'audit-agent' }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('findRunArgs — argv array, never a shell string (Q3)', () => {
  it('passes a display name with quotes and spaces as ONE argument', () => {
    expect(findRunArgs({ runName: `Brand "Perception" survey page` })).toEqual(['run', 'agent', 'find-run', '--run-name', `Brand "Perception" survey page`]);
    expect(findRunArgs({ runId: 'survey-page-audit' })).toEqual(['run', 'agent', 'find-run', '--run-id', 'survey-page-audit']);
  });
});

describe('parseFindRunStdout — the stdout contract (Decision Log #7)', () => {
  it('finds the JSON object line among pnpm noise and uses its runDir', () => {
    const stdout = ['', '> audit-agent@0.1.0 agent /x/audit-agent', '> node src/cli/index.ts "find-run" "--run-id" "survey-page-audit"', '', JSON.stringify({ projectName: 'www.kenresearch.com-survey', runId: 'survey-page-audit', displayName: 'Survey Page Audit', targetUrl: 'https://www.kenresearch.com/survey', runDir: '/x/audit-agent/projects/www.kenresearch.com-survey/runs/survey-page-audit' })].join('\n');
    const { run, warnings } = parseFindRunStdout(stdout, '/x/audit-agent');
    expect(run).toEqual({ projectName: 'www.kenresearch.com-survey', runId: 'survey-page-audit', displayName: 'Survey Page Audit', targetUrl: 'https://www.kenresearch.com/survey', runDir: '/x/audit-agent/projects/www.kenresearch.com-survey/runs/survey-page-audit' });
    expect(warnings).toEqual([]);
  });

  it('falls back to the locked projects/<project>/runs/<runId> layout WITH a warning when runDir is absent; displayName defaults to runId', () => {
    const { run, warnings } = parseFindRunStdout(JSON.stringify({ projectName: 'p', runId: 'r' }), '/aa');
    expect(run.runDir).toBe('/aa/projects/p/runs/r');
    expect(run.displayName).toBe('r');
    expect(run.targetUrl).toBeNull();
    expect(warnings[0]).toMatch(/no runDir/);
  });

  it('is TERMINAL when no usable JSON object was printed', () => {
    expect(() => parseFindRunStdout('Run survey-page-audit · https://…\n', '/aa')).toThrow(TerminalError);
    expect(() => parseFindRunStdout('{"foo": 1}\n', '/aa')).toThrow(/printed no JSON object with projectName \+ runId/);
  });

  it('§security: refuses a projectName/runId that is not a safe single path segment, rather than using it to build a path (path traversal)', () => {
    expect(() => parseFindRunStdout(JSON.stringify({ projectName: '../../etc', runId: 'r' }), '/aa')).toThrow(TerminalError);
    expect(() => parseFindRunStdout(JSON.stringify({ projectName: '../../etc', runId: 'r' }), '/aa')).toThrow(/safe single path segment/);
    expect(() => parseFindRunStdout(JSON.stringify({ projectName: 'p', runId: '../../etc' }), '/aa')).toThrow(/safe single path segment/);
    expect(() => parseFindRunStdout(JSON.stringify({ projectName: 'a/b', runId: 'r' }), '/aa')).toThrow(/safe single path segment/);
    // a runDir supplied explicitly is still honoured for a safe projectName/runId — the check
    // only guards the two fields THIS side (and the fallback layout above) treats as path segments.
    const { run } = parseFindRunStdout(JSON.stringify({ projectName: 'p', runId: 'r', runDir: '/aa/projects/p/runs/r' }), '/aa');
    expect(run.runDir).toBe('/aa/projects/p/runs/r');
  });
});

describe('assertAuditAgentRepo', () => {
  it('accepts the audit-agent package and rejects anything else, naming the path', () => {
    expect(() => assertAuditAgentRepo(root)).not.toThrow();
    const other = mkdtempSync(join(tmpdir(), 'fra-other-'));
    try {
      expect(() => assertAuditAgentRepo(other)).toThrow(/has no package.json/);
      writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'project_aura1-main' }));
      expect(() => assertAuditAgentRepo(other)).toThrow(/is package "project_aura1-main", not "audit-agent"/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('resolveAuditRun — every outcome but single-match is TERMINAL with audit-agent\'s own text attached', () => {
  const exec = (result: Awaited<ReturnType<ExecFn>>, calls: Array<{ cmd: string; args: string[]; cwd: string }> = []): ExecFn => async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    return result;
  };

  it('single match: runs pnpm in auditAgentRepoRoot and returns the run (folder must exist)', async () => {
    const runDir = join(root, 'projects', 'p', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const { run } = await resolveAuditRun(root, { runId: 'r1' }, exec({ code: 0, stdout: `${JSON.stringify({ projectName: 'p', runId: 'r1', displayName: 'R One', targetUrl: 'https://x', runDir })}\n`, stderr: '' }, calls));
    expect(run.runDir).toBe(runDir);
    expect(calls).toEqual([{ cmd: 'pnpm', args: ['run', 'agent', 'find-run', '--run-id', 'r1'], cwd: root }]);
  });

  it('a resolved folder that does not exist is TERMINAL', async () => {
    await expect(resolveAuditRun(root, { runId: 'ghost' }, exec({ code: 0, stdout: JSON.stringify({ projectName: 'p', runId: 'ghost', runDir: join(root, 'nope') }), stderr: '' }))).rejects.toThrow(/does not exist/);
  });

  it('zero/multiple matches (non-zero exit): stops and shows the candidates audit-agent printed', async () => {
    const said = 'No exact match. Candidates:\n  www.kenresearch.com-survey / survey-page-audit · "Survey Page Audit"\n  www.kenresearch.com-survey / survey-page-audit-2 · "Survey Page Audit"';
    const err = await resolveAuditRun(root, { runName: 'Survey Page Audit' }, exec({ code: 1, stdout: said, stderr: '' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toContain('survey-page-audit-2');
    expect((err as Error).message).toContain('pass --run-id');
  });

  it('audit-agent without find-run yet (Part 1 not landed) is named as exactly that', async () => {
    const err = await resolveAuditRun(root, { runId: 'r' }, exec({ code: 1, stdout: '', stderr: "error: unknown command 'find-run'" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toMatch(/has no "find-run" command yet/);
    expect((err as Error).message).toMatch(/Part 1/);
  });

  it('a spawn failure (pnpm missing) is TERMINAL and says so', async () => {
    await expect(resolveAuditRun(root, { runId: 'r' }, exec({ code: null, spawnError: 'ENOENT', stdout: '', stderr: '' }))).rejects.toThrow(/could not run "pnpm run agent find-run --run-id r".*ENOENT/);
  });

  it('a wrong auditAgentRepoRoot fails before any process is spawned', async () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    await expect(resolveAuditRun(join(root, 'missing'), { runId: 'r' }, exec({ code: 0, stdout: '', stderr: '' }, calls))).rejects.toThrow(/has no package.json/);
    expect(calls).toEqual([]);
  });
});
