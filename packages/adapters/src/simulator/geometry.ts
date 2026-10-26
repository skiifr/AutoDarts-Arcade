import { BOARD_NUMBERS_CLOCKWISE, INNER_BULL, MISS, OUTER_BULL, makeSegment, miss, type Coords, type Segment } from '@arcade/event-schema';
import { pick } from '../random';
import type { RandomSource } from '../ports';

/**
 * Board geometry in Autodarts' coordinate convention (🟡, confirmed by DartLab's 2.0.2
 * capture): bull-centred, r = 1.0 at the outer edge of the double ring (170 mm), y points
 * at the 20, x to the right (so T5 and S12 have negative x).
 */
const R = {
  innerBull: 6.35 / 170,
  outerBull: 15.9 / 170,
  tripleIn: 99 / 170,
  tripleOut: 107 / 170,
  doubleIn: 162 / 170,
  doubleOut: 1,
  offBoard: 1.35,
};

function radiusRange(seg: Segment): [number, number] {
  switch (seg.bed) {
    case 'inner-bull':
      return [0, R.innerBull];
    case 'outer-bull':
      return [R.innerBull, R.outerBull];
    case 'single-inner':
      return [R.outerBull, R.tripleIn];
    case 'single':
    case 'single-outer':
      return [R.tripleOut, R.doubleIn];
    case 'triple':
      return [R.tripleIn, R.tripleOut];
    case 'double':
      return [R.doubleIn, R.doubleOut];
    case 'miss':
      return [R.doubleOut, R.offBoard];
  }
}

/** A random point inside a segment's bed (a miss lands just outside the board). */
export function coordsFor(seg: Segment, random: RandomSource): Coords {
  const [r0, r1] = radiusRange(seg);
  const margin = (r1 - r0) * 0.08;
  const r = r0 + margin + random() * (r1 - r0 - 2 * margin);
  const sectorNumber = seg.bed === 'miss' ? (seg.missSector ?? pick(random, BOARD_NUMBERS_CLOCKWISE)) : seg.number;
  let angle: number;
  if (sectorNumber === 25 || sectorNumber === 0) angle = random() * 2 * Math.PI;
  else {
    const i = BOARD_NUMBERS_CLOCKWISE.indexOf(sectorNumber as (typeof BOARD_NUMBERS_CLOCKWISE)[number]);
    const centre = ((90 - i * 18) * Math.PI) / 180;
    angle = centre + (random() - 0.5) * ((16 * Math.PI) / 180);
  }
  return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
}

/** Moves a dart across a nearby wire by at most ~5 mm, keeping it on the board. */
export function nudge(c: Coords, random: RandomSource, max = 0.03): Coords {
  const a = random() * 2 * Math.PI;
  const d = max * (0.3 + 0.7 * random());
  return { x: c.x + d * Math.cos(a), y: c.y + d * Math.sin(a) };
}

/** A plausible spread of darts for random play and demo mode. */
export function randomSegment(random: RandomSource): Segment {
  const u = random();
  if (u < 0.06) return miss(pick(random, BOARD_NUMBERS_CLOCKWISE));
  if (u < 0.09) return OUTER_BULL;
  if (u < 0.105) return INNER_BULL;
  const n = pick(random, BOARD_NUMBERS_CLOCKWISE);
  const v = random();
  if (v < 0.14) return makeSegment(n, 3);
  if (v < 0.26) return makeSegment(n, 2);
  return makeSegment(n, 1, v < 0.55 ? 'single-inner' : 'single-outer');
}

/** A different segment the board might confuse this one with (for "board changes its mind"). */
export function neighbourSegment(seg: Segment, random: RandomSource): Segment {
  if (seg.number === 25) return seg.multiplier === 2 ? OUTER_BULL : makeSegment(pick(random, BOARD_NUMBERS_CLOCKWISE), 1, 'single-inner');
  if (seg.bed === 'miss') return makeSegment(seg.missSector ?? 20, 2);
  const i = BOARD_NUMBERS_CLOCKWISE.indexOf(seg.number as (typeof BOARD_NUMBERS_CLOCKWISE)[number]);
  const side = BOARD_NUMBERS_CLOCKWISE[(i + (random() < 0.5 ? 1 : 19)) % 20] as number;
  switch (seg.bed) {
    case 'triple':
      return random() < 0.5 ? makeSegment(seg.number, 1, 'single-outer') : makeSegment(side, 3);
    case 'double':
      return random() < 0.5 ? miss(seg.number) : makeSegment(side, 2);
    case 'single-inner':
      return random() < 0.5 ? makeSegment(seg.number, 3) : OUTER_BULL;
    default:
      return random() < 0.5 ? makeSegment(seg.number, 2) : makeSegment(side, 1, 'single-outer');
  }
}

/** Segment from a label: T20, D16, S5, SI5 / SO5 (inner/outer single), 25, BULL, MISS, M12. */
export function parseLabel(label: string): Segment {
  const l = label.trim().toUpperCase();
  if (l === 'MISS' || l === 'M') return MISS;
  if (l === '25' || l === 'SB' || l === 'OB') return OUTER_BULL;
  if (l === 'BULL' || l === 'DB' || l === '50') return INNER_BULL;
  const m = /^M(\d{1,2})$/.exec(l);
  if (m) return miss(Number(m[1]));
  const s = /^(SI|SO|S|D|T)(\d{1,2})$/.exec(l);
  if (!s) throw new RangeError(`Unknown segment label "${label}"`);
  const n = Number(s[2]);
  switch (s[1]) {
    case 'SI':
      return makeSegment(n, 1, 'single-inner');
    case 'SO':
      return makeSegment(n, 1, 'single-outer');
    case 'S':
      return makeSegment(n, 1, 'single-outer');
    case 'D':
      return makeSegment(n, 2);
    default:
      return makeSegment(n, 3);
  }
}
