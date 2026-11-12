import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/audit-link/index.ts';
import type { AppliedEdit, IterationRecord } from '../../src/agents/types.ts';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import type { MappingEntry } from '../../src/mapping/types.ts';
import { expectedScope, finalAppliedEdits, finalPlannerGaps, findingProperties, planIslands, routeFindings, type IslandPlan } from '../../src/preview/plan.ts';
import type { ElementLayout, ExtractedSection, PreviewNode } from '../../src/preview/types.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';

const id = (c: string) => c.repeat(32);
const withDs = (f: Finding, dsComponent: string | null, dsVariant: string | null, productionType = f.component.productionType): Finding => ({ ...f, component: { ...f.component, dsComponent, dsVariant, productionType } });
const layout: ElementLayout = { display: 'inline-flex', margin: ['0px', '0px', '0px', '0px'], alignSelf: 'auto', flexGrow: '0', fullWidth: false };
const el = (tag: string, attrs: Record<string, string>, children: PreviewNode[], stamp?: string): PreviewNode => ({ t: 'el', tag, attrs, children, ...(stamp ? { elementStamp: stamp } : {}) }) as PreviewNode;
const text = (v: string): PreviewNode => ({ t: 'text', v });
const section = (idv: string, tree: PreviewNode, findingElements: ExtractedSection['findingElements']): ExtractedSection => ({ id: idv, name: idv, order: 0, unlabelled: false, tree, ancestors: [], text: '', visibleText: '', height: 100, locator: { cssPath: 'div', textStart: '', textLength: 0 }, links: [], images: 0, headings: [], findingElements });

describe('expectedScope — derived from the audit and the Fix Plan only', () => {
  const all = [
    makeFinding({ findingId: id('a'), section: 'Header' }),
    makeFinding({ findingId: id('b'), section: 'Hero' }),
    makeFinding({ findingId: id('c'), section: 'Pricing' }),
    makeFinding({ findingId: id('d'), section: 'Footer' }),
    makeFinding({ findingId: id('e'), section: 'FAQ' }),
  ];
  const fix = [all[0]!, all[1]!, all[3]!, all[4]!];

  it('Selected Sections: only sections that hold a Fix finding, in order, never Header/Footer, never an unselected section', () => {
    const s = expectedScope('selected-sections', all, fix);
    expect(s.expectedSectionIds).toEqual(['hero', 'faq']);
    expect(s.forbiddenSectionIds.sort()).toEqual(['footer', 'header', 'pricing']);
    expect(s.fixFindingsBySection).toEqual({ hero: [id('b')], faq: [id('e')] });
  });
  it('Full Page: every page-specific section, with global header and footer still excluded', () => {
    const s = expectedScope('full-page', all, fix);
    expect(s.expectedSectionIds).toEqual(['hero', 'pricing', 'faq']);
    expect(s.forbiddenSectionIds.sort()).toEqual(['footer', 'header']);
    expect(s.globalSectionIds.sort()).toEqual(['footer', 'header']);
  });
  it('a Fix finding that sits in the header or footer never pulls that section in', () => {
    const s = expectedScope('selected-sections', all, [all[0]!, all[3]!]);
    expect(s.expectedSectionIds).toEqual([]);
  });
  it('uses the same slug and collision rule as the mapper so ids line up with the stamps', () => {
    const twins = [makeFinding({ findingId: id('a'), section: 'Our Insights' }), makeFinding({ findingId: id('b'), section: 'Our  insights!' })];
    const s = expectedScope('selected-sections', twins, twins);
    expect(s.expectedSectionIds).toEqual(['our-insights', 'our-insights-2']);
  });
});

describe('finalAppliedEdits', () => {
  const edit = (findingId: string, property: string, value: string): TargetedEdit => ({ findingId, selector: '[data-fra-element="e1"]', expectedMatches: 1, kind: 'style', property, value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: '', confidence: 1 });
  const applied = (e: TargetedEdit, ok = true): AppliedEdit => ({ edit: e, applied: ok, matched: 1, previousValue: null, error: ok ? null : 'x' }) as AppliedEdit;
  const iteration = (list: AppliedEdit[]): IterationRecord => ({ iteration: 1, plan: {} as never, applied: { applied: list } as never, validation: {} as never });

  it('keeps edits that landed, drops refused ones, and lets a later iteration replace the same (finding, selector, property)', () => {
    const out = finalAppliedEdits([
      iteration([applied(edit('f1', 'color', 'red')), applied(edit('f1', 'padding', '4px'), false)]),
      iteration([applied(edit('f1', 'color', 'blue')), applied(edit('f2', 'color', 'green'))]),
    ]);
    expect(out.map((e) => `${e.findingId}:${e.property}=${e.value}`)).toEqual(['f1:color=blue', 'f2:color=green']);
  });
});

