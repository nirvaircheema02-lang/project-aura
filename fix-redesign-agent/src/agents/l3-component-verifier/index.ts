import type { Page } from 'playwright';
import type { ComponentSpec, L3Output } from '../../library/types.ts';
import type { Affordances } from '../../mapping/types.ts';
import { runDsChecks, storiesFilePresent } from './ds-checks.ts';
import { runAcceptanceChecks } from './acceptance.ts';

/**
 * L3 — Component Verifier (hybrid, §9.4). Deterministic half: the DS repo's OWN typecheck /
 * lint / verify scripts, run for real, plus §9.5's acceptance checks against a REAL reference
 * element on a live page.
 *
 * SCOPED LIMITATION, stated plainly rather than faked: rendering the newly-generated,
 * isolated `.tsx` file itself requires the DS's own bundler/Storybook pipeline, which this
 * system does not invoke automatically (no dev server is started, no playground entry is
 * generated). The per-variant vision comparison this node's contract names is therefore
 * `NOT_CHECKED` here — never silently reported as CONFIRMED. What IS checked for real is the
 * DS repo's own tooling (a genuine compile/lint signal on the generated code) and the
 * acceptance checks against the corrected reference element already live on the page.
 */

export const L3_STATUS = 'implemented' as const;

export interface L3Deps {
  dsRepoPath: string;
  page: Page | null;
  viewports: Array<{ width: number; height: number }>;
  capturedViewport: { width: number; height: number };
  captureStates: Array<'hover' | 'focus' | 'active' | 'disabled'>;
  log?: (line: string) => void;
}

export async function runL3(deps: L3Deps, spec: ComponentSpec, referenceSelector: string | null, referenceAffordances: Affordances | null): Promise<L3Output> {
  const log = deps.log ?? (() => {});
  const ds = await runDsChecks(deps.dsRepoPath);
  const storiesFile = spec.writeSet.find((f) => f.endsWith('.stories.tsx'));
  const storyPresence = storiesFile ? storiesFilePresent(deps.dsRepoPath, storiesFile.replace(/^core-v2\/src\//, '')) : { ok: false, detail: 'no stories file in this spec\'s write set' };

  const acceptance = referenceSelector && referenceAffordances && deps.page
    ? await runAcceptanceChecks({ page: deps.page, selector: referenceSelector, affordances: referenceAffordances, viewports: deps.viewports, capturedViewport: deps.capturedViewport, captureStates: deps.captureStates })
    : [];

  const dsChecksOk = ds.typecheck.ok && ds.lint.ok && ds.verify.ok && storyPresence.ok;
  const failedChecks: string[] = [];
  if (!ds.typecheck.ok) failedChecks.push(`typecheck: ${ds.typecheck.detail.split('\n')[0]}`);
  if (!ds.lint.ok) failedChecks.push(`lint: ${ds.lint.detail.split('\n')[0]}`);
  if (!ds.verify.ok) failedChecks.push(`verify: ${ds.verify.detail.split('\n')[0]}`);
  if (!storyPresence.ok) failedChecks.push(`story: ${storyPresence.detail}`);
  for (const a of acceptance) if (!a.passed && a.evidenceClass === 'observed') failedChecks.push(`${a.area}/${a.check}: ${a.detail}`);

  const anyProposed = acceptance.some((a) => a.evidenceClass === 'proposed');
  const anyMissingEvidence = acceptance.some((a) => a.evidenceClass === 'missing-evidence');
  const allObservedPass = acceptance.filter((a) => a.evidenceClass === 'observed').every((a) => a.passed);

  const status: L3Output['status'] = !dsChecksOk ? 'FAIL' : anyProposed || anyMissingEvidence ? 'PARTIAL' : allObservedPass ? 'PASS' : 'FAIL';
  log(`L3 · ${spec.componentId} · DS checks ${dsChecksOk ? 'ok' : 'FAILED'} · ${acceptance.length} acceptance check(s) · ${status}`);

  return {
    componentId: spec.componentId,
    dsChecks: { typecheck: ds.typecheck.ok, lint: ds.lint.ok, verify: ds.verify.ok, storyBuild: storyPresence.ok, detail: [ds.typecheck.detail, ds.lint.detail, ds.verify.detail, storyPresence.detail].filter((d) => d !== 'ok' && d !== 'present') },
    acceptance,
    visionVerdict: 'NOT_CHECKED',
    status,
    failedChecks,
    usage: null,
  };
}
