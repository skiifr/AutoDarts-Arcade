import { createRng, type Rng } from '@arcade/engine';
import {
  BOARD_NUMBERS_CLOCKWISE,
  INNER_BULL,
  OUTER_BULL,
  makeSegment,
  miss,
  type Segment,
} from '@arcade/event-schema';
import type { DartSource } from './harness';

/**
 * A pub-level dart at `target` (1–20, or 25 for the bull): mostly the number, sometimes a
 * double or treble, often a neighbouring number, now and then off the board.
 */
export function aimedDart(rng: Rng, target: number): Segment {
  const r = rng.next();
  if (target === 25) {
    if (r < 0.1) return INNER_BULL;
    if (r < 0.35) return OUTER_BULL;
    if (r < 0.9) return makeSegment(rng.int(1, 20), 1, 'single-inner');
    return miss();
  }
  if (r < 0.1) return makeSegment(target, 3);
  if (r < 0.18) return makeSegment(target, 2);
  if (r < 0.6) return makeSegment(target, 1, r < 0.4 ? 'single-inner' : 'single-outer');
  if (r < 0.93) {
    const at = BOARD_NUMBERS_CLOCKWISE.indexOf(target as (typeof BOARD_NUMBERS_CLOCKWISE)[number]);
    const side = rng.next() < 0.5 ? 19 : 1;
    return makeSegment(BOARD_NUMBERS_CLOCKWISE[(at + side) % 20]!, 1, 'single-outer');
  }
  return miss(target);
}

/**
 * A seeded player who aims at the first of the view's `targets` (or 20). It has its own
 * random stream, so the game's `Rng` sees exactly the draws the game makes.
 */
export function aimingThrower(seed: string): DartSource {
  const rng = createRng(`thrower:${seed}`);
  return ({ view }) => {
    const targets = (view as { targets?: readonly number[] }).targets;
    return aimedDart(rng, targets?.[0] ?? 20);
  };
}
