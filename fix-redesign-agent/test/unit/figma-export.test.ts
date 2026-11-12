import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { exportFigmaBundle } from '../../src/preview/figma-export.ts';
import { buildTrees, col } from '../../scripts/figma-export/tree.mjs';

describe('figma export', () => {
  it('is on by default and never throws when the preview was not built', async () => {
    expect(loadConfig().preview.figmaExport).toBe(true);
    const r = await exportFigmaBundle(mkdtempSync(join(tmpdir(), 'fx-')));
    expect(r.ok).toBe(false);
  });

  it('turns computed colours into hex and a stack into auto-layout', () => {
    expect(col('rgb(10, 10, 10)')).toBe('0a0a0a');
    expect(col('rgba(255, 255, 255, 0.5)')).toBe('ffffff80');
    const box = (ax: number, ay: number, w: number, h: number) => ({ k: 't', ax, ay, w, h, s: 'x', ff: 'DM Sans', z: 16, fw: 400, c: 'rgb(0, 0, 0)', ls: 0, lh: 24, ta: 'start', tt: 'none', td: 'none' });
    const t = buildTrees({ s: { w: 400, h: 100, ax: 0, ay: 0, masks: [], root: { k: 'f', ax: 0, ay: 0, w: 400, h: 100, n: 'Section', kids: [box(0, 0, 100, 20), box(0, 30, 100, 20), box(0, 60, 100, 20)] } } });
    expect(t.s.al).toMatchObject({ d: 'V', g: 10 });
    expect(t.s.ch).toHaveLength(3);
  });
});
