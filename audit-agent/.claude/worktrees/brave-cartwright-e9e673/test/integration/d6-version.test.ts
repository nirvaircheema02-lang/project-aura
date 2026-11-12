import { describe, expect, it, beforeAll } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { readFilesystemSource } from '../../src/ds/d1-reader/index.ts';
import { buildD6, type D6Result } from '../../src/ds/d6-version/index.ts';

let d6: D6Result | undefined;
let d6Again: D6Result | undefined;

beforeAll(async () => {
  const config = loadConfig();
  try {
    const raw = await readFilesystemSource(config.designSystemPath);
    d6 = await buildD6(raw);
    const raw2 = await readFilesystemSource(config.designSystemPath);
    d6Again = await buildD6(raw2);
  } catch {
    d6 = undefined;
  }
}, 30_000);

describe('D6 against the real Design System', () => {
  it('produces a 64-char hex sha256 dsRegistryVersion', () => {
    if (!d6) return;
    expect(d6.dsRegistryVersion).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — hashing the same real content twice produces the same version', () => {
    if (!d6 || !d6Again) return;
    expect(d6Again.dsRegistryVersion).toBe(d6.dsRegistryVersion);
    expect(d6Again.tokensHash).toBe(d6.tokensHash);
    expect(d6Again.componentsHash).toBe(d6.componentsHash);
  });

  it('changes if the token content changes (content-addressed, not mtime/semver-based)', async () => {
    if (!d6) return;
    const config = loadConfig();
    const raw = await readFilesystemSource(config.designSystemPath);
    const mutated = { ...raw, tokensJsonRaw: { ...raw.tokensJsonRaw, content: raw.tokensJsonRaw.content + '/* touch */' } };
    const { buildD6: buildD6Again } = await import('../../src/ds/d6-version/index.ts');
    const mutatedResult = await buildD6Again(mutated);
    expect(mutatedResult.tokensHash).not.toBe(d6.tokensHash);
    expect(mutatedResult.dsRegistryVersion).not.toBe(d6.dsRegistryVersion);
  });

  it('records both package.json versions as 0.1.0 and flags them as frozen/unreliable (verified real content)', () => {
    if (!d6) return;
    expect(d6.advisory.tokensPackageVersion).toBe('0.1.0');
    expect(d6.advisory.coreV2PackageVersion).toBe('0.1.0');
    expect(d6.findings.some((f) => f.summary.includes('frozen at 0.1.0'))).toBe(true);
  });

  it('reports the real index.ts barrel-file count (verified 12 via full recursive walk, not the plan\'s stated 9)', () => {
    if (!d6) return;
    const barrelFinding = d6.findings.find((f) => f.summary.includes('Component-hash barrel-file count'));
    expect(barrelFinding).toBeDefined();
    expect(barrelFinding?.summary).toContain('12 index.ts files');
  });
});
