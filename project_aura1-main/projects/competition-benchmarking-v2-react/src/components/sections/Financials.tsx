/**
 * Financials — ported 1:1 from competition-benchmarking-v2/index.html.
 * Mechanical HTML->JSX conversion; styling comes from the verbatim globals.css.
 */
/**
 * The six snapshot charts ship as rasterised PNGs rather than live SVG — each
 * was rendered from the original inline chart at 1680x1080 on transparency, so
 * it still reads crisply on a retina display at the ~400px the card gives it.
 * Regenerate with scripts/raster-charts.mjs if a figure changes.
 *
 * Every card is gated identically: a light blur over the artwork plus an
 * unlock CTA that fades in on hover/focus. The badge text is the only thing
 * that still distinguishes a preview chart from a locked one.
 */
const SNAPSHOTS: {
  slug: string;
  label: string;
  badge: string;
  badgeKind: 'preview' | 'locked';
  alt: string;
  /** Only the PAT card carries a legend — the chart plots two series. */
  legend?: boolean;
}[] = [
  { slug: 'revenue',        label: 'Revenue (USD Mn)',  badge: 'Sample Preview', badgeKind: 'preview', alt: 'Revenue by fiscal year, USD Mn' },
  { slug: 'revenue-growth', label: 'Revenue Growth (%)', badge: 'Sample Preview', badgeKind: 'preview', alt: 'Revenue growth percent by fiscal year' },
  { slug: 'cogs',           label: 'COGS (USD Mn)',     badge: 'Locked',         badgeKind: 'locked',  alt: 'COGS by fiscal year, USD Mn' },
  { slug: 'ebitda',         label: 'EBITDA (USD Mn)',   badge: 'Locked',         badgeKind: 'locked',  alt: 'EBITDA waterfall by fiscal year, USD Mn' },
  { slug: 'ebitda-margin',  label: 'EBITDA Margin (%)', badge: 'Sample Preview', badgeKind: 'preview', alt: 'FY25 EBITDA margin 18.9 percent of a 30 percent scale' },
  { slug: 'pat-margin',     label: 'PAT & PAT Margin',  badge: 'Locked',         badgeKind: 'locked',  alt: 'PAT and PAT margin by fiscal year', legend: true },
];

export function Financials() {
  return (
      <div id="financials">
          <div className="sec-head">
            <span className="label">Financial Intelligence</span>
            <h2>Core Financial Performance Metrics</h2>
            <p className="sub">Nine financial KPIs benchmarked across all covered dealerships. Full company-wise data in the complete report.</p>
          </div>

        <div className="fin-snapshot-grid">
          {SNAPSHOTS.map(({ slug, label, badge, badgeKind, alt, legend }) => (
            <div className="fin-snap-card" key={slug}>
              <div className="fin-snap-label">
                {label} <span className={`fin-badge fin-badge--${badgeKind}`}>{badge}</span>
              </div>
              {/* Every chart gets the blur and the gate; only the three that
                  were already locked also get the dimming and the bottom fade. */}
              <div className={`fin-chart${badgeKind === 'locked' ? ' fin-locked-region' : ''}`}>
                <img
                  className="fc-img"
                  src={`/charts/${slug}.png`}
                  alt={alt}
                  width={1680}
                  height={1080}
                  loading="lazy"
                  decoding="async"
                />
                {badgeKind === 'locked' && <div className="fin-locked-fade" aria-hidden="true"></div>}
                <div className="fin-unlock">
                  <a href="#faq" className="btn btn-secondary btn-sm">
                    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    Unlock Full Report
                  </a>
                </div>
              </div>
              {legend && (
                <div className="fc-legend">
                  <span className="fc-legend-item"><span className="fc-legend-swatch" /> PAT (USD Mn)</span>
                  <span className="fc-legend-item"><span className="fc-legend-line" /> PAT Margin (%)</span>
                </div>
              )}
            </div>
          ))}
        </div>

          <div className="fin-note">
            <div className="fin-note-copy">
              <span className="fin-note-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg></span>
              <p>Sample trends shown above are indicative. Full company-wise financial data — including individual Revenue, COGS, EBITDA, PAT, and margin values — is available in the complete benchmarking report.</p>
            </div>
            <a href="#faq" className="btn btn-secondary btn-sm">Request Full Financial Benchmarking</a>
          </div>

          <div className="report-table-wrap">
          <div className="report-table-scroll">
          <table className="report-table">
            <thead><tr><th>Metric</th><th>Why It Matters for Dealership Benchmarking</th></tr></thead>
            <tbody>
              <tr><td>Revenue</td><td>Reflects total vehicle and aftersales commercial scale of each dealership</td></tr>
              <tr><td>Revenue Growth</td><td>Signals expansion momentum — driven by new model launches, aftersales scaling, or network expansion</td></tr>
              <tr><td>COGS</td><td>Shows vehicle procurement cost intensity — critical for gross margin and pricing flexibility analysis</td></tr>
              <tr><td>EBITDA</td><td>Measures operating profitability, removing financing effects that vary widely across dealer structures</td></tr>
              <tr><td>EBITDA Margin</td><td>Benchmarks operational efficiency across dealerships of varying scale and brand mix</td></tr>
              <tr><td>PAT</td><td>Shows net profitability after all deductions — the bottom-line health of each dealership entity</td></tr>
              <tr><td>PAT Margin</td><td>Measures ultimate bottom-line strength and net return on total revenue generated</td></tr>
            </tbody>
          </table>
          </div>
          </div>
        </div>
  );
}
