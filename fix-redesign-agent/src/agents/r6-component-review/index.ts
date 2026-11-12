import { buildComponentManifest } from '../../manifest/build.ts';
import { TerminalError } from '../../retry.ts';
import type { R6Input, R6Output } from '../types.ts';

/**
 * R6 — Component Review (deterministic, §8.6, Decision Log #16). Thin node wrapper around
 * `manifest/build.ts` — kept separate so the manifest-building LOGIC is independently
 * testable (pure-ish, given a fake registry/session) without going through the node's
 * tracing/error-wrapping ceremony.
 */

export const R6_STATUS = 'implemented' as const;

export interface R6Deps {
  auditAgentRepoRoot: string;
  plausibilityBar: number;
  log?: (line: string) => void;
}

export async function runR6(deps: R6Deps, input: R6Input): Promise<R6Output> {
  const log = deps.log ?? (() => {});
  if (!input.session.mapping) throw new TerminalError('R6: session.mapping is not set — C2 must run before R6.');
  const manifest = await buildComponentManifest({ auditAgentRepoRoot: deps.auditAgentRepoRoot, plausibilityBar: deps.plausibilityBar, otherRunDataJsonPaths: input.otherRunDataJsonPaths }, input);
  log(`R6 · manifest: ${manifest.components.length} component(s) · ${manifest.sections.length} section(s) · buckets ${JSON.stringify(manifest.counts.byBucket)}`);
  return { manifest };
}
