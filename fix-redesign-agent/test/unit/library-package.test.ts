import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assemblePackage } from '../../src/library/package.ts';
import { sha256OfFile } from '../../src/session/fingerprint.ts';
import type { ComponentSpec, L2Output } from '../../src/library/types.ts';

/**
 * assemblePackage computes real sha256 hashes over real files (§11.4) — a mocked filesystem
 * would not exercise that. Every fixture below is a real file under a real temp "DS repo" dir.
 */

let dsRepoPath: string;
beforeEach(() => {
  dsRepoPath = mkdtempSync(join(tmpdir(), 'fra-package-'));
  mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
  mkdirSync(join(dsRepoPath, 'core-v2/src/organisms'), { recursive: true });
  mkdirSync(join(dsRepoPath, 'core-v2/src/styles'), { recursive: true });
  writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'), 'export const Card = () => null;\n');
  writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/Button.tsx'), 'export const Button = () => null;\n');
  writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/index.ts'), "export { Card } from './Card';\n");
  writeFileSync(join(dsRepoPath, 'core-v2/src/organisms/index.ts'), "export { Nav } from './Nav';\n");
  writeFileSync(join(dsRepoPath, 'core-v2/src/styles/tokens.css'), ':root { --x: 1px; }\n');
});
afterEach(() => rmSync(dsRepoPath, { recursive: true, force: true }));

const baseSpec = (overrides: Partial<ComponentSpec> = {}): ComponentSpec => ({
  schemaVersion: 1,
  componentId: 'comp-a',
  patternId: 'sig-a',
  resolution: 'new',
  updateTarget: null,
  name: 'Card',
  category: 'molecules',
  scope: 'page-local',
  scopeEvidenceMissing: false,
  reference: { source: 'live-capture', priorRunId: null, elementStamp: 'e1', cropPath: null },
  anatomy: 'card — 1 instance',
  variantAxes: [],
  tokens: [],
  statesObserved: ['default'],
  statesToDesign: ['hover'],
  postFixPrerequisite: null,
  writeSet: ['core-v2/src/molecules/Card.tsx', 'core-v2/src/molecules/Card.stories.tsx'],
  declaredSharedChanges: { barrelEntries: [], tokenAdditions: [] },
  dependsOn: { findings: [], components: [] },
  constraints: [],
  ...overrides,
});

const baseBuild = (overrides: Partial<L2Output> = {}): L2Output => ({
  componentId: 'comp-a',
  filesWritten: ['core-v2/src/molecules/Card.tsx'],
  writeSetRespected: true,
  violatingPaths: [],
  usage: null,
  ...overrides,
});

