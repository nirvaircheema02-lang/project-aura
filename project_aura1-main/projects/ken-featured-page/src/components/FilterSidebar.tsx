'use client';

import { useState } from 'react';
import { Newspaper, MapPin, Layers, Calendar, Tag, FileText, ChevronRight, SlidersHorizontal } from 'lucide-react';

export type FilterState = Record<string, string[]>;

export type FilterDimension = {
  key: string;
  label: string;
  options: string[];
};

const Check = () => (
  <svg viewBox="0 0 24 24" fill="none">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// Per-dimension icon — matches the real kenresearch.com/report-store filter
// sidebar (Layers for Industries, MapPin for Regions, Calendar for Publish
// Year, FileText for Report Type); Publication/Topic don't exist there, so
// the closest equivalent icon is used.
const DIM_ICONS: Record<string, typeof Layers> = {
  publisher: Newspaper,
  region: MapPin,
  industry: Layers,
  year: Calendar,
  topic: Tag,
  contentType: FileText,
};

// Sub-industry labels, browsing/visual parity only (no citation is tagged at
// this granularity) — matches the design system's real Industries pattern:
// clicking an industry reveals its own sub-industry list underneath.
const SUB_INDUSTRIES: Record<string, string[]> = {
  'Food, Beverage and Tobacco': ['Packaged Food', 'Beverages', 'Tobacco Products', 'Foodservice'],
  'Public Sector and Administration': ['Government IT', 'Public Infrastructure', 'Civic Services', 'Defense Procurement'],
  'Defense and Security': ['Homeland Security', 'Cybersecurity', 'Defense Equipment', 'Surveillance Systems'],
  Healthcare: ['Pharmaceuticals', 'Medical Devices', 'Hospitals & Clinics', 'Digital Health'],
  'Banking Financial Services and Insurance': ['Retail Banking', 'Insurance', 'Wealth Management', 'Payments & Fintech'],
  'Media and Entertainment': ['Streaming & OTT', 'Gaming', 'Publishing', 'Advertising'],
  'Consumer Products and Retail': ['E-commerce', 'Apparel & Footwear', 'FMCG', 'Home & Lifestyle'],
  'Manufacturing and Construction': ['Industrial Manufacturing', 'Construction Materials', 'Infrastructure', 'Real Estate Development'],
  'Education and Recruitment': ['EdTech', 'Higher Education', 'Staffing & Recruitment', 'Vocational Training'],
  'Automotive, Transportation and Warehousing': ['Passenger Vehicles', 'Commercial Fleet', 'Warehousing & 3PL', 'EV & Charging'],
  'Metal, Mining and Chemicals': ['Base Metals', 'Specialty Chemicals', 'Mining Equipment', 'Petrochemicals'],
  'Energy and Utilities': ['Renewable Energy', 'Oil & Gas', 'Power Utilities', 'Energy Storage'],
  'Agriculture and Animal Care': ['Crop Production', 'Animal Feed', 'Agri-Tech', 'Veterinary Care'],
  'Technology and Telecom': ['Cloud & SaaS', 'Telecom Services', 'AI & Data', 'Cybersecurity Tech'],
};

/**
 * Single filter group — parent row (label + chevron) with a checkbox option
 * list underneath. Accordion open/closed state is fully controlled by the
 * parent (`open`/`onToggleOpen`) so only one group can be open at a time —
 * do not give this its own internal open state, that's what caused multiple
 * groups staying open simultaneously.
 */
export function FilterGroup({
  dim,
  selected,
  counts,
  onToggle,
  open,
  onToggleOpen,
}: {
  dim: FilterDimension;
  selected: string[];
  counts: Record<string, number>;
  onToggle: (key: string, value: string) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  // Design-system FilterSectionHeader convention: the bg tint reflects whether
  // this group HAS an active selection — independent of whether it's open —
  // while the chevron alone signals expand/collapse state.
  const hasSelection = selected.length > 0;
  const Icon = DIM_ICONS[dim.key];
  return (
    <div className="fsb-grp">
      <button
        className={`fsb-trig${open ? ' open' : ''}${hasSelection ? ' has-selection' : ''}`}
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        <span className="fsb-trig-l">
          {Icon && (
            <span className="fsb-ic" aria-hidden>
              <Icon size={12} />
            </span>
          )}
          {dim.label}
        </span>
        <span className="chev">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="fsb-body">
          {dim.options.map((opt) => {
            const count = counts[opt] ?? 0;
            return (
              <label key={opt} className="fsb-opt">
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  onChange={() => onToggle(dim.key, opt)}
                />
                <span className="fsb-box">
                  <Check />
                </span>
                <span className="fsb-txt">{opt}</span>
                <span className="fsb-count">{count}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * One industry row within the Industries group. Matches the design system's
 * real FiltersPanel pattern: clicking an industry SELECTS it exclusively
 * (single-select, not a checkbox) and reveals its sub-industries underneath;
 * clicking the same industry again deselects/collapses it. Sub-industry
 * clicks are visual-only (aria-pressed) — no citation is tagged at that
 * granularity, so they don't further filter results.
 */
function IndustryRow({
  name,
  count,
  isSelected,
  onSelect,
}: {
  name: string;
  count: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [activeSubs, setActiveSubs] = useState<Set<string>>(new Set());
  const subs = SUB_INDUSTRIES[name] ?? [];
  return (
    <div>
      <button
        type="button"
        className={`fsb-ind-row${isSelected ? ' active' : ''}`}
        aria-expanded={isSelected}
        onClick={onSelect}
      >
        <span className={`fsb-ind-chev${isSelected ? ' open' : ''}`} aria-hidden>
          <ChevronRight size={12} />
        </span>
        <span className="fsb-ind-txt">{name}</span>
        <span className="fsb-count">{count}</span>
      </button>
      {isSelected && subs.length > 0 && (
        <div className="fsb-ind-subs" role="group" aria-label={`${name} sub-categories`}>
          {subs.map((sub) => {
            const subActive = activeSubs.has(sub);
            return (
              <button
                key={sub}
                type="button"
                className={`fsb-ind-sub${subActive ? ' active' : ''}`}
                aria-pressed={subActive}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveSubs((prev) => {
                    const next = new Set(prev);
                    next.has(sub) ? next.delete(sub) : next.add(sub);
                    return next;
                  });
                }}
              >
                {sub}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Industries group — same accordion trigger/header as every other group, but
 * the body underneath is the design system's single-select industry→sub-
 * industry drill-down instead of a flat checkbox list (see IndustryRow).
 */
export function IndustryFilterGroup({
  dim,
  selected,
  counts,
  onSelect,
  open,
  onToggleOpen,
}: {
  dim: FilterDimension;
  selected: string[];
  counts: Record<string, number>;
  onSelect: (value: string) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const hasSelection = selected.length > 0;
  const Icon = DIM_ICONS[dim.key];
  return (
    <div className="fsb-grp">
      <button
        className={`fsb-trig${open ? ' open' : ''}${hasSelection ? ' has-selection' : ''}`}
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        <span className="fsb-trig-l">
          {Icon && (
            <span className="fsb-ic" aria-hidden>
              <Icon size={12} />
            </span>
          )}
          {dim.label}
        </span>
        <span className="chev">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="fsb-body fsb-body--industry">
          {dim.options.map((opt) => (
            <IndustryRow
              key={opt}
              name={opt}
              count={counts[opt] ?? 0}
              isSelected={selected.includes(opt)}
              onSelect={() => onSelect(opt)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FilterSidebar({
  dimensions,
  filters,
  counts,
  activeCount,
  onToggle,
  onSelectIndustry,
  onReset,
}: {
  dimensions: FilterDimension[];
  filters: FilterState;
  counts: Record<string, Record<string, number>>;
  activeCount: number;
  onToggle: (key: string, value: string) => void;
  onSelectIndustry: (value: string) => void;
  onReset: () => void;
}) {
  // Accordion — only one group open at a time; first group open on load.
  const [openKey, setOpenKey] = useState<string | null>(dimensions[0]?.key ?? null);

  return (
    <aside className="fsb" aria-label="Filter citations">
      <div className="fsb-hd">
        <div className="fsb-hd-lbl-wrap">
          <span className="fsb-hd-ic" aria-hidden>
            <SlidersHorizontal size={14} />
          </span>
          <span className="fsb-hd-lbl">Filters</span>
        </div>
        {activeCount > 0 && (
          <button className="fsb-reset" onClick={onReset}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8" />
              <polyline points="3 3 3 8 8 8" />
            </svg>
            Clear all
          </button>
        )}
      </div>
      {dimensions.map((dim) =>
        dim.key === 'industry' ? (
          <IndustryFilterGroup
            key={dim.key}
            dim={dim}
            selected={filters[dim.key] ?? []}
            counts={counts[dim.key] ?? {}}
            onSelect={onSelectIndustry}
            open={openKey === dim.key}
            onToggleOpen={() => setOpenKey((k) => (k === dim.key ? null : dim.key))}
          />
        ) : (
          <FilterGroup
            key={dim.key}
            dim={dim}
            selected={filters[dim.key] ?? []}
            counts={counts[dim.key] ?? {}}
            onToggle={onToggle}
            open={openKey === dim.key}
            onToggleOpen={() => setOpenKey((k) => (k === dim.key ? null : dim.key))}
          />
        )
      )}
    </aside>
  );
}
