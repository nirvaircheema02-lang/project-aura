// Vendored verbatim from audit-agent src/ds/d3-tokens/index.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
import type { DSRawContent } from '../d1-reader/index.ts';
import { relativeToDs } from '../d1-reader/index.ts';
import { finding, type DSFinding } from '../findings.ts';
import { parseCssBlocks } from './css-cascade.ts';

/**
 * D3 Tokens — two-layer model (IMPLEMENTATION-PLAN.md §4), not a single
 * source read:
 *  - SOURCE layer: tokens.json (DTCG), read directly — parsed here, never
 *    through Style Dictionary's build pipeline, so shadow values are never
 *    put through its color transform (verified: that transform is exactly
 *    what corrupts them in the generated tokens.css — see the `warnings`
 *    this module returns).
 *  - EFFECTIVE layer: what a real page actually renders, resolved from the
 *    real CSS cascade across tokens.css + base.css + the active variant
 *    file, PER VARIANT (editorial-light / cinematic-dark) — not one merged
 *    set. See the module-level precedence note below for exactly why.
 */

export type DsTokenType = 'color' | 'dimension' | 'string' | 'number' | 'unknown';

export interface SourceToken {
  path: string; // dot-joined, e.g. "shadow.md"
  value: string;
  declaredType: string;
  description?: string;
}

export interface EffectiveTokens {
  variant: 'editorial-light' | 'cinematic-dark';
  /** cssVarName -> resolved value, e.g. "--button-height-md" -> "48px" */
  values: Map<string, string>;
  /** Which layer/file each value ultimately came from, for traceability. */
  provenance: Map<string, string>;
}

export interface D3Result {
  sourceTokens: SourceToken[];
  effective: EffectiveTokens[];
  chartTokens: {
    /** Named export -> flattened key -> hex value, from charts/theme/tokens.ts (the TS file, authoritative for rendering). */
    values: Map<string, string>;
  };
  findings: DSFinding[];
}

function flattenDtcg(obj: unknown, path: string[] = []): SourceToken[] {
  if (!obj || typeof obj !== 'object') return [];
  const record = obj as Record<string, unknown>;
  if ('$value' in record) {
    const description = typeof record.$description === 'string' ? record.$description : undefined;
    return [
      {
        path: path.join('.'),
        value: String(record.$value),
        declaredType: typeof record.$type === 'string' ? record.$type : 'unknown',
        ...(description !== undefined ? { description } : {}),
      },
    ];
  }
  const out: SourceToken[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('$')) continue; // $schema, $description at group level, etc.
    out.push(...flattenDtcg(value, [...path, key]));
  }
  return out;
}

/** True box-shadow syntax has multiple comma-separated layers and/or an `inset` keyword — a real color never does. */
function looksLikeShadowValue(value: string): boolean {
  return /inset|(?:\d+(?:\.\d+)?px\s+){2,}/.test(value);
}

function parseChartTokens(chartThemeTs: string): { values: Map<string, string>; findings: DSFinding[] } {
  const values = new Map<string, string>();
  // Deliberately simple, targeted extraction (not a TS parser): matches
  // `key: '#hex'` inside `export const NAME = { ... } as const;` blocks —
  // sufficient for this file's actual authoring style (verified 2026-09-11),
  // and safer than a full TS AST for a file this module only needs to read
  // hex literals out of.
  const exportRe = /export const (\w+)\s*=\s*\{([\s\S]*?)\n\}(?:\s+as const)?;/g;
  let exportMatch: RegExpExecArray | null;
  while ((exportMatch = exportRe.exec(chartThemeTs))) {
    const name = exportMatch[1] as string;
    const body = exportMatch[2] as string;
    const entryRe = /(\w+):\s*'(#[0-9a-fA-F]{3,8})'/g;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRe.exec(body))) {
      values.set(`${name}.${entryMatch[1]}`, (entryMatch[2] as string).toLowerCase());
    }
  }
  return { values, findings: [] };
}

