import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Identity of the code that decides what the dashboard SHOWS. The dashboard
 * is a long-running detached server (Decision Log #20), so an instance
 * started before a code change keeps serving the old rendering — e.g. a
 * not-compared component shown as a plain MATCH. The launcher compares this
 * id with the running server's and restarts a stale one instead of reusing it.
 */
const RENDERING_FILES = [
  'src/dashboard/server.ts',
  'src/dashboard/views/render.ts',
  'src/output/reading-order.ts',
  'src/agents/c2-json-writer/index.ts',
  'src/skills/s0-result-contract.ts',
  'src/graph/run-metadata.ts',
];

export function dashboardBuildId(repoRoot = join(import.meta.dirname, '..', '..')): string {
  const hash = createHash('sha256');
  for (const file of RENDERING_FILES) hash.update(file).update(readFileSync(join(repoRoot, file)));
  return hash.digest('hex').slice(0, 16);
}
