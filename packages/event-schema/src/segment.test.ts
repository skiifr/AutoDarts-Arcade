import { describe, expect, it } from 'vitest';
import {
  BOARD_NUMBERS_CLOCKWISE,
  INNER_BULL,
  MISS,
  OUTER_BULL,
  SegmentSchema,
  labelFor,
  makeSegment,
  miss,
  points,
  sameSegment,
} from './segment';

describe('labelFor', () => {
  it.each([
    [20, 3, 'T20'],
    [16, 2, 'D16'],
    [5, 1, 'S5'],
    [25, 1, '25'],
    [25, 2, 'BULL'],
    [0, 0, 'MISS'],
    [12, 0, 'MISS'],
  ])('%i × %i → %s', (n, m, label) => {
    expect(labelFor(n, m)).toBe(label);
  });
});

describe('points', () => {
  it('derives points from number × multiplier', () => {
    expect(points(makeSegment(20, 3))).toBe(60);
    expect(points(INNER_BULL)).toBe(50);
    expect(points(OUTER_BULL)).toBe(25);
    expect(points(MISS)).toBe(0);
  });
});

describe('makeSegment', () => {
  it('builds every valid board segment', () => {
    for (const n of BOARD_NUMBERS_CLOCKWISE) {
      for (const m of [1, 2, 3] as const) {
        expect(SegmentSchema.safeParse(makeSegment(n, m)).success).toBe(true);
      }
    }
  });

  it('keeps inner and outer singles apart', () => {
    expect(makeSegment(7, 1, 'single-outer').bed).toBe('single-outer');
    expect(sameSegment(makeSegment(7, 1, 'single-inner'), makeSegment(7, 1, 'single-outer'))).toBe(false);
  });

  it('rejects impossible segments', () => {
    expect(() => makeSegment(25, 3)).toThrow(RangeError);
    expect(() => makeSegment(21, 1)).toThrow(RangeError);
    expect(() => makeSegment(5, 2, 'triple')).toThrow(RangeError);
  });
});

describe('SegmentSchema', () => {
  it('rejects a label that does not match the segment', () => {
    const r = SegmentSchema.safeParse({ number: 20, multiplier: 3, bed: 'triple', label: 'S20' });
    expect(r.success).toBe(false);
  });

  it('rejects a bed that does not match the multiplier', () => {
    const r = SegmentSchema.safeParse({ number: 20, multiplier: 3, bed: 'double', label: 'T20' });
    expect(r.success).toBe(false);
  });

  it('accepts a miss with the sector it landed beside', () => {
    expect(SegmentSchema.parse(miss(12))).toEqual({ ...MISS, missSector: 12 });
  });

  it('rejects missSector on a scoring dart', () => {
    const r = SegmentSchema.safeParse({ ...makeSegment(12, 1), missSector: 12 });
    expect(r.success).toBe(false);
  });
});
