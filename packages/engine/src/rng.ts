import type { Rng } from './game-module';

/** The four 32-bit words of sfc32's state. Plain numbers, so it serialises with a snapshot. */
export type RngState = readonly [number, number, number, number];

/**
 * cyrb128: hashes a string into four 32-bit words. Uses only `charCodeAt` (UTF-16 code units),
 * `Math.imul` and unsigned shifts, which every JavaScript engine (V8, Hermes, JSC) computes
 * identically.
 */
function cyrb128(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

const TWO_POW_32 = 4294967296;

/**
 * sfc32 (Chris Doty-Humphrey's Small Fast Counting generator) seeded from a string.
 * 32-bit integer arithmetic only, so a seed draws the same sequence on Node and on Hermes.
 * `next()` returns a multiple of 2^-32, which is exact in a double.
 */
export class SeededRng implements Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  private constructor(state: RngState) {
    [this.a, this.b, this.c, this.d] = state;
  }

  static fromSeed(seed: string): SeededRng {
    const rng = new SeededRng(cyrb128(seed));
    // Mix the hashed words before the first draw.
    for (let i = 0; i < 15; i++) rng.nextUint32();
    return rng;
  }

  static fromState(state: RngState): SeededRng {
    return new SeededRng(state);
  }

  getState(): RngState {
    return [this.a, this.b, this.c, this.d];
  }

  /** Uniform integer in [0, 2^32). */
  nextUint32(): number {
    // tmp = a + b + counter++ ; a = b ^ (b >> 9) ; b = c + (c << 3) ; c = rotl(c, 21) + tmp
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (((this.c << 21) | (this.c >>> 11)) + t) | 0;
    return t >>> 0;
  }

  next(): number {
    return this.nextUint32() / TWO_POW_32;
  }

  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new RangeError(`Rng.int needs integers with min <= max, got [${min}, ${max}]`);
    }
    const span = max - min + 1;
    if (span > TWO_POW_32) throw new RangeError('Rng.int supports ranges of at most 2^32 values');
    return min + Math.floor(this.next() * span);
  }
}

/** A seeded `Rng` for `SessionStarted.rngSeed`. */
export function createRng(seed: string): SeededRng {
  return SeededRng.fromSeed(seed);
}
