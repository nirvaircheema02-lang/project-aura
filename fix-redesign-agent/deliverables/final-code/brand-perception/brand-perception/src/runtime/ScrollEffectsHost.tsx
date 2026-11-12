import { useEffect } from 'react';
import { scrollEffects } from '../generated/scrollEffects';
import { startScrollEffects } from './scrollEffects';

/** Replays the original page's scroll-linked movement (recorded read-only on the production page). Renders nothing. */
export function ScrollEffects() {
  useEffect(() => startScrollEffects(scrollEffects), []);
  return null;
}
