'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, MotionConfig } from 'framer-motion';
import SiteHeader from './SiteHeader';
import Footer from './Footer';
import VariantTabs, { type Variant } from './VariantTabs';
import PublicationsCarousel from './PublicationsCarousel';
import HeroCarouselClean from './variants/design2/HeroCarouselClean';
import CitationRowWide from './variants/design1/CitationRowWide';
import CitationGridCard from './variants/design3/CitationGridCard';
import FilterSidebar, { type FilterDimension, type FilterState } from './FilterSidebar';
import MobileFilterDrawer from './MobileFilterDrawer';
import BottomCTA from './BottomCTA';
import StickyCTA from './StickyCTA';
import {
  CITATIONS,
  PUBLICATIONS,
  REGIONS,
  INDUSTRIES,
  TOPICS,
  YEARS,
  CONTENT_TYPES,
  type Citation,
} from '@/lib/mock-citations';

// dimension key → citation field it filters on
const DIMENSIONS: FilterDimension[] = [
  { key: 'publisher', label: 'Publication', options: PUBLICATIONS },
  { key: 'region', label: 'Region / Geography', options: REGIONS },
  { key: 'industry', label: 'Industries', options: INDUSTRIES },
  { key: 'year', label: 'Year', options: YEARS },
  { key: 'topic', label: 'Topic', options: TOPICS },
  { key: 'contentType', label: 'Content Type', options: CONTENT_TYPES },
];

const SORTS = [
  { value: 'recent', label: 'Most Recent' },
  { value: 'popular', label: 'Most Popular' },
  { value: 'publication', label: 'Publication A-Z' },
  { value: 'year', label: 'Year' },
];

const EMPTY: FilterState = {
  publisher: [],
  region: [],
  industry: [],
  year: [],
  topic: [],
  contentType: [],
};

// Infinite-scroll batch size — no Load More button, no per-page selector.
const BATCH = 10;

const fieldOf = (c: Citation, key: string) => (c as unknown as Record<string, string>)[key];

