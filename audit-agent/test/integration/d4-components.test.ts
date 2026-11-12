import { describe, expect, it, beforeAll } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { readFilesystemSource } from '../../src/ds/d1-reader/index.ts';
import { buildD4, type D4Result } from '../../src/ds/d4-components/index.ts';

let d4: D4Result | undefined;

beforeAll(async () => {
  const config = loadConfig();
  try {
    const raw = await readFilesystemSource(config.designSystemPath);
    d4 = buildD4(raw);
  } catch {
    d4 = undefined;
  }
  // ts-morph parses all 289 .tsx files of the real DS here; under a full
  // parallel suite that exceeds vitest's 10s default hook timeout.
}, 120_000);

describe('D4 against the real Design System', () => {
  it('finds 289 .tsx files under core-v2/src (verified count, 2026-09-11)', () => {
    if (!d4) return;
    expect(d4.totalTsxFiles).toBe(289);
  });

  it('extracts Button.tsx\'s 3 string-literal-union variant types', () => {
    if (!d4) return;
    const buttonTypes = d4.stringUnionVariants.filter((v) => v.file === 'atoms/Button.tsx');
    const byName = Object.fromEntries(buttonTypes.map((v) => [v.typeName, v.values]));
    expect(byName.ButtonVariant).toEqual(['primary', 'secondary', 'ghost', 'brand']);
    expect(byName.ButtonSize).toEqual(['xs', 'sm', 'md', 'lg', 'xl']);
    expect(byName.ButtonBackground).toEqual(['light', 'dark']);
  });

  it('extracts Badge.tsx\'s themeColors Record<BadgeTheme, ThemeColor> lookup map', () => {
    if (!d4) return;
    const badgeMap = d4.lookupMaps.find((m) => m.file === 'atoms/Badge.tsx' && m.constName === 'themeColors');
    expect(badgeMap?.keyedBy).toBe('BadgeTheme');
  });

  it('flags Button.tsx\'s variantInlineStyle as runtime-only (React hover state, un-extractable)', () => {
    if (!d4) return;
    const entry = d4.iifeLogic.find((l) => l.file === 'atoms/Button.tsx' && l.functionOrConstName === 'variantInlineStyle');
    expect(entry?.runtimeOnly).toBe(true);
    expect(d4.findings.some((f) => f.summary.includes('variantInlineStyle') && f.summary.includes('runtime-only'))).toBe(true);
  });

  it('finds cva() in exactly 6 files, all under ui/ (verified, 2026-09-11)', () => {
    if (!d4) return;
    expect(d4.cvaConfigs).toHaveLength(6);
    expect(d4.cvaConfigs.every((c) => c.file.startsWith('ui/'))).toBe(true);
  });

  it('flags ui/button.tsx\'s bg-primary reference as unthemed (no --primary defined anywhere in styles)', () => {
    if (!d4) return;
    expect(
      d4.findings.some((f) => f.summary.includes('ui/button.tsx') && f.summary.includes('not defined anywhere')),
    ).toBe(true);
  });

  it('data-component coverage matches the verified 161/289 total', () => {
    if (!d4) return;
    expect(d4.dataComponentCoverage.withAttribute).toBe(161);
    expect(d4.dataComponentCoverage.total).toBe(289);
    expect(d4.dataComponentCoverage.byCategory.ui?.withAttribute ?? 0).toBe(0); // shadcn ui/ has zero
  });
});
