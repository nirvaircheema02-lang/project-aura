import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAuditData, resolveAuditRun } from '../../src/audit-link/index.ts';
import { loadConfig } from '../../src/config/index.ts';
import { TerminalError } from '../../src/retry.ts';

/**
 * The linkage to the REAL sibling audit-agent, read-only:
 *  (1) its most recent real run's data.json parses against our read-side S0 contract;
 *  (2) `find-run` is invoked exactly as R1 would invoke it. Until Part 1 lands in
 *      audit-agent that command does not exist — the expected outcome TODAY is the specific
 *      "has no find-run command yet" TERMINAL error, asserted as such rather than hidden.
 * Both skip cleanly on a machine without the sibling repo.
 */

const config = loadConfig(join(import.meta.dirname, '..', '..', 'fix-redesign-agent.config.json'));
const REAL_RUN = join(config.auditAgentRepoRoot, 'projects', 'www.kenresearch.com-survey', 'runs', 'survey-page-audit');
const hasSibling = existsSync(join(config.auditAgentRepoRoot, 'package.json'));

describe('audit-agent linkage (read-only)', () => {
  it('a real data.json parses against the read-side S0 contract, untouched', () => {
    const path = join(REAL_RUN, 'data.json');
    if (!existsSync(path)) return console.warn(`skipped: no real run at ${REAL_RUN}`);
    const bytes = readFileSync(path);
    const data = parseAuditData(JSON.parse(bytes.toString('utf-8')), path);
    expect(data.run.runId).toBe('survey-page-audit');
    expect(data.run.targetUrl).toBe('https://www.kenresearch.com/survey');
    expect(data.findings.length).toBeGreaterThan(0);
    expect(new Set(data.findings.map((f) => f.identity.findingId)).size).toBe(data.findings.length);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it('find-run is reached through audit-agent\'s own CLI; today that is the explicit "Part 1 not landed" error, later a resolved run', async () => {
    if (!hasSibling) return console.warn(`skipped: audit-agent not at ${config.auditAgentRepoRoot}`);
    const outcome = await resolveAuditRun(config.auditAgentRepoRoot, { runId: 'survey-page-audit' }).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    if (outcome.ok) {
      expect(outcome.r.run.runId).toBe('survey-page-audit');
      expect(existsSync(join(outcome.r.run.runDir, 'data.json'))).toBe(true);
    } else {
      expect(outcome.e).toBeInstanceOf(TerminalError);
      expect((outcome.e as Error).message).toMatch(/has no "find-run" command yet/);
      console.warn('find-run not available in audit-agent yet (Part 1 pending) — linkage error surfaced correctly');
    }
  }, 60_000);
});
