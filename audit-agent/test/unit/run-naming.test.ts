import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRunMeta, resolveRunName, runPaths, safeFileName, writeRunMeta } from '../../src/output/run-store.ts';

/**
 * Locks the run-naming contract: the run DISPLAY name is whatever the user gave, preserved
 * byte-for-byte — never replaced by its own slug — while a separate, auto-derived slug is what
 * actually needs to be filesystem/DB/Figma-node safe. Regression protection for exactly the
 * failure mode this exists to prevent: a run named "Brand Perception survey page" silently
 * becoming just "brand-perception-survey-page" everywhere a human reads it.
 */

describe('resolveRunName — display name preserved verbatim, slug derived FROM it', () => {
  it('preserves an explicit run name exactly, and derives the matching slug', () => {
    const { displayName, runId } = resolveRunName('https://www.kenresearch.com/brand-perception-survey', 'Brand Perception survey page');
    expect(displayName).toBe('Brand Perception survey page'); // byte-for-byte, never slugified
    expect(runId).toBe('brand-perception-survey-page');
  });

  it('trims incidental whitespace but changes nothing else about the given name', () => {
    const { displayName } = resolveRunName('https://example.com/x', '  Brand Perception survey page  ');
    expect(displayName).toBe('Brand Perception survey page');
  });

  it('derives a clean, readable name from the URL when none is given — never a timestamp/random id', () => {
    const { displayName, runId } = resolveRunName('https://www.kenresearch.com/brand-perception-survey');
    expect(displayName).toBe('Brand Perception Survey');
    expect(runId).toBe('brand-perception-survey');
    expect(displayName).not.toMatch(/^run-\d+-/); // the old run-<timestamp>-<random> scheme must never be the display name
  });

  it('falls back to the hostname when the URL has no meaningful path', () => {
    const { displayName } = resolveRunName('https://www.kenresearch.com/');
    expect(displayName).toBe('www.kenresearch.com');
  });

  it('slugifies punctuation and mixed case consistently', () => {
    const { runId } = resolveRunName('https://example.com/x', "Q4 Report — Client's Review!");
    expect(runId).toBe('q4-report-clients-review');
  });
});

describe('safeFileName — filename-safe, NOT slug-safe: spaces, case, and hyphens survive', () => {
  it('leaves a normal display name completely untouched', () => {
    expect(safeFileName('Brand Perception survey page')).toBe('Brand Perception survey page');
  });

  it('strips only genuinely filesystem-invalid characters', () => {
    expect(safeFileName('Q4 Report: "Final" / v2')).toBe('Q4 Report Final v2');
  });

  it('collapses runs of whitespace left behind after stripping, and trims the ends', () => {
    expect(safeFileName('  Spaced   Out  ')).toBe('Spaced Out');
  });
});

describe('writeRunMeta / readRunMeta — the display name survives across separate CLI invocations', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-agent-run-meta-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips the exact display name through run.json', async () => {
    const paths = runPaths(dir, 'proj', 'brand-perception-survey-page');
    await writeRunMeta(paths, { runId: 'brand-perception-survey-page', displayName: 'Brand Perception survey page', targetUrl: 'https://example.com', mode: 'single-page', createdAt: '2026-09-16T00:00:00.000Z' });
    const meta = await readRunMeta(paths, 'brand-perception-survey-page');
    expect(meta.displayName).toBe('Brand Perception survey page');
  });

  it('falls back to the runId itself for a run that predates run.json — never throws, never a blank name', async () => {
    const paths = runPaths(dir, 'proj', 'market-entry-real-1');
    const meta = await readRunMeta(paths, 'market-entry-real-1');
    expect(meta.displayName).toBe('market-entry-real-1');
    expect(meta.runId).toBe('market-entry-real-1');
  });
});
