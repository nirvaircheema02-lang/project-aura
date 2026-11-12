/**
 * Records real-page fixtures for the 4 templates validated in
 * docs/VALIDATION-NOTES.md (IMPLEMENTATION-PLAN.md §9 "fixture-based
 * integration"): read-only page loads through the real T-layer, paced by
 * the politeness limiter. Output replays offline in tests — no production
 * traffic on every test run.
 *
 *   node --experimental-strip-types scripts/record-fixtures.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadConfig } from '../src/config/index.ts';
import { BrowserPool } from '../src/t-layer/browser.ts';
import { Politeness } from '../src/t-layer/politeness.ts';
import { withCapturedPage } from '../src/t-layer/capture.ts';

const TEMPLATES = [
  { slug: 'consulting-subpage', url: 'https://www.kenresearch.com/consulting/strategy-consulting/market-entry-consulting' },
  { slug: 'report-store-listing', url: 'https://www.kenresearch.com/report-store' },
  { slug: 'report-detail', url: 'https://www.kenresearch.com/malaysia-industrial-packaging-pallets-supply-chain-packaging-solutions-market' },
  { slug: 'survey-landing', url: 'https://www.kenresearch.com/brand-perception-survey' },
];

const config = loadConfig();
const pool = new BrowserPool({
  channel: config.browserChannel,
  userAgentProduct: config.politeness.userAgentProduct,
  contactEmail: config.politeness.contactEmail,
});
const politeness = new Politeness(config.politeness.minNavigationIntervalMs);
const root = join(import.meta.dirname, '..', 'test', 'fixtures', 'templates');

await pool.start();
try {
  for (const t of TEMPLATES) {
    const dir = join(root, t.slug);
    await mkdir(dir, { recursive: true });
    for (let attempt = 1; attempt <= 2; attempt++) try {
      await withCapturedPage(pool, politeness, t.url, async (page, capture, observer) => {
        const { requests, ariaSnapshot, ...summary } = capture;
        await writeFile(join(dir, 'capture.json'), JSON.stringify(summary, null, 2));
        await writeFile(join(dir, 'requests.json'), JSON.stringify(requests, null, 2));
        await writeFile(join(dir, 'console.json'), JSON.stringify(observer.consoleMessages, null, 2));
        await writeFile(join(dir, 'aria-snapshot.yaml'), ariaSnapshot);
        await writeFile(join(dir, 'page.html.gz'), gzipSync(await page.content()));
        const rs = capture.renderSettled;
        console.log(
          `${t.slug}: HTTP ${capture.httpStatus} · ${capture.network.total} requests (${capture.network.critical} critical) · ` +
            `settled=${rs.settled} (net=${rs.network.settled} stale=${rs.network.staleInFlight.length} dom=${rs.domQuiet} ` +
            `img ${rs.viewportImages.total - rs.viewportImages.incomplete.length}/${rs.viewportImages.total} broken=${rs.viewportImages.broken.length}) · ` +
            `${capture.console.summary} · ${capture.placeholders.length} placeholder(s) · canonical=${capture.canonical.source}`,
        );
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      if (attempt === 2) console.error(`${t.slug}: FAILED after ${attempt} attempts — ${msg}`);
      else console.error(`${t.slug}: attempt ${attempt} failed (${msg}) — retrying`);
    }
  }
} finally {
  await pool.stop();
}
