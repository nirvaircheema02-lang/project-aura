/**
 * ARCHITECTURE.md §2.4 console-message noise policy: only error-level
 * messages and specific known-meaningful warning patterns feed B4/B5
 * evidence. Validated necessity: one real survey page produced 1198+
 * messages, nearly all benign `<link rel=preload>`-not-used warnings, with
 * one real carousel misconfiguration ("Swiper Loop Warning") buried in them.
 *
 * Grounding pitfalls handled: browser-generated entries can arrive with a
 * 'verbose' level outside Playwright's declared type union (default
 * branch below, never a crash); suppressed messages are COUNTED and
 * summarized, never dropped invisibly; uncaught page errors are always
 * evidence. Pure functions, testable offline against recorded output.
 */

export interface ConsoleFacts {
  type: string; // msg.type() — may be 'verbose' or other values outside the TS union
  text: string;
  locationUrl?: string | undefined;
}

export type ConsoleVerdict =
  | { keep: true; reason: 'error-level' | 'known-meaningful-pattern' | 'critical-resource-failure'; pattern?: string }
  | { keep: false; reason: 'benign-preload-warning' | 'speculative-resource' | 'third-party-origin' | 'below-threshold' };

/** Seeded from validation evidence; extend deliberately, never with a catch-all. */
const MEANINGFUL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'swiper-loop-misconfiguration', re: /^Swiper Loop Warning/ },
  { name: 'react-hydration-mismatch', re: /Minified React error #(418|423|425)|Hydration failed|hydration mismatch/i },
  { name: 'csp-violation', re: /Content Security Policy|Refused to (load|execute|apply|connect)/i },
  { name: 'http-resource-error', re: /Failed to load resource: the server responded with a status of [45]\d\d/ },
];

const BENIGN_PRELOAD = /was preloaded using link preload but not used within a few seconds/i;

export interface ClassifyContext {
  auditedOrigin: string;
  /** URLs the network-noise filter already classified speculative — their failures die with them. */
  speculativeUrls: ReadonlySet<string>;
}

export function classifyConsoleMessage(msg: ConsoleFacts, ctx: ClassifyContext): ConsoleVerdict {
  if (BENIGN_PRELOAD.test(msg.text)) return { keep: false, reason: 'benign-preload-warning' };

  if (msg.locationUrl && ctx.speculativeUrls.has(msg.locationUrl)) {
    return { keep: false, reason: 'speculative-resource' };
  }

  for (const p of MEANINGFUL_PATTERNS) {
    if (p.re.test(msg.text)) {
      if (p.name === 'http-resource-error' && msg.locationUrl && !msg.locationUrl.startsWith(ctx.auditedOrigin)) {
        // A third-party 4xx/5xx is not a DS finding.
        return { keep: false, reason: 'third-party-origin' };
      }
      return { keep: true, reason: p.name === 'http-resource-error' ? 'critical-resource-failure' : 'known-meaningful-pattern', pattern: p.name };
    }
  }

  switch (msg.type) {
    case 'error':
      if (msg.locationUrl && !msg.locationUrl.startsWith(ctx.auditedOrigin)) return { keep: false, reason: 'third-party-origin' };
      return { keep: true, reason: 'error-level' };
    case 'warning':
    case 'log':
    case 'info':
    case 'debug':
    case 'verbose':
    default:
      return { keep: false, reason: 'below-threshold' };
  }
}

export interface ConsoleSummary {
  total: number;
  kept: Array<ConsoleFacts & { verdict: ConsoleVerdict }>;
  suppressedByReason: Record<string, number>;
  /** Human-readable, e.g. "1198 messages, 1196 suppressed by policy" — recorded, never silent. */
  summary: string;
}

export function summarizeConsole(messages: ConsoleFacts[], ctx: ClassifyContext): ConsoleSummary {
  const kept: ConsoleSummary['kept'] = [];
  const suppressedByReason: Record<string, number> = {};
  for (const m of messages) {
    const verdict = classifyConsoleMessage(m, ctx);
    if (verdict.keep) kept.push({ ...m, verdict });
    else suppressedByReason[verdict.reason] = (suppressedByReason[verdict.reason] ?? 0) + 1;
  }
  const suppressed = messages.length - kept.length;
  return {
    total: messages.length,
    kept,
    suppressedByReason,
    summary: `${messages.length} messages, ${suppressed} suppressed by policy, ${kept.length} kept as evidence`,
  };
}
