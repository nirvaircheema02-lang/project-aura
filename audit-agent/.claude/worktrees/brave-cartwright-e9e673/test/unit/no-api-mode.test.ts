import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { AnthropicLlmClient } from '../../src/llm/client.ts';
import { createAiProvider, DEFAULT_AI_MODE, DisabledLlmClient, resolveAiMode } from '../../src/llm/provider.ts';
import { resolveResumeProvider } from '../../src/cli/resume-provider.ts';
import { policyVersionFor } from '../../src/graph/run-metadata.ts';
import { TerminalError } from '../../src/graph/retry.ts';
import { deterministicTemplateMap } from '../../src/agents/a2-template-classifier/index.ts';
import { deterministicRootCauses } from '../../src/agents/a4-site-consolidator/index.ts';
import { buildFoundationContext, checkFoundationRules } from '../../src/agents/b4-compliance-auditor/foundation-rules.ts';
import { buildAuditData } from '../../src/agents/c2-json-writer/index.ts';
import { publishToFigma } from '../../src/figma/publish.ts';
import { classify, severityFor } from '../../src/skills/s5-compliance-classification.ts';
import { findingStatus, scoreCompliance, type Finding } from '../../src/skills/s0-result-contract.ts';
import type { ExtractedStyle } from '../../src/t-layer/computed-style.ts';
import type { RenderingPolicy } from '../../src/t-layer/browser.ts';

/**
 * Decision Log #31 — the execution-mode switch and the pure parts of the
 * deterministic (no-api) strategies. The browser-driven parts are covered in
 * test/integration/no-api-audit.test.ts and the real CLI in cli-e2e.test.ts.
 */

const savedEnv = { AI_MODE: process.env.AI_MODE, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('execution mode: no-api is the v1 default, anthropic-api is opt-in', () => {
  it('defaults to no-api with nothing configured', () => {
    expect(DEFAULT_AI_MODE).toBe('no-api');
    expect(resolveAiMode({})).toBe('no-api');
    expect(resolveAiMode({}, undefined)).toBe('no-api');
  });

  it('AI_MODE overrides the config file; an unknown value is an error, never a silent fallback', () => {
    expect(resolveAiMode({ AI_MODE: 'anthropic-api' }, 'no-api')).toBe('anthropic-api');
    expect(resolveAiMode({ AI_MODE: 'no-api' }, 'anthropic-api')).toBe('no-api');
    expect(resolveAiMode({}, 'anthropic-api')).toBe('anthropic-api');
    expect(() => resolveAiMode({ AI_MODE: 'claude' })).toThrow(/not a valid execution mode/);
  });

  it('the config file defaults aiMode to no-api', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-agent-mode-'));
    try {
      const path = join(dir, 'c.json');
      writeFileSync(path, JSON.stringify({ designSystemPath: '/tmp/ds', figmaTeamPlanKey: 'team::1' }));
      expect(loadConfig(path).aiMode).toBe('no-api');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-api needs no credential and its model client refuses every call (TERMINAL, counted)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const provider = createAiProvider('no-api', 'claude-opus-5');
    expect(provider.mode).toBe('no-api');
    expect(provider.llm).toBeInstanceOf(DisabledLlmClient);
    await expect(provider.llm.structured({ nodeId: 'B4', system: 's', prompt: 'p', schema: z.object({}) })).rejects.toBeInstanceOf(TerminalError);
    expect((provider.llm as DisabledLlmClient).attempts).toBe(1);
  });

  it('anthropic-api stays available — but only when explicitly chosen AND a credential exists', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    expect(() => createAiProvider('anthropic-api', 'claude-opus-5')).toThrow(/AI_MODE=anthropic-api needs ANTHROPIC_API_KEY/);
    process.env.ANTHROPIC_API_KEY = 'unit-test-not-a-real-key';
    const provider = createAiProvider('anthropic-api', 'claude-opus-5');
    expect(provider.mode).toBe('anthropic-api');
    expect(provider.llm).toBeInstanceOf(AnthropicLlmClient); // constructed, never called here
  });

  it('the mode is part of the policy version, so a mode change is a baseline change, not a regression', () => {
    const rendering = { engine: 'chromium', channel: 'chromium', browserVersion: '153.0.8010.12', playwrightVersion: '1.63.0' } as unknown as RenderingPolicy;
    expect(policyVersionFor(rendering, 'no-api')).toContain('+ai-no-api+');
    expect(policyVersionFor(rendering, 'no-api')).not.toBe(policyVersionFor(rendering, 'anthropic-api'));
  });
});

