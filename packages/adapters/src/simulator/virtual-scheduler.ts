import type { Scheduler, TimerHandle } from '../ports';

interface Timer {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
}

/**
 * Deterministic virtual time for tests and simulations: timers fire in (time, creation)
 * order, and pending promise callbacks are flushed after each one, so code that mixes
 * timers and promises (the adapter over the fake transport) runs as it would for real,
 * only instantly.
 */
export class VirtualScheduler implements Scheduler {
  private time: number;
  private seq = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.time + Math.max(0, ms), seq: this.seq++, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Runs every timer due up to `now + ms`, flushing promise callbacks between them. */
  async advance(ms: number): Promise<void> {
    await this.runUntil(this.time + ms);
  }

  async runUntil(t: number): Promise<void> {
    await flushMicrotasks();
    for (;;) {
      const next = this.earliest();
      if (!next || next.at > t) break;
      this.timers.delete(next.id);
      this.time = next.at;
      next.fn();
      await flushMicrotasks();
    }
    this.time = Math.max(this.time, t);
  }

  private earliest(): Timer | undefined {
    let best: Timer | undefined;
    for (const timer of this.timers.values()) {
      if (!best || timer.at < best.at || (timer.at === best.at && timer.seq < best.seq)) best = timer;
    }
    return best;
  }
}

/** Lets chained promise callbacks run (each `await` drains one level of the chain). */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