describe('finalAppliedEdits — an edit corrected after the rendered preview failed it', () => {
  const stamp = '[data-fra-element="e1"]';
  const edit = (findingId: string, property: string, value: string, selector = stamp): TargetedEdit => ({ findingId, selector, expectedMatches: 1, kind: 'style', property, value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: '', confidence: 1 });
  const applied = (e: TargetedEdit, ok = true): AppliedEdit => ({ edit: e, applied: ok, matched: 1, previousValue: null, error: ok ? null : 'x' }) as AppliedEdit;
  const iteration = (list: AppliedEdit[], reopened?: NonNullable<IterationRecord['reopened']>): IterationRecord => ({ iteration: 1, plan: {} as never, applied: { applied: list } as never, validation: {} as never, ...(reopened ? { reopened } : {}) });
  const show = (edits: TargetedEdit[]) => edits.map((e) => `${e.property}=${e.value}@${e.selector.replace(stamp, 'stamp')}`);

  it('without a reopened record a different selector adds a second edit (unchanged behaviour)', () => {
    expect(show(finalAppliedEdits([iteration([applied(edit('f1', 'padding-left', '12px'))]), iteration([applied(edit('f1', 'padding-left', '28px', `${stamp} span`))])]))).toEqual(['padding-left=12px@stamp', 'padding-left=28px@stamp span']);
  });

  it('the corrected edit REPLACES the failing one even on another selector; the edits of other properties survive', () => {
    const out = finalAppliedEdits([
      iteration([applied(edit('f1', 'padding-left', '12px')), applied(edit('f1', 'font-weight', '500'))]),
      iteration([applied(edit('f1', 'padding-left', '28px', `${stamp} span`))], [{ findingId: 'f1', property: 'padding-left', state: 'default' }]),
    ]);
    expect(show(out)).toEqual(['font-weight=500@stamp', 'padding-left=28px@stamp span']);
  });

  it('a corrected edit that did not land leaves the earlier edit in force', () => {
    const out = finalAppliedEdits([
      iteration([applied(edit('f1', 'padding-left', '12px'))]),
      iteration([applied(edit('f1', 'padding-left', '28px', `${stamp} span`), false)], [{ findingId: 'f1', property: 'padding-left', state: 'default' }]),
    ]);
    expect(show(out)).toEqual(['padding-left=12px@stamp']);
  });

  it('another state, another property and another finding are never retired', () => {
    const out = finalAppliedEdits([
      iteration([applied(edit('f1', 'padding-left', '12px', `${stamp}:hover`)), applied(edit('f1', 'padding-right', '12px')), applied(edit('f2', 'padding-left', '12px')), applied(edit('f1', 'padding-left', '12px'))]),
      iteration([applied(edit('f1', 'padding-left', '28px', `${stamp} span`))], [{ findingId: 'f1', property: 'padding-left', state: 'default' }]),
    ]);
    expect(show(out)).toEqual(['padding-left=12px@stamp:hover', 'padding-right=12px@stamp', 'padding-left=12px@stamp', 'padding-left=28px@stamp span']);
  });

  it('a restore of one longhand retires only edits within that property: the shorthand edit stays, and the later longhand rule wins', () => {
    const out = finalAppliedEdits([
      iteration([applied(edit('f1', 'padding', '4px 28px')), applied(edit('f1', 'padding-left', '28px'))]),
      iteration([applied(edit('f1', 'padding-left', '12px'))], [{ findingId: 'f1', property: 'padding-left', state: 'default' }]),
    ]);
    expect(show(out)).toEqual(['padding=4px 28px@stamp', 'padding-left=12px@stamp']);
  });

  it('only the edit the correction actually overrides is retired: two same-property edits on sibling descendants both survive when one of them is corrected on a deeper element', () => {
    const out = finalAppliedEdits([
      iteration([applied(edit('f1', 'color', 'red', `${stamp} h2`)), applied(edit('f1', 'color', 'red', `${stamp} p`))]),
      iteration([applied(edit('f1', 'color', 'blue', `${stamp} h2 span`))], [{ findingId: 'f1', property: 'color', state: 'default' }]),
    ]);
    expect(show(out)).toEqual(['color=red@stamp p', 'color=blue@stamp h2 span']);
  });

  it('a correction retires the bare stamp edit, an ancestor of its own selector and an identical selector, but never a sibling or a descendant of it', () => {
    const out = finalAppliedEdits([
      iteration([
        applied(edit('f1', 'color', '1', stamp)),
        applied(edit('f1', 'color', '2', `${stamp} section`)),
        applied(edit('f1', 'color', '3', `${stamp} section > h2`)),
        applied(edit('f1', 'color', '4', `${stamp} section > h2 span b`)),
        applied(edit('f1', 'color', '5', `${stamp} section > p`)),
        applied(edit('f1', 'color', '6', `${stamp} section2`)),
      ]),
      iteration([applied(edit('f1', 'color', 'blue', `${stamp} section > h2 span`))], [{ findingId: 'f1', property: 'color', state: 'default' }]),
    ]);
    expect(show(out)).toEqual(['color=4@stamp section > h2 span b', 'color=5@stamp section > p', 'color=6@stamp section2', 'color=blue@stamp section > h2 span']);
  });

  it('a hover correction retires the bare hover edit of the stamp, not a sibling descendant hover edit', () => {
    const out = finalAppliedEdits([
      iteration([applied(edit('f1', 'color', 'red', `${stamp}:hover`)), applied(edit('f1', 'color', 'red', `${stamp} a:hover`)), applied(edit('f1', 'color', 'red', `${stamp} b:hover`))]),
      iteration([applied(edit('f1', 'color', 'blue', `${stamp} a span:hover`))], [{ findingId: 'f1', property: 'color', state: 'hover' }]),
    ]);
    expect(show(out)).toEqual(['color=red@stamp b:hover', 'color=blue@stamp a span:hover']);
  });

  it('a pass that lands a correction and has a sibling edit refused: the correction replaces the failing edit, the refused edit never enters, the other descendant stays', () => {
    const out = finalAppliedEdits([
      iteration([applied(edit('f1', 'color', 'red', `${stamp} h2`)), applied(edit('f1', 'color', 'red', `${stamp} p`))]),
      iteration([applied(edit('f1', 'color', 'blue', `${stamp} h2 span`)), applied(edit('f1', 'margin-top', '40px'), false)], [{ findingId: 'f1', property: 'color', state: 'default' }]),
    ]);
    expect(show(out)).toEqual(['color=red@stamp p', 'color=blue@stamp h2 span']);
  });

  it('a corrected shorthand retires the earlier longhand edits it overrides inside the reopened property', () => {
    const out = finalAppliedEdits([
      iteration([applied(edit('f1', 'padding-left', '12px')), applied(edit('f1', 'padding-right', '12px'))]),
      iteration([applied(edit('f1', 'padding', '4px 28px', `${stamp} span`))], [{ findingId: 'f1', property: 'padding', state: 'default' }]),
    ]);
    expect(show(out)).toEqual(['padding=4px 28px@stamp span']);
  });

  describe('the failing target\'s part decides whether the bare-stamp edit is retired', () => {
    const colourOnStamp = () => iteration([applied(edit('f1', 'color', 'red'))]);
    const correction = (part?: string | null) => iteration([applied(edit('f1', 'color', 'blue', `${stamp} h2`))], [{ findingId: 'f1', property: 'color', state: 'default', ...(part !== undefined ? { part } : {}) }]);

    it('a label (descendant) part correction keeps the bare-stamp edit that still satisfies the element\'s own target', () => {
      expect(show(finalAppliedEdits([colourOnStamp(), correction('label')]))).toEqual(['color=red@stamp', 'color=blue@stamp h2']);
    });

    it('a named or descendants part keeps it too', () => {
      expect(show(finalAppliedEdits([colourOnStamp(), correction('descendants')]))).toEqual(['color=red@stamp', 'color=blue@stamp h2']);
      expect(show(finalAppliedEdits([colourOnStamp(), correction('icon')]))).toEqual(['color=red@stamp', 'color=blue@stamp h2']);
    });

    it('a self part retires it: the descendant edit is the cure for the element itself', () => {
      expect(show(finalAppliedEdits([colourOnStamp(), correction('self')]))).toEqual(['color=blue@stamp h2']);
    });

    it('a null part is NOT the element itself: a default-regression names no part, and its restore usually lands on the descendant an inherited property leaked into — the stamp edit that satisfies the element\'s own target stays', () => {
      expect(show(finalAppliedEdits([colourOnStamp(), correction(null)]))).toEqual(['color=red@stamp', 'color=blue@stamp h2']);
    });

    it('a record without the field at all (older than parts) still means the element itself', () => {
      expect(show(finalAppliedEdits([colourOnStamp(), correction()]))).toEqual(['color=blue@stamp h2']);
    });

    it('a null part still lets a restore on the SAME selector (or an ancestor of its own) replace the offending edit', () => {
      const sameStamp = iteration([applied(edit('f1', 'color', 'black'))], [{ findingId: 'f1', property: 'color', state: 'default', part: null }]);
      expect(show(finalAppliedEdits([colourOnStamp(), sameStamp]))).toEqual(['color=black@stamp']);
      const out = finalAppliedEdits([
        iteration([applied(edit('f1', 'color', 'green', `${stamp} h2`))]),
        iteration([applied(edit('f1', 'color', 'blue', `${stamp} h2 span`))], [{ findingId: 'f1', property: 'color', state: 'default', part: null }]),
      ]);
      expect(show(out)).toEqual(['color=blue@stamp h2 span']);
    });

    it('a label-part correction still retires an edit on the very same selector and on an ancestor of its own (those are not the stamp edit)', () => {
      const out = finalAppliedEdits([
        iteration([applied(edit('f1', 'color', 'red')), applied(edit('f1', 'color', 'green', `${stamp} h2`)), applied(edit('f1', 'color', 'teal', `${stamp} h2 span`))]),
        iteration([applied(edit('f1', 'color', 'blue', `${stamp} h2 span`))], [{ findingId: 'f1', property: 'color', state: 'default', part: 'label' }]),
      ]);
      expect(show(out)).toEqual(['color=red@stamp', 'color=blue@stamp h2 span']);
    });

    it('a hover label correction keeps the bare hover edit of the stamp', () => {
      const out = finalAppliedEdits([
        iteration([applied(edit('f1', 'color', 'red', `${stamp}:hover`))]),
        iteration([applied(edit('f1', 'color', 'blue', `${stamp} a:hover`))], [{ findingId: 'f1', property: 'color', state: 'hover', part: 'label' }]),
      ]);
      expect(show(out)).toEqual(['color=red@stamp:hover', 'color=blue@stamp a:hover']);
    });
  });
});