describe('assemblePackage', () => {
  it('includes files only from builds that are BOTH approved AND writeSetRespected', async () => {
    const specA = baseSpec({ componentId: 'comp-a' });
    const specB = baseSpec({ componentId: 'comp-b', name: 'Button', writeSet: ['core-v2/src/molecules/Button.tsx'] });
    const specC = baseSpec({ componentId: 'comp-c', name: 'Unapproved', writeSet: ['core-v2/src/molecules/Card.tsx'] });
    const buildA = baseBuild({ componentId: 'comp-a', filesWritten: ['core-v2/src/molecules/Card.tsx'], writeSetRespected: true });
    const buildB = baseBuild({ componentId: 'comp-b', filesWritten: ['core-v2/src/molecules/Button.tsx'], writeSetRespected: false }); // approved but write set violated
    const buildC = baseBuild({ componentId: 'comp-c', filesWritten: ['core-v2/src/molecules/Card.tsx'], writeSetRespected: true }); // respected but never approved

    const result = await assemblePackage(dsRepoPath, 'branch-1', ['comp-a', 'comp-b'], [specA, specB, specC], [buildA, buildB, buildC], [], null);

    expect(result.approvedComponentIds).toEqual(['comp-a', 'comp-b']);
    expect(result.branch).toBe('branch-1');
    expect(result.files).toHaveLength(1);
    const expectedPath = join(dsRepoPath, 'core-v2/src/molecules/Card.tsx');
    expect(result.files[0]!.path).toBe(expectedPath);
    expect(result.files[0]!.blobSha256).toBe(await sha256OfFile(expectedPath));
  });

  it('includes a shared barrel file only when an APPROVED spec declared a change to that specific barrel — not just any touched barrel', async () => {
    const specA = baseSpec({ componentId: 'comp-a', declaredSharedChanges: { barrelEntries: [{ barrelFile: 'core-v2/src/molecules/index.ts', exportLine: "export { Card } from './Card';" }], tokenAdditions: [] } });
    const specB = baseSpec({ componentId: 'comp-b', name: 'Nav', category: 'organisms', writeSet: ['core-v2/src/organisms/Nav.tsx'], declaredSharedChanges: { barrelEntries: [{ barrelFile: 'core-v2/src/organisms/index.ts', exportLine: "export { Nav } from './Nav';" }], tokenAdditions: [] } });
    const buildA = baseBuild({ componentId: 'comp-a', filesWritten: ['core-v2/src/molecules/Card.tsx'] });
    const buildB = baseBuild({ componentId: 'comp-b', filesWritten: ['core-v2/src/organisms/Nav.tsx'] }); // never approved below

    const touchedBarrels = [join(dsRepoPath, 'core-v2/src/molecules/index.ts'), join(dsRepoPath, 'core-v2/src/organisms/index.ts')];
    const result = await assemblePackage(dsRepoPath, 'branch-1', ['comp-a'], [specA, specB], [buildA, buildB], touchedBarrels, null);

    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual([join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'), join(dsRepoPath, 'core-v2/src/molecules/index.ts')].sort());
    expect(paths).not.toContain(join(dsRepoPath, 'core-v2/src/organisms/index.ts'));
  });

  it('includes the token stylesheet only when an APPROVED spec declares tokenAdditions', async () => {
    const specA = baseSpec({ componentId: 'comp-a', declaredSharedChanges: { barrelEntries: [], tokenAdditions: [{ name: '--x', value: '1px' }] } });
    const buildA = baseBuild({ componentId: 'comp-a' });
    const tokenStylesheet = join(dsRepoPath, 'core-v2/src/styles/tokens.css');

    const result = await assemblePackage(dsRepoPath, 'branch-1', ['comp-a'], [specA], [buildA], [], tokenStylesheet);
    expect(result.files.map((f) => f.path)).toContain(tokenStylesheet);
  });

  it('omits the token stylesheet when no approved spec has tokenAdditions, even if tokenStylesheetTouched is set', async () => {
    const specA = baseSpec({ componentId: 'comp-a' }); // no tokenAdditions
    const buildA = baseBuild({ componentId: 'comp-a' });
    const tokenStylesheet = join(dsRepoPath, 'core-v2/src/styles/tokens.css');

    const result = await assemblePackage(dsRepoPath, 'branch-1', ['comp-a'], [specA], [buildA], [], tokenStylesheet);
    expect(result.files.map((f) => f.path)).not.toContain(tokenStylesheet);
  });

  it('omits the token stylesheet when the spec declaring tokenAdditions was never approved', async () => {
    const specA = baseSpec({ componentId: 'comp-a' }); // approved, no tokenAdditions
    const specB = baseSpec({ componentId: 'comp-b', declaredSharedChanges: { barrelEntries: [], tokenAdditions: [{ name: '--y', value: '2px' }] } }); // has tokenAdditions but not approved
    const buildA = baseBuild({ componentId: 'comp-a' });
    const buildB = baseBuild({ componentId: 'comp-b' });
    const tokenStylesheet = join(dsRepoPath, 'core-v2/src/styles/tokens.css');

    const result = await assemblePackage(dsRepoPath, 'branch-1', ['comp-a'], [specA, specB], [buildA, buildB], [], tokenStylesheet);
    expect(result.files.map((f) => f.path)).not.toContain(tokenStylesheet);
  });
});