function matches(c: Citation, filters: FilterState, query: string, ignoreKey?: string) {
  for (const dim of DIMENSIONS) {
    if (dim.key === ignoreKey) continue;
    const sel = filters[dim.key];
    if (sel && sel.length && !sel.includes(fieldOf(c, dim.key))) return false;
  }
  if (query.trim()) {
    const q = query.toLowerCase();
    const hay = `${c.title} ${c.excerpt} ${c.publisher} ${c.relatedReport} ${c.industry} ${c.region} ${c.topic}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export default function MediaCitationsPage() {
  // Variant 1 (Design 1 cards) is the default.
  const [variant, setVariant] = useState<Variant>('variant1');

  const [filters, setFilters] = useState<FilterState>(EMPTY);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [visibleCount, setVisibleCount] = useState(BATCH);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Variant 2 has no filtering UI at all — make sure a drawer left open on
  // Variant 1 doesn't carry over if the user switches tabs to Variant 2.
  useEffect(() => {
    if (variant === 'variant2') setDrawerOpen(false);
  }, [variant]);

  const activeCount = useMemo(
    () => Object.values(filters).reduce((n, arr) => n + arr.length, 0),
    [filters]
  );

  // Filtered + sorted list — identical across both variants (layout-only switch)
  const filtered = useMemo(() => {
    const list = CITATIONS.filter((c) => matches(c, filters, query));
    const s = [...list];
    switch (sort) {
      case 'popular':
        s.sort((a, b) => b.popularity - a.popularity);
        break;
      case 'publication':
        s.sort((a, b) => a.publisher.localeCompare(b.publisher) || b.ts - a.ts);
        break;
      case 'year':
        s.sort((a, b) => Number(b.year) - Number(a.year) || b.ts - a.ts);
        break;
      default:
        s.sort((a, b) => b.ts - a.ts);
    }
    return s;
  }, [filters, query, sort]);

  // Context-aware facet counts
  const counts = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const dim of DIMENSIONS) {
      const base = CITATIONS.filter((c) => matches(c, filters, query, dim.key));
      out[dim.key] = {};
      for (const opt of dim.options) {
        out[dim.key][opt] = base.filter((c) => fieldOf(c, dim.key) === opt).length;
      }
    }
    return out;
  }, [filters, query]);

  // Infinite scroll — no Load More button, no per-page selector. A sentinel
  // element near the bottom of the listing triggers the next batch as it
  // scrolls into view.
  const pageItems = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  useEffect(() => {
    setVisibleCount(BATCH);
  }, [filters, query, sort]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisibleCount((v) => v + BATCH);
      },
      { rootMargin: '0px 0px 400px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore]);

  const toggle = (key: string, value: string) => {
    setFilters((prev) => {
      const cur = prev[key] ?? [];
      return { ...prev, [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
    });
  };
  // Industries is single-select (design-system FiltersPanel behavior) —
  // selecting one replaces any prior selection; clicking the active one clears it.
  const selectIndustry = (value: string) => {
    setFilters((prev) => ({
      ...prev,
      industry: prev.industry?.includes(value) ? [] : [value],
    }));
  };
  const reset = () => {
    setFilters(EMPTY);
    setQuery('');
  };

  // Marks the in-flow final CTA so StickyCTA can hide itself once it's in view
  // (avoids showing two CTAs on screen at the same time).
  const finalCtaRef = useRef<HTMLDivElement>(null);

  const isVariant2 = variant === 'variant2';

  // Flat list of active filter chips for the "applied filters" row above results.
  const activeChips = useMemo(() => {
    const chips: { key: string; value: string; label: string }[] = [];
    for (const dim of DIMENSIONS) {
      for (const value of filters[dim.key] ?? []) {
        chips.push({ key: dim.key, value, label: value });
      }
    }
    return chips;
  }, [filters]);

  return (
    <MotionConfig reducedMotion="user">
    <div>
      <SiteHeader />

      <VariantTabs variant={variant} onChange={setVariant} />

      {/* Hero + logo carousel are identical for both variants — mounted once,
          never re-animated on a plain card-style switch. */}
      <HeroCarouselClean />
      <PublicationsCarousel />

      <section className="listing">
        <div className={`listing-in${isVariant2 ? ' no-sidebar' : ''}`}>
          {!isVariant2 && (
            <FilterSidebar
              dimensions={DIMENSIONS}
              filters={filters}
              counts={counts}
              activeCount={activeCount}
              onToggle={toggle}
              onSelectIndustry={selectIndustry}
              onReset={reset}
            />
          )}

          <div className="rcol">
            <div className="tbar">
              <div className="search">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search citations, publications or topics..."
                  aria-label="Search media citations"
                />
              </div>
              {!isVariant2 && (
                <button className="mfilter" onClick={() => setDrawerOpen(true)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="6" x2="20" y2="6" />
                    <line x1="7" y1="12" x2="17" y2="12" />
                    <line x1="10" y1="18" x2="14" y2="18" />
                  </svg>
                  Filters
                  {activeCount > 0 && <span className="badge">{activeCount}</span>}
                </button>
              )}
              <div className="sortwrap">
                <label htmlFor="sort">Sort by</label>
                <div className="sortsel">
                  <select id="sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                    {SORTS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <span className="caret">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </div>
              </div>
            </div>

            {activeChips.length > 0 && (
              <div className="chip-row" aria-label="Applied filters">
                {activeChips.map((chip) => (
                  <button
                    key={`${chip.key}-${chip.value}`}
                    className="chip"
                    onClick={() => toggle(chip.key, chip.value)}
                  >
                    {chip.label}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                ))}
                <button className="chip-clear" onClick={reset}>
                  Clear all
                </button>
              </div>
            )}

            {pageItems.length > 0 ? (
              <motion.div
                key={variant}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.22 }}
                className={isVariant2 ? 'egrid' : 'clist'}
              >
                {pageItems.map((c, i) =>
                  isVariant2 ? (
                    <CitationGridCard key={c.id} c={c} index={i} />
                  ) : (
                    <CitationRowWide key={c.id} c={c} index={i} />
                  )
                )}
              </motion.div>
            ) : (
              <div className="empty">
                <h4>No citations found</h4>
                <p>Try adjusting or clearing your filters to see more results.</p>
                <button onClick={reset}>Clear all filters</button>
              </div>
            )}

            {hasMore && <div ref={sentinelRef} className="infinite-sentinel" aria-hidden />}
          </div>
        </div>
      </section>

      <div ref={finalCtaRef}>
        <BottomCTA />
      </div>
      <Footer />

      <MobileFilterDrawer
        open={drawerOpen}
        dimensions={DIMENSIONS}
        filters={filters}
        counts={counts}
        resultCount={filtered.length}
        onToggle={toggle}
        onSelectIndustry={selectIndustry}
        onReset={reset}
        onClose={() => setDrawerOpen(false)}
      />

      <StickyCTA finalCtaRef={finalCtaRef} />
    </div>
    </MotionConfig>
  );
}
