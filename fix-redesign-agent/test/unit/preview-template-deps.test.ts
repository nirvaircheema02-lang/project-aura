import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard: every design-system component the preview can mount must have ALL its external packages in the generated app's
 * dependencies, or the preview does not build ("the generated React preview does not build" fails the whole run at R8). ui/button
 * (used by the carousel arrows) needs @radix-ui/react-slot and class-variance-authority — they were missing.
 */
const DS = '/Users/sachin/Project-aura/project_aura1-main/design-system/core-v2/src';
const ENTRIES = ['atoms/Button.tsx', 'atoms/SectionHeading.tsx', 'atoms/CTALink.tsx', 'molecules/AccordionItem.tsx', 'ui/button.tsx'].map((f) => join(DS, f));
const pkg = JSON.parse(readFileSync('templates/react-preview/package.json', 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);

function externalsOf(file: string, seen = new Set<string>(), out = new Set<string>()): Set<string> {
  if (seen.has(file)) return out;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1]!;
    if (spec.startsWith('.')) {
      const base = resolve(dirname(file), spec);
      const hit = ['.tsx', '.ts', '/index.ts', '/index.tsx', ''].map((e) => base + e).find((c) => existsSync(c) && !c.endsWith('/'));
      if (hit && /\.(tsx?|jsx?)$/.test(hit)) externalsOf(hit, seen, out);
    } else if (!spec.startsWith('@kenresearch/')) {
      out.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
    }
  }
  return out;
}

describe('react-preview template dependencies', () => {
  it('declares every external package the mountable design-system components import', () => {
    if (!existsSync(DS)) return; // the DS checkout is not present on this machine
    const needed = new Set<string>();
    for (const e of ENTRIES) if (existsSync(e)) externalsOf(e, new Set(), needed);
    const missing = [...needed].filter((n) => !declared.has(n) && n !== 'react/jsx-runtime');
    expect(missing).toEqual([]);
  });

  it('REGRESSION: includes the two packages ui/button needs', () => {
    expect(declared.has('@radix-ui/react-slot')).toBe(true);
    expect(declared.has('class-variance-authority')).toBe(true);
  });
});
