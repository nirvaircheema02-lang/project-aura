// Vendored verbatim from audit-agent src/ds/d2-registry/index.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
import { readFilesystemSource } from '../d1-reader/index.ts';
import { buildD3, type D3Result } from '../d3-tokens/index.ts';
import { buildD4, type D4Result } from '../d4-components/index.ts';
import { buildD5, type D5Result } from '../d5-rules/index.ts';
import { buildD6, type D6Result } from '../d6-version/index.ts';
import type { DSFinding } from '../findings.ts';

/**
 * D2 DS Registry — ARCHITECTURE.md §2.2: D reads are fetched ONCE per run
 * into a cached snapshot keyed to ds_registry_version, never re-fetched
 * independently by each of N parallel B instances. This is that snapshot
 * — call `loadDsRegistry` once per run and pass the returned object to
 * every B instance; never call it again mid-run.
 */

export interface DsRegistry {
  designSystemPath: string;
  loadedAt: number;
  version: D6Result;
  tokens: D3Result;
  components: D4Result;
  rules: D5Result;
  /** Every finding from every D-module, in one place — what B4/reporting actually consumes. */
  allFindings: DSFinding[];
}

export async function loadDsRegistry(designSystemPath: string): Promise<DsRegistry> {
  const raw = await readFilesystemSource(designSystemPath);

  // D3/D4/D6 are independent of each other and of D5's child-process work —
  // run them concurrently. D6 also reads tsx file contents itself (see its
  // own module comment), which is the slowest step here.
  const [tokens, components, version, rules] = await Promise.all([
    Promise.resolve(buildD3(raw)),
    Promise.resolve(buildD4(raw)),
    buildD6(raw),
    buildD5(raw),
  ]);

  const allFindings = [...version.findings, ...tokens.findings, ...components.findings, ...rules.findings];

  return {
    designSystemPath,
    loadedAt: Date.now(),
    version,
    tokens,
    components,
    rules,
    allFindings,
  };
}
