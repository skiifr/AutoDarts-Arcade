import { describe, expect, it } from 'vitest';
import { checkoutHint } from './checkout';

const DOUBLE_OUT = { doubleOut: true, dartsLeft: 3 };
const SINGLE_OUT = { doubleOut: false, dartsLeft: 3 };
const MULTIPLIER: Record<string, number> = { S: 1, D: 2, T: 3 };
const valueOf = (label: string) => (label === 'BULL' ? 50 : label === '25' ? 25 : Number(label.slice(1)) * MULTIPLIER[label[0]!]!);
const finishesOnDouble = (label: string) => label === 'BULL' || label.startsWith('D');

describe('double out: chart routes', () => {
  it.each([
    // Three darts: T20 / T19 first, onto the doubles charts like.
    [170, 'T20 T20 BULL'],
    [167, 'T20 T19 BULL'],
    [164, 'T20 T18 BULL'],
    [161, 'T20 T17 BULL'],
    [160, 'T20 T20 D20'],
    [158, 'T20 T20 D19'],
    [157, 'T20 T19 D20'],
    [156, 'T20 T20 D18'],
    [155, 'T20 T19 D19'],
    [152, 'T20 T20 D16'],
    [150, 'T20 T18 D18'],
    [141, 'T20 T19 D12'],
    [140, 'T20 T20 D10'],
    [136, 'T20 T20 D8'],
    [132, 'T20 T16 D12'],
    [121, 'T20 T15 D8'],
    [120, 'T20 S20 D20'],
    [99, 'T20 S7 D16'],
    // Two darts.
    [110, 'T20 BULL'],
    [107, 'T19 BULL'],
    [104, 'T18 BULL'],
    [101, 'T17 BULL'],
    [100, 'T20 D20'],
    [97, 'T19 D20'],
    [96, 'T20 D18'],
    [92, 'T20 D16'],
    [90, 'T18 D18'],
    [89, 'T19 D16'],
    [84, 'T20 D12'],
    [81, 'T19 D12'],
    [80, 'T20 D10'],
    [76, 'T20 D8'],
    [70, 'T18 D8'],
    [64, 'T16 D8'],
    [62, 'T10 D16'],
    [61, 'T15 D8'],
    [60, 'S20 D20'],
    [57, 'S17 D20'],
    [48, 'S16 D16'],
    [41, 'S9 D16'],
    [33, 'S1 D16'],
    [17, 'S1 D8'],
    [9, 'S1 D4'],
    [3, 'S1 D1'],
    // One dart.
    [50, 'BULL'],
    [40, 'D20'],
    [32, 'D16'],
    [16, 'D8'],
    [2, 'D1'],
  ])('%i → %s', (remaining, route) => {
    expect(checkoutHint(remaining, DOUBLE_OUT)).toEqual(route.split(' '));
  });

  it.each([169, 168, 166, 165, 163, 162, 159])('%i is a bogey number', (remaining) => {
    expect(checkoutHint(remaining, DOUBLE_OUT)).toBeNull();
  });

  it.each([171, 180, 501, 1, 0, -4, 40.5])('%s has no checkout', (remaining) => {
    expect(checkoutHint(remaining, DOUBLE_OUT)).toBeNull();
  });

  it('every route from 2 to 170 adds up, uses at most three darts and ends on a double', () => {
    for (let remaining = 2; remaining <= 170; remaining++) {
      const route = checkoutHint(remaining, DOUBLE_OUT);
      if (route === null) continue;
      expect(route.length).toBeLessThanOrEqual(3);
      expect(route.reduce((sum, label) => sum + valueOf(label), 0)).toBe(remaining);
      expect(finishesOnDouble(route[route.length - 1]!)).toBe(true);
    }
  });
});

describe('darts left in the visit', () => {
  it.each([
    [141, 2, null],
    [100, 2, 'T20 D20'],
    [110, 2, 'T20 BULL'],
    [99, 2, null],
    [50, 1, 'BULL'],
    [40, 1, 'D20'],
    [41, 1, null],
    [60, 1, null],
    [40, 0, null],
  ])('%i with %i darts → %s', (remaining, dartsLeft, route) => {
    expect(checkoutHint(remaining, { doubleOut: true, dartsLeft })).toEqual(route === null ? null : route.split(' '));
  });
});

describe('single out: the shortest finish', () => {
  it.each([
    [20, 'S20'],
    [25, '25'],
    [40, 'D20'],
    [50, 'BULL'],
    [57, 'T19'],
    [60, 'T20'],
    [61, 'T20 S1'],
    [170, 'T20 T20 BULL'],
    [180, 'T20 T20 T20'],
    [1, 'S1'],
  ])('%i → %s', (remaining, route) => {
    expect(checkoutHint(remaining, SINGLE_OUT)).toEqual(route.split(' '));
  });

  it('still has none when three darts cannot make it', () => {
    expect(checkoutHint(179, SINGLE_OUT)).toBeNull();
    expect(checkoutHint(181, SINGLE_OUT)).toBeNull();
    expect(checkoutHint(61, { doubleOut: false, dartsLeft: 1 })).toBeNull();
  });
});
