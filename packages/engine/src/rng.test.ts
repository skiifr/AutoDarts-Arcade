import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SeededRng, createRng } from './rng';

describe('SeededRng', () => {
  // Pinned outputs. They were cross-checked against an independent uint32 implementation of
  // cyrb128 + sfc32 (the C reference: tmp = a + b + counter++). Any engine (Node, Hermes)
  // must reproduce them exactly, or replays of randomised games would diverge.
  it.each([
    ['01JBX0SEED', [3661088504, 4040469090, 106930455, 1671917833, 1637076166]],
    ['', [2420727049, 3315390910, 31621017]],
    ['seed-ü-🎯', [3483672342, 1542851078, 3696948870]],
  ])('draws the pinned sequence for seed %j', (seed, expected) => {
    const rng = createRng(seed);
    expect(expected.map(() => rng.nextUint32())).toEqual(expected);
  });

  it('pins next() and int() too', () => {
    const a = createRng('01JBX0SEED');
    expect([a.next(), a.next(), a.next()]).toEqual([0.8524135928601027, 0.9407450188882649, 0.024896686663851142]);
    const b = createRng('01JBX0SEED');
    expect(Array.from({ length: 8 }, () => b.int(1, 20))).toEqual([18, 19, 1, 8, 8, 19, 18, 16]);
  });

  it('is deterministic for any seed, and seeds give different streams', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (s1, s2) => {
        const x = createRng(s1);
        const y = createRng(s1);
        const xs = Array.from({ length: 16 }, () => x.next());
        expect(Array.from({ length: 16 }, () => y.next())).toEqual(xs);
        if (s1 !== s2) {
          const z = createRng(s2);
          expect(Array.from({ length: 16 }, () => z.next())).not.toEqual(xs);
        }
      }),
    );
  });

  it('resumes exactly from a saved state', () => {
    fc.assert(
      fc.property(fc.string(), fc.nat(50), (seed, skip) => {
        const rng = createRng(seed);
        for (let i = 0; i < skip; i++) rng.next();
        const state = rng.getState();
        const rest = Array.from({ length: 10 }, () => rng.nextUint32());
        const resumed = SeededRng.fromState(JSON.parse(JSON.stringify(state)));
        expect(Array.from({ length: 10 }, () => resumed.nextUint32())).toEqual(rest);
      }),
    );
  });

  it('keeps next() in [0, 1) and int() in [min, max]', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: -1000, max: 1000 }), fc.nat(1000), (seed, min, width) => {
        const rng = createRng(seed);
        for (let i = 0; i < 50; i++) {
          const f = rng.next();
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThan(1);
          const n = rng.int(min, min + width);
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(min);
          expect(n).toBeLessThanOrEqual(min + width);
        }
      }),
    );
  });

  it('reaches every value of a small range with a roughly even spread', () => {
    const rng = createRng('spread');
    const counts = new Array<number>(20).fill(0);
    for (let i = 0; i < 20000; i++) counts[rng.int(1, 20) - 1]! += 1;
    for (const c of counts) {
      expect(c).toBeGreaterThan(850);
      expect(c).toBeLessThan(1150);
    }
  });

  it('rejects invalid ranges', () => {
    const rng = createRng('x');
    expect(() => rng.int(5, 4)).toThrow(RangeError);
    expect(() => rng.int(0.5, 4)).toThrow(RangeError);
    expect(() => rng.int(0, 2 ** 33)).toThrow(RangeError);
  });
});