describe('finalPlannerGaps — the planner\'s recorded conflicts that are still in force', () => {
  const plan = (edits: string[], unaddressed: Array<[string, string]>): IterationRecord => ({ iteration: 1, plan: { iteration: 1, plan: { edits: edits.map((findingId) => ({ findingId }) as TargetedEdit), unaddressed: unaddressed.map(([findingId, reason]) => ({ findingId, reason })) }, chunks: 1, usage: null }, applied: {} as never, validation: {} as never });
  it('the last iteration that planned a finding decides: a later edit-only plan closes the gap, a later unaddressed entry replaces the reason', () => {
    const gaps = finalPlannerGaps([plan(['a'], [['a', 'old reason'], ['b', 'b conflict']]), plan(['a'], [['b', 'b conflict again']])]);
    expect(gaps).toEqual([{ findingId: 'b', reason: 'b conflict again' }]);
  });
  it('is empty when nothing was left unaddressed', () => {
    expect(finalPlannerGaps([plan(['a'], [])])).toEqual([]);
  });

  describe('a pass that re-planned from rendered-preview feedback (reopened)', () => {
    const stamp = '[data-fra-element="e1"]';
    const e = (findingId: string, property: string, selector = stamp, state?: string): TargetedEdit => ({ findingId, selector: state ? `${selector}:${state}` : selector, expectedMatches: 1, kind: 'style', property, value: '1px', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: '', confidence: 1 });
    const reopenedPass = (landed: TargetedEdit[], refused: TargetedEdit[], unaddressed: Array<[string, string]>, reopened: NonNullable<IterationRecord['reopened']>): IterationRecord => ({
      iteration: 2,
      plan: { iteration: 2, plan: { edits: landed, unaddressed: unaddressed.map(([findingId, reason]) => ({ findingId, reason })) }, chunks: 1, usage: null },
      applied: { applied: [...landed.map((x) => ({ edit: x, applied: true, matched: 1 })), ...refused.map((x) => ({ edit: x, applied: false, matched: 0 }))] } as never,
      validation: {} as never,
      reopened,
    });
    const first = plan([], [['f1', 'no basis in the first pass']]);

    it('drops the gap when the pass landed a correction for the reopened finding: a refused sibling edit ("outside the preview feedback scope") must not explain away a target the correction was meant to fix', () => {
      const pass = reopenedPass([e('f1', 'padding-left', `${stamp} span`)], [], [['f1', 'outside the preview feedback scope (property/state)']], [{ findingId: 'f1', property: 'padding-left', state: 'default' }]);
      expect(finalPlannerGaps([first, pass])).toEqual([]);
    });

    it('keeps the gap when no correction landed (nothing was corrected, so the reason still stands)', () => {
      const pass = reopenedPass([], [], [['f1', 'no selector reaches the visible text']], [{ findingId: 'f1', property: 'padding-left', state: 'default' }]);
      expect(finalPlannerGaps([first, pass])).toEqual([{ findingId: 'f1', reason: 'no selector reaches the visible text' }]);
    });

    it('keeps the gap when a landed correction covers only some of the reopened properties: the reason may explain the uncorrected one', () => {
      const pass = reopenedPass([e('f1', 'padding-left', `${stamp} span`)], [], [['f1', 'the mobile viewport cannot be planned']], [{ findingId: 'f1', property: 'padding-left', state: 'default' }, { findingId: 'f1', property: 'color', state: 'hover' }]);
      expect(finalPlannerGaps([first, pass])).toEqual([{ findingId: 'f1', reason: 'the mobile viewport cannot be planned' }]);
    });

    it('a correction of another finding or another state does not close this finding\'s gap', () => {
      const pass = reopenedPass([e('f2', 'padding-left', `${stamp} span`), e('f1', 'padding-left', stamp, 'hover')], [], [['f1', 'stays']], [{ findingId: 'f1', property: 'padding-left', state: 'default' }]);
      expect(finalPlannerGaps([pass])).toEqual([{ findingId: 'f1', reason: 'stays' }]);
    });

    describe('only the gaps that belong to the reopened property are retired', () => {
      const POLICY = 'Project redesign policy: black CTA fill is prohibited; use the existing red brand variant.';
      const reopenedPadding: NonNullable<IterationRecord['reopened']> = [{ findingId: 'f1', property: 'padding-left', state: 'default' }];
      const landed = () => [e('f1', 'padding-left', `${stamp} span`)];

      it('keeps an older project-policy refusal beside a landed correction of another property', () => {
        const pass = reopenedPass(landed(), [], [], reopenedPadding);
        expect(finalPlannerGaps([plan([], [['f1', POLICY]]), pass])).toEqual([{ findingId: 'f1', reason: POLICY }]);
      });

      it('keeps an older gap that names ANOTHER property of the finding, drops the one that names the reopened property or none', () => {
        const withFontWeight: IterationRecord = { ...plan([], [['f1', 'font-weight cannot be satisfied: the two tokens conflict']]), plan: { iteration: 1, plan: { edits: [{ ...e('f1', 'font-weight') }], unaddressed: [{ findingId: 'f1', reason: 'font-weight cannot be satisfied: the two tokens conflict' }] }, chunks: 1, usage: null } };
        const pass = reopenedPass(landed(), [], [], reopenedPadding);
        expect(finalPlannerGaps([withFontWeight, pass])).toEqual([{ findingId: 'f1', reason: 'font-weight cannot be satisfied: the two tokens conflict' }]);
        const namesReopened = plan([], [['f1', 'padding-left has no selector that reaches the text']]);
        expect(finalPlannerGaps([namesReopened, pass])).toEqual([]);
      });

      it('a longhand and its shorthand are the same property for this: a gap naming "padding" belongs to a reopened padding-left', () => {
        const pass = reopenedPass(landed(), [], [], reopenedPadding);
        const shorthand = { ...plan([], [['f1', 'padding is set by two conflicting tokens']]), plan: { iteration: 1, plan: { edits: [e('f1', 'padding')], unaddressed: [{ findingId: 'f1', reason: 'padding is set by two conflicting tokens' }] }, chunks: 1, usage: null } } as IterationRecord;
        expect(finalPlannerGaps([shorthand, pass])).toEqual([]);
      });

      it('what the corrected pass itself refused is filtered the same way: the scope refusal naming the reopened property goes, a policy refusal stays', () => {
        const pass = reopenedPass(landed(), [], [['f1', 'outside the preview feedback scope (property/state): the rendered preview failed padding-left (default state); margin-top in the default state is not one of them'], ['f1', POLICY]], reopenedPadding);
        expect(finalPlannerGaps([first, pass])).toEqual([{ findingId: 'f1', reason: POLICY }]);
      });

      it('several kept reasons of one finding stay one entry per finding (the consumer keys gaps by finding id)', () => {
        const pass = reopenedPass(landed(), [], [['f1', 'Project redesign policy: second refusal']], reopenedPadding);
        expect(finalPlannerGaps([plan([], [['f1', POLICY]]), pass])).toEqual([{ findingId: 'f1', reason: `${POLICY} | Project redesign policy: second refusal` }]);
      });

      describe('a gap that names a property the finding carries but the plan never edited', () => {
        // the usual conflict gap: "pick one mismatch and put the OTHER in unaddressed, naming the conflict"
        const conflict = 'margin-top conflicts with the card gap token';
        const pass = () => reopenedPass(landed(), [], [], reopenedPadding);
        const firstWithConflict = () => ({ ...plan([], [['f1', conflict]]), plan: { iteration: 1, plan: { edits: [e('f1', 'padding-left')], unaddressed: [{ findingId: 'f1', reason: conflict }] }, chunks: 1, usage: null } }) as IterationRecord;

        it('stays when the property is one of the finding\'s MISMATCHES, beside a correction of another property', () => {
          expect(finalPlannerGaps([firstWithConflict(), pass()], new Map([['f1', ['padding-left', 'margin-top']]]))).toEqual([{ findingId: 'f1', reason: conflict }]);
        });

        it('stays when the property is one of its RESOLVED TARGETS, and the policy refusal still stands', () => {
          expect(finalPlannerGaps([firstWithConflict(), pass()], new Map([['f1', ['margin-top']]]))).toEqual([{ findingId: 'f1', reason: conflict }]);
          const polite = { ...plan([], [['f1', POLICY]]), plan: { iteration: 1, plan: { edits: [e('f1', 'padding-left')], unaddressed: [{ findingId: 'f1', reason: POLICY }] }, chunks: 1, usage: null } } as IterationRecord;
          expect(finalPlannerGaps([polite, pass()], new Map([['f1', ['margin-top']]]))).toEqual([{ findingId: 'f1', reason: POLICY }]);
        });

        it('a gap that names the reopened property AND a declared property nobody edited stands: it closes only when every property it names was corrected', () => {
          const names = plan([], [['f1', 'padding-left cannot reach the text; margin-top is fine']]);
          expect(finalPlannerGaps([names, pass()], new Map([['f1', ['padding-left', 'margin-top']]]))).toEqual([{ findingId: 'f1', reason: 'padding-left cannot reach the text; margin-top is fine' }]);
          // (what the finding does not carry as margin-top is no property of it: the same text then names only the corrected one and closes)
          expect(finalPlannerGaps([names, pass()], new Map([['f1', ['padding-left']]]))).toEqual([]);
        });

        it('the planner\'s usual conflict reason names BOTH properties ("margin-top conflicts with padding-left"): it keeps explaining the deliberately unedited one', () => {
          const both = 'margin-top conflicts with padding-left: both cannot hold, kept padding-left';
          const first = { ...plan([], [['f1', both]]), plan: { iteration: 1, plan: { edits: [e('f1', 'padding-left')], unaddressed: [{ findingId: 'f1', reason: both }] }, chunks: 1, usage: null } } as IterationRecord;
          expect(finalPlannerGaps([first, pass()], new Map([['f1', ['padding-left', 'margin-top']]]))).toEqual([{ findingId: 'f1', reason: both }]);
          // the resolved-target route (no mismatch) is the same
          expect(finalPlannerGaps([first, pass()], new Map([['f1', ['margin-top']]]))).toEqual([{ findingId: 'f1', reason: both }]);
        });

        it('a named property that HAS a landed edit (it was addressed) does not keep the gap standing, even though this pass did not reopen it', () => {
          const both = 'margin-top conflicts with padding-left: both cannot hold';
          const landedFirst: IterationRecord = { iteration: 1, plan: { iteration: 1, plan: { edits: [e('f1', 'padding-left'), e('f1', 'margin-top')], unaddressed: [{ findingId: 'f1', reason: both }] }, chunks: 1, usage: null }, applied: { applied: [{ edit: e('f1', 'padding-left'), applied: true, matched: 1 }, { edit: e('f1', 'margin-top'), applied: true, matched: 1 }] } as never, validation: {} as never };
          expect(finalPlannerGaps([landedFirst, pass()], new Map([['f1', ['padding-left', 'margin-top']]]))).toEqual([]);
          // a REFUSED edit is not a landed one
          const refusedFirst: IterationRecord = { ...landedFirst, applied: { applied: [{ edit: e('f1', 'padding-left'), applied: true, matched: 1 }, { edit: e('f1', 'margin-top'), applied: false, matched: 0 }] } as never };
          expect(finalPlannerGaps([refusedFirst, pass()], new Map([['f1', ['padding-left', 'margin-top']]]))).toEqual([{ findingId: 'f1', reason: both }]);
        });

        it('a shorthand and its longhands count as one property here too: a landed `border-radius` covers a named border-top-left-radius', () => {
          const both = 'border-top-left-radius conflicts with padding-left';
          const landedFirst: IterationRecord = { iteration: 1, plan: { iteration: 1, plan: { edits: [e('f1', 'border-radius')], unaddressed: [{ findingId: 'f1', reason: both }] }, chunks: 1, usage: null }, applied: { applied: [{ edit: e('f1', 'border-radius'), applied: true, matched: 1 }] } as never, validation: {} as never };
          expect(finalPlannerGaps([landedFirst, pass()], new Map([['f1', ['padding-left', 'border-top-left-radius']]]))).toEqual([]);
        });

        it('a gap naming no property of the finding is still closed by the correction', () => {
          expect(finalPlannerGaps([plan([], [['f1', 'the first plan had no basis']]), pass()], new Map([['f1', ['margin-top']]]))).toEqual([]);
        });
      });

      describe('a property that is not a CSS identifier never breaks the scoping (non-style edits carry arbitrary property strings)', () => {
        const attr = (property: string): TargetedEdit => ({ ...e('f1', 'padding-left'), kind: 'attribute', property, value: 'x' });
        const planWith = (edits: TargetedEdit[], reason: string) => ({ ...plan([], [['f1', reason]]), plan: { iteration: 1, plan: { edits, unaddressed: [{ findingId: 'f1', reason }] }, chunks: 1, usage: null } }) as IterationRecord;

        it.each(['data-x(', '*', '[', '\\', 'a|b', '.+'])('an attribute edit whose property is %j', (property) => {
          const first = planWith([attr(property), e('f1', 'padding-left')], 'color is blocked by the surface');
          expect(() => finalPlannerGaps([first, reopenedPass(landed(), [], [], reopenedPadding)])).not.toThrow();
          // the gap names no style property of the finding: closed by the correction, as for any property-less reason
          expect(finalPlannerGaps([first, reopenedPass(landed(), [], [], reopenedPadding)], new Map([['f1', [property]]]))).toEqual([]);
        });

        it('metacharacters in a declared property are literal: "margin-top(" is matched as text, not as a pattern', () => {
          const reason = 'margin-top( conflicts';
          const first = planWith([e('f1', 'padding-left')], reason);
          expect(finalPlannerGaps([first, reopenedPass(landed(), [], [], reopenedPadding)], new Map([['f1', ['margin-top(']]]))).toEqual([{ findingId: 'f1', reason }]);
        });
      });

      it('a pass that landed no correction still replaces the earlier reason (the last planning decides, unchanged)', () => {
        const pass = reopenedPass([], [], [['f1', 'no selector reaches the visible text']], reopenedPadding);
        expect(finalPlannerGaps([plan([], [['f1', POLICY]]), pass])).toEqual([{ findingId: 'f1', reason: 'no selector reaches the visible text' }]);
      });
    });
  });
});

