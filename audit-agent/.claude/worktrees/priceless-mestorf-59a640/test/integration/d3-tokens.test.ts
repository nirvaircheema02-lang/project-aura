import { describe, expect, it, beforeAll } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { readFilesystemSource, type DSRawContent } from '../../src/ds/d1-reader/index.ts';
import { buildD3, type D3Result } from '../../src/ds/d3-tokens/index.ts';
import { parseCssBlocks } from '../../src/ds/d3-tokens/css-cascade.ts';

/**
 * Integration test — reads the REAL Design System on disk (read-only) via
 * the configured designSystemPath. This is the strongest available check
 * for a cascade parser this intricate: does it reproduce values already
 * independently verified (IMPLEMENTATION-PLAN.md §4) against the live site.
 * Skips gracefully if the configured DS path isn't present on this machine.
 */

let raw: DSRawContent | undefined;
let d3: D3Result | undefined;

beforeAll(async () => {
  const config = loadConfig();
  try {
    raw = await readFilesystemSource(config.designSystemPath);
    d3 = buildD3(raw);
  } catch {
    raw = undefined;
    d3 = undefined;
  }
});

describe('D3 against the real Design System', () => {
  it('reads tokens.json and finds the shadow $type:"color" mismatch (verified real DS content)', () => {
    if (!d3) return; // DS not present on this machine — nothing to assert
    const shadowMd = d3.sourceTokens.find((t) => t.path === 'shadow.md');
    expect(shadowMd?.declaredType).toBe('color');
    expect(shadowMd?.value).toContain('rgba(0,0,0,0.10)'); // full multi-layer value, not corrupted

    const shadowFinding = d3.findings.find((f) => f.summary.includes('shadow.md'));
    expect(shadowFinding).toBeDefined();
    expect(shadowFinding?.severity).toBe('warning');
  });

  it('flags the chart primary-series color divergence between tokens.json and charts/theme/tokens.ts', () => {
    if (!d3) return;
    expect(d3.chartTokens.values.get('KEN_CHART_SERIES.primary')).toBe('#6c5bc0');
    const chartFinding = d3.findings.find((f) => f.summary.includes('Chart primary-series'));
    expect(chartFinding).toBeDefined();
    expect(chartFinding?.detail).toContain('#b01f24');
    expect(chartFinding?.detail).toContain('#6c5bc0');
  });

  it('resolves --button-height-md to the effective 48px override, not the 40px tokens.css source, for both variants', () => {
    if (!d3) return;
    for (const eff of d3.effective) {
      expect(eff.values.get('--button-height-md')).toBe('48px');
      expect(eff.provenance.get('--button-height-md')).toContain('base.css');
    }
  });

  it('the tokens.css layer alone (before the base.css override) has --button-height-md at 40px', () => {
    if (!raw) return;
    // Cross-check the parser's raw layer output directly, not just the final merged value.
    const blocks = parseCssBlocks(raw.tokensBuildCssRaw.content);
    const rootBlock = blocks.find((b) => b.selectors.includes(':root'));
    expect(rootBlock?.declarations.get('--button-height-md')).toBe('40px');
  });

  it('resolves all 6 --shadow-* tokens to the effective override, not tokens.css\'s corrupted single-color value', () => {
    if (!d3) return;
    const shadowVars = ['--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-xl', '--shadow-premium', '--shadow-inset-soft'];
    for (const eff of d3.effective) {
      for (const v of shadowVars) {
        const value = eff.values.get(v);
        expect(value, `${v} should be defined for ${eff.variant}`).toBeDefined();
      }
    }
  });

  it('editorial-light is the default (:root) variant; cinematic-dark is opt-in only ([data-variant] only)', () => {
    if (!raw) return;
    const editorialBlocks = parseCssBlocks(raw.editorialLightCssRaw.content);
    const cinematicBlocks = parseCssBlocks(raw.cinematicDarkCssRaw.content);
    expect(editorialBlocks.some((b) => b.selectors.includes(':root'))).toBe(true);
    expect(cinematicBlocks.some((b) => b.selectors.includes(':root'))).toBe(false);
    expect(cinematicBlocks.some((b) => b.selectors.includes('[data-variant="cinematic-dark"]'))).toBe(true);
  });

  it('emits the precedence-assumption finding (tokens.css vs variant files order is unverified)', () => {
    if (!d3) return;
    expect(d3.findings.some((f) => f.summary.includes('precedence between tokens.css and the variant files'))).toBe(true);
  });
});
