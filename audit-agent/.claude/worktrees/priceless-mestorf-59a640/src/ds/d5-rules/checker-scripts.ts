import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workspaceCheckerScripts } from '../d1-reader/paths.ts';
import { finding, type DSFinding } from '../findings.ts';

const execFileAsync = promisify(execFile);

/**
 * D5 Track A (IMPLEMENTATION-PLAN.md §4): "lift six already-executable
 * rule-checkers directly into the audit agent." These are read-only lint
 * scripts (verified: no writes to the DS) — run as child processes exactly
 * as the DS's own tooling would (`node scripts/check-tokens.mjs`), never
 * copied or reimplemented. Output format varies per script (verified by
 * actually running all 6, 2026-09-11) — this captures a common shape
 * rather than assuming one, and flags the one script that is a stub.
 *
 * Real bug found and fixed during this build: `check-tokens.mjs` and
 * `verify-css-vars.mjs` write their entire report to STDERR, not stdout
 * (confirmed empirically — stdout length 0, stderr length 33176 for
 * check-tokens.mjs's real failing run). Capturing stdout alone silently
 * lost their entire result. Both streams are captured and combined below.
 */

export interface CheckerScriptResult {
  name: string;
  scriptPath: string;
  exitCode: number;
  passed: boolean;
  /** True if the script's own output says it's an unimplemented stub — passed=true here does NOT mean "0 violations." */
  isStub: boolean;
  summaryLine: string | null;
  /** Combined stdout+stderr — several of these scripts report exclusively via stderr; see module note. */
  output: string;
}

const SCRIPTS: Array<{ name: string; key: keyof ReturnType<typeof workspaceCheckerScripts> }> = [
  { name: 'check-tokens', key: 'checkTokens' },
  { name: 'check-components', key: 'checkComponents' },
  { name: 'check-font-scale', key: 'checkFontScale' },
  { name: 'check-ink-roles', key: 'checkInkRoles' },
  { name: 'verify-css-vars', key: 'verifyCssVars' },
  { name: 'lint-section-alternation', key: 'lintSectionAlternation' },
];

function extractSummaryLine(output: string): string | null {
  const lines = output.split('\n');
  return (
    lines.find((l) => /(FAIL|PASS)\s*·/.test(l.trim())) ??
    lines.find((l) => l.includes('✅') || l.includes('violations')) ??
    null
  );
}

async function runOne(name: string, scriptPath: string, cwd: string): Promise<CheckerScriptResult> {
  let output = '';
  let exitCode = 0;
  try {
    const result = await execFileAsync('node', [scriptPath], { cwd, maxBuffer: 10 * 1024 * 1024 });
    output = result.stdout + result.stderr;
  } catch (err) {
    // Checker scripts exit non-zero on violations found — that's a normal
    // "FAIL" result, not a tooling error. Still capture output either way.
    const e = err as { stdout?: string; stderr?: string; code?: number };
    output = (e.stdout ?? '') + (e.stderr ?? '');
    exitCode = typeof e.code === 'number' ? e.code : 1;
  }
  const isStub = /STUB|not yet implement/i.test(output);
  return {
    name,
    scriptPath,
    exitCode,
    passed: exitCode === 0,
    isStub,
    summaryLine: extractSummaryLine(output),
    output,
  };
}

export async function runCheckerScripts(designSystemPath: string): Promise<{ results: CheckerScriptResult[]; findings: DSFinding[] }> {
  const paths = workspaceCheckerScripts(designSystemPath);
  const results = await Promise.all(SCRIPTS.map((s) => runOne(s.name, paths[s.key], paths.workspaceRoot)));

  const findings: DSFinding[] = [];
  for (const r of results) {
    if (r.isStub) {
      findings.push(
        finding({
          module: 'D5',
          severity: 'warning',
          summary: `${r.name} is a stub, not a real check — its exit code (${r.exitCode}) does not mean "0 violations"`,
          detail: `Output: "${r.output.trim().split('\n')[0]}". Do not treat this script's pass/fail as a real signal until it's actually implemented upstream.`,
          sources: [r.scriptPath],
        }),
      );
    } else if (!r.passed) {
      findings.push(
        finding({
          module: 'D5',
          severity: 'info',
          summary: `${r.name}: real, pre-existing violations in the DS (not introduced by this audit agent)`,
          detail: r.summaryLine ?? `Exit code ${r.exitCode}, see full output for detail.`,
          sources: [r.scriptPath],
        }),
      );
    }
  }
  return { results, findings };
}
