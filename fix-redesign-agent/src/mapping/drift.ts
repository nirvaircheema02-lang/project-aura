import type { Box, DriftClass, DriftRecord, StyleDelta } from './types.ts';
import { iou } from './objective-checks.ts';

/**
 * §6.5 — drift classification. Live-page state governs current structure/styles (§6.1); the
 * audit's own record of "actual" governs what was FOUND. When they disagree, that disagreement
 * is the drift record itself, never silently reconciled into one or the other.
 */

export interface ClassifyDriftInput {
  confidence: 'confirmed' | 'probable' | 'ambiguous' | 'absent';
  auditBox: Box | null;
  liveBox: Box | null;
  /** Every property the audit's `comparison.mismatches` named as "actual" at audit time, paired with the freshly-measured live value. */
  styleComparisons: Array<{ property: string; auditActual: string; liveActual: string }>;
  /** True when the live element's text/child structure looks meaningfully different from the audit's recorded label (already computed by the objective text check, inverted). */
  contentLooksChanged: boolean;
  identicalGeometryFloor?: number;
}

export function classifyDrift(input: ClassifyDriftInput): DriftRecord {
  if (input.confidence === 'absent') {
    return { class: 'absent', auditBox: input.auditBox, liveBox: input.liveBox, styleDeltas: [], note: 'no candidate passed the objective checks — never guessed' };
  }
  if (input.confidence === 'ambiguous') {
    return { class: 'ambiguous', auditBox: input.auditBox, liveBox: input.liveBox, styleDeltas: [], note: 'several candidates remained after objective checks and the model sub-step, none uniquely selected' };
  }

  const styleDeltas: StyleDelta[] = input.styleComparisons
    .filter((c) => c.auditActual.trim() !== c.liveActual.trim())
    .map((c) => ({ property: c.property, auditActual: c.auditActual, liveActual: c.liveActual }));

  if (input.contentLooksChanged) {
    return { class: 'content-changed', auditBox: input.auditBox, liveBox: input.liveBox, styleDeltas, note: 'text or child structure differs from the audit\'s record' };
  }
  if (styleDeltas.length > 0) {
    return { class: 'restyled', auditBox: input.auditBox, liveBox: input.liveBox, styleDeltas, note: `${styleDeltas.length} propert${styleDeltas.length === 1 ? 'y differs' : 'ies differ'} from the audit's recorded computed style` };
  }
  const identicalFloor = input.identicalGeometryFloor ?? 0.98;
  if (input.auditBox && input.liveBox && iou(input.auditBox, input.liveBox) < identicalFloor) {
    return { class: 'moved', auditBox: input.auditBox, liveBox: input.liveBox, styleDeltas, note: 'geometry changed; text and measured styles match the audit\'s record' };
  }
  return { class: 'identical', auditBox: input.auditBox, liveBox: input.liveBox, styleDeltas: [], note: 'within tolerance on geometry, text and styles' };
}
