import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { wireSchema } from '../../src/llm/client.ts';
import { B1SectionsSchema, B2ComponentsSchema, B3MatchesSchema, B4ExpectationsSchema, B5VerdictsSchema, B6EvaluationsSchema } from '../../src/llm/schemas/b-nodes.ts';
import { TemplateMapSchema } from '../../src/agents/a2-template-classifier/index.ts';
import { RootCauseSchema } from '../../src/agents/a4-site-consolidator/index.ts';

/**
 * Every node schema goes to the API verbatim (llm/client.ts `wireSchema`),
 * because the SDK helper silently turned every enum into description text. The
 * price of verbatim is that nothing filters what zod emits — so this test is
 * the filter: a `.min()`, `.int()` or `.regex()` added to any schema later
 * would otherwise become a 400 (TERMINAL) on the first real call.
 */

const SCHEMAS: Record<string, z.ZodType> = {
  B1: B1SectionsSchema,
  B2: B2ComponentsSchema,
  B3: B3MatchesSchema,
  B4: B4ExpectationsSchema,
  B5: B5VerdictsSchema,
  B6: B6EvaluationsSchema,
  A2: TemplateMapSchema,
  A4: RootCauseSchema,
};

// Structured outputs: numeric constraints, string constraints and complex array constraints are not supported.
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'default'];

function walk(node: unknown, visit: (n: Record<string, unknown>, path: string) => void, path = ''): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, visit, `${path}/${i}`));
  const obj = node as Record<string, unknown>;
  visit(obj, path);
  for (const [k, v] of Object.entries(obj)) walk(v, visit, `${path}/${k}`);
}

describe('node schemas are valid structured-output JSON Schema on the wire', () => {
  for (const [node, schema] of Object.entries(SCHEMAS)) {
    it(`${node}: no unsupported keyword, and every object closed with additionalProperties:false`, () => {
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

describe('enums reach the API as enums, not as description text', () => {
  const enumsOf = (schema: z.ZodType): unknown[][] => {
    const found: unknown[][] = [];
    walk(wireSchema(schema), (n) => {
      if (Array.isArray(n.enum)) found.push(n.enum);
    });
    return found;
  };

  it('B1 section kind', () => expect(enumsOf(B1SectionsSchema).flat()).toContain('footer'));
  it('B5 verdict, issue type and severity', () => {
    const all = enumsOf(B5VerdictsSchema).flat();
    expect(all).toEqual(expect.arrayContaining(['CONFIRMED', 'FALSE_POSITIVE', 'UNCERTAIN', 'alignment', 'CRITICAL']));
  });
  it('B6 verdict', () => expect(enumsOf(B6EvaluationsSchema).flat()).toEqual(expect.arrayContaining(['NEW_COMPONENT', 'DS_CANDIDATE'])));
});

describe('every confidence field tells the model its scale', () => {
  it('each `confidence` property carries a 0..1 description', () => {
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
