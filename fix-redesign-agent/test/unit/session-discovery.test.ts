import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveStartReference, type DiscoveryDeps } from '../../src/session/discovery.ts';
import { TerminalError } from '../../src/retry.ts';
import type { ResolvedAuditRun } from '../../src/audit-link/index.ts';

/**
 * S0 (§5.1) — `session/discovery.ts` had NO dedicated test file before this. Regression focus:
 * a genuine configuration/environment failure (a bad `auditAgentRepoRoot`, a missing find-run
 * command, a spawn failure) must propagate immediately, never be silently swallowed into a
 * misleading generic "did not resolve" after uselessly retrying every other reference form.
 */

let auditAgentRepoRoot: string;
let projectsRoot: string;
beforeEach(() => {
  auditAgentRepoRoot = mkdtempSync(join(tmpdir(), 'fra-disc-audit-'));
  projectsRoot = mkdtempSync(join(tmpdir(), 'fra-disc-projects-'));
});
afterEach(() => {
  rmSync(auditAgentRepoRoot, { recursive: true, force: true });
  rmSync(projectsRoot, { recursive: true, force: true });
});

function resolvedRun(overrides: Partial<ResolvedAuditRun> = {}): ResolvedAuditRun {
  return { projectName: 'p', runId: 'r', displayName: 'R', targetUrl: 'https://x', runDir: '/aa/projects/p/runs/r', ...overrides };
}

describe('resolveStartReference — §security/#4 regression: a genuine config/environment failure propagates, never silently swallowed as "not found"', () => {
  it('a TerminalError NOT matching "could not resolve...to exactly one run" (e.g. a bad auditAgentRepoRoot) is thrown, not swallowed into a generic not-found', async () => {
    const deps: DiscoveryDeps = {
      auditAgentRepoRoot,
      projectsRoot,
      resolveRun: async () => {
        throw new TerminalError(`auditAgentRepoRoot "${auditAgentRepoRoot}" has no package.json — it must point at the audit-agent repo`);
      },
    };
    await expect(resolveStartReference('some-run', deps)).rejects.toThrow(/has no package\.json/);
  });

  it('a spawn failure (pnpm not on PATH) propagates immediately — never retried across the 6 other reference forms', async () => {
    let calls = 0;
    const deps: DiscoveryDeps = {
      auditAgentRepoRoot,
      projectsRoot,
      resolveRun: async () => {
        calls++;
        throw new TerminalError('could not run "pnpm run agent find-run --run-id x" in /aa (spawn failed) — pnpm must be on PATH and audit-agent installed');
      },
    };
    await expect(resolveStartReference('some-run', deps)).rejects.toThrow(/pnpm must be on PATH/);
    expect(calls).toBe(1); // never tried the Run Name form (or beyond) after a config-level failure
  });

  it('"audit-agent has no find-run command yet" (Part 1 missing) propagates immediately', async () => {
    const deps: DiscoveryDeps = {
      auditAgentRepoRoot,
      projectsRoot,
      resolveRun: async () => {
        throw new TerminalError(`audit-agent at ${auditAgentRepoRoot} has no "find-run" command yet. That command is part of the approved Part 1.`);
      },
    };
    await expect(resolveStartReference('some-run', deps)).rejects.toThrow(/no "find-run" command yet/);
  });

  it('a genuine per-reference "could not resolve...to exactly one run" failure (regardless of exit code) is NOT treated as a config error — it still lets later reference forms (project name, etc.) be tried', async () => {
    // Both the Run ID and Run Name attempts fail with audit-agent's own "not resolved" text —
    // this is the pre-existing ambiguous/ask handling this fix must leave untouched; what
    // matters for THIS regression is that it is not mistaken for a config failure and thrown.
    let calls = 0;
    const deps: DiscoveryDeps = {
      auditAgentRepoRoot,
      projectsRoot,
      resolveRun: async (ref) => {
        calls++;
        throw new TerminalError(`audit-agent could not resolve ${'runId' in ref ? `Run ID "${ref.runId}"` : `Run Name "${ref.runName}"`} to exactly one run (find-run exit 1). It said:\nno matches found\n→ pick one of the candidates above, or pass --run-id with the exact Run ID.`);
      },
    };
    const result = await resolveStartReference('nonexistent-thing', deps);
    expect(calls).toBe(2); // BOTH the Run ID and Run Name forms were tried — neither was mistaken for a config failure
    expect(result).toEqual({ kind: 'not-found', message: '"nonexistent-thing" did not resolve as an audit Run ID, an audit Run Name, an audit project, a redesign run id, a dashboard URL, or a folder reference.' });
  });

  it('§regression: a zero-match Run ID/Name lookup (audit-agent prints NO candidate list — the real exit-1 shape) is never misreported as "ambiguous" — §5.1\'s project-name fallback would otherwise be UNREACHABLE, since a typed project name always misses both lookups this same way', async () => {
    // Before this fix, ANY "could not resolve...to exactly one run" message with no printed
    // candidate list was treated as `{ambiguous: [wholeMessage]}` — and resolveStartReference's
    // Run Name step returns immediately on any ambiguous-shaped result, so step 3 (project
    // name, §5.1) was never reached for what is overwhelmingly the common real case.
    mkdirSync(join(auditAgentRepoRoot, 'projects/real-project/runs/the-only-run'), { recursive: true });
    writeFileSync(join(auditAgentRepoRoot, 'projects/real-project/runs/the-only-run/run.json'), JSON.stringify({ displayName: 'The Only Run' }));
    const deps: DiscoveryDeps = {
      auditAgentRepoRoot,
      projectsRoot,
      resolveRun: async (ref) => {
        throw new TerminalError(`audit-agent could not resolve ${'runId' in ref ? `Run ID "${ref.runId}"` : `Run Name "${ref.runName}"`} to exactly one run (find-run exit 1). It said:\nno matches found\n→ pick one of the candidates above, or pass --run-id with the exact Run ID.`);
      },
    };
    const result = await resolveStartReference('real-project', deps);
    expect(result).toEqual({ kind: 'new-run', runRef: { runId: 'the-only-run' }, how: 'resolved as the one run in audit project "real-project" (The Only Run)' });
  });

  it('an ambiguous Run Name (find-run exit 2, with a printed candidate list) still surfaces as `kind: "ambiguous"`, unaffected by the fix', async () => {
    const deps: DiscoveryDeps = {
      auditAgentRepoRoot,
      projectsRoot,
      resolveRun: async (ref) => {
        if ('runId' in ref) throw new TerminalError(`audit-agent could not resolve Run ID "${ref.runId}" to exactly one run (find-run exit 1). It said:\nno matches found`);
        throw new TerminalError(`audit-agent could not resolve Run Name "${ref.runName}" to exactly one run (find-run exit 2). It said:\n  survey-page-audit — Survey Page Audit\n  survey-page-audit-2 — Survey Page Audit (copy)\n→ pick one of the candidates above, or pass --run-id with the exact Run ID.`);
      },
    };
    const result = await resolveStartReference('Survey Page Audit', deps);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toEqual(['survey-page-audit — Survey Page Audit', 'survey-page-audit-2 — Survey Page Audit (copy)']);
    }
  });
});

