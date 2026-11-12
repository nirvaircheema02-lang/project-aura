/**
 * `audit-link/` is the ONLY place this repo touches audit-agent, and it is read-only in
 * every direction: run resolution through audit-agent's own CLI (`find-run.ts`) and
 * read-side copies of the two artifact contracts a run folder supplies (`data.json`,
 * `fix-plan.json`). Nothing here writes into audit-agent's tree, database, or Figma
 * outputs — ARCHITECTURE.md Q10/Q11.
 */
export * from './find-run.ts';
export * from './finding-schema.ts';
export * from './audit-data-schema.ts';
export * from './fix-plan-schema.ts';
export { parseWith } from './parse.ts';
