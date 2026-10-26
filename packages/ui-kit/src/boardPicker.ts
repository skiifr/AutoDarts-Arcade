import {
  BOARD_NUMBERS_CLOCKWISE,
  INNER_BULL,
  OUTER_BULL,
  makeSegment,
  miss,
  type Bed,
  type Segment,
} from '@arcade/event-schema';
import { sectorIndexOf } from './boardGeometry';

/**
 * D-pad model for the correction picker (wireframe W4):
 * ◀ ▶ rotate round the numbers; ▲ ▼ move outward / inward through the rings,
 * from inner bull all the way out to a miss beside the current number.
 */
export const RADIAL_RINGS = [
  'inner-bull',
  'outer-bull',
  'single-inner',
  'triple',
  'single-outer',
  'double',
  'miss',
] as const satisfies readonly Bed[];

export interface PickerState {
  /** Index into BOARD_NUMBERS_CLOCKWISE; kept while passing through bull or miss. */
  sector: number;
  /** Index into RADIAL_RINGS. */
  ring: number;
}

export type PickerMove = 'left' | 'right' | 'up' | 'down';

const SECTORS = BOARD_NUMBERS_CLOCKWISE.length;
const DEFAULT_RING = RADIAL_RINGS.indexOf('single-outer');

export function movePicker(state: PickerState, move: PickerMove): PickerState {
  switch (move) {
    case 'right':
      return { sector: (state.sector + 1) % SECTORS, ring: isNumberRing(state.ring) ? state.ring : DEFAULT_RING };
    case 'left':
      return { sector: (state.sector - 1 + SECTORS) % SECTORS, ring: isNumberRing(state.ring) ? state.ring : DEFAULT_RING };
    case 'up':
      return { ...state, ring: Math.min(state.ring + 1, RADIAL_RINGS.length - 1) };
    case 'down':
      return { ...state, ring: Math.max(state.ring - 1, 0) };
  }
}

function isNumberRing(ring: number): boolean {
  const bed = RADIAL_RINGS[ring];
  return bed !== 'inner-bull' && bed !== 'outer-bull' && bed !== 'miss';
}

export function pickerNumber(state: PickerState): number {
  return BOARD_NUMBERS_CLOCKWISE[state.sector] ?? 20;
}

export function pickerToSegment(state: PickerState): Segment {
  const bed = RADIAL_RINGS[state.ring] ?? 'single-outer';
  const number = pickerNumber(state);
  switch (bed) {
    case 'inner-bull':
      return INNER_BULL;
    case 'outer-bull':
      return OUTER_BULL;
    case 'miss':
      return miss(number);
    case 'triple':
      return makeSegment(number, 3);
    case 'double':
      return makeSegment(number, 2);
    case 'single-inner':
    case 'single-outer':
      return makeSegment(number, 1, bed);
  }
}

export function pickerFromSegment(segment: Segment): PickerState {
  const bed: Bed = segment.bed === 'single' ? 'single-outer' : segment.bed;
  const fromNumber = sectorIndexOf(segment.bed === 'miss' ? (segment.missSector ?? 20) : segment.number);
  return {
    sector: fromNumber < 0 ? 0 : fromNumber,
    ring: (RADIAL_RINGS as readonly Bed[]).indexOf(bed),
  };
}
