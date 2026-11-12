import { describe, expect, it } from 'vitest';
import { HTML_TEMPLATE_VERSION, STATUS_COLORS } from '../../src/dashboard/views/render.ts';

/**
 * Locks the HTML/dashboard template's semantic status palette — the same five-color meaning as
 * the Figma template (Incorrect=Red, Deviation=Orange, Needs Review=Amber, Unverified=Gray,
 * Match=Green). Regression protection for the specific drift found and fixed once already:
 * UNVERIFIED silently reused the NEEDS_REVIEW amber hue (distinguished only by a dashed border),
 * which is not "gray/muted treatment" as approved — it must be a genuinely distinct color.
 */

describe('STATUS_COLORS — the locked HTML semantic palette', () => {
  it('matches the approved five-color mapping exactly', () => {
    expect(STATUS_COLORS).toEqual({
      incorrect: '#b01f24',
      deviation: '#d96548',
      needsReview: '#c99a2e',
      unverified: '#6b7280',
      match: '#3f7d58',
    });
  });

  it('gives UNVERIFIED a genuinely distinct hue from NEEDS_REVIEW — never the same amber plus only a border-style difference', () => {
    expect(STATUS_COLORS.unverified).not.toBe(STATUS_COLORS.needsReview);
  });

  it('every status color is distinct — no two statuses silently share a hue', () => {
    const values = Object.values(STATUS_COLORS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('HTML_TEMPLATE_VERSION — the locked template contract, the HTML counterpart to FIGMA_CONTRACT_VERSION', () => {
  it('is set to a real, non-empty version string', () => {
    expect(HTML_TEMPLATE_VERSION).toMatch(/^html-report-v\d+$/);
  });
});
