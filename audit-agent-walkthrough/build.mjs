import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pageGraph, siteGraph } from './graphs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, 'audit-agent');
// The 8 Oct guide used dealers-voice-survey-page-audit-v2 (engine r9); that run was removed from the repository, so the
// same three teaching examples are taken from v3 (engine r10): the heading finding keeps its finding id.
const runPath = 'projects/www.kenresearch.com-dealers-voice-survey/runs/dealers-voice-survey-page-audit-v3/data.json';
const raw = await readFile(resolve(repo, runPath), 'utf8');
const audit = JSON.parse(raw);
const selected = [
  audit.findings.find(f => f.identity.findingId === '6d87d2e1bf5fcae0e0399ae9fdbcbe24'),
  audit.findings.find(f => f.component.productionLabel === 'ABOUT KEN SURVEY'),
  audit.findings.find(f => f.classification === 'NEEDS_REVIEW' && f.location.region === 'page-content' && f.quality.evidence.some(e => e.kind === 'context-screenshot')),
];
if (selected.some(f => !f)) throw new Error('The three expected teaching examples are not available.');
const scrub = value => JSON.parse(JSON.stringify(value).replaceAll(root + '/', ''));
const findings = [];
for (const f of selected) {
  const pictures = {};
  for (const kind of ['context-screenshot', 'element-screenshot']) {
    const e = f.quality.evidence.find(e => e.kind === kind);
    if (e) pictures[kind] = 'data:image/png;base64,' + (await readFile(e.ref)).toString('base64');
  }
  findings.push({ ...scrub(f), pictures });
}
const sources = {};
const excerpts = {
  'src/agents/page-graph.ts': [28, 128],
  'src/agents/site-graph.ts': [73, 199],
  'src/graph/engine.ts': [97, 205],
  'src/config/schema.ts': [47, 70],
  'src/ds/d2-registry/index.ts': [1, 55],
  'src/agents/b7-coverage-qa/correct.ts': [42, 61],
  'src/graph/retry.ts': [1, 74],
  'src/agents/b3-ds-matcher/reference.ts': [1, 48],
  'src/agents/b6-new-component-evaluator/evaluate.ts': [178, 298],
  'src/ds/reference-patterns.ts': [100, 155],
  'src/llm/provider.ts': [5, 67],
  'src/node-id.ts': [1, 40],
  'src/ds/d1-reader/index.ts': [1, 45],
  'src/skills/s0-result-contract.ts': [307, 357],
  'src/skills/s3-component-taxonomy.ts': [1, 90],
  'src/skills/s5-compliance-classification.ts': [1, 65],
  'src/skills/s7-audit-state-history.ts': [1, 70],
  'src/skills/s8-confidence-escalation-policy.ts': [1, 75],
  'src/skills/s9-registry-update-governance.ts': [1, 85],
  'src/skills/contextual-recommendations.ts': [1, 65],
  'src/skills/nearest-typography.ts': [1, 70],
  '.claude/skills/audit-run/SKILL.md': [1, 47],
  '.claude/skills/audit-recommendation/SKILL.md': [1, 55],
  '.claude/skills/fix-plan-review/SKILL.md': [1, 95],
  'src/graph/run-metadata.ts': [1, 38],
  'reference/README.md': [1, 32],
  'package.json': [1, 90],
  'docs/FIGMA-PUBLISH-RUNBOOK.md': [1, 65],
};
delete excerpts['src/node-id.ts'];
for (const [path, range] of Object.entries(excerpts)) {
  const content = await readFile(resolve(repo, path), 'utf8');
  const lines = content.split('\n');
  sources[path] = { start: range[0], content: lines.slice(range[0] - 1, range[1]).join('\n'), sha256: createHash('sha256').update(content).digest('hex') };
}
// Facts that used to be typed by hand are read from the code, so a rebuild cannot print a stale revision or date.
const now = new Date();
const snapshotLong = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const snapshotShort = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const grab = async (file, pattern, label) => {
  const match = pattern.exec(await readFile(resolve(repo, file), 'utf8'));
  if (!match) throw new Error(`Could not read the ${label} from ${file}.`);
  return match[1];
};
const engineRevision = await grab('src/graph/run-metadata.ts', /AUDIT_ENGINE_REVISION\s*=\s*(\d+)/, 'engine revision');
const templateVersion = await grab('src/dashboard/views/render.ts', /HTML_TEMPLATE_VERSION\s*=\s*'(html-report-v\d+)'/, 'report template version');
const runEngine = /engine-r(\d+)/.exec(audit.run.policyVersion ?? '')?.[1] ?? 'unknown';
const data = {
  snapshotDate: snapshotLong, engineRevision, templateVersion, runEngine, run: audit.run, runPath, findings,
  runHash: createHash('sha256').update(raw).digest('hex'),
  page: audit.pageSummary[0], sections: audit.sections,
  coverage: audit.coverageSummary.gate,
  reference: JSON.parse(await readFile(resolve(repo, 'reference/approved-reference-patterns.json'), 'utf8')),
  sources,
};
const screenshotMismatch = audit.findings.find(f => f.component.productionLabel === 'Dealer Insights Dashboard');
data.evidenceCaution = {
  findingId: screenshotMismatch.identity.findingId,
  label: screenshotMismatch.component.productionLabel,
  note: 'Saved finding label is Dealer Insights Dashboard, but its attached element screenshot visibly shows a Ken Research / Overview bar. The screenshot does not establish the claimed heading identity. Measurements remain the saved run’s claims; this guide does not re-verify that mapping.',
  picture: 'data:image/png;base64,' + (await readFile(screenshotMismatch.quality.evidence.find(e => e.kind === 'element-screenshot').ref)).toString('base64'),
};
const template = await readFile(resolve(here, 'guide.template.html'), 'utf8');
const config = JSON.parse(await readFile(resolve(repo, 'audit-agent.config.json'), 'utf8'));
const dsTokens = await readFile(resolve(config.designSystemPath, 'tokens/build/tokens.css'), 'utf8');
const font = (await readFile(resolve(here, 'assets/dm-sans-latin.woff2'))).toString('base64');
const fontCss = `@font-face{font-family:'DM Sans';font-style:normal;font-weight:100 1000;font-display:swap;src:url(data:font/woff2;base64,${font}) format('woff2')}`;
const tokens = { SNAPSHOT_LONG: snapshotLong, SNAPSHOT_SHORT: snapshotShort, ENGINE_REV: engineRevision, TEMPLATE_VERSION: templateVersion, RUN_ID: audit.run.runId, RUN_ENGINE: runEngine };
let filled = template;
for (const [key, value] of Object.entries(tokens)) filled = filled.replaceAll(`{{${key}}}`, String(value));
if (/\{\{[A-Z_]+\}\}/.test(filled)) throw new Error('The template still has an unfilled {{TOKEN}}.');
const output = filled
  .replace('/*__DS_TOKENS__*/', dsTokens)
  .replace('/*__DS_FONTS__*/', fontCss)
  .replace('<!--__PAGE_GRAPH__-->', pageGraph)
  .replace('<!--__SITE_GRAPH__-->', siteGraph)
  .replace('/*__SNAPSHOT__*/', JSON.stringify(data).replaceAll('<', '\\u003c'));
await mkdir(resolve(here, 'dist'), { recursive: true });
await writeFile(resolve(here, 'dist/index.html'), output);
console.log(`Built ${relative(root, resolve(here, 'dist/index.html'))} (${Math.round(Buffer.byteLength(output) / 1024)} KB); ${findings.length} real findings, ${Object.keys(sources).length} source excerpts.`);
