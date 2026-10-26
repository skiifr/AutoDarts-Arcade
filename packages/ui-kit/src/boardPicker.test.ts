import { INNER_BULL, MISS, makeSegment, miss } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { bedCentroid, sectorPath } from './boardGeometry';
import { RADIAL_RINGS, movePicker, pickerFromSegment, pickerNumber, pickerToSegment, type PickerState } from './boardPicker';

const at = (seg: Parameters<typeof pickerFromSegment>[0]) => pickerFromSegment(seg);
const walk = (start: PickerState, ...moves: Parameters<typeof movePicker>[1][]) => moves.reduce(movePicker, start);

describe('board picker (W4 D-pad model)', () => {
  it('rotates clockwise with ▶ and wraps 5 → 20', () => {
    expect(pickerNumber(walk(at(makeSegment(20, 1)), 'right'))).toBe(1);
    expect(pickerNumber(walk(at(makeSegment(5, 1)), 'right'))).toBe(20);
  });

  it('rotates anticlockwise with ◀ and wraps 20 → 5', () => {
    expect(pickerNumber(walk(at(makeSegment(20, 1)), 'left'))).toBe(5);
  });

  it('fixes "S5 should have been T5" in one press', () => {
    expect(pickerToSegment(walk(at(makeSegment(5, 1, 'single-outer')), 'down')).label).toBe('T5');
  });

  it('walks outward to a double, then to a miss beside the number', () => {
    const s = walk(at(makeSegment(16, 1, 'single-outer')), 'up');
    expect(pickerToSegment(s).label).toBe('D16');
    expect(pickerToSegment(movePicker(s, 'up'))).toEqual(miss(16));
  });

  it('walks inward through the bull and clamps at the inner bull', () => {
    const s = walk(at(makeSegment(3, 1, 'single-inner')), 'down', 'down', 'down', 'down');
    expect(pickerToSegment(s)).toEqual(INNER_BULL);
  });

  it('returns to the last number when rotating out of the bull', () => {
    const s = walk(at(makeSegment(17, 1, 'single-inner')), 'down', 'right');
    expect(pickerToSegment(s).label).toBe('S3');
  });

  it('round-trips every segment', () => {
    for (const ring of RADIAL_RINGS.keys()) {
      for (let sector = 0; sector < 20; sector++) {
        const seg = pickerToSegment({ sector, ring });
        const back = pickerToSegment(pickerFromSegment(seg));
        expect(back).toEqual(seg);
      }
    }
  });

  it('opens a plain miss on 20', () => {
    expect(pickerToSegment(at(MISS))).toEqual(miss(20));
  });
});

describe('board geometry', () => {
  it('draws closed sector paths', () => {
    expect(sectorPath(0, 0.9, 1)).toMatch(/^M.*Z$/);
  });

  it('puts the 20 treble straight up', () => {
    const c = bedCentroid(20, 'triple');
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeLessThan(0);
  });
});
