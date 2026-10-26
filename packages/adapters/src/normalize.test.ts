import { INNER_BULL, MISS, OUTER_BULL, SegmentSchema, makeSegment, miss } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { normalizeSegment, normalizeThrow } from './normalize';

describe('normalizeSegment: ARCHITECTURE §7.3 table', () => {
  it.each([
    // Misses, both community shapes and the hint-only forms.
    ['2.0.2 capture miss M12', { name: 'M12', bed: 'Outside', multiplier: 0, number: 12 }, miss(12)],
    ['bare miss M', { name: 'M', number: 0, multiplier: 0 }, MISS],
    ['multiplier 0 alone', { number: 7, multiplier: 0 }, miss(7)],
    ['bed Outside, no multiplier', { name: 'M3', bed: 'Outside', number: 3 }, miss(3)],
    ['name Miss, no multiplier', { name: 'Miss', number: 0 }, MISS],
    ['sector from the name only', { name: 'M19', multiplier: 0 }, miss(19)],
    ['miss beside the bull keeps no sector', { name: 'M', number: 25, multiplier: 0 }, MISS],
    // Bulls, both inner-bull spellings.
    ['inner bull, bed Double (HomeDarts)', { name: 'Bull', number: 25, bed: 'Double', multiplier: 2 }, INNER_BULL],
    ['inner bull, bed DoubleBull (cloud types)', { name: 'Bull', number: 25, bed: 'DoubleBull', multiplier: 2 }, INNER_BULL],
    ['inner bull, no hints', { number: 25, multiplier: 2 }, INNER_BULL],
    ['outer bull, name 25 bed Single (HomeDarts)', { name: '25', number: 25, bed: 'Single', multiplier: 1 }, OUTER_BULL],
    ['outer bull, bed SingleOuter', { name: 'S25', number: 25, bed: 'SingleOuter', multiplier: 1 }, OUTER_BULL],
    ['outer bull named Bull', { name: 'Bull', number: 25, multiplier: 1 }, OUTER_BULL],
    // Singles keep inner and outer apart; doubles and triples.
    ['T20', { name: 'T20', number: 20, bed: 'Triple', multiplier: 3 }, makeSegment(20, 3)],
    ['D16', { name: 'D16', number: 16, bed: 'Double', multiplier: 2 }, makeSegment(16, 2)],
    ['SingleInner', { name: 'S20', number: 20, bed: 'SingleInner', multiplier: 1 }, makeSegment(20, 1, 'single-inner')],
    ['SingleOuter', { name: 'S12', number: 12, bed: 'SingleOuter', multiplier: 1 }, makeSegment(12, 1, 'single-outer')],
    ['Single', { name: 'S5', number: 5, bed: 'Single', multiplier: 1 }, makeSegment(5, 1, 'single')],
    ['number × multiplier without hints', { number: 3, multiplier: 3 }, makeSegment(3, 3)],
  ])('%s', (_label, raw, expected) => {
    const r = normalizeSegment(raw);
    expect(r.fatal).toBeUndefined();
    expect(r.segment).toEqual(expected);
    expect(SegmentSchema.safeParse(r.segment).success).toBe(true);
  });

  it.each([
    ['not an object', 'T20'],
    ['null', null],
    ['missing number and multiplier', { name: 'T20', bed: 'Triple' }],
    ['multiplier 4', { number: 20, multiplier: 4 }],
    ['triple bull', { number: 25, multiplier: 3 }],
    ['number 21', { number: 21, multiplier: 1 }],
    ['number 0 scoring', { number: 0, multiplier: 2 }],
    ['fractional number', { number: 2.5, multiplier: 1 }],
    ['string number', { number: '20', multiplier: 3 }],
    ['bed contradicts multiplier', { name: 'T20', number: 20, bed: 'Double', multiplier: 3 }],
    ['name contradicts number', { name: 'T19', number: 20, bed: 'Triple', multiplier: 3 }],
    ['miss name with a scoring multiplier', { name: 'M20', number: 20, multiplier: 3 }],
    ['bed Outside with a scoring multiplier', { bed: 'Outside', number: 20, multiplier: 1 }],
    ['multiplier 0 with bed Triple', { bed: 'Triple', number: 20, multiplier: 0 }],
    ['bull named as a double', { name: 'D25', number: 25, bed: 'Single', multiplier: 1 }],
    ['inner-bull name for an outer bull', { name: 'DB', number: 25, multiplier: 1 }],
  ])('unreadable: %s → miss pending review', (_label, raw) => {
    const r = normalizeSegment(raw);
    expect(r.segment).toEqual(MISS);
    expect(r.fatal?.note).toMatch(/pending review/);
    expect(r.fatal?.rawExcerpt.length).toBeLessThanOrEqual(512);
  });

  it('derives from number × multiplier and only notes unknown hints', () => {
    const r = normalizeSegment({ name: 'Treble-20', number: 20, bed: 'TripleOuter', multiplier: 3 });
    expect(r.segment).toEqual(makeSegment(20, 3));
    expect(r.fatal).toBeUndefined();
    expect(r.notes).toEqual(['unknown bed "TripleOuter"', 'unknown segment name "Treble-20"']);
  });

  it('caps the excerpt of a huge unreadable segment', () => {
    const r = normalizeSegment({ number: 99, multiplier: 1, junk: 'x'.repeat(100_000) });
    expect(r.fatal?.rawExcerpt.length).toBeLessThanOrEqual(512);
  });
});

describe('normalizeThrow', () => {
  it('keeps finite coordinates and the segment', () => {
    const r = normalizeThrow({
      bouncer: false,
      coords: { x: -0.819618835559737, y: 0.9862693484666629 },
      segment: { bed: 'Outside', multiplier: 0, name: 'M12', number: 12 },
    });
    expect(r).toEqual({ segment: miss(12), coords: { x: -0.819618835559737, y: 0.9862693484666629 }, notes: [] });
  });

  it('accepts a dart without coordinates (bounce-outs may carry none)', () => {
    expect(normalizeThrow({ segment: { number: 1, multiplier: 1 } }).coords).toBeUndefined();
  });

  it('notes bad coordinates and bouncer: true but keeps the dart', () => {
    const r = normalizeThrow({ bouncer: true, coords: { x: 'a', y: 1 }, segment: { number: 6, multiplier: 2 } });
    expect(r.segment).toEqual(makeSegment(6, 2));
    expect(r.notes).toEqual(['coords not two finite numbers', 'bouncer: true observed']);
  });

  it('treats a non-object entry as a miss pending review', () => {
    const r = normalizeThrow(42);
    expect(r.segment).toEqual(MISS);
    expect(r.fatal?.note).toMatch(/not an object/);
  });
});
