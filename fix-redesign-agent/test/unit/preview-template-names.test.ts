import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression: runtime/ScrollEffects.tsx and runtime/scrollEffects.ts differ only by case. On a case-insensitive filesystem
 * (macOS default) TypeScript reports TS1149 and the generated preview does not build.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

describe('react-preview template', () => {
  it('has no two files whose paths differ only by letter case or by extension-less name inside one folder', () => {
    const files = walk('templates/react-preview');
    const byLower = new Map<string, string[]>();
    for (const f of files) {
      const k = f.toLowerCase().replace(/\.(tsx|ts|jsx|js)$/, '');
      byLower.set(k, [...(byLower.get(k) ?? []), f]);
    }
    const clashes = [...byLower.values()].filter((v) => v.length > 1);
    expect(clashes).toEqual([]);
  });
});
