import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDsTokenIndex, type DsTokenIndex } from '../../src/resolution/ds-evidence.ts';

/**
 * A small Design System token tree whose colour tokens carry the REAL DS values and names for the families the colour mapper cares about
 * (hairline / border / tint / surface / ink / primitives / component tokens / shadows), including a dark-scope override file. Tests build a
 * `DsTokenIndex` from it so the mapper is exercised with the same scope rules as the real DS without depending on the workspace.
 */

export const MINI_DS_TOKENS = `
:root {
  --white: #ffffff;
  --black: #000000;
  --color-ramp-black-100: #f5f5f5;
  --color-ramp-white-800: #f5f5f5;
  --color-ramp-warm-300: #f5f2f1;
  --color-ramp-black-200: #e5e5e5;
  --semantic-hairline-strong: rgba(0, 0, 0, 0.18);
  --semantic-hairline-default: rgba(0, 0, 0, 0.12);
  --semantic-hairline-soft: rgba(0, 0, 0, 0.08);
  --semantic-hairline-faint: rgba(0, 0, 0, 0.07);
  --semantic-hairline-on-dark-default: rgba(255, 255, 255, 0.12);
  --semantic-hairline-on-dark-soft: rgba(255, 255, 255, 0.1);
  --semantic-hairline-on-dark-faint: rgba(255, 255, 255, 0.06);
  --semantic-surface-tint-soft: rgba(0, 0, 0, 0.03);
  --semantic-surface-tint-default: rgba(0, 0, 0, 0.04);
  --semantic-surface-white: #ffffff;
  --semantic-ink-strong: #171717;
  --semantic-ink-muted: #525252;
  --border-hairline: rgba(0, 0, 0, 0.05);
  --border-card: rgba(0, 0, 0, 0.08);
  --border-section: rgba(0, 0, 0, 0.10);
  --border-input: rgba(0, 0, 0, 0.15);
  --border-active: rgba(0, 0, 0, 0.20);
  --border-on-dark-hairline: rgba(255, 255, 255, 0.06);
  --border-on-dark-card: rgba(255, 255, 255, 0.10);
  --border-on-dark-section: rgba(255, 255, 255, 0.12);
  --border-on-dark-input: rgba(255, 255, 255, 0.18);
  --border-on-dark-active: rgba(255, 255, 255, 0.25);
  --border-soft: rgba(0, 0, 0, 0.08);
  --border-default: rgba(0, 0, 0, 0.12);
  --border-strong: rgba(0, 0, 0, 0.18);
  --tint-soft: rgba(0, 0, 0, 0.03);
  --tint-default: rgba(0, 0, 0, 0.04);
  --section-bg-primary: #ffffff;
  --section-bg-accent: #f5f2f1;
  --section-bg-contrast: #000000;
  --surface-text: #000000;
  --table-row-divider: rgba(0, 0, 0, 0.08);
  --table-open-last-row-border: rgb(228, 226, 240);
  --semantic-status-success-border: #bbf7d0;
  --glass-border: rgba(255, 255, 255, 0.15);
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.08);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.12);
  --shadow-card-rest: 0 1px 3px rgba(0, 0, 0, 0.04);
  --shadow-none: none;
  --radius-sm: 10px;
}
`;

export const MINI_DS_DARK = `
@layer tokens {
  [data-variant="cinematic-dark"] {
    --border-soft: rgba(255, 255, 255, 0.10);
    --border-default: rgba(255, 255, 255, 0.12);
    --border-strong: rgba(255, 255, 255, 0.20);
    --tint-soft: rgba(255, 255, 255, 0.025);
    --tint-default: rgba(255, 255, 255, 0.04);
    --section-bg-primary: #111114;
    --section-bg-accent: #1a1a1e;
    --section-bg-contrast: #050506;
    --surface-text: #fafafa;
  }
}
`;

const dirs: string[] = [];

export function makeDsDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ds-colour-fixture-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** The mini DS (optionally with extra declarations appended to the base `:root` block). */
export function miniDsIndex(extraTokens = ''): DsTokenIndex {
  return buildDsTokenIndex(makeDsDir({ 'tokens/build/tokens.css': `${MINI_DS_TOKENS}\n:root { ${extraTokens} }`, 'core-v2/src/styles/cinematic-dark.css': MINI_DS_DARK }));
}

export function cleanupDsFixtures(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const REAL_DS = '/Users/sachin/Project-aura/project_aura1-main/design-system';
