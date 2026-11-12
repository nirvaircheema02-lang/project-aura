import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { judgmentBundlePath, judgmentResultPath, type RedesignPaths } from '../output/redesign-store.ts';
import type { JudgmentResultFile, PendingJudgmentBundle } from './types.ts';

/** One row of `judgment status` — a bundle a judgment node wrote, and whether it's been answered yet. */
export interface JudgmentBundleStatus {
  bundleId: string;
  nodeId: string;
  createdAt: string;
  submitted: boolean;
}

/** Every bundle ever written for this run, oldest first — `judgment status`'s listing. */
export async function listJudgmentBundles(paths: Pick<RedesignPaths, 'judgmentsDir'>): Promise<JudgmentBundleStatus[]> {
  if (!existsSync(paths.judgmentsDir)) return [];
  const files = (await readdir(paths.judgmentsDir)).filter((f) => f.endsWith('.bundle.json'));
  const rows: JudgmentBundleStatus[] = [];
  for (const f of files) {
    const bundle = JSON.parse(await readFile(`${paths.judgmentsDir}/${f}`, 'utf8')) as PendingJudgmentBundle;
    rows.push({ bundleId: bundle.bundleId, nodeId: bundle.nodeId, createdAt: bundle.createdAt, submitted: existsSync(judgmentResultPath(paths, bundle.bundleId)) });
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function readJudgmentBundle(paths: Pick<RedesignPaths, 'judgmentsDir'>, bundleId: string): Promise<PendingJudgmentBundle | null> {
  const p = judgmentBundlePath(paths, bundleId);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, 'utf8')) as PendingJudgmentBundle;
}

export async function writeJudgmentResult(paths: Pick<RedesignPaths, 'judgmentsDir'>, bundleId: string, nodeId: string, data: unknown, now: () => Date = () => new Date()): Promise<void> {
  const result: JudgmentResultFile = { schemaVersion: 1, bundleId, nodeId, submittedAt: now().toISOString(), data };
  await writeFile(judgmentResultPath(paths, bundleId), JSON.stringify(result, null, 2));
}

/** The one pending (unsubmitted) bundle, when exactly one exists — the "unambiguous, proceed automatically" case `judgment show`/`judgment submit` use when no `--bundle` is given (ARCHITECTURE.md §5.1's own precedent). */
export function onlyPendingBundle(rows: JudgmentBundleStatus[]): JudgmentBundleStatus | null {
  const pending = rows.filter((r) => !r.submitted);
  return pending.length === 1 ? pending[0]! : null;
}