describe('findingProperties — what each finding carries, for scoping its planner gaps', () => {
  it('lists the mismatch properties and the resolved-target properties per finding, lower-cased and de-duplicated', () => {
    const f = makeFinding({ findingId: id('a'), mismatches: [{ property: 'Padding-Left', actual: '1px', expected: '2px', expectedToken: null, comparison: 'length-px', delta: 1 }, { property: 'margin-top', actual: '1px', expected: '2px', expectedToken: null, comparison: 'length-px', delta: 1 }] });
    const resolution = { targets: [{ findingId: id('a'), property: 'margin-top' }, { findingId: id('a'), property: 'color' }, { findingId: id('b'), property: 'gap' }] } as never;
    expect(findingProperties([f], resolution)).toEqual(new Map([[id('a'), ['padding-left', 'margin-top', 'color']], [id('b'), ['gap']]]));
    expect(findingProperties([f], null)).toEqual(new Map([[id('a'), ['padding-left', 'margin-top']]]));
    expect(findingProperties([], { targets: [{ findingId: id('a'), property: ' ' }] } as never)).toEqual(new Map());
  });
});

describe('planIslands — design-system components only where the audit verified them', () => {
  const button = (variant: string, tag = 'a') => ({ finding: withDs(makeFinding({ findingId: id('a') }), 'Button', variant), node: el(tag, { href: '/go', class: 'cta' }, [text('Talk to us')], 'e1') });
  const plan = (finding: Finding, node: PreviewNode, layoutOver: Partial<ElementLayout> = {}, decisions: Parameters<typeof planIslands>[0]['decisions'] = null) =>
    planIslands({ sections: [section('hero', el('div', {}, [node]), [{ stamp: 'e1', findingIds: [finding.identity.findingId], tag: node.t === 'el' ? node.tag : 'a', textAlign: 'left', layout: { ...layout, ...layoutOver } }])], entries: [] as MappingEntry[], findings: [finding], decisions });

  it('mounts Button brand / secondary / ghost from the audit match, with the link target and the surface prop', () => {
    const { finding, node } = button('brand · md · dark');
    const { plans } = plan(finding, node);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.spec).toEqual({ component: 'Button', props: { variant: 'brand', size: 'md', background: 'dark', href: '/go' } });
    expect(plans[0]!.label).toBe('Talk to us');
  });
  it('NEVER substitutes the prohibited black Button primary, and says why', () => {
    const { finding, node } = button('primary · md · light');
    const out = plan(finding, node);
    expect(out.plans).toHaveLength(0);
    expect(out.skipped[0]!.reason).toMatch(/primary/);
  });
  it('carries the original full-width layout so the component keeps its place', () => {
    const { finding, node } = button('brand · sm · light', 'button');
    const out = plan(finding, node, { fullWidth: true, display: 'flex' });
    expect(out.plans[0]!.spec.props['fullWidth']).toBe(true);
    expect(out.plans[0]!.layout.display).toBe('flex');
  });
  it('does not replace a wrapper element that is not the interactive container', () => {
    const { finding } = button('brand · md · light');
    const out = plan(finding, el('div', {}, [text('Talk to us')], 'e1'));
    expect(out.plans).toHaveLength(0);
    expect(out.skipped[0]!.reason).toMatch(/not the interactive container/);
  });
  it('mounts SectionHeading with the level and the original alignment', () => {
    const finding = withDs(makeFinding({ findingId: id('h') }), 'SectionHeading', 'level 2', 'section-heading');
    const node = el('h2', {}, [text('Pricing')], 'e1');
    const { plans } = planIslands({ sections: [section('hero', el('div', {}, [node]), [{ stamp: 'e1', findingIds: [id('h')], tag: 'h2', textAlign: 'center', layout }])], entries: [], findings: [finding], decisions: null });
    expect(plans[0]!.spec).toEqual({ component: 'SectionHeading', props: { level: 2, align: 'center' } });
  });
  it('a recorded decision to preserve the original means no island; an explicit island wins over the audit match', () => {
    const { finding, node } = button('brand · md · light');
    const preserve = plan(finding, node, {}, { schemaVersion: 1, findings: { [id('a')]: { resolution: 'preserve-existing', note: 'keep' } } });
    expect(preserve.plans).toHaveLength(0);
    const explicit = plan(finding, node, {}, { schemaVersion: 1, findings: { [id('a')]: { resolution: 'reuse-existing', island: { component: 'Button', props: { variant: 'secondary', size: 'lg', background: 'dark' } } } } });
    expect(explicit.plans[0]!.basis).toBe('decision');
    expect(explicit.plans[0]!.spec.props['variant']).toBe('secondary');
  });
});

