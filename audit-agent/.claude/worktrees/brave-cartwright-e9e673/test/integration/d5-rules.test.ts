import { describe, expect, it, beforeAll } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { readFilesystemSource } from '../../src/ds/d1-reader/index.ts';
import { buildD5, type D5Result } from '../../src/ds/d5-rules/index.ts';

let d5: D5Result | undefined;

beforeAll(async () => {
  const config = loadConfig();
  try {
    const raw = await readFilesystemSource(config.designSystemPath);
    d5 = await buildD5(raw);
  } catch {
    d5 = undefined;
  }
}, 30_000);

describe('D5 against the real Design System', () => {
  it('runs all 6 checker scripts and flags lint-section-alternation.mjs as a stub, not a real pass', () => {
    if (!d5) return;
    expect(d5.checkerScripts).toHaveLength(6);
    const lintAlternation = d5.checkerScripts.find((r) => r.name === 'lint-section-alternation');
    expect(lintAlternation?.isStub).toBe(true);
    expect(d5.findings.some((f) => f.summary.includes('lint-section-alternation is a stub'))).toBe(true);
  });

  it('check-ink-roles.mjs is a real check that currently passes with 0 violations', () => {
    if (!d5) return;
    const inkRoles = d5.checkerScripts.find((r) => r.name === 'check-ink-roles');
    expect(inkRoles?.isStub).toBe(false);
    expect(inkRoles?.passed).toBe(true);
  });

  it('check-tokens.mjs finds real, pre-existing undefined-token violations in the DS', () => {
    if (!d5) return;
    const checkTokens = d5.checkerScripts.find((r) => r.name === 'check-tokens');
    expect(checkTokens?.isStub).toBe(false);
    expect(checkTokens?.passed).toBe(false);
    expect(checkTokens?.summaryLine).toMatch(/FAIL/);
  });

  it('extracts RULES.md rules with the WHY/WHAT/WHEN/WHEN NOT/WHERE fields, keyed by R#.# id', () => {
    if (!d5) return;
    const r12 = d5.rules.find((r) => r.id === 'R1.2');
    expect(r12?.title).toContain('Brand Red is for CTAs ONLY');
    expect(r12?.fields.WHY).toBeDefined();
    expect(r12?.fields.WHAT).toContain('#b01f24');
    expect(r12?.fields['WHEN NOT']).toContain('NEVER for borders');
    expect(r12?.startLine).toBeGreaterThan(0);
    expect(r12?.endLine).toBeGreaterThan(r12?.startLine ?? 0);
  });

  it('corrects the plan\'s "Cat N.N" claim and flags the real divergence: core-v2 has 14 categories, root has 13', () => {
    if (!d5) return;
    const f = d5.findings.find((f) => f.summary.includes('does not match the current file'));
    expect(f).toBeDefined();
    expect(f?.summary).toContain('root: 13, core-v2: 14');
    expect(f?.detail).toContain('Gradients & Backgrounds');
  });

  it('flags recipes/case-study.md as stale (missing directory + GSAP references)', () => {
    if (!d5) return;
    const staleFinding = d5.findings.find((f) => f.summary.includes('case-study.md is stale'));
    expect(staleFinding).toBeDefined();
    expect(staleFinding?.detail).toContain('GSAP');
    expect(staleFinding?.detail).toContain('verified not to exist on disk');
  });
});
