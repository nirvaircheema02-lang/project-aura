import { describe, expect, it } from 'vitest';
import { deterministicJudgment } from '../../src/judgment/deterministic.ts';
import { JUDGMENT_SCHEMAS } from '../../src/judgment/schema-registry.ts';

const R3 = `Project rules...
findingId=F1
stampSelector=[data-fra-element="e32"]
section="S" type=badge label="Step 01" classification=DEVIATION
  resolved targets (the ONLY properties you may change):
    - color = rgba(0, 0, 0, 0.80) (token --surface-text-muted) — audit-expected: x.
    - text-transform = none — audit-expected: the audit measured text-transform as "none" against its own expected "none".
  not to be changed (resolved as preserve-existing/unresolved):
    - width: preserve-existing (no-ds-requirement)
  recommendation: Candidate correction

findingId=F2
stampSelector=[data-fra-element="e33"]
section="S" type=paragraph label="Body" classification=DEVIATION
  resolved targets (the ONLY properties you may change):
  not to be changed (resolved as preserve-existing/unresolved):
    - width: preserve-existing (no-ds-requirement)
`;

describe('deterministic judgment mode', () => {
  it('R3: each resolved target becomes a verbatim style edit on the finding\'s own stamp; a finding without targets is unaddressed', () => {
    const d = deterministicJudgment('R3', R3) as { edits: Array<Record<string, unknown>>; unaddressed: Array<{ findingId: string }> };
    expect(JUDGMENT_SCHEMAS.R3.safeParse(d).success).toBe(true);
    expect(d.edits.map((e) => [e.findingId, e.property, e.value, e.dsToken])).toEqual([['F1', 'color', 'rgba(0, 0, 0, 0.80)', '--surface-text-muted'], ['F1', 'text-transform', 'none', null]]);
    expect(d.edits.every((e) => e.selector === '[data-fra-element="e32"]')).toBe(true);
    expect(d.unaddressed.map((u) => u.findingId)).toEqual(['F2']);
  });
  it('R5: every finding is UNCERTAIN (the picture cannot settle it) and overall is UNCERTAIN — never FIXED', () => {
    const d = deterministicJudgment('R5', 'x\nfindingId=A section="S" button "x": a\nfindingId=B section="S" badge "y": b\n') as { verdicts: Array<{ verdict: string }>; overall: string };
    expect(JUDGMENT_SCHEMAS.R5.safeParse(d).success).toBe(true);
    expect(d.verdicts.map((v) => v.verdict)).toEqual(['UNCERTAIN', 'UNCERTAIN']);
    expect(d.overall).toBe('UNCERTAIN');
  });
  it('RV adds no decision; C2 picks nothing; unknown nodes are left to a Session Agent', () => {
    const rv = deterministicJudgment('RV', 'p');
    expect(JUDGMENT_SCHEMAS.RV.safeParse(rv).success).toBe(true);
    expect((rv as { decisions: unknown[] }).decisions).toEqual([]);
    const c2 = deterministicJudgment('C2', 'findingId=abc\nsection="x"\nfindingId=def\n') as { proposals: Array<{ selectedCandidateId: string | null }> };
    expect(JUDGMENT_SCHEMAS.C2.safeParse(c2).success).toBe(true);
    expect(c2.proposals.map((p) => p.selectedCandidateId)).toEqual([null, null]);
    expect(deterministicJudgment('L2', 'x')).toBeNull();
  });
});
