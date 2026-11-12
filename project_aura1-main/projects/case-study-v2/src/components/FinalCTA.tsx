'use client';

/**
 * Final "Contact us" CTA. Three faithful Figma variants ("Case Study 2026 N"):
 *  - 'card'       → contained light card, no eyebrow, 25px heading, "contact Us ↗"
 *                   (Templates A & C)
 *  - 'band'       → full-width tone band + "Get Started" eyebrow, 32px heading,
 *                   "contact Us ↗" (Templates D grey, E warm)
 *  - 'prominent'  → full-width grey band, 31px light-serif heading, Inter 20px
 *                   sub, "Schedule a Discovery Call" button (Template B)
 */
type Variant = 'card' | 'band' | 'prominent';
type Tone = 'grey' | 'warm';

const SUB =
  'Our research team can recommend the right approach for your specific business context.';

export default function FinalCTA({
  variant = 'band',
  tone = 'grey',
  inline = false,
  eyebrow = false,
  band = false,
}: {
  variant?: Variant;
  tone?: Tone;
  /** Card variant only: fill the parent column (no outer centering / gutter),
   *  so it aligns with Template A's main content. */
  inline?: boolean;
  /** Card variant only: show the "Get Started" eyebrow (Template D). */
  eyebrow?: boolean;
  /** Card variant only: sit the white card on a grey band with a 32px heading
   *  (Template D). */
  band?: boolean;
}) {
  if (variant === 'card') {
    return (
      <section
        className={`fcta fcta--card${inline ? ' fcta--inline' : ''}${
          band ? ' fcta--onband' : ''
        }`}
      >
        <div className="fcta-in fu">
          <div className="fcta-text">
            {eyebrow && <p className="fcta-eyebrow">Get Started</p>}
            <h2 className="fcta-h2">Contact us for tailored solutions.</h2>
            <p className="fcta-sub">{SUB}</p>
          </div>
          <button className="fcta-btn">
            contact Us <span aria-hidden>↗</span>
          </button>
        </div>
      </section>
    );
  }

  const prominent = variant === 'prominent';
  return (
    <section
      className={`fcta fcta--band fcta--${tone}${prominent ? ' fcta--prominent' : ''}`}
    >
      <div className="fcta-in fu">
        <div className="fcta-text">
          <p className="fcta-eyebrow">Get Started</p>
          <h2 className="fcta-h2">Contact us for tailored solutions.</h2>
          <p className="fcta-sub">{SUB}</p>
        </div>
        {prominent ? (
          <button className="fcta-btn">
            Schedule a Discovery Call <span aria-hidden>↗</span>
          </button>
        ) : (
          <button className="fcta-btn">
            contact Us <span aria-hidden>↗</span>
          </button>
        )}
      </div>
    </section>
  );
}
