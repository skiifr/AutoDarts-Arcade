import type { IdSource, RandomSource } from './ports';

/** xmur3 string hash → 32-bit seed. */
function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic uniform [0, 1) generator (mulberry32) for tests, the simulator and replays. */
export function seededRandom(seed: string | number): RandomSource {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max]. */
export function randomInt(random: RandomSource, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: RandomSource, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new RangeError('pick from an empty list');
  return item;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Monotonic ULID factory with injected time (ms since epoch) and randomness, so ids are
 * deterministic in tests and lexically ordered even within one millisecond.
 */
export function createUlidSource(options: { now: () => number; random: RandomSource }): IdSource {
  let lastTime = -1;
  const rand: number[] = new Array<number>(16).fill(0);
  return () => {
    let time = Math.max(0, Math.floor(options.now()));
    if (time <= lastTime) {
      time = lastTime;
      // Increment the 80-bit random part; on overflow, step the time (practically never).
      let i = 15;
      while (i >= 0 && rand[i] === 31) rand[i--] = 0;
      if (i < 0) time = ++lastTime;
      else rand[i] = (rand[i] as number) + 1;
    } else {
      for (let i = 0; i < 16; i++) rand[i] = Math.floor(options.random() * 32);
    }
    lastTime = time;
    let timePart = '';
    let t = time;
    for (let i = 0; i < 10; i++) {
      timePart = CROCKFORD[t % 32] + timePart;
      t = Math.floor(t / 32);
    }
    return timePart + rand.map((d) => CROCKFORD[d]).join('');
  };
}
