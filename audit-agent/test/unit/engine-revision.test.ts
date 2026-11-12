import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AUDIT_ENGINE_REVISION, ENGINE_REVISION_LOG, ENGINE_SOURCE_FILES, S8_POLICY_TAG, policyVersionFor } from '../../src/graph/run-metadata.ts';
import type { RenderingPolicy } from '../../src/t-layer/browser.ts';

/**
 * The audit ENGINE revision (Decision Log #39). A full-site run reuses a page's previous findings
 * only while the page's DOM, the Design System AND the policy version are unchanged — so the policy
 * version has to change whenever what B1–B7 detect, match, compare, account for or report changes. This file is
 * what makes that impossible to forget:
 *
 *   1. `policyVersionFor` carries the revision (the part full-site reuse and S7 compare);
 *   2. every revision has a one-line entry in `ENGINE_REVISION_LOG` saying what it changed;
 *   3. the engine sources are FINGERPRINTED below. Editing one fails this test until a human has
 *      looked at it and decided one of two things:
 *        - it changes what an audit reports → bump `AUDIT_ENGINE_REVISION` in
 *          src/graph/run-metadata.ts, add its `ENGINE_REVISION_LOG` line, set `PINNED_REVISION`
 *          to the new number and re-pin;
 *        - it does not (a refactor, a rename, a performance change) → re-pin only.
 *      Comments, JSDoc, whitespace and formatting never count: the fingerprint is of the file's
 *      code tokens.
 *
 * Re-pinning is a deliberate act, never a way to make the suite green. The failure message prints
 * the paste-ready map.
 */

