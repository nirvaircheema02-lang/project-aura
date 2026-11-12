import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { buildComponentCatalog, findCatalogEntry, renderCatalogForPrompt, renderTokensForPrompt } from '../../src/ds/catalog.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';

/**
 * The vendored D1–D6 loader against the REAL Design System at the configured path
 * (read-only, never vendored) — plus the catalog rendering R3 will put in its prompt.
 * Skips cleanly when the Design System is not present on this machine.
 */

let registry: DsRegistry | undefined;
let reason = '';

beforeAll(async () => {
  const config = loadConfig(join(import.meta.dirname, '..', '..', 'fix-redesign-agent.config.json'));
  if (!existsSync(config.designSystemPath)) {
    reason = `design system not found at ${config.designSystemPath}`;
    return;
  }
  registry = await loadDsRegistry(config.designSystemPath);
}, 120_000);

describe('vendored DS registry loader (D1–D6) against the real Design System', () => {
  it('loads one coherent snapshot with a content-hash version, tokens, components and rules', () => {
    if (!registry) return console.warn(`skipped: ${reason}`);
    expect(registry.version.dsRegistryVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.tokens.sourceTokens.length).toBeGreaterThan(0);
    expect(registry.components.totalTsxFiles).toBeGreaterThan(0);
    expect(registry.rules.checkerScripts.length).toBeGreaterThan(0);
    expect(new Set(registry.allFindings.map((f) => f.module)).size).toBeGreaterThan(0);
  });

  it('renders the component catalog and tokens R3 prompts with, and resolves a known component', () => {
    if (!registry) return;
    const catalog = buildComponentCatalog(registry);
    expect(catalog.length).toBeGreaterThan(0);
    const button = findCatalogEntry(catalog, 'Button');
    expect(button?.name).toBe('Button');
    expect(renderCatalogForPrompt(catalog)).toContain('Button');
    expect(renderTokensForPrompt(registry, 'editorial-light', /^--button-/)).toMatch(/--button-/);
  });
});