describe('resolveStartReference — baseline resolution paths (S0, §5.1)', () => {
  it('an empty reference resolves to not-found without ever calling resolveRun', async () => {
    let called = false;
    const deps: DiscoveryDeps = { auditAgentRepoRoot, projectsRoot, resolveRun: async () => { called = true; throw new Error('should never be called'); } };
    const result = await resolveStartReference('   ', deps);
    expect(result).toEqual({ kind: 'not-found', message: 'An empty reference was given — nothing to resolve.' });
    expect(called).toBe(false);
  });

  it('an exact Run ID match resolves as a new-run, without trying the Run Name form', async () => {
    let calls: string[] = [];
    const deps: DiscoveryDeps = {
      auditAgentRepoRoot,
      projectsRoot,
      resolveRun: async (ref) => {
        calls.push('runId' in ref ? `id:${ref.runId}` : `name:${ref.runName}`);
        return { run: resolvedRun({ runId: 'survey-page-audit' }), warnings: [] };
      },
    };
    const result = await resolveStartReference('survey-page-audit', deps);
    expect(result).toEqual({ kind: 'new-run', runRef: { runId: 'survey-page-audit' }, how: 'resolved as an audit Run ID ("survey-page-audit")' });
    expect(calls).toEqual(['id:survey-page-audit']);
  });

  it('a project name with exactly one run resolves automatically to that run (§5.1: "exactly one → proceed automatically")', async () => {
    mkdirSync(join(auditAgentRepoRoot, 'projects/my-project/runs/only-run'), { recursive: true });
    writeFileSync(join(auditAgentRepoRoot, 'projects/my-project/runs/only-run/run.json'), JSON.stringify({ displayName: 'Only Run', targetUrl: 'https://x/only' }));
    const deps: DiscoveryDeps = {
      auditAgentRepoRoot,
      projectsRoot,
      resolveRun: async () => {
        throw new TerminalError('could not resolve Run ID "my-project" to exactly one run (find-run exit 1). It said:\nno matches found');
      },
    };
    const result = await resolveStartReference('my-project', deps);
    expect(result).toEqual({ kind: 'new-run', runRef: { runId: 'only-run' }, how: 'resolved as the one run in audit project "my-project" (Only Run)' });
  });

  it('a project name with several runs asks once, listing every candidate', async () => {
    mkdirSync(join(auditAgentRepoRoot, 'projects/multi-project/runs/run-a'), { recursive: true });
    mkdirSync(join(auditAgentRepoRoot, 'projects/multi-project/runs/run-b'), { recursive: true });
    writeFileSync(join(auditAgentRepoRoot, 'projects/multi-project/runs/run-a/run.json'), JSON.stringify({ displayName: 'Run A' }));
    writeFileSync(join(auditAgentRepoRoot, 'projects/multi-project/runs/run-b/run.json'), JSON.stringify({ displayName: 'Run B' }));
    const deps: DiscoveryDeps = {
      auditAgentRepoRoot,
      projectsRoot,
      resolveRun: async () => {
        throw new TerminalError('could not resolve Run ID "multi-project" to exactly one run (find-run exit 1). It said:\nno matches found');
      },
    };
    const result = await resolveStartReference('multi-project', deps);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.candidates.sort()).toEqual(['run-a — "Run A"', 'run-b — "Run B"']);
  });
});
