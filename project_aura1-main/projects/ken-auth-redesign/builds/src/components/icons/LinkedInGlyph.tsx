/**
 * LinkedInGlyph — official-style solid LinkedIn brand mark (blue rounded square + white "in").
 *
 * WHY: lucide-react (installed version) no longer ships third-party brand glyphs
 * (`Linkedin` export removed) and its old brand icon was an outline anyway, not the
 * reference's solid-blue-square mark. Per signup-email.spec.md uncertainty #5, use an
 * inline brand-accurate SVG instead of a DS token — this is an expected exception
 * (third-party brand color, not a Ken DS color) per the spec's color-mapping table.
 */
export interface LinkedInGlyphProps {
  className?: string;
  /** Matches lucide-react's icon prop convention — `Button` clones its `icon` prop with `size`. */
  size?: number;
}

export function LinkedInGlyph({ className, size = 18 }: LinkedInGlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <path
        fill="#FFFFFF"
        d="M7.2 9.6H4.8V19.2H7.2V9.6ZM6 8.4C6.795 8.4 7.44 7.755 7.44 6.96C7.44 6.165 6.795 5.52 6 5.52C5.205 5.52 4.56 6.165 4.56 6.96C4.56 7.755 5.205 8.4 6 8.4ZM9.36 9.6H11.64V10.68H11.673C11.986 10.09 12.746 9.469 13.884 9.469C16.32 9.469 16.8 11.06 16.8 13.14V19.2H14.4V13.62C14.4 12.63 14.382 11.358 13.02 11.358C11.638 11.358 11.4 12.436 11.4 13.55V19.2H9.36V9.6Z"
      />
    </svg>
  );
}
