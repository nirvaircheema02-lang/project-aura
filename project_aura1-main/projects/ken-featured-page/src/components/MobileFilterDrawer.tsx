'use client';

import { useEffect, useState } from 'react';
import { FilterGroup, IndustryFilterGroup, type FilterState, type FilterDimension } from './FilterSidebar';

/**
 * Mobile filter surface — bottom sheet under 720px, left drawer above. Same
 * single-open accordion behavior as the desktop sidebar: only one group open
 * at a time (first group open on load, opening another closes the previous).
 * Locks body scroll while open and closes on Escape.
 */
export default function MobileFilterDrawer({
  open,
  dimensions,
  filters,
  counts,
  resultCount,
  onToggle,
  onSelectIndustry,
  onReset,
  onClose,
}: {
  open: boolean;
  dimensions: FilterDimension[];
  filters: FilterState;
  counts: Record<string, Record<string, number>>;
  resultCount: number;
  onToggle: (key: string, value: string) => void;
  onSelectIndustry: (value: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  // Accordion — only one group open at a time; first group open on load.
  const [openKey, setOpenKey] = useState<string | null>(dimensions[0]?.key ?? null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-scrim${open ? ' open' : ''}`} onClick={onClose} aria-hidden={!open} style={{ pointerEvents: open ? 'auto' : 'none' }} />
      <div className={`drawer${open ? ' open' : ''}`} role="dialog" aria-modal="true" aria-label="Filters" aria-hidden={!open}>
        <div className="drawer-hd">
          <h3>Filters</h3>
          <button className="drawer-x" aria-label="Close filters" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="drawer-body">
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
        </div>
        <div className="drawer-foot">
          <button className="btn-outline" onClick={onReset}>
            Clear all
          </button>
          <button className="btn-primary" onClick={onClose}>
            Show {resultCount} result{resultCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </>
  );
}