describe('resume: keeps the mode a run started with, never silently switches or blocks the Publish Gate on a credential (third-pass review MS-1/MS-2)', () => {
  const run = (aiMode: 'no-api' | 'anthropic-api') => ({ policy_version: `chromium@1.0+ds@1+ai-${aiMode}+` });
  const config = { aiMode: 'no-api' as const, anthropicModel: 'claude-opus-5' };

  it('MS-1: a mode-mismatched environment is refused by name, not silently resolved to the recorded mode', () => {
    process.env.ANTHROPIC_API_KEY = 'unit-test-not-a-real-key';
    const result = resolveResumeProvider('run-1', run('no-api'), 'A2', { AI_MODE: 'anthropic-api' }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Run run-1 was started in no-api mode; this environment asks for anthropic-api/);
      expect(result.message).toMatch(/AI_MODE=no-api to match how it started/);
    }
  });

  it('a matching mode resumes normally at the Scope Gate', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const result = resolveResumeProvider('run-2', run('no-api'), 'A2', {}, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider.mode).toBe('no-api');
      expect(result.provider.llm).toBeInstanceOf(DisabledLlmClient);
    }
  });

  it('MS-2: resuming an anthropic-api run at the Publish Gate needs no credential — the remaining work is deterministic', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const result = resolveResumeProvider('run-3', run('anthropic-api'), 'A4', { AI_MODE: 'anthropic-api' }, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider.mode).toBe('anthropic-api');
      expect(result.provider.llm).toBeInstanceOf(DisabledLlmClient); // never actually constructs the Anthropic client
    }
  });

  it('contrast: the SAME run resumed at the Scope Gate (not the Publish Gate) still needs the credential', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const result = resolveResumeProvider('run-4', run('anthropic-api'), 'A2', { AI_MODE: 'anthropic-api' }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/AI_MODE=anthropic-api needs ANTHROPIC_API_KEY/);
  });

  it('an invalid AI_MODE is reported, never thrown past the caller', () => {
    const result = resolveResumeProvider('run-5', run('no-api'), 'A2', { AI_MODE: 'claude' }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not a valid execution mode/);
  });
});

describe('S0/S5: NEEDS_REVIEW and UNVERIFIED never count as compliant', () => {
  const f = (classification: Finding['classification'], reasons: string[] = []) => ({ classification, quality: { escalationReasons: reasons } });
  it('both are excluded from the score and counted on their own', () => {
    const score = scoreCompliance([f('MATCH'), f('DEVIATION'), f('NEEDS_REVIEW'), f('UNVERIFIED'), f('MATCH', ['NOT_COMPARED'])]);
    expect(score).toMatchObject({ match: 1, deviation: 1, needsReview: 1, unverified: 2, notCompared: 2, compliancePercent: 50 });
  });
  it('the output status reads both the new UNVERIFIED and the older MATCH + NOT_COMPARED form', () => {
    expect(findingStatus(f('UNVERIFIED'))).toBe('UNVERIFIED');
    expect(findingStatus(f('MATCH', ['NOT_COMPARED']))).toBe('UNVERIFIED');
    expect(findingStatus(f('NEEDS_REVIEW'))).toBe('NEEDS_REVIEW');
  });
  it('a matched component with nothing compared is UNVERIFIED, not MATCH; a proven foundation breach stands without a DS match', () => {
    expect(classify({ hasDsMatch: true, mismatches: [], ruleViolations: [], nothingCompared: true })).toBe('UNVERIFIED');
    expect(classify({ hasDsMatch: false, mismatches: [], ruleViolations: [{ ruleId: 'R1.4', title: 't', why: 'w' }], foundationRulesApply: true })).toBe('INCORRECT');
    expect(classify({ hasDsMatch: false, mismatches: [], ruleViolations: [], newComponentVerdict: 'NEEDS_REVIEW' })).toBe('NEEDS_REVIEW');
  });
  it('a measured breach carries its own severity; the rubric still decides for model-cited rules', () => {
    const measured = [{ ruleId: 'R3.6', title: 't', why: 'w', severity: 'LOW' as const }];
    expect(severityFor({ hasDsMatch: true, mismatches: [], ruleViolations: measured, classification: 'INCORRECT' })).toBe('LOW');
    expect(severityFor({ hasDsMatch: true, mismatches: [], ruleViolations: [{ ruleId: 'R1.2', title: 't', why: 'w' }], classification: 'INCORRECT' })).toBe('CRITICAL');
    expect(severityFor({ hasDsMatch: false, mismatches: [], ruleViolations: [], classification: 'NEEDS_REVIEW' })).toBe('INFO');
  });
});

