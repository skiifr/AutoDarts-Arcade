import { seededRandom } from '@arcade/adapters';
import { describe, expect, it } from 'vitest';
import { e2eRun, gameView, type E2EOptions, type E2EStats, type GameChoice } from './testing/e2e';

/**
 * The Phase 2 acceptance test, end to end: BoardModel (with faults: drops, duplicates, delays,
 * reorders, cuts, outages from a blink to several visits, takeouts and whole visits while
 * offline) → FakeBoardTransport → AutodartsLocalAdapter → createArcadeRuntime → SessionHost
 * playing a real game. The board has its odd ways too (E2E_BOARD): darts pulled one at a time,
 * takeouts called off (then, sometimes, a dart withdrawn), one-dart visits of 3 s, and in some
 * faulty runs darts without coordinates. Around it, the people (testing/e2e.ts): players taking
 * turns, a referee who confirms every review pause as it stands, and in some runs a player
 * correcting recent darts (VoidDart, CorrectDart, AddDart). The storage refuses appends in some
 * runs, and the app crashes at any moment in others (mid-visit, mid-takeout, after long idle
 * stretches) and is launched again after 0–10 s.
 *
 * For each run (`judge`): every turn scores exactly the darts the board listed for its visit, as
 * the person corrected them, of the player who threw that visit, or is flagged needsReview; in an
 * unflagged turn each physical dart keeps one throw id; a turn never runs on into the next
 * visit; every board visit with darts reaches a turn or is covered by a flagged turn; every
 * inferred takeout ends its turn flagged and pauses for review before the next turn; nothing
 * invented or counted twice; the log is gap-free and schema-valid; a session cannot complete
 * with anything unreviewed. Zero silent mismatches.
 *
 * Every run is on virtual time: about 14 ms each on this machine.
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
  withdrawnVisits: 0,
  unseenVisits: 0,
  finished: 0,
  userCommands: 0,
  refusedAppends: 0,
  sourceRebuilds: 0,
  crashes: 0,
  pulledDarts: 0,
  calledOffTakeouts: 0,
  noCoordsDetections: 0,
});

async function sweep(from: number, runs: number, options: E2EOptions): Promise<{ failures: string[]; total: E2EStats; crashed: number }> {
  const failures: string[] = [];
  const total = zero();
  let crashed = 0;
  for (let seed = from; seed < from + runs; seed++) {
    const run = await e2eRun(seed, options);
    addUp(total, run.stats);
    if (run.stats.crashes > 0) crashed++;
    if (run.violations.length > 0) failures.push(`seed ${seed} ${JSON.stringify(run.features)}: ${run.violations.slice(0, 3).join(' | ')}`);
  }
  return { failures, total, crashed };
}

describe('end-to-end chaos: board → adapter → runtime → host → game', () => {
  it(`${RUNS} seeded Countdown runs with faults, the user bot, a failing store and crashes: zero silent mismatches`, async () => {
    const { failures, total } = await sweep(0, RUNS, { mix: true });
    expect(failures.slice(0, 10)).toEqual([]);
    // The suite must exercise recovery, not just quiet networks.
    expect(total.inferredTakeouts).toBeGreaterThan(1000);
    expect(total.reviewPauses).toBeGreaterThan(1000);
    expect(total.recoveredDarts).toBeGreaterThan(2500);
    expect(total.coveredLostVisits).toBeGreaterThan(700);
    expect(total.turns).toBeGreaterThan(8000);
    expect(total.finished).toBeGreaterThan(80);
    expect(total.userCommands).toBeGreaterThan(1500);
    expect(total.refusedAppends).toBeGreaterThan(1500);
    expect(total.sourceRebuilds).toBeGreaterThan(300);
    expect(total.crashes).toBeGreaterThan(200);
    // …and the board's odd ways.
    expect(total.pulledDarts).toBeGreaterThan(4500);
    expect(total.calledOffTakeouts).toBeGreaterThan(500);
    expect(total.noCoordsDetections).toBeGreaterThan(1000);
    // Uncertain turns are flagged, but not every turn. In this mix about half are (0.52): most
    // networks are faulty, a third of the visits have an outage, and each inferred takeout flags
    // two turns, its own and the one its review pause hands over to (who is up is a guess).
    // A clean network flags only visits the board withdrew (below).
    expect(total.flaggedTurns / total.turns).toBeLessThan(0.55);
  }, 120_000);

  it.each(['siege', 'cricket', 'around-the-clock'] as GameChoice[])('the other games too: 40 runs of %s', async (game) => {
    const { failures } = await sweep(50_000, 40, { game, mix: true });
    expect(failures).toEqual([]);
  }, 60_000);

  it('a clean network flags nothing but a visit the board withdrew: 200 runs, every turn exactly as thrown, by whoever threw it', async () => {
    const { failures, total } = await sweep(10_000, 200, { clean: true });
    expect(failures).toEqual([]);
    // The only flag a clean network allows: the board withdrew every dart of a visit.
    expect(total.flaggedTurns - total.withdrawnVisits + total.reviewPauses + total.inferredTakeouts + total.recoveredDarts).toBe(0);
    expect(total.turns).toBeGreaterThan(1500);
    // Pulls one at a time, called-off takeouts and 3 s visits are part of a clean session too.
    expect(total.pulledDarts).toBeGreaterThan(500);
    expect(total.calledOffTakeouts).toBeGreaterThan(100);
    expect(total.noCoordsDetections).toBe(0);
  }, 60_000);

  it('a failing store: 150 faulty runs whose store refuses appends at random, every dart present or recovered and flagged', async () => {
    const { failures, total } = await sweep(40_000, 150, { storeFaults: true });
    expect(failures.slice(0, 10)).toEqual([]);
    expect(total.refusedAppends).toBeGreaterThan(1000);
    expect(total.sourceRebuilds).toBeGreaterThan(200);
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

  it('crash on an idle board: 200 runs dropped during a long quiet spell and relaunched within 1.5 s end exactly like uninterrupted ones', async () => {
    // The log has no board fact from the quiet spell: without the runtime's ContactStore the
    // relaunch measured the whole spell as an outage and ended the waiting player's turn.
    const failures: string[] = [];
    let crashed = 0;
    for (let seed = 0; seed < 200; seed++) {
      const reference = await e2eRun(25_000 + seed, { clean: true, idle: true });
      const resumed = await e2eRun(25_000 + seed, { clean: true, idleCrashOnly: true, resumeMs: [0, 1500] });
      const label = `seed ${25_000 + seed}`;
      if (resumed.stats.crashes > 0) crashed++;
      if (resumed.violations.length > 0) failures.push(`${label}: ${resumed.violations.slice(0, 2).join(' | ')}`);
      const a = gameView(reference.state) as Record<string, unknown>;
      const b = gameView(resumed.state) as Record<string, unknown>;
      const differ = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      if (differ.length > 0) failures.push(`${label}: ${differ.join(', ')} differ`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(crashed).toBeGreaterThan(100);
  }, 60_000);

  it('crashes at any moment under chaos: 200 faulty runs dropped mid-visit, mid-takeout or idle and relaunched after 0–10 s still never mismatch silently', async () => {
    // With faults the runs part ways (a crash is an outage of its own), so only the verdict counts.
    const { failures, crashed } = await sweep(30_000, 200, { crashes: true, idle: true });
    expect(failures.slice(0, 10)).toEqual([]);
    expect(crashed).toBeGreaterThan(190);
  }, 60_000);
});
