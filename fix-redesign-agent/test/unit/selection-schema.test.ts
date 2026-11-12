import { describe, expect, it } from 'vitest';
import { isEmptySelection, parseComponentSelection } from '../../src/library/selection-schema.ts';
import type { ComponentSelection } from '../../src/library/selection-schema.ts';
import { TerminalError } from '../../src/retry.ts';

const validSelection = (overrides: Partial<ComponentSelection> = {}): ComponentSelection => ({
  schemaVersion: 1,
  redesignRunId: 'page-audit-redesign-test',
  sourceRun: { runId: 'page-audit', projectName: 'www.example.com-page' },
  dsRegistryVersion: 'f'.repeat(64),
  exportedAt: '2026-09-18T10:00:00.000Z',
  decidedBy: 'reviewer@example.com',
  selections: [{ patternId: 'pattern-1', findingIds: ['a'.repeat(32)], selection: 'new-component', suggestion: 'new-component', note: null }],
  manualCandidates: [],
  globalCandidates: [],
  ...overrides,
});

describe('parseComponentSelection', () => {
  it('parses a valid selection', () => {
    const parsed = parseComponentSelection(validSelection(), '/fake/component-selection.json');
    expect(parsed.selections).toHaveLength(1);
    expect(parsed.selections[0]).toMatchObject({ patternId: 'pattern-1', selection: 'new-component' });
  });

  it('rejects a malformed selection (bad selection enum value, field path named)', () => {
    const bad = validSelection();
    bad.selections[0]!.selection = 'not-a-real-kind' as never;
    try {
      parseComponentSelection(bad, '/fake/component-selection.json');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).message).toContain('selections.0.selection');
    }
  });

  it('rejects a selection missing required fields (empty findingIds array)', () => {
    const bad = validSelection();
    bad.selections[0]!.findingIds = [];
    expect(() => parseComponentSelection(bad, '/fake/component-selection.json')).toThrow(TerminalError);
  });
});

describe('isEmptySelection', () => {
  it('true only when selections, manualCandidates AND globalCandidates are all empty', () => {
    const base = validSelection({ selections: [], manualCandidates: [], globalCandidates: [] });
    expect(isEmptySelection(base)).toBe(true);
  });

  it('false when selections has an entry', () => {
    expect(isEmptySelection(validSelection())).toBe(false);
  });

  it('false when only manualCandidates has an entry', () => {
    const sel = validSelection({ selections: [], globalCandidates: [], manualCandidates: [{ sectionId: 'hero', label: 'Promo banner', selection: 'new-component', note: null }] });
    expect(isEmptySelection(sel)).toBe(false);
  });

  it('false when only globalCandidates has an entry', () => {
    const sel = validSelection({ selections: [], manualCandidates: [], globalCandidates: [{ patternId: 'pattern-2', findingIds: ['b'.repeat(32)], selection: 'global-shared', suggestion: null, note: null }] });
    expect(isEmptySelection(sel)).toBe(false);
  });
});
