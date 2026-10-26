import { seededRandom } from '@arcade/adapters';
import { describe, expect, it } from 'vitest';
import { e2eRun, gameView, type E2EStats, type GameChoice } from './testing/e2e';

/**
 * The Phase 2 acceptance test, end to end: BoardModel (with faults: drops, duplicates, delays,
 * reorders, cuts, outages from a blink to several visits, takeouts and whole visits while
 * offline) → FakeBoardTransport → AutodartsLocalAdapter → createArcadeRuntime → SessionHost
 * playing a real game, with a referee who confirms every review pause as it stands. For each
 * run (testing/e2e.ts `judge`): every turn scores exactly the darts the board listed for its
 * visit, or is flagged needsReview; every board visit with darts reaches a turn or is covered
 * by a flagged turn; every inferred takeout ends its turn flagged and pauses for review before
 * the next turn; nothing invented or counted twice; the log is gap-free and schema-valid.
 * Zero silent mismatches.
 *
 * Every run is on virtual time: about 8 ms each on this machine.
 */

const RUNS = 1000;

function addUp(total: E2EStats, stats: E2EStats): void {
  for (const k of Object.keys(total) as (keyof E2EStats)[]) total[k] += stats[k];
}

const zero = (): E2EStats => ({
  boardVisits: 0,
  detections: 0,
  turns: 0,
  flaggedTurns: 0,
  inferredTakeouts: 0,
  reviewPauses: 0,
  recoveredDarts: 0,
  coveredLostVisits: 0,
  finished: 0,
});

describe('end-to-end chaos: board → adapter → runtime → host → game', () => {
  it(`${RUNS} seeded Countdown runs with faults: zero silent mismatches`, async () => {
    const failures: string[] = [];
    const total = zero();
    for (let seed = 0; seed < RUNS; seed++) {
      const run = await e2eRun(seed);
      addUp(total, run.stats);
      if (run.violations.length > 0) failures.push(`seed ${seed} ${JSON.stringify(run.plan)}: ${run.violations.slice(0, 3).join(' | ')}`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // The suite must exercise recovery, not just quiet networks.
    expect(total.inferredTakeouts).toBeGreaterThan(500);
    expect(total.reviewPauses).toBeGreaterThan(500);
    expect(total.recoveredDarts).toBeGreaterThan(1000);
    expect(total.coveredLostVisits).toBeGreaterThan(300);
    expect(total.turns).toBeGreaterThan(8000);
    expect(total.finished).toBeGreaterThan(50);
    // Uncertain turns are flagged, but most turns still score as they are.
    expect(total.flaggedTurns / total.turns).toBeLessThan(0.5);
  }, 120_000);

  it.each(['siege', 'cricket', 'around-the-clock'] as GameChoice[])('the other games too: 40 runs of %s', async (game) => {
    const failures: string[] = [];
    for (let seed = 0; seed < 40; seed++) {
      const run = await e2eRun(50_000 + seed, { game });
      if (run.violations.length > 0) failures.push(`seed ${50_000 + seed}: ${run.violations.slice(0, 3).join(' | ')}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it('a clean network flags nothing: 200 runs, every turn exactly as thrown', async () => {
    const failures: string[] = [];
    const total = zero();
    for (let seed = 0; seed < 200; seed++) {
      const run = await e2eRun(10_000 + seed, { clean: true });
      addUp(total, run.stats);
      if (run.violations.length > 0) failures.push(`seed ${10_000 + seed}: ${run.violations.slice(0, 3).join(' | ')}`);
    }
    expect(failures).toEqual([]);
    expect(total.flaggedTurns + total.reviewPauses + total.inferredTakeouts + total.recoveredDarts).toBe(0);
    expect(total.turns).toBeGreaterThan(1500);
  }, 60_000);

  it('crash-resume: 200 runs dropped at a random quiet moment and resumed from the store end exactly like uninterrupted ones', async () => {
    const failures: string[] = [];
    for (let seed = 0; seed < 200; seed++) {
      const reference = await e2eRun(20_000 + seed, { clean: true });
      const cut = Math.floor(seededRandom(`cut:${seed}`)() * reference.steps);
      const resumed = await e2eRun(20_000 + seed, { clean: true, crashAtStep: cut });
      const label = `seed ${20_000 + seed} cut at step ${cut}/${reference.steps}`;
      if (resumed.incarnations.length !== 2) failures.push(`${label}: did not crash`);
      if (resumed.violations.length > 0) failures.push(`${label}: ${resumed.violations.slice(0, 2).join(' | ')}`);
      const a = gameView(reference.state) as Record<string, unknown>;
      const b = gameView(resumed.state) as Record<string, unknown>;
      const differ = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      if (differ.length > 0) failures.push(`${label}: ${differ.join(', ')} differ`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
  }, 60_000);

  it('crash-resume under chaos: 200 faulty runs dropped at a random quiet moment still never mismatch silently', async () => {
    // With faults the two runs part ways (the crash is an outage of its own), so only the
    // verdict is compared, not the final state.
    const failures: string[] = [];
    let crashed = 0;
    for (let seed = 0; seed < 200; seed++) {
      const cut = Math.floor(seededRandom(`cut:${seed}`)() * 25);
      const run = await e2eRun(30_000 + seed, { crashAtStep: cut });
      if (run.incarnations.length === 2) crashed++;
      if (run.violations.length > 0) failures.push(`seed ${30_000 + seed} cut at step ${cut}: ${run.violations.slice(0, 3).join(' | ')}`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(crashed).toBeGreaterThan(150);
  }, 60_000);
});
