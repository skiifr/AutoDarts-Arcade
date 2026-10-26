import { createUlidSource, type Clock, type IdSource, type RandomSource, type Scheduler } from '@arcade/adapters';

interface TimerGlobals {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  performance?: { now(): number };
}

const g = globalThis as unknown as TimerGlobals;

/** Real timers. Vitest's fake timers replace the globals, so tests can drive this too. */
export const systemScheduler: Scheduler = {
  setTimeout: (fn, ms) => g.setTimeout(fn, ms),
  clearTimeout: (handle) => g.clearTimeout(handle),
  now: () => (g.performance ? g.performance.now() : Date.now()),
};

/** The device clock as ISO-8601 (diagnostics only: the log orders by seq). */
export const systemClock: Clock = () => new Date().toISOString();

/** Jitter and ids do not need cryptographic randomness. */
export const systemRandom: RandomSource = () => Math.random();

/** Monotonic ULIDs from the device clock. */
export const systemIds: IdSource = createUlidSource({ now: () => Date.now(), random: systemRandom });
