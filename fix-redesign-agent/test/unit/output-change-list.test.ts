import { describe, expect, it } from 'vitest';
import type { FixPlanEntry } from '../../src/audit-link/index.ts';
import { renderChangeListMd, type ChangeListInput } from '../../src/output/change-list.ts';
import { makeFinding, makeFixPlanEntry } from '../helpers/fixture-audit-run.ts';

/**
 * `change-list.md` (§13, §8.1): "findings outside the scope are never dropped; they appear in
 * the change list with the reason." Every disposition — applied, unaddressed (with reason),
 * skipped, out-of-scope (with reason) — must show up somewhere, never silently missing.
 */

const findingA = makeFinding({ findingId: 'a'.repeat(32), section: 'Hero', label: 'Sign up' });
const findingB = makeFinding({ findingId: 'b'.repeat(32), section: 'Hero', label: 'Talk to us' });
const findingC = makeFinding({ findingId: 'c'.repeat(32), section: 'Footer', label: 'Subscribe' });
const findingD = makeFinding({ findingId: 'd'.repeat(32), section: 'Nav', label: 'Menu' });

function baseInput(overrides: Partial<ChangeListInput> = {}): ChangeListInput {
  const fixEntries: FixPlanEntry[] = [
    makeFixPlanEntry('a'.repeat(32), 'fix'),
    makeFixPlanEntry('b'.repeat(32), 'fix'),
    { ...makeFixPlanEntry('c'.repeat(32), 'skip'), note: 'reviewer decided this is out of scope for now' },
    makeFixPlanEntry('d'.repeat(32), 'keep_for_review'),
  ];
  return {
    fixFindings: [findingA, findingB],
    fixEntries,
    allFindings: [findingA, findingB, findingC, findingD],
    iterations: [
      {
        iteration: 1,
        plan: {
          iteration: 1,
          chunks: 1,
          usage: null,
          plan: { edits: [], unaddressed: [{ findingId: 'b'.repeat(32), reason: 'no safe targeted edit exists on this DOM' }] },
        },
        applied: {
          iteration: 1,
          after: { tiles: [], totalHeight: 0, truncated: false, composite: null },
          applied: [
            {
              edit: { findingId: 'a'.repeat(32), selector: '#a', expectedMatches: 1, kind: 'style', property: 'padding-left', value: '28px', removeValue: null, dsComponent: null, dsVariant: null, dsToken: '--button-px-md', rationale: 'close the padding mismatch', confidence: 0.9 },
              matched: 1,
              applied: true,
              previousValue: '12px',
              error: null,
            },
          ],
        },
        validation: {
          iteration: 1,
          checks: [{ findingId: 'a'.repeat(32), fixed: true, detail: 'padding now matches', measured: [] }],
          structural: { ok: true, lostInteractive: [], lostText: [], note: '' },
          vision: 'NOT_CHECKED',
          visionIssues: [],
          visionVerdicts: null,
          overall: 'PASS',
          failedChecks: [],
          usage: null,
        },
      },
    ],
    outOfScope: [{ findingId: 'c'.repeat(32), reason: 'section-not-selected' }],
    ...overrides,
  };
}

describe('renderChangeListMd', () => {
  it('lists an applied edit under "Applied", with its before/after value and verified-fixed status', () => {
    const md = renderChangeListMd(baseInput());
    const applied = md.slice(md.indexOf('## Applied'), md.indexOf('## Unaddressed'));
    expect(applied).toContain('Hero');
    expect(applied).toContain('button "Sign up"');
    expect(applied).toContain('verified fixed');
    expect(applied).toContain('style padding-left: "12px" → "28px" (close the padding mismatch)');
  });

  it('never lists a fix-decision finding under "Applied" when nothing was actually applied to it', () => {
    const md = renderChangeListMd(baseInput());
    const applied = md.slice(md.indexOf('## Applied'), md.indexOf('## Unaddressed'));
    expect(applied).not.toContain('Talk to us');
  });

  it('lists an unaddressed finding with its reason, under "Unaddressed"', () => {
    const md = renderChangeListMd(baseInput());
    const unaddressed = md.slice(md.indexOf('## Unaddressed'), md.indexOf('## Out of scope'));
    expect(unaddressed).toContain('Talk to us');
    expect(unaddressed).toContain('no safe targeted edit exists on this DOM');
  });

  it('never drops a finding outside the authorized scope — it appears under "Out of scope" with its reason (§8.1)', () => {
    const md = renderChangeListMd(baseInput());
    const outOfScope = md.slice(md.indexOf('## Out of scope'), md.indexOf('## Every fix decision'));
    expect(outOfScope).toContain('Subscribe');
    expect(outOfScope).toContain('section-not-selected');
  });

  it('lists EVERY fix-plan decision — including skip and keep_for_review — under "Every fix decision", so a "skipped" disposition is never invisible', () => {
    const md = renderChangeListMd(baseInput());
    const everyDecision = md.slice(md.indexOf('## Every fix decision'));
    expect(everyDecision).toContain('(fix)');
    expect(everyDecision).toContain('(skip)');
    expect(everyDecision).toContain('(keep_for_review)');
    expect(everyDecision).toContain('reviewer decided this is out of scope for now');
  });

  it('names an unknown finding id in the fix plan as "(unknown finding)" rather than omitting the line', () => {
    const withUnknown = baseInput({ fixEntries: [...baseInput().fixEntries, makeFixPlanEntry('z'.repeat(32), 'fix')] });
    const md = renderChangeListMd(withUnknown);
    const everyDecision = md.slice(md.indexOf('## Every fix decision'));
    expect(everyDecision).toContain('(unknown finding)');
  });

  it('renders "(none)" placeholders when there is nothing unaddressed and nothing out of scope', () => {
    const md = renderChangeListMd(baseInput({ iterations: [{ ...baseInput().iterations[0]!, plan: { ...baseInput().iterations[0]!.plan, plan: { edits: [], unaddressed: [] } } }], outOfScope: [] }));
    const unaddressed = md.slice(md.indexOf('## Unaddressed'), md.indexOf('## Out of scope'));
    const outOfScope = md.slice(md.indexOf('## Out of scope'), md.indexOf('## Every fix decision'));
    expect(unaddressed).toContain('(none)');
    expect(outOfScope).toContain('(none)');
  });
});
