export type Variant = 'variant1' | 'variant2';

const TABS: { key: Variant; label: string }[] = [
  { key: 'variant1', label: 'Variant 1' },
  { key: 'variant2', label: 'Variant 2' },
];

/**
 * Segmented pill control for switching between the 2 finalized card-listing
 * variants. Both share the same hero — only the citation card style (and
 * filter-sidebar visibility) differ. Ken-red active state, neutral inactive —
 * same visual language as the DS's other pill/segmented controls. Purely
 * presentational; the parent owns `variant` state and keeps data/filters
 * shared across tabs.
 */
export default function VariantTabs({
  variant,
  onChange,
}: {
  variant: Variant;
  onChange: (v: Variant) => void;
}) {
  return (
    <div className="vtabs-wrap">
      <div className="vtabs" role="tablist" aria-label="Design variant">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={variant === t.key}
            className={`vtab${variant === t.key ? ' on' : ''}`}
            onClick={() => onChange(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
