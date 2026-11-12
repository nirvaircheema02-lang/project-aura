import { copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeHtmlReport } from '../src/agents/c1-html-reporter/index.ts';
import { projectNameFor, readFixPlan, readRunMeta, runPaths, safeFileName } from '../src/output/run-store.ts';
import type { AuditData } from '../src/agents/c2-json-writer/index.ts';

/**
 * One-off validation utility: regenerate ONLY report.html (+ its friendly-named copy) for an
 * existing run, from that run's already-persisted data.json — no re-audit, no browser, no model
 * call, no Figma. Mirrors figma-plan <runId>'s own "no re-audit" shape, but for the HTML layer
 * specifically. data.json and fix-plan.json are opened for READING only.
 *
 * Usage: node --experimental-strip-types scripts/regenerate-html.ts <runId>
 */
async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error('Usage: node --experimental-strip-types scripts/regenerate-html.ts <runId>');
    process.exitCode = 1;
    return;
  }

  const dataRoot = process.env.AUDIT_AGENT_DATA_DIR ?? process.cwd();
  const projectsRoot = join(dataRoot, 'projects');

  // Find which project this run belongs to (mirrors find-run's own scan, without the CLI ceremony).
  const { listProjects, listRuns } = await import('../src/output/run-store.ts');
  let projectName: string | null = null;
  for (const p of await listProjects(projectsRoot)) {
    if ((await listRuns(projectsRoot, p)).includes(runId)) {
      projectName = p;
      break;
    }
  }
  if (!projectName) {
    console.error(`No run ${runId} found under ${projectsRoot}.`);
    process.exitCode = 1;
    return;
  }

  const paths = runPaths(projectsRoot, projectName, runId);
  if (!existsSync(paths.dataJson)) {
    console.error(`No data.json for run ${runId} at ${paths.dataJson}.`);
    process.exitCode = 1;
    return;
  }

  const data = JSON.parse(await readFile(paths.dataJson, 'utf-8')) as AuditData;
  const fixPlan = await readFixPlan(paths, runId);
  const meta = await readRunMeta(paths, runId);

  const result = await writeHtmlReport(paths, projectName, data, { fixPlan });

  // Same friendly-named-copy convention the CLI itself uses — never a rename, always a copy.
  const base = safeFileName(meta.displayName) || 'report';
  const friendlyHtml = join(paths.runDir, `${base}.html`);
  await copyFile(paths.reportHtml, friendlyHtml);

  console.log(`Run ${runId} · ${projectName}`);
  console.log(`data.json:    ${paths.dataJson}  (read only, untouched)`);
  console.log(`fix-plan.json: ${paths.fixPlanJson}  (read only, untouched — ${fixPlan.entries.length} decision(s) seeded)`);
  console.log(`report.html:  ${paths.reportHtml}  (${result.htmlBytes} bytes${result.zipBytes !== null ? `, + report-package.zip fallback (${result.zipBytes} bytes)` : ''})`);
  if (result.missingRefs.length > 0) console.log(`missing evidence refs (reported, not faked): ${result.missingRefs.length}`);
  console.log(`friendly copy: ${friendlyHtml}`);
}

main();
