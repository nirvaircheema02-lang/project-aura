/**
 * KenLogo — logo mark + wordmark injected into `TopNavigation`'s `logo` slot.
 *
 * `atoms/LogoButton.tsx` is intentionally slot-based (package never imports brand
 * SVG assets — see its own doc comment: "package stays free of brand assets").
 * There is no DS `Logo` atom in `core-v2` to import here (only `LogoButton`, the
 * clickable wrapper). This is the same red-square-K + "Ken Research" wordmark
 * pattern used by the previous (wrong) `organisms/Navbar.tsx`'s inline logo
 * markup — kept here as plain content, not a hand-rolled approximation of a
 * mapped DS component.
 */
export function KenLogo() {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="w-8 h-8 flex items-center justify-center flex-shrink-0"
        style={{ background: 'var(--color-brand-red)', borderRadius: 'var(--radius-button)' }}
      >
        <span className="text-white font-bold text-sm">K</span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-[var(--surface-text)] tracking-tight text-[14px]">Ken Research</span>
        <span className="text-[var(--surface-text-subtle)] uppercase text-[9px] tracking-[0.12em]">
          Market Intelligence
        </span>
      </div>
    </div>
  );
}
