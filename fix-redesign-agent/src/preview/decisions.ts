import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { DesignDecisionsFile } from './types.ts';

/** Reads `context/design-decisions.json` (authored per-finding decisions and section overrides). Shared by the Resolver and the preview generator. */
export async function readDesignDecisions(path: string): Promise<DesignDecisionsFile | null> {
  if (!existsSync(path)) return null;
  const j = JSON.parse(await readFile(path, 'utf8')) as Partial<DesignDecisionsFile>;
  if (j.schemaVersion !== 1 || typeof j.findings !== 'object' || j.findings === null) throw new Error(`${path} is not a design-decisions file (expected { "schemaVersion": 1, "findings": { … }, "overrides"?: { … } })`);
  return j as DesignDecisionsFile;
}