describe('A2 no-api: template families from URL shape', () => {
  it('groups by first path segment and depth, and places every URL exactly once', () => {
    const urls = ['https://x.com/', 'https://x.com/consulting', 'https://x.com/consulting/a/b', 'https://x.com/consulting/c/d', 'https://x.com/reports/r1', 'https://x.com/reports/r2'];
    const map = deterministicTemplateMap({ root: 'https://x.com/', urls: urls.map((url) => ({ url, source: 'sitemap' as const, depth: 0 })) } as never);
    const byPattern = Object.fromEntries(map.families.map((f) => [f.urlPattern, f.urls]));
    expect(byPattern['/consulting/*/*']).toEqual(['https://x.com/consulting/a/b', 'https://x.com/consulting/c/d']);
    expect(byPattern['/reports/*']).toHaveLength(2);
    expect(byPattern['/']).toEqual(['https://x.com/']);
    expect(map.families.flatMap((f) => f.urls).sort()).toEqual([...urls].sort());
    expect(map.families.every((f) => f.rationale.startsWith('deterministic:'))).toBe(true);
  });
});

describe('A4 no-api: shared-cause clusters, never an invented cause', () => {
  const finding = (sig: string, url: string, rule: string | null, token: string | null): Finding =>
    ({
      identity: { auditId: 'a', runId: 'r', findingId: `${sig}-${url}`, timestamp: 't', dsRegistryVersion: 'd', policyVersion: 'p' },
      location: { url, pageId: url, pageName: url, templateFamily: 'Consulting', section: 's', captureState: 'default' },
      component: { productionType: 'button', productionLabel: 'x', dsComponent: token ? 'Button' : null, dsVariant: null, signature: sig },
      classification: rule ? 'INCORRECT' : 'DEVIATION',
      comparison: {
        mismatches: token ? [{ property: 'height', actual: '44px', expected: '48px', expectedToken: token, comparison: 'length-px', delta: -4 }] : [],
        ruleViolations: rule ? [{ ruleId: rule, title: 'Two-Font Pairing', why: 'Manrope' }] : [],
      },
      quality: { severity: 'HIGH', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
      action: { recommendation: 'r', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
      history: { previousStatus: null, currentStatus: rule ? 'INCORRECT' : 'DEVIATION', delta: null, previousRunId: null },
    }) as Finding;

  it('a rule broken by several patterns is one cluster; a lone issue gets no cause', () => {
    const page = (findings: Finding[]) => ({ runId: 'r', pageId: 'p', url: 'u', pageName: 'u', templateFamily: null, domHash: 'd', dsRegistryVersion: 'd', policyVersion: 'p', findings, compliance: scoreCompliance(findings), coverage: { sectionsAnalyzed: 1, componentsDetected: findings.length, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] }, capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 } });
    const data = buildAuditData({ runId: 'r', auditId: 'a', mode: 'full-site', startedAt: '2026-09-14T10:00:00.000Z', targetUrl: 'u', pages: [page([finding('s1', 'https://x.com/a', 'R1.4', null), finding('s2', 'https://x.com/b', 'R1.4', null), finding('s3', 'https://x.com/c', null, '--lone-token')])], failedPages: [] });
    const causes = deterministicRootCauses(data);
    expect(causes).toHaveLength(1);
    expect(causes[0]!.title).toMatch(/^R1\.4 Two-Font Pairing/);
    expect(causes[0]!.issueSignatures.sort()).toEqual(['s1', 's2']);
    expect(causes[0]!.likelyOrigin).toMatch(/^deterministic cluster/);
  });
});

