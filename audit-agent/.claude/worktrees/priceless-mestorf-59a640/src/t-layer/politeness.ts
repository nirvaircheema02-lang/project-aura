/**
 * Per-origin navigation pacing (grounding risk: per-context cold caches
 * multiply real production request volume by page count). Enforces a
 * minimum interval between navigations to the same origin, across all
 * concurrent contexts in this process. Backs off on 429/503 with
 * Retry-After. Crawl-delay isn't in RFC 9309, so pacing lives here.
 */
export class Politeness {
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly minIntervalMs: number;

  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
  }

  /** Resolves when a navigation to `url`'s origin is allowed; serializes per origin. */
  async beforeNavigation(url: string): Promise<void> {
    const origin = new URL(url).origin;
    const prev = this.chains.get(origin) ?? Promise.resolve();
    const next = prev.then(async () => {
      const wait = (this.nextAllowedAt.get(origin) ?? 0) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.nextAllowedAt.set(origin, Date.now() + this.minIntervalMs);
    });
    this.chains.set(origin, next.catch(() => {}));
    return next;
  }

  /** Call on 429/503. `retryAfter` is the raw header (delay-seconds or an HTTP-date). */
  backOff(url: string, retryAfter: string | null, fallbackMs = 30_000): number {
    const origin = new URL(url).origin;
    let delayMs = fallbackMs;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) delayMs = seconds * 1000;
      else {
        const at = Date.parse(retryAfter);
        if (!Number.isNaN(at)) delayMs = Math.max(0, at - Date.now());
      }
    }
    this.nextAllowedAt.set(origin, Math.max(this.nextAllowedAt.get(origin) ?? 0, Date.now() + delayMs));
    return delayMs;
  }
}
