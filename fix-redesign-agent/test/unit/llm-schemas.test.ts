import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { wireSchema } from '../../src/llm/client.ts';
import { CompareVerdictsSchema, RedesignPlanSchema } from '../../src/llm/schemas/r-nodes.ts';
import { AcceptanceReviewSchema } from '../../src/llm/schemas/l-nodes.ts';
import { JUDGMENT_SCHEMAS as SCHEMAS } from '../../src/judgment/schema-registry.ts';

/**
 * Every node schema goes to the API verbatim (llm/client.ts `wireSchema`) — in `anthropic-api`
 * mode directly, in `claude-session` mode as the JSON Schema recorded in a pending judgment
 * bundle for the Session Agent — so nothing filters what zod emits either way. This test is
 * the filter (mirrors audit-agent's own guard): a `.min()`, `.int()` or `.regex()` added later
 * would become a 400 (TERMINAL) on the first real call, or an unenforceable bundle schema.
 * Reuses `judgment/schema-registry.ts`'s own node→schema map so this can never silently drift
 * from what `judgment submit` actually validates against.
 */
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'default'];

function walk(node: unknown, visit: (n: Record<string, unknown>, path: string) => void, path = ''): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, visit, `${path}/${i}`));
  const obj = node as Record<string, unknown>;
  visit(obj, path);
  for (const [k, v] of Object.entries(obj)) walk(v, visit, `${path}/${k}`);
}

describe('every LLM-facing schema (R3, R5, C2, L2, L3) is valid structured-output JSON Schema on the wire', () => {
  for (const [node, schema] of Object.entries(SCHEMAS)) {
    it(`${node}: no unsupported keyword, every object closed with additionalProperties:false`, () => {
      const json = wireSchema(schema);
      expect(json).not.toHaveProperty('$schema');
      const problems: string[] = [];
      walk(json, (n, path) => {
        for (const k of UNSUPPORTED) if (k in n && path.split('/').at(-2) !== 'properties') problems.push(`${path || '<root>'}: ${k}`);
        if (n.type === 'object' && n.additionalProperties !== false) problems.push(`${path || '<root>'}: object without additionalProperties:false`);
      });
      expect(problems).toEqual([]);
    });
  }
});

describe('enums reach the API as enums, and every confidence states its scale', () => {
  const enumsOf = (schema: z.ZodType): unknown[] => {
    const found: unknown[] = [];
    walk(wireSchema(schema), (n) => {
      if (Array.isArray(n.enum)) found.push(...n.enum);
    });
    return found;
  };
  it('R3 edit kinds', () => expect(enumsOf(RedesignPlanSchema)).toEqual(expect.arrayContaining(['style', 'attribute', 'text', 'class', 'component-swap'])));
  it('R5 verdicts, severities, overall', () => expect(enumsOf(CompareVerdictsSchema)).toEqual(expect.arrayContaining(['FIXED', 'NOT_FIXED', 'UNCERTAIN', 'CRITICAL', 'CONFIRMED', 'REJECTED'])));
  it('L3 (AcceptanceReview) visionVerdict and regression severities', () => expect(enumsOf(AcceptanceReviewSchema)).toEqual(expect.arrayContaining(['CONFIRMED', 'UNCERTAIN', 'REJECTED', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'])));
  it('confidence descriptions carry 0..1', () => {
    const missing: string[] = [];
    for (const [node, schema] of Object.entries(SCHEMAS)) {
      walk(wireSchema(schema), (n, path) => {
        const props = n.properties as Record<string, { description?: string }> | undefined;
        if (props?.confidence && !/0\s*\.\.\s*1/.test(props.confidence.description ?? '')) missing.push(`${node}${path}`);
      });
    }
    expect(missing).toEqual([]);
  });
});
