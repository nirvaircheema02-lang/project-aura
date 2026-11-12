import type { z } from 'zod';
import { TerminalError } from '../retry.ts';

/**
 * One error-formatting convention for every audit-agent artifact this repo reads —
 * the same field-per-line shape audit-agent's own config loader prints. A file that
 * fails its contract is TERMINAL: a wrong or half-written artifact is never retried
 * and never "best-effort" parsed.
 */
export function parseWith<T>(schema: z.ZodType<T>, json: unknown, what: string, path: string): T {
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  const shown = result.error.issues.slice(0, 10).map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`);
  const more = result.error.issues.length > 10 ? `\n  … and ${result.error.issues.length - 10} more` : '';
  throw new TerminalError(`${what} at ${path} does not match its contract:\n${shown.join('\n')}${more}`);
}
