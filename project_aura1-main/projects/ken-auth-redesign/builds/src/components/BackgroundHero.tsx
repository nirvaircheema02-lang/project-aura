import { Globe, TrendingUp, BarChart3 } from 'lucide-react';
import { Container, SectionHeading, BodyText } from '@/vendor/ds/atoms';
import { StatPairRow } from '@/vendor/ds/molecules';

/**
 * BackgroundHero — page-background filler for the ken-auth-redesign Loop project.
 *
 * WHY: The user explicitly asked for "any random section" behind the auth modal so the
 * page doesn't render as an empty gray canvas — this is directed low-stakes decorative
 * page content, NOT a fidelity-to-reference build. No Figma/chat reference exists for
 * this section, so there is no Copy Lock / DS Mapping Gate spec to follow (per task
 * instruction). It still reuses real DS atoms/molecules and existing tokens rather than
 * hand-rolled CSS, so it stays visually consistent with the rest of this project.
 *
 * WHAT: Simple Ken Research market-intelligence placeholder — eyebrow + heading +
 * supporting paragraph via `SectionHeading` + `BodyText`, and a 3-stat row via the real
 * `StatPairRow` molecule (which itself composes `InlineStats` atoms). Wrapped in the real
 * `Container` atom at `maxWidth="content"` for consistent horizontal rhythm.
 *
 * WHERE: Rendered in `src/app/page.tsx`, behind the `Navbar` and behind the `AuthModal`
 * overlay/scrim. Pure background filler — not interactive, not part of the auth flow.
 */
export function BackgroundHero() {
  return (
    <section
      data-component="BackgroundHero"
      className="w-full py-16 sm:py-24"
      style={{ background: 'var(--semantic-surface-white, #fafafa)' }}
    >
      <Container maxWidth="content">
        <SectionHeading
          level={1}
          align="center"
          eyebrow="Ken Research"
          title="Market Intelligence for Global Decisions"
          subtitle="Actionable research across 50+ countries and 1,000+ industries — built for teams who need answers, not just data."
          className="mx-auto"
        />

        <div className="mx-auto max-w-2xl text-center">
          <BodyText spacing="first">
            From market sizing to competitive benchmarking, Ken Research turns raw
            industry signal into decisions your team can act on today.
          </BodyText>
        </div>

        <div className="mt-10 max-w-2xl mx-auto">
          <StatPairRow
            stats={[
              { icon: Globe, value: '50+', label: 'Countries Covered', iconColor: 'periwinkle' },
              { icon: BarChart3, value: '1,000+', label: 'Industries Tracked', iconColor: 'periwinkle' },
              { icon: TrendingUp, value: '1M+', label: 'Reports Delivered', iconColor: 'periwinkle' },
            ]}
          />
        </div>
      </Container>
    </section>
  );
}