const PINNED_REVISION = 12;
const PINNED: Readonly<Record<string, string>> = {
  "src/agents/b1-page-analyzer/deterministic.ts": "6bccfd7b815a3678",
  "src/agents/b1-page-analyzer/index.ts": "c4c9184c1c17c60f",
  "src/agents/b2-component-detector/deterministic.ts": "cd3108f00bb49ed2",
  "src/agents/b2-component-detector/index.ts": "6ed531a1117d5678",
  "src/agents/b3-ds-matcher/deterministic.ts": "66696d95e99803b8",
  "src/agents/b3-ds-matcher/index.ts": "90d172f11e42efb2",
  "src/agents/b4-compliance-auditor/foundation-rules.ts": "5b1df6405ad9f0fb",
  "src/agents/b4-compliance-auditor/index.ts": "0a5af3e36a7bdc9c",
  "src/agents/b5-visual-verifier/completeness.ts": "b874901b33a8ad44",
  "src/agents/b5-visual-verifier/index.ts": "fbf64855b6b26ade",
  "src/agents/b6-new-component-evaluator/evaluate.ts": "1531954a1ccf2a4b",
  "src/agents/b6-new-component-evaluator/index.ts": "958455089f37dd80",
  "src/agents/b6-new-component-evaluator/post-fix-opportunity.ts": "7d393b3dc2b96ea4",
  "src/skills/nearest-typography.ts": "beec95c55a783df7",
  "src/skills/s3-component-taxonomy.ts": "c5dacecf7969f3e2",
  "src/skills/s5-compliance-classification.ts": "2d77a5b5dbe6ed6d",
  "src/skills/s8-confidence-escalation-policy.ts": "8c4ec62e6feefed0",
  "src/skills/contextual-recommendations.ts": "2e74443ab1707bf8",
  "src/t-layer/element-registry.ts": "1c05f374e4c6d9aa",
  "src/t-layer/section-label.ts": "99ac6528734ac47c",
  "src/t-layer/token-comparator.ts": "21df155b043a3e78",
  "src/t-layer/dom-facts.ts": "9e6b7ef2ae650379",
  "src/t-layer/computed-style.ts": "1f3103629d1c0b1a",
  "src/ds/component-styles.ts": "877d6bbb5e4d3702",
  "src/ds/context-models.ts": "ada5c5ece57fe400",
  "src/agents/b3-ds-matcher/reference.ts": "261d6965feea065e",
  "src/agents/b7-coverage-qa/index.ts": "b087be58c77d01d3",
  "src/agents/b7-coverage-qa/manifest.ts": "72a154ab9bda3607",
  "src/agents/b7-coverage-qa/reconcile.ts": "5855b3a7650d90e4",
  "src/agents/b7-coverage-qa/ownership.ts": "af0083d697cc6e32",
  "src/agents/b7-coverage-qa/identity.ts": "1af1267ac4c81a48",
  "src/agents/b7-coverage-qa/regions.ts": "355c111c2c259412",
  "src/agents/b7-coverage-qa/correct.ts": "da2547913260910b",
  "src/agents/b7-coverage-qa/ledger.ts": "533ba358bc8e46c1",
  "src/agents/b7-coverage-qa/states.ts": "14a59a8469e5a80a",
  "src/ds/reference-patterns.ts": "b2966a0eadc085e2",
  "reference/approved-reference-patterns.json": "059b80604ca976ad"
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rendering = { channel: 'chromium', browserVersion: '141.0.7390.37', playwrightVersion: '1.63.0' } as RenderingPolicy;

/** Every code token of a parsed file, in order — comments, JSDoc and whitespace are not tokens. */
function tokensOf(node: ts.Node, file: ts.SourceFile, out: string[]): void {
  if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
  const children = node.getChildren(file);
  if (children.length === 0) out.push(node.getText(file));
  else for (const child of children) tokensOf(child, file, out);
}

/** What a source SAYS: its token stream. Only a real edit moves it — never a comment, a blank line or a reformat. */
function fingerprintSource(source: string, name = 'source.ts'): string {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const tokens: string[] = [];
  tokensOf(file, file, tokens);
  return createHash('sha256').update(tokens.join('\u0000')).digest('hex').slice(0, 16);
}

/** A source file's fingerprint; the approved reference evidence (JSON) is fingerprinted by its parsed content, never its layout. */
const fingerprintOf = (path: string): string => {
  const text = readFileSync(join(root, path), 'utf8');
  return path.endsWith('.json') ? createHash('sha256').update(JSON.stringify(JSON.parse(text))).digest('hex').slice(0, 16) : fingerprintSource(text, path);
};

describe('the fingerprint measures code, nothing else', () => {
  const base = `/** the limit */\nexport const LIMIT = 5; // five\nexport function f(a: number): string {\n  return \`https://x/\${a * LIMIT}\`;\n}\nexport const RE = /^a\\/\\/b$/;\n`;

  it('ignores comments, JSDoc, blank lines and layout', () => {
    const reformatted = `// something else entirely\nexport const LIMIT = 5;\n\n\n/* block */ export function f(\n  a: number\n): string {\n  // note\n  return \`https://x/\${a * LIMIT}\`;\n}\n\nexport const RE = /^a\\/\\/b$/;`;
    expect(fingerprintSource(reformatted)).toBe(fingerprintSource(base));
  });

  it('moves on any real edit — a constant, an operator, a template expression, a template\'s own text, a regex', () => {
    const edits = [
      base.replace('LIMIT = 5', 'LIMIT = 6'),
      base.replace('a * LIMIT', 'a + LIMIT'),
      base.replace('${a * LIMIT}', '${a * 2}'),
      base.replace('https://x/', 'https://y/'),
      base.replace('/^a\\/\\/b$/', '/^a\\/\\/c$/'),
      base.replace('return `', 'return a && `'),
    ];
    for (const edited of edits) expect(edited).not.toBe(base);
    for (const edited of edits) expect(fingerprintSource(edited), edited).not.toBe(fingerprintSource(base));
  });

  it('is not fooled by "//" inside a string or a template — text after it is still code', () => {
    const a = `const u = 'http://a.example/x'; const n = 1;`;
    expect(fingerprintSource(a.replace('n = 1', 'n = 2'))).not.toBe(fingerprintSource(a));
    const b = 'const u = `http://${host}/x`; const n = 1;';
    expect(fingerprintSource(b.replace('n = 1', 'n = 2'))).not.toBe(fingerprintSource(b));
  });
});

describe('policyVersion carries the engine revision', () => {
  it('has the documented shape, with the current engine revision in it', () => {
    expect(policyVersionFor(rendering, 'no-api')).toBe(
      `${S8_POLICY_TAG}+recommendations-context-v2+engine-r${AUDIT_ENGINE_REVISION}+ai-no-api+browser-chromium@141.0.7390.37+playwright@1.63.0`,
    );
  });

  it('is deterministic, and differs by engine revision, execution mode and browser build', () => {
    expect(policyVersionFor(rendering, 'no-api')).toBe(policyVersionFor(rendering, 'no-api'));
    expect(policyVersionFor(rendering, 'no-api', AUDIT_ENGINE_REVISION)).toBe(policyVersionFor(rendering, 'no-api'));
    expect(policyVersionFor(rendering, 'no-api', AUDIT_ENGINE_REVISION + 1)).not.toBe(policyVersionFor(rendering, 'no-api'));
    expect(policyVersionFor(rendering, 'anthropic-api')).not.toBe(policyVersionFor(rendering, 'no-api'));
    expect(policyVersionFor({ ...rendering, browserVersion: '142.0.0.0' }, 'no-api')).not.toBe(policyVersionFor(rendering, 'no-api'));
  });
});

describe('the engine revision log', () => {
  it('the revision is a positive integer', () => {
    expect(Number.isInteger(AUDIT_ENGINE_REVISION) && AUDIT_ENGINE_REVISION >= 1).toBe(true);
  });

  it('has one entry per revision — every bump says what it changed, and no entry exists for a revision that does not', () => {
    const logged = Object.keys(ENGINE_REVISION_LOG).map(Number).sort((a, b) => a - b);
    expect(logged).toEqual(Array.from({ length: AUDIT_ENGINE_REVISION }, (_, i) => i + 1));
    for (const [revision, line] of Object.entries(ENGINE_REVISION_LOG)) expect(line.trim().length, `revision ${revision}'s log line`).toBeGreaterThan(40);
  });
});

describe('the engine sources are fingerprinted', () => {
  it('every listed source exists, once', () => {
    expect(ENGINE_SOURCE_FILES.filter((p) => !existsSync(join(root, p)))).toEqual([]);
    expect(new Set(ENGINE_SOURCE_FILES).size).toBe(ENGINE_SOURCE_FILES.length);
  });

  it('every file of a B1–B7 stage directory is listed — a new stage file cannot escape the guard', () => {
    const stageFiles = readdirSync(join(root, 'src', 'agents'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^b[1-7]-/.test(d.name))
      .flatMap((d) => readdirSync(join(root, 'src', 'agents', d.name)).filter((f) => f.endsWith('.ts')).map((f) => `src/agents/${d.name}/${f}`));
    expect(stageFiles.length).toBeGreaterThanOrEqual(18);
    expect(stageFiles.filter((p) => !ENGINE_SOURCE_FILES.includes(p)), 'add the new stage file(s) to ENGINE_SOURCE_FILES in src/graph/run-metadata.ts').toEqual([]);
  });

  it('the pin was made at the current engine revision — a bump without a re-pin (or a re-pin without a bump) fails here', () => {
    expect(PINNED_REVISION, 'PINNED_REVISION must equal AUDIT_ENGINE_REVISION (src/graph/run-metadata.ts)').toBe(AUDIT_ENGINE_REVISION);
  });

  it('no engine source changed since it was pinned — or the change was consciously handled (bump the revision and/or re-pin)', () => {
    const current = Object.fromEntries(ENGINE_SOURCE_FILES.map((p) => [p, fingerprintOf(p)]));
    const changed = ENGINE_SOURCE_FILES.filter((p) => PINNED[p] !== current[p]);
    const removed = Object.keys(PINNED).filter((p) => !(p in current));
    const pasteReady = `const PINNED: Readonly<Record<string, string>> = ${JSON.stringify(current, null, 2)};`;
    const message = [
      'The audit engine sources changed since the pinned fingerprint:',
      ...[...changed, ...removed].map((p) => `  - ${p}`),
      'Does this change what an audit REPORTS (a detection, a rule, an expected value, a sampling or exclusion policy, wording)?',
      '  YES → bump AUDIT_ENGINE_REVISION and add its ENGINE_REVISION_LOG line in src/graph/run-metadata.ts (full-site runs then stop reusing stale findings), set PINNED_REVISION, and re-pin.',
      '  NO  → (refactor / rename / performance) re-pin only.',
      'Paste-ready:',
      pasteReady,
    ].join('\n');
    expect({ changed, removed }, message).toEqual({ changed: [], removed: [] });
  });
});
