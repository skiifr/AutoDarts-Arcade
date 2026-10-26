import type { BoardFactDraft } from '@arcade/event-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../ports';
import { createUlidSource, seededRandom } from '../random';
import { BoardModel } from '../simulator/board-model';
import { FakeBoardTransport } from '../simulator/fake-transport';
import { SIM_EPOCH_MS } from '../simulator/iso-time';
import { AutodartsLocalAdapter } from './adapter';

/**
 * NF5 (resync ≤ 2 s after the board is reachable) and NF8 (≤ 1 idle request per 5 s),
 * measured with Vitest's fake timers driving the adapter through real-timer globals.
 */

interface TimerGlobals {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}
const g = globalThis as unknown as TimerGlobals;
const fakeTimerScheduler: Scheduler = {
  setTimeout: (fn, ms) => g.setTimeout(fn, ms),
  clearTimeout: (h) => g.clearTimeout(h),
  now: () => Date.now(),
};

function setup(seed: number) {
  const board = new BoardModel({ random: seededRandom(`b${seed}`), now: () => Date.now() });
  const transport = new FakeBoardTransport({ board, scheduler: fakeTimerScheduler, random: seededRandom(`n${seed}`), latencyMs: 4 });
  const adapter = new AutodartsLocalAdapter({
    transport,
    scheduler: fakeTimerScheduler,
    clock: () => new Date().toISOString(),
    ids: createUlidSource({ now: () => Date.now(), random: seededRandom(`i${seed}`) }),
    random: seededRandom(`r${seed}`),
  });
  const facts: { at: number; fact: BoardFactDraft }[] = [];
  adapter.subscribe((fact) => facts.push({ at: Date.now(), fact }));
  return { board, transport, adapter, facts };
}

const isOnline = (f: BoardFactDraft): boolean => f.type === 'SourceConnectionChanged' && f.payload.state === 'online';

beforeEach(() => {
  vi.useFakeTimers({ now: SIM_EPOCH_MS });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('NF8: idle load on the board', () => {
  it('at most one HTTP request in any 5 s window while idle (2 minutes)', async () => {
    const { board, transport, adapter } = setup(1);
    adapter.start();
    await vi.advanceTimersByTimeAsync(500);
    board.throwDart();
    board.takeout();
    await vi.advanceTimersByTimeAsync(500);
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(120_000);
    const gets = transport.httpRequestsSince(t0).map((r) => r.at);
    expect(gets.length).toBeGreaterThanOrEqual(20); // liveness is running
    for (const t of gets) expect(gets.filter((u) => u >= t && u < t + 5000)).toHaveLength(1);
    expect(transport.requests.filter((r) => r.kind === 'WS')).toHaveLength(1);
    adapter.stop();
  });

  it('a stuck takeout does not add load', async () => {
    const { board, transport, adapter } = setup(2);
    adapter.start();
    await vi.advanceTimersByTimeAsync(500);
    board.stickTakeout();
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    const gets = transport.httpRequestsSince(t0).map((r) => r.at);
    for (const t of gets) expect(gets.filter((u) => u >= t && u < t + 5000)).toHaveLength(1);
    adapter.stop();
  });
});

describe('NF5: resync within 2 s of the board becoming reachable', () => {
  async function measure(seed: number, outageMs: number, offsetMs: number, mode: 'unreachable' | 'hanging'): Promise<number> {
    const { board, transport, adapter, facts } = setup(seed);
    adapter.start();
    await vi.advanceTimersByTimeAsync(300 + offsetMs);
    board.throwDart({ segment: 'T20' });
    await vi.advanceTimersByTimeAsync(50);
    if (mode === 'unreachable') transport.setReachable(false);
    else transport.setSilent(true);
    await vi.advanceTimersByTimeAsync(outageMs);
    board.throwDart({ segment: 'S7' }); // thrown while away: must come back recovered
    const back = Date.now();
    if (mode === 'unreachable') transport.setReachable(true);
    else transport.setSilent(false);
    let elapsed = Infinity;
    for (let t = 0; t <= 5000; t += 10) {
      await vi.advanceTimersByTimeAsync(10);
      const hit = facts.find((f) => f.at >= back && isOnline(f.fact));
      if (hit) {
        elapsed = hit.at - back;
        break;
      }
    }
    // Online only after the resync snapshot was diffed: the recovered dart is already out.
    const recovered = facts.find((f) => f.fact.type === 'DartDetected' && f.fact.payload.recovered === true && f.at >= back);
    expect(recovered, `seed ${seed} outage ${outageMs} offset ${offsetMs}`).toBeDefined();
    adapter.stop();
    return elapsed;
  }

  it('when the board was unreachable (connection refused or no route)', async () => {
    let worst = 0;
    let seed = 0;
    for (const outage of [400, 1100, 2700, 7300, 31_000, 64_900]) {
      for (const offset of [0, 133, 377, 611, 958]) {
        worst = Math.max(worst, await measure(seed++, outage, offset, 'unreachable'));
      }
    }
    expect(worst).toBeLessThanOrEqual(2000);
  });

  it('when the network silently dropped packets (attempts hang until their timeout)', async () => {
    let worst = 0;
    let seed = 100;
    for (const outage of [12_000, 15_500, 27_300, 61_000]) {
      for (const offset of [0, 97, 251, 503, 877]) {
        worst = Math.max(worst, await measure(seed++, outage, offset, 'hanging'));
      }
    }
    expect(worst).toBeLessThanOrEqual(2000);
  });
});