export function buildD3(raw: DSRawContent): D3Result {
  const findings: DSFinding[] = [];

  // ── Source layer ──────────────────────────────────────────────────────
  const tokensJson = JSON.parse(raw.tokensJsonRaw.content);
  const sourceTokens = flattenDtcg(tokensJson);

  for (const t of sourceTokens) {
    if (t.path.startsWith('shadow.') && t.declaredType !== 'shadow') {
      findings.push(
        finding({
          module: 'D3',
          severity: 'warning',
          summary: `Shadow token "${t.path}" is declared $type:"${t.declaredType}", not "shadow"`,
          detail:
            `DTCG-typed correctly as "shadow" this would be preserved as-is by any spec-compliant tooling. ` +
            `Declared as "${t.declaredType}" instead, Style Dictionary's color transform reduces the multi-layer ` +
            `box-shadow value "${t.value}" down to a single rgba() — confirmed corrupted in the generated ` +
            `tokens/build/tokens.css output for this same token. Source-layer value above is read directly from ` +
            `tokens.json and is NOT run through that transform, so it is correct; any code path that instead reads ` +
            `the generated CSS/JS output for this token will get the corrupted single-color value.`,
          sources: [relativeToDs(raw.designSystemPath, raw.tokensJsonRaw.path)],
        }),
      );
    } else if (looksLikeShadowValue(t.value) && !t.path.startsWith('shadow.')) {
      findings.push(
        finding({
          module: 'D3',
          severity: 'info',
          summary: `Token "${t.path}" has a shadow-shaped value outside the shadow.* group`,
          detail: `Value "${t.value}" looks like box-shadow syntax; flagged for visibility, not necessarily an error.`,
          sources: [relativeToDs(raw.designSystemPath, raw.tokensJsonRaw.path)],
        }),
      );
    }
  }

  // ── Chart tokens — resolve precedence explicitly, flag the divergence ──
  const chartTokens = parseChartTokens(raw.chartThemeTokensRaw.content);
  const jsonChartPrimary = sourceTokens.find((t) => t.path === 'chart.palette.1');
  const tsChartPrimary = chartTokens.values.get('KEN_CHART_SERIES.primary');
  if (jsonChartPrimary && tsChartPrimary && jsonChartPrimary.value.toLowerCase() !== tsChartPrimary) {
    findings.push(
      finding({
        module: 'D3',
        severity: 'warning',
        summary: 'Chart primary-series color diverges between tokens.json and charts/theme/tokens.ts',
        detail:
          `tokens.json chart.palette.1 = "${jsonChartPrimary.value}" ("${jsonChartPrimary.description}"), but ` +
          `charts/theme/tokens.ts KEN_CHART_SERIES.primary = "${tsChartPrimary}". The TS file is what Highcharts ` +
          `actually consumes at render time and explicitly documents brand-red as CTA-only, never chart data — ` +
          `D3 treats the TS file's value as authoritative for what actually renders (chartTokens.values above), ` +
          `but tokens.json's DTCG value is preserved unchanged in sourceTokens rather than silently corrected.`,
        sources: [
          relativeToDs(raw.designSystemPath, raw.tokensJsonRaw.path),
          relativeToDs(raw.designSystemPath, raw.chartThemeTokensRaw.path),
        ],
      }),
    );
  }

  // ── Effective layer — per-variant cascade resolution ────────────────────
  // Precedence, verified against the real files (2026-09-11), highest first:
  //  1. base.css's own UNLAYERED :root override block (lines ~101+) — its own
  //     comment confirms this is deliberate; verified unlayered-vs-unlayered
  //     document-order win over tokens.css's own (also unlayered) :root, since
  //     base.css's override text appears later than the `@import` of tokens.css.
  //  2. editorial-light.css / cinematic-dark.css — @layer tokens, scoped to
  //     :root (editorial-light only, it's the default) or [data-variant=...].
  //  3. tokens/build/tokens.css — unlayered, but imported first; foundation
  //     primitives that (2)'s semantic tokens are authored to reference via
  //     var(--foundation-x, fallback), not generally the same variable names.
  //  ASSUMPTION, not independently verified this pass: the true relative order
  //  of (2) vs (3) in a real page depends on the CONSUMING NEXT.JS APP's own
  //  import order (outside design-system/ itself) — not verifiable from the
  //  DS repo alone. This resolver assumes semantic variant tokens (2) layer
  //  over foundation primitives (3), matching their authoring pattern; flagged
  //  below as an explicit, reportable assumption rather than asserted fact.
  findings.push(
    finding({
      module: 'D3',
      severity: 'info',
      summary: 'Effective-layer precedence between tokens.css and the variant files is an assumption, not verified',
      detail:
        `base.css's own unlayered override block winning is verified (its own comment + confirmed unlayered ` +
        `document-order semantics). The relative precedence between tokens/build/tokens.css (unlayered, imported ` +
        `first) and editorial-light.css/cinematic-dark.css (@layer tokens) depends on the consuming Next.js app's ` +
        `real import order, which is outside design-system/ and was not checked this pass. This resolver assumes ` +
        `the variant files' semantic tokens layer over tokens.css's foundation primitives (consistent with their ` +
        `var(--foundation-x, fallback) authoring pattern) — flagged here rather than silently asserted as fact.`,
      sources: [
        relativeToDs(raw.designSystemPath, raw.baseCssRaw.path),
        relativeToDs(raw.designSystemPath, raw.tokensBuildCssRaw.path),
      ],
    }),
  );

  const tokensCssBlocks = parseCssBlocks(raw.tokensBuildCssRaw.content);
  const baseCssBlocks = parseCssBlocks(raw.baseCssRaw.content);
  const baseUnlayeredOverride = baseCssBlocks.filter((b) => b.layer === null && b.selectors.includes(':root'));

  const variantFiles: Array<{ variant: 'editorial-light' | 'cinematic-dark'; content: string; path: string }> = [
    { variant: 'editorial-light', content: raw.editorialLightCssRaw.content, path: raw.editorialLightCssRaw.path },
    { variant: 'cinematic-dark', content: raw.cinematicDarkCssRaw.content, path: raw.cinematicDarkCssRaw.path },
  ];

  const effective: EffectiveTokens[] = variantFiles.map(({ variant, content }) => {
    const values = new Map<string, string>();
    const provenance = new Map<string, string>();

    const setFrom = (blocks: ReturnType<typeof parseCssBlocks>, matchesVariant: (sel: string) => boolean, sourceLabel: string) => {
      for (const block of blocks) {
        if (!block.selectors.some(matchesVariant)) continue;
        for (const [name, value] of block.declarations) {
          values.set(name, value);
          provenance.set(name, sourceLabel);
        }
      }
    };

    // Lowest precedence first, later calls override earlier ones.
    setFrom(tokensCssBlocks, (s) => s === ':root', 'tokens/build/tokens.css');
    const variantBlocks = parseCssBlocks(variantFiles.find((v) => v.variant === variant)!.content);
    setFrom(variantBlocks, (s) => s === ':root' || s === `[data-variant="${variant}"]`, `core-v2/src/styles/${variant}.css`);
    for (const block of baseUnlayeredOverride) {
      for (const [name, value] of block.declarations) {
        values.set(name, value);
        provenance.set(name, 'core-v2/src/styles/base.css (unlayered override)');
      }
    }

    return { variant, values, provenance };
  });

  return { sourceTokens, effective, chartTokens: { values: chartTokens.values }, findings };
}
