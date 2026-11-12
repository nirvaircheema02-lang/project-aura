import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runL2 } from '../../src/agents/l2-component-builder/index.ts';
import { ScriptedLlmClient } from '../../src/llm/provider.ts';
import type { DsRegistry } from '../../src/ds/d2-registry/index.ts';
import type { ComponentSpec } from '../../src/library/types.ts';

/**
 * L2 touches the real filesystem (writes generated component files into a DS repo) and goes
 * through the real `ScriptedLlmClient` (which validates the scripted answer against L2's own
 * zod schema, exactly like a real wire response would be) — real disk I/O, no browser, same
 * tier `r1-resolve-load.test.ts` uses for its own real-fs-but-no-browser coverage.
 */

let dsRepoPath: string;
beforeEach(() => {
  dsRepoPath = mkdtempSync(join(tmpdir(), 'fra-l2-'));
  mkdirSync(join(dsRepoPath, 'core-v2/src/atoms'), { recursive: true });
  writeFileSync(join(dsRepoPath, 'core-v2/src/atoms/Button.tsx'), "export const Button = () => <button>Click</button>;\n");
});
afterEach(() => rmSync(dsRepoPath, { recursive: true, force: true }));

function fakeRegistry(): DsRegistry {
  return { designSystemPath: dsRepoPath, components: { componentFiles: ['atoms/Button.tsx'] } } as unknown as DsRegistry;
}

function componentSpec(overrides: Partial<ComponentSpec> = {}): ComponentSpec {
  return {
    schemaVersion: 1,
    componentId: 'card-abcd1234',
    patternId: 'pattern-1',
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
    declaredSharedChanges: { barrelEntries: [{ barrelFile: 'core-v2/src/molecules/index.ts', exportLine: "export { Card, type CardProps } from './Card';" }], tokenAdditions: [] },
    dependsOn: { findings: [], components: [] },
    constraints: [],
    ...overrides,
  };
}

