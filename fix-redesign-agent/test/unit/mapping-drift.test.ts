import { describe, expect, it } from 'vitest';
import { classifyDrift, type ClassifyDriftInput } from '../../src/mapping/drift.ts';
import type { Box } from '../../src/mapping/types.ts';

/** §6.5's six drift classes — pure, no browser needed. */

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });

const base: ClassifyDriftInput = {
  confidence: 'confirmed',
  auditBox: box(0, 0, 100, 100),
  liveBox: box(0, 0, 100, 100),
  styleComparisons: [],
  contentLooksChanged: false,
};

describe('classifyDrift', () => {
  it('absent: no candidate passed the objective checks', () => {
    const result = classifyDrift({ ...base, confidence: 'absent', liveBox: null });
    expect(result.class).toBe('absent');
    expect(result.styleDeltas).toEqual([]);
    expect(result.note).toBe('no candidate passed the objective checks — never guessed');
    expect(result.auditBox).toEqual(base.auditBox);
    expect(result.liveBox).toBeNull();
  });

  it('ambiguous: several candidates, none uniquely selected', () => {
    const result = classifyDrift({ ...base, confidence: 'ambiguous' });
    expect(result.class).toBe('ambiguous');
    expect(result.styleDeltas).toEqual([]);
    expect(result.note).toBe('several candidates remained after objective checks and the model sub-step, none uniquely selected');
  });

  it('identical: within tolerance on geometry, text and styles', () => {
    const result = classifyDrift(base);
    expect(result.class).toBe('identical');
    expect(result.styleDeltas).toEqual([]);
    expect(result.note).toBe('within tolerance on geometry, text and styles');
  });

  it('moved: geometry changed only, below the identical-geometry floor', () => {
    const result = classifyDrift({ ...base, liveBox: box(400, 400, 100, 100) });
    expect(result.class).toBe('moved');
    expect(result.styleDeltas).toEqual([]);
    expect(result.note).toBe('geometry changed; text and measured styles match the audit\'s record');
  });

  it('a small geometry shift stays within a custom identicalGeometryFloor', () => {
    // iou of box(0,0,100,100) vs box(2,0,100,100) is 98/102 ~ 0.9608 -> above a 0.9 floor, below the 0.98 default
    const stillIdentical = classifyDrift({ ...base, liveBox: box(2, 0, 100, 100), identicalGeometryFloor: 0.9 });
    expect(stillIdentical.class).toBe('identical');
    const nowMoved = classifyDrift({ ...base, liveBox: box(2, 0, 100, 100) });
    expect(nowMoved.class).toBe('moved');
  });

  it('restyled: computed styles differ from the audit\'s record, geometry unchanged', () => {
    const result = classifyDrift({
      ...base,
      styleComparisons: [
        { property: 'color', auditActual: 'rgb(0, 0, 0)', liveActual: 'rgb(176, 31, 36)' },
        { property: 'font-size', auditActual: '16px', liveActual: '16px' }, // unchanged -> not a delta
      ],
    });
    expect(result.class).toBe('restyled');
    expect(result.styleDeltas).toEqual([{ property: 'color', auditActual: 'rgb(0, 0, 0)', liveActual: 'rgb(176, 31, 36)' }]);
    expect(result.note).toBe("1 property differs from the audit's recorded computed style");
  });

  it('restyled note pluralizes for more than one delta', () => {
    const result = classifyDrift({
      ...base,
      styleComparisons: [
        { property: 'color', auditActual: 'a', liveActual: 'b' },
        { property: 'padding-top', auditActual: '4px', liveActual: '8px' },
      ],
    });
    expect(result.class).toBe('restyled');
    expect(result.note).toBe("2 properties differ from the audit's recorded computed style");
  });

  it('style comparisons are trimmed before being compared, so whitespace-only differences are not deltas', () => {
    const result = classifyDrift({ ...base, styleComparisons: [{ property: 'color', auditActual: ' red ', liveActual: 'red' }] });
    expect(result.class).toBe('identical');
    expect(result.styleDeltas).toEqual([]);
  });

  it('content-changed: takes priority over restyled/moved when content looks different', () => {
    const result = classifyDrift({
      ...base,
      liveBox: box(400, 400, 100, 100),
      styleComparisons: [{ property: 'color', auditActual: 'a', liveActual: 'b' }],
      contentLooksChanged: true,
    });
    expect(result.class).toBe('content-changed');
    // styleDeltas are still computed and carried, even though class is content-changed
    expect(result.styleDeltas).toEqual([{ property: 'color', auditActual: 'a', liveActual: 'b' }]);
    expect(result.note).toBe("text or child structure differs from the audit's record");
  });

  it('content-changed only authorized to proceed for a confirmed mapping per §6.5 — probable is recorded the same way here (the gate lives elsewhere)', () => {
    const result = classifyDrift({ ...base, confidence: 'probable', contentLooksChanged: true });
    expect(result.class).toBe('content-changed');
  });
});