describe('routeFindings — how each Fix finding is delivered', () => {
  const f = (c: string, section = 'Hero') => makeFinding({ findingId: id(c), section });
  const entry = (c: string): MappingEntry => ({ element: `e-${c}`, stamp: `e-${c}`, findingIds: [id(c)] }) as MappingEntry;
  const edit = (c: string): TargetedEdit => ({ findingId: id(c), selector: '', expectedMatches: 1, kind: 'style', property: 'color', value: 'red', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: '', confidence: 1 });
  const islandFor = (c: string): IslandPlan => ({ slot: 'island1', stamp: `e-${c}`, sectionId: 'hero', findingIds: [id(c)], spec: { component: 'Button', props: {} }, label: 'x', basis: 'audit-match', layout });

  it('css-edit, island, override, original (mapped but untouched) and none (no live element)', () => {
    const routes = routeFindings({
      fixFindings: [f('a'), f('b'), f('c', 'Pricing'), f('d'), f('e')],
      entries: [entry('a'), entry('b'), entry('c'), entry('d')],
      edits: [edit('a')],
      islands: [islandFor('b')],
      sectionIdByName: (n) => n.toLowerCase(),
      overrides: { pricing: 'preview-overrides/Pricing.tsx' },
    });
    expect([...routes].map(([k, v]) => [k[0], v.route])).toEqual([['a', 'css-edit'], ['b', 'island'], ['c', 'override'], ['d', 'original'], ['e', 'none']]);
    expect(routes.get(id('e'))!.stamp).toBeNull();
  });
});
