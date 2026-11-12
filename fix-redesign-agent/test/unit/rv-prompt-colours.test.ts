import { describe, expect, it } from 'vitest';
import { describeResidual, SYSTEM_PROMPT } from '../../src/agents/rv-resolve-targets/index.ts';
import { inferElementKinds } from '../../src/reference/element-kind.ts';
import type { ResidualQuestion } from '../../src/resolution/resolve.ts';

/** Finding 3 in what the Resolver's judgment is told: the resolution order, that a reference colour is never raw, and what each candidate's colours map to. */

const inference = inferElementKinds({
  audit: { productionType: 'card', dsComponent: null, signals: [], possibleMatches: [] },
  mapping: { tagName: 'div', role: null, href: null, type: null, ariaExpanded: null, ariaControls: null, dsComponent: null, dsBasis: 'none' },
  structure: null,
});

const question = (candidates: ResidualQuestion['candidatePatterns'], backdrop: ResidualQuestion['backdrop'] = { color: 'rgb(255, 255, 255)', source: 'measured', why: null }): ResidualQuestion => ({
  findingId: 'f1', section: 'Blog', productionType: 'card', productionLabel: 'Plans', classification: 'NEEDS_REVIEW', reviewReason: null, signals: [], possibleMatches: [],
  dsReference: { dsComponent: null, dsVariant: null, basis: 'none' }, surface: 'light', backdrop, element: { selector: '[data-fra-element="e1"]', tag: 'div', role: null },
  properties: [], elementKinds: inference, candidatePatterns: candidates, candidatePatternsNote: null,
});

const base = { project: 'competition-benchmarking-v2-react', pattern: 'faq-accordion-row', purpose: 'light card separation', declarations: { border: '1px solid var(--faq-border)' }, preferred: true, elementKinds: ['card'] };

describe('RV prompt - reference colours', () => {
  it('states the resolution order: DS component first, then an approved reference for a real gap (used confidently), then a local composition, then unresolved', () => {
    const order = [/suitable existing DS component\/variant/i, /approved reference-project treatment for a REAL DS gap/, /do not redesign what an approved project already solved/, /local composition built only from DS tokens/, /unresolved, naming the specific evidence gap/];
    let at = -1;
    for (const re of order) {
      const m = re.exec(SYSTEM_PROMPT);
      expect(m, String(re)).not.toBeNull();
      expect(m!.index, String(re)).toBeGreaterThan(at);
      at = m!.index;
    }
    expect(SYSTEM_PROMPT).toMatch(/\[preferred\] is the first source for subtle borders/);
  });

  it('says a reference colour is never used raw, how it is mapped, and what to do with an unmappable candidate', () => {
    expect(SYSTEM_PROMPT).toMatch(/reference COLOUR is never used raw/);
    expect(SYSTEM_PROMPT).toMatch(/exact DS token of that value/);
    expect(SYSTEM_PROMPT).toMatch(/nearest SUITABLE one for that role on the real backdrop/);
    expect(SYSTEM_PROMPT).toMatch(/NOT MAPPABLE/);
    expect(SYSTEM_PROMPT).toMatch(/never relabel it a proposed local variant to keep the raw colour/);
    expect(SYSTEM_PROMPT).not.toMatch(/approval of a project does not make its hardcoded values DS guidance/);
  });

  it('shows each candidate\'s colour mapping and the measured backdrop', () => {
    const text = describeResidual(question([{ ...base, colourPreview: ['border: #f5f5f5 -> --color-ramp-black-100 (exact, primitive, ΔE 0)'], mappable: true, gap: null }]));
    expect(text).toMatch(/backdrop=rgb\(255, 255, 255\)/);
    expect(text).toMatch(/colours, previewed on the DS section backgrounds of a light surface.*--color-ramp-black-100 \(exact/);
    expect(text).not.toMatch(/NOT MAPPABLE/);
  });

  it('flags a candidate whose colours have no DS mapping, and a token ladder as evidence only', () => {
    const text = describeResidual(
      question([
        { ...base, pattern: 'odd', colourPreview: ['border: rgba(255,0,170,.5) -> NO DS MAPPING (no DS border token is a suitable match)'], mappable: false, gap: '1 reference colour problem(s): no DS border token' },
        { ...base, pattern: 'hairline-border-scale', evidenceOnly: true, mappable: false, gap: 'a token ladder: not applicable to a CSS property' },
      ], { color: null, source: 'ds-section-tokens', why: 'a background image or gradient on <section>' }),
    );
    expect(text).toMatch(/NOT MAPPABLE: 1 reference colour problem/);
    expect(text).toMatch(/evidence only: a token ladder/);
    expect(text).toMatch(/backdrop=unmeasured \(a background image or gradient on <section>\)/);
  });
});
