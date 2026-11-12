import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@kenresearch/design-system/ui/button';

/**
 * A carousel previous/next control exactly as the design system builds it (`ui/carousel`: CarouselPrevious / CarouselNext):
 * the DS `Button` in its `outline` variant, `icon` size narrowed to `size-8 rounded-full`, lucide `ArrowLeft` / `ArrowRight`,
 * and a screen-reader label. The section's carousel adapter connects both native button controls to its track.
 */
export function CarouselArrow({ direction, disabled }: { direction: 'prev' | 'next'; disabled?: boolean }) {
  const prev = direction === 'prev';
  return (
    <Button variant="outline" size="icon" className="size-8 rounded-full" data-pv-carousel-direction={direction} disabled={disabled}>
      {prev ? <ArrowLeft /> : <ArrowRight />}
      <span className="sr-only">{prev ? 'Previous slide' : 'Next slide'}</span>
    </Button>
  );
}