describe('runL2 — write-set respected', () => {
  it('writes every generated file to disk at its declared write-set path when the model stays inside the write set', async () => {
    const spec = componentSpec();
    const llm = new ScriptedLlmClient({
      L2: [
        {
          files: [
            { path: 'core-v2/src/molecules/Card.tsx', content: 'export const Card = () => <div className="p-4" />;\n' },
            { path: 'core-v2/src/molecules/Card.stories.tsx', content: 'export default { title: "molecules/Card" };\n' },
          ],
          barrelExportLine: "export { Card, type CardProps } from './Card';",
          tokenAdditions: [],
          notes: 'built from the atoms/Button style reference',
        },
      ],
    });

    const result = await runL2({ llm, registry: fakeRegistry(), dsRepoPath }, spec);

    expect(result.writeSetRespected).toBe(true);
    expect(result.violatingPaths).toEqual([]);
    expect(result.componentId).toBe('card-abcd1234');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });

    // L2 read the style-reference file and sent exactly one request, carrying its own prompt.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.nodeId).toBe('L2');
    expect(llm.requests[0]!.prompt).toContain('Style reference');
    expect(llm.requests[0]!.prompt).toContain('export const Button = () => <button>Click</button>;'); // the real atoms/Button.tsx source, read off disk

    // Something real landed on disk for each generated file, at a path recorded relative to
    // dsRepoPath — the exact directory is covered (and a real discrepancy flagged) by the
    // dedicated test below; here we only pin the bookkeeping contract that isn't in question.
    expect(result.filesWritten).toHaveLength(2);
    for (const rel of result.filesWritten) {
      expect(existsSync(join(dsRepoPath, rel))).toBe(true);
    }
    expect(result.filesWritten.some((p) => p.endsWith('Card.tsx'))).toBe(true);
    expect(result.filesWritten.some((p) => p.endsWith('Card.stories.tsx'))).toBe(true);
  });

  it('writes land at the write-set path, not a doubled core-v2/src/core-v2/src/... path (regression test — was a real bug, fixed at l2-component-builder/index.ts:72)', async () => {
    // The write-set check just above requires `f.path` to equal one of the spec's OWN
    // write-set paths, which are themselves `core-v2/src/...`-prefixed (per
    // `library/resolve.ts::buildSpec`, e.g. `core-v2/src/molecules/Card.tsx`) — relative to
    // `dsRepo.path`, never re-prefixed. L2 previously joined `dsRepoPath` + `'core-v2/src'` +
    // `f.path` and doubled the prefix, writing to `<dsRepoPath>/core-v2/src/core-v2/src/...`.
    // Fixed to `join(deps.dsRepoPath, f.path)`, matching how L2b/L3 already treated write-set
    // paths as already-prefixed.
    const spec = componentSpec();
    const llm = new ScriptedLlmClient({
      L2: [{ files: [{ path: 'core-v2/src/molecules/Card.tsx', content: 'export const Card = () => null;\n' }, { path: 'core-v2/src/molecules/Card.stories.tsx', content: 'x' }], barrelExportLine: '', tokenAdditions: [], notes: '' }],
    });
    await runL2({ llm, registry: fakeRegistry(), dsRepoPath }, spec);
    expect(existsSync(join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'))).toBe(true);
    expect(readFileSync(join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'), 'utf-8')).toBe('export const Card = () => null;\n');
  });

  it('rejects the WHOLE build, writing nothing, when even one file falls outside the declared write set (§9.4/§7.6)', async () => {
    const spec = componentSpec();
    const llm = new ScriptedLlmClient({
      L2: [
        {
          files: [
            { path: 'core-v2/src/molecules/Card.tsx', content: 'export const Card = () => null;\n' }, // inside the write set
            { path: 'core-v2/src/atoms/Button.tsx', content: 'export const Button = () => null;\n' }, // OUTSIDE it — a shared file no build may touch directly
          ],
          barrelExportLine: "export { Card, type CardProps } from './Card';",
          tokenAdditions: [],
          notes: 'oops',
        },
      ],
    });

    const result = await runL2({ llm, registry: fakeRegistry(), dsRepoPath }, spec);

    expect(result.writeSetRespected).toBe(false);
    expect(result.violatingPaths).toEqual(['core-v2/src/atoms/Button.tsx']);
    expect(result.filesWritten).toEqual([]);

    // Nothing landed on disk — not even the in-write-set file — the batch fails wholesale, never partially.
    expect(existsSync(join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'))).toBe(false);
    expect(existsSync(join(dsRepoPath, 'core-v2/src/molecules/Card.stories.tsx'))).toBe(false);
    // The real DS file that was targeted outside the write set is untouched — still its original content.
    expect(readFileSync(join(dsRepoPath, 'core-v2/src/atoms/Button.tsx'), 'utf-8')).toBe('export const Button = () => <button>Click</button>;\n');
  });

  it('an update spec carries the existing DS file source into the prompt, and an unreadable reference crop is skipped rather than failing the build', async () => {
    mkdirSync(join(dsRepoPath, 'core-v2/src/atoms'), { recursive: true });
    writeFileSync(join(dsRepoPath, 'core-v2/src/atoms/Badge.tsx'), 'export const Badge = (props: { tone: "neutral" }) => null;\n');
    const spec = componentSpec({
      resolution: 'update',
      updateTarget: { dsFile: 'atoms/Badge.tsx', dsComponent: 'Badge' },
      writeSet: ['core-v2/src/atoms/Badge.tsx'],
      reference: { source: 'live-capture', priorRunId: null, elementStamp: 'e1', cropPath: join(dsRepoPath, 'does-not-exist.png') },
    });
    const llm = new ScriptedLlmClient({
      L2: [{ files: [{ path: 'core-v2/src/atoms/Badge.tsx', content: 'export const Badge = (props: { tone: "neutral" | "danger" }) => null;\n' }], barrelExportLine: '', tokenAdditions: [], notes: 'additive variant' }],
    });

    const result = await runL2({ llm, registry: fakeRegistry(), dsRepoPath }, spec);

    expect(result.writeSetRespected).toBe(true);
    expect(llm.requests[0]!.prompt).toContain('Updating existing component Badge');
    expect(llm.requests[0]!.prompt).toContain('tone: "neutral"'); // the existing file's real source, verbatim
    expect(llm.requests[0]!.imageCount).toBe(0); // the crop path does not exist — the request proceeds without an image
  });

  it('§security regression: refuses to write through a write-set path whose containing directory is a SYMLINK escaping the DS repo root', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'fra-l2-outside-'));
    try {
      // core-v2/src/molecules is a symlink to a directory OUTSIDE dsRepoPath entirely.
      symlinkSync(outsideDir, join(dsRepoPath, 'core-v2/src/molecules'));

      const spec = componentSpec();
      const llm = new ScriptedLlmClient({
        L2: [{ files: [{ path: 'core-v2/src/molecules/Card.tsx', content: 'export const Card = () => null;\n' }, { path: 'core-v2/src/molecules/Card.stories.tsx', content: 'x' }], barrelExportLine: '', tokenAdditions: [], notes: '' }],
      });
      const result = await runL2({ llm, registry: fakeRegistry(), dsRepoPath }, spec);

      expect(result.writeSetRespected).toBe(false);
      expect(result.filesWritten).toEqual([]);
      expect(result.violatingPaths.some((p) => p.includes('symlink') || p.includes('outside the DS repo root'))).toBe(true);
      // Nothing was written through the symlink into the outside directory.
      expect(existsSync(join(outsideDir, 'Card.tsx'))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('§security regression: refuses to write to a write-set path that ALREADY exists as a symlink', async () => {
    const outsideFile = join(mkdtempSync(join(tmpdir(), 'fra-l2-outside-')), 'evil.tsx');
    writeFileSync(outsideFile, 'ORIGINAL');
    mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
    symlinkSync(outsideFile, join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'));

    const spec = componentSpec();
    const llm = new ScriptedLlmClient({
      L2: [{ files: [{ path: 'core-v2/src/molecules/Card.tsx', content: 'HIJACKED' }, { path: 'core-v2/src/molecules/Card.stories.tsx', content: 'x' }], barrelExportLine: '', tokenAdditions: [], notes: '' }],
    });
    const result = await runL2({ llm, registry: fakeRegistry(), dsRepoPath }, spec);

    expect(result.writeSetRespected).toBe(false);
    expect(readFileSync(outsideFile, 'utf-8')).toBe('ORIGINAL'); // never followed the symlink to overwrite it
  });
});
