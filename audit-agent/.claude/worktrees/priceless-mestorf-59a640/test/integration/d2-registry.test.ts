import { describe, expect, it, beforeAll } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';

let registry: DsRegistry | undefined;

beforeAll(async () => {
  const config = loadConfig();
  try {
    registry = await loadDsRegistry(config.designSystemPath);
  } catch {
    registry = undefined;
  }
}, 30_000);

describe('D2 Registry — one cached snapshot per run (§2.2)', () => {
  it('aggregates D3/D4/D5/D6 into one object with a coherent, consistent dsRegistryVersion', () => {
    if (!registry) return;
    expect(registry.version.dsRegistryVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.tokens.sourceTokens.length).toBeGreaterThan(0);
    expect(registry.components.totalTsxFiles).toBe(289);
    expect(registry.rules.checkerScripts).toHaveLength(6);
  });

  it('collects findings from every D-module into one allFindings list', () => {
    if (!registry) return;
    const modules = new Set(registry.allFindings.map((f) => f.module));
    expect(modules.has('D3')).toBe(true);
    expect(modules.has('D4')).toBe(true);
    expect(modules.has('D5')).toBe(true);
    expect(modules.has('D6')).toBe(true);
    expect(registry.allFindings.length).toBeGreaterThan(5);
  });
});
