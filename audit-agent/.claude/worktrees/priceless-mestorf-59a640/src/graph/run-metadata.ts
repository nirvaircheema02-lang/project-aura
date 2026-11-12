import type { AiMode } from '../llm/provider.ts';
import type { RenderingPolicy } from '../t-layer/browser.ts';

/**
 * policy_version (§2.2): the snapshot of everything that shapes a finding
 * OTHER than the page and the Design System — the S8 confidence bands and the
 * exact rendering engine. Built in exactly one place: it used to be four
 * copies of a template string, which could drift apart silently.
 *
 * The browser part is the exact build, not the channel name. Two runs on
 * different Chromium builds carry different policy versions, so a rendering
 * change is visible as a policy change instead of passing for a REGRESSION.
 * The execution mode is part of it for the same reason: a deterministic
 * no-api result and a model-backed one are different baselines.
 */

export const S8_POLICY_TAG = 's8-bands-0.85/0.5';

export function policyVersionFor(rendering: RenderingPolicy, aiMode: AiMode): string {
  return `${S8_POLICY_TAG}+ai-${aiMode}+browser-${rendering.channel}@${rendering.browserVersion}+playwright@${rendering.playwrightVersion}`;
}

/** Human-readable engine line for reports: "Playwright Chromium 141.0.7390.37 (channel chromium, Playwright 1.63.0)". */
export function describeRenderingEngine(rendering: RenderingPolicy): string {
  return `Playwright Chromium ${rendering.browserVersion} (channel ${rendering.channel}, Playwright ${rendering.playwrightVersion})`;
}