describe('foundation rules — measured against the real Design System', () => {
  let registry: DsRegistry;
  beforeAll(async () => {
    registry = await loadDsRegistry(loadConfig().designSystemPath);
  }, 120_000);
  const style = (raw: Record<string, string>, box = { width: 200, height: 44 }): ExtractedStyle => ({ connected: true, raw, rootFontSizePx: 16, box });
  const base = { 'font-family': '"DM Sans", "DM Sans Fallback", sans-serif', 'font-size': '16px', color: 'rgb(0, 0, 0)', 'border-top-left-radius': '5px', 'border-top-right-radius': '5px', 'border-bottom-right-radius': '5px', 'border-bottom-left-radius': '5px' };

  it('DS typeface, a DS size and a DS radius break nothing', () => {
    const ctx = buildFoundationContext(registry);
    expect(checkFoundationRules({ componentType: 'button', headingLevel: null, hasText: true, style: style(base), ctx })).toEqual([]);
  });

  it('R1.4: a non-DS typeface (the site\'s Manrope, or the browser default stack) is a violation', () => {
    const ctx = buildFoundationContext(registry);
    const manrope = checkFoundationRules({ componentType: 'link', headingLevel: null, hasText: true, style: style({ ...base, 'font-family': 'Manrope, "Manrope Fallback"' }), ctx });
    expect(manrope.map((v) => v.ruleId)).toContain('R1.4');
    expect(manrope.find((v) => v.ruleId === 'R1.4')!.why).toMatch(/manrope/i);
    const system = checkFoundationRules({ componentType: 'button', headingLevel: null, hasText: true, style: style({ ...base, 'font-family': 'ui-sans-serif, system-ui, sans-serif' }), ctx });
    expect(system.map((v) => v.ruleId)).toContain('R1.4');
  });

  it('R1.3 and R3.6: an off-scale font size and an arbitrary radius are violations; a pill is not', () => {
    const ctx = buildFoundationContext(registry);
    // 17px sits between the DS's 16px and 18px steps (12px would pass: --typography-size-2xs is 0.75rem).
    const v = checkFoundationRules({ componentType: 'button', headingLevel: null, hasText: true, style: style({ ...base, 'font-size': '17px', 'border-top-left-radius': '6px' }), ctx });
    expect(v.map((x) => x.ruleId).sort()).toEqual(['R1.3', 'R3.6']);
    const pill = checkFoundationRules({ componentType: 'button', headingLevel: null, hasText: true, style: style({ ...base, 'border-top-left-radius': '22px' }, { width: 120, height: 44 }), ctx });
    expect(pill).toEqual([]);
  });

  it('R1.4 display rule: a 52px h2 in the sans face is a violation; a 14px h2 is not (serif starts at 25px)', () => {
    const ctx = buildFoundationContext(registry);
    expect(checkFoundationRules({ componentType: 'section-heading', headingLevel: 2, hasText: true, style: style({ ...base, 'font-size': '48px' }), ctx }).map((v) => v.ruleId)).toContain('R1.4');
    expect(checkFoundationRules({ componentType: 'section-heading', headingLevel: 2, hasText: true, style: style({ ...base, 'font-size': '14px' }), ctx })).toEqual([]);
  });

  it('R1.2: brand red heading text is a violation; an icon (no text) is never judged on typeface', () => {
    const ctx = buildFoundationContext(registry);
    expect(checkFoundationRules({ componentType: 'section-heading', headingLevel: 3, hasText: true, style: style({ ...base, color: 'rgb(176, 31, 36)' }), ctx }).map((v) => v.ruleId)).toContain('R1.2');
    expect(checkFoundationRules({ componentType: 'icon-button', headingLevel: null, hasText: false, style: style({ ...base, 'font-family': 'Manrope' }), ctx })).toEqual([]);
  });
});

describe('C3 in no-api mode', () => {
  it('builds the plan but never starts the headless Claude run that performs the Figma write', async () => {
    const data = buildAuditData({ runId: 'r', auditId: 'a', mode: 'single-page', startedAt: '2026-09-14T10:00:00.000Z', targetUrl: 'u', pages: [], failedPages: [], aiMode: 'no-api' });
    // A real claude binary must never be spawned: point the default transport at one that cannot exist.
    const { outcome } = await publishToFigma(data, { figmaFileKey: 'KEY', figmaNodes: { pages: {}, frames: {}, markers: {}, imageHashes: {} } } as never, {} as never, { claudeBin: '/nonexistent/claude-must-not-run' });
    expect(outcome.status).toBe('unavailable');
    if (outcome.status === 'unavailable') expect(outcome.detail).toMatch(/AI_MODE=no-api/);
  });
});
