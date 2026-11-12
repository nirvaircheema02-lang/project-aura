import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAuditData, type Finding } from '../audit-link/index.ts';
import type { CrossRunBasis, CrossRunSighting } from './schema.ts';

/**
 * §6/Decision Log #23 — cross-run evidence: read-only over every OTHER audit run under
 * `auditAgentRepoRoot`'s documented `projects/<p>/runs/<r>` layout, the same recorded
 * exception to Decision Log #3 that `session/discovery.ts`'s project-name resolution uses.
 * Matched strongest-basis-first; the basis is always shown, never hidden behind a bare score.
 */

/** Every OTHER run's `data.json` path under `auditAgentRepoRoot`, excluding the current one. */
export function findOtherRunDataJsonPaths(auditAgentRepoRoot: string, excludeRunId: string): string[] {
  const projectsDir = join(auditAgentRepoRoot, 'projects');
  if (!existsSync(projectsDir)) return [];
  const out: string[] = [];
  for (const project of readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const runsDir = join(projectsDir, project.name, 'runs');
    if (!existsSync(runsDir)) continue;
    for (const run of readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      if (run.name === excludeRunId) continue;
      const dataJsonPath = join(runsDir, run.name, 'data.json');
      if (existsSync(dataJsonPath)) out.push(dataJsonPath);
    }
  }
  return out;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let overlap = 0;
  for (const x of sa) if (sb.has(x)) overlap++;
  return overlap / new Set([...sa, ...sb]).size;
}

function classesOf(f: Finding): string[] {
  return (f.review?.signals ?? []).filter((s) => s.startsWith('class=')).map((s) => s.slice(6));
}

export interface CrossRunMatchInput {
  productionType: string;
  dsComponent: string | null;
  dsVariant: string | null;
  classes: string[];
  normalizedLabel: string;
}

function matchBasis(target: CrossRunMatchInput, candidate: Finding): { basis: CrossRunBasis; score: number } | null {
  if (target.dsComponent && candidate.component.dsComponent === target.dsComponent && candidate.component.dsVariant === target.dsVariant) {
    return { basis: 'ds-match', score: 1 };
  }
  if (candidate.component.productionType !== target.productionType) return null;
  const classScore = jaccard(target.classes, classesOf(candidate));
  if (target.classes.length > 0 && classScore >= 0.6) return { basis: 'signals', score: classScore };
  const candidateLabel = candidate.component.productionLabel.trim().toLowerCase();
  if (target.normalizedLabel.length > 0 && candidateLabel === target.normalizedLabel) return { basis: 'label', score: 0.7 };
  return { basis: 'type-only', score: 0.3 };
}

/** Every sighting of a pattern (by production type/DS match/class fingerprint/label) across the OTHER runs given. */
export async function findCrossRunSightings(otherRunDataJsonPaths: string[], target: CrossRunMatchInput): Promise<CrossRunSighting[]> {
  const sightings: CrossRunSighting[] = [];
  for (const path of otherRunDataJsonPaths) {
    let data;
    try {
      data = parseAuditData(JSON.parse(await readFile(path, 'utf-8')), path);
    } catch {
      continue; // an unreadable/invalid other-run file is skipped, never fatal to this run's own manifest
    }
    const matchedFindingIds: string[] = [];
    let bestBasis: CrossRunBasis = 'type-only';
    let bestScore = 0;
    for (const f of data.findings) {
      const m = matchBasis(target, f);
      if (!m) continue;
      matchedFindingIds.push(f.identity.findingId);
      if (rank(m.basis) < rank(bestBasis) || (rank(m.basis) === rank(bestBasis) && m.score > bestScore)) {
        bestBasis = m.basis;
        bestScore = m.score;
      }
    }
    if (matchedFindingIds.length > 0) {
      sightings.push({ runId: data.run.runId, displayName: data.run.runId, url: data.run.targetUrl, findingIds: matchedFindingIds, basis: bestBasis, score: bestScore });
    }
  }
  return sightings;
}

const BASIS_RANK: Record<CrossRunBasis, number> = { 'ds-match': 0, signals: 1, label: 2, 'type-only': 3 };
function rank(b: CrossRunBasis): number {
  return BASIS_RANK[b];
}
