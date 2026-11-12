import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditProperty, Finding } from '../../src/audit-link/index.ts';
import { classifyProperty } from '../../src/resolution/ds-evidence.ts';
import { resolveTargets } from '../../src/resolution/resolve.ts';

/**
 * The two real audit runs the brief names are used READ-ONLY, as data: their `data.json` is parsed and every per-property record is
 * classified. Neither run has a reviewed `fix-plan.json`, so nothing here selects findings, records a decision or starts a redesign —
 * the resolver is run in memory on isolated copies only to prove that the real "Not resolved" shapes are all understood, and that none
 * of them becomes a change merely because a value is absent. Skipped when the runs are not on this machine.
 */

const ROOT = '/Users/sachin/Project-aura/audit-agent/projects';
const RUNS = [
  { name: 'cndp-survey-page', dir: join(ROOT, 'www.kenresearch.com-cndp-survey/runs/cndp-survey-page') },
  { name: 'dealers-voice-survey-page-audit-v2', dir: join(ROOT, 'www.kenresearch.com-dealers-voice-survey/runs/dealers-voice-survey-page-audit-v2') },
].filter((r) => existsSync(join(r.dir, 'data.json')));

const mtimes = (dir: string) => Object.fromEntries(readdirSync(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs]));

describe.skipIf(RUNS.length === 0)('real audit runs (read-only)', () => {
  for (const run of RUNS) {
    describe(run.name, () => {
      const before = mtimes(run.dir);
      const data = JSON.parse(readFileSync(join(run.dir, 'data.json'), 'utf8')) as { findings: Finding[] };
      const findings = data.findings;
      const props = findings.flatMap((f) => (f.comparison.properties ?? []).map((p) => ({ f, p })));
      const ctx = (f: Finding) => ({ findingClassification: f.classification, dsComponent: f.component.dsComponent, dsVariant: f.component.dsVariant, surface: 'light' as const });

      it('has no reviewed fix-plan.json, so no decision is made or implied', () => {
        expect(existsSync(join(run.dir, 'fix-plan.json'))).toBe(false);
        expect(props.length).toBeGreaterThan(1000);
      });

      it('every per-property record classifies; only an audit-measured expectation is ever changeable', () => {
        const reasons: Record<string, number> = {};
        for (const { f, p } of props) {
          const c = classifyProperty(p as AuditProperty, ctx(f));
          reasons[c.reason] = (reasons[c.reason] ?? 0) + 1;
          // changeable means evidence exists: the audit measured an expectation, or the DS's own value is named in the note together with its source file
          // (still resolved only by a rendered measurement), or a DS token is named. An observed value with no requirement is never changeable.
          if (c.changeable) {
            const measured = p.status === 'DIFFERENT' && p.expected !== null;
            const dsValueNamed = c.reason === 'layout-measurement-required' && c.expectedFromNote !== null && p.source !== null;
            const dsTokenNamed = c.reason === 'variant-or-theme-context' && c.tokenFromNote !== null;
            expect(measured || dsValueNamed || dsTokenNamed, `${p.property}: ${p.note}`).toBe(true);
          }
          if (p.status === 'UNRESOLVED' && /no verified DS requirement/i.test(p.note ?? '')) expect(c.changeable, `${p.property}: ${p.note}`).toBe(false);
        }
        console.info(`[${run.name}] ${props.length} properties → ${JSON.stringify(reasons)}`);
        // the three shapes that used to read "Not resolved" are all understood — none falls through to a capture gap
        const unresolved = props.filter(({ p }) => p.status === 'UNRESOLVED');
        const gaps = unresolved.filter(({ f, p }) => classifyProperty(p as AuditProperty, ctx(f)).reason === 'capture-capability-gap');
        expect(gaps.map(({ p }) => p.note)).toEqual([]);
      });

      it('the Resolver, run in memory on isolated copies, never turns an absent expectation into a change', async () => {
        // an isolated copy, limited to findings with unresolved properties, none of them selected by a person: this is analysis, not a run
        const sample = structuredClone(findings.filter((f) => (f.comparison.properties ?? []).some((p) => p.status === 'UNRESOLVED'))).slice(0, 120);
        const { file } = await resolveTargets(
          { page: null, dsIndex: null, dsRegistryVersion: null, decisions: null, reference: null },
          { run: { runId: run.name, projectName: 'read-only-example', dataJsonSha256: null, fixPlanSha256: null }, findings: sample, entries: [] },
        );
        const byOutcome: Record<string, number> = {};
        for (const t of file.targets) byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
        console.info(`[${run.name}] ${sample.length} sampled findings → ${JSON.stringify(byOutcome)}`);
        for (const t of file.targets) {
          if (t.audit.status === 'UNRESOLVED') {
            // with no page and no DS index nothing could be measured, so nothing may be a target
            expect(t.outcome, `${t.property}: ${t.audit.note}`).not.toBe('resolved-target');
          }
          if (t.outcome === 'resolved-target') expect(t.audit.expected, t.property).not.toBeNull();
        }
        expect(file.targets.every((t) => t.status.verification === 'not-run')).toBe(true);
      });

      it('the audit run is left untouched', () => {
        expect(mtimes(run.dir)).toEqual(before);
      });
    });
  }
});
