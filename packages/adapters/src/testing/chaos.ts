import { MIN_UNSEEN_VISIT_MS } from '../autodarts-local/visit-tracker';
import { seededRandom } from '../random';
import type { TimerHandle } from '../ports';
import type { FaultPlan } from '../simulator/fake-transport';
import { ChaosRecorder, type ChaosStats } from './oracle';
import { makeRig, type Rig } from './rig';

/**
 * The shortest visit the simulation plays, from its first throw to its last dart out. A real
 * visit cannot be shorter than MIN_UNSEEN_VISIT_MS (throw, detect, pull the darts out); the
 * extra second covers the simulated network's frame delays (up to ~0.65 s with delay and
 * reorder faults), which the adapter cannot see. Real LAN latency is milliseconds.
 */
export const SIM_MIN_VISIT_MS = MIN_UNSEEN_VISIT_MS + 1000;

/**
 * How often the chaos runs use the board behaviours the review found unreachable (all drawn from
 * a stream of their own, so the network and dart draws of each seed stay as they were).
 */
export const CHAOS_BOARD = {
  /** Runs (with faults) where the board reports some darts without coordinates… */
  noCoordsRuns: 0.3,
  /** …and the fraction of such darts in them. */
  noCoordsRate: 0.25,
  /** Takeouts whose darts come out one at a time, as on a real board. */
  pullOneByOne: 0.5,
  /** Of those, the ones where the last dart too comes out before "Takeout finished". */
  pullLastToo: 0.3,
  /** Visits where a takeout starts and is called off with the darts still in. */
  callOff: 0.1,
  /** Of those, the ones where the board then withdraws one of the darts. */
  withdrawAfterCallOff: 0.4,
  /** Visits of one dart, taken out as soon as a visit can be (SIM_MIN_VISIT_MS). */
  quickVisit: 0.15,
};

/** One chaos run (see chaos.test.ts). Test support only. */
export function faultPlan(r: () => number): FaultPlan {
  const u = r();
  const plan: FaultPlan = {};
  if (u < 0.15) return plan; // clean network, outages only
  plan.drop = [0, 0.02, 0.05, 0.1][Math.floor(r() * 4)];
  // A lost frame comes with a broken connection, as on a real (TCP) network; see FaultPlan.
  plan.dropBreaksSocket = true;
  plan.duplicate = [0, 0.05, 0.15][Math.floor(r() * 3)];
  plan.delayMs = r() < 0.5 ? [0, 0] : [0, 40 + r() * 160];
  if (r() < 0.3) plan.reorder = 0.03;
  if (r() < 0.2) plan.cutEvery = 6 + Math.floor(r() * 30);
  return plan;
}

export interface ChaosOptions {
  /** No network faults and no darts without coordinates: nothing may be flagged. */
  clean?: boolean;
  /** The board behaviours of CHAOS_BOARD (default on); off replays a seed as the suite played it before them. */
  boardQuirks?: boolean;
}

export async function chaosRun(
  seed: number,
  options: ChaosOptions = {},
): Promise<{ rig: Rig; recorder: ChaosRecorder; result: { violations: string[]; stats: ChaosStats }; plan: FaultPlan }> {
  const r = seededRandom(`chaos:${seed}`);
  const x = seededRandom(`chaos-board:${seed}`);
  const plan: FaultPlan = options.clean ? {} : faultPlan(r);
  const quirks = options.boardQuirks !== false;
  const noCoordsRate = quirks && !options.clean && x() < CHAOS_BOARD.noCoordsRuns ? CHAOS_BOARD.noCoordsRate : 0;
  const hook: { recorder?: ChaosRecorder } = {};
  const rig = makeRig({
    seed,
    faults: plan,
    board: {
      annotate: true,
      noiseFrames: r() < 0.3,
      missStyle: r() < 0.5 ? 'outside' : 'bare',
      emptyThrows: r() < 0.8 ? 'omit' : 'array',
      noCoordsRate,
    },
    stateOnlySocket: r() < 0.5,
    observer: {
      beforeApply: (s, m) => hook.recorder?.beforeApply(s, m),
      afterApply: () => hook.recorder?.afterApply(),
    },
  });
  const recorder = new ChaosRecorder(rig.board, rig.facts, () => rig.adapter.visitState());
  hook.recorder = recorder;
  const { sched, board, transport } = rig;
  const between = (lo: number, hi: number): number => lo + r() * (hi - lo);
  const xBetween = (lo: number, hi: number): number => lo + x() * (hi - lo);
  const outageTimers: TimerHandle[] = [];

  rig.adapter.start();
  await sched.advance(between(50, 400));

  const visits = 3 + Math.floor(r() * 9);
  for (let v = 0; v < visits; v++) {
    // Network trouble somewhere in this visit, sometimes spanning several visits.
    const trouble = options.clean ? 1 : r();
    if (trouble < 0.3) {
      const at = between(0, 4000);
      const long = r() < 0.35;
      const dur = long ? between(4000, 30000) : between(100, 3000);
      outageTimers.push(sched.setTimeout(() => transport.setReachable(false), at));
      outageTimers.push(sched.setTimeout(() => transport.setReachable(true), at + dur));
    } else if (trouble < 0.4) {
      outageTimers.push(sched.setTimeout(() => transport.cutSockets(), between(0, 4000)));
    }

    const quick = quirks && x() < CHAOS_BOARD.quickVisit;
    const drawn = r() < 0.15 ? 1 + Math.floor(r() * 2) : 3;
    const darts = quick ? 1 : drawn;
    let firstThrowAt = -1;
    for (let d = 0; d < darts; d++) {
      const wait = between(250, 2500);
      await sched.advance(quick ? Math.min(wait, 400) : wait);
      if (firstThrowAt < 0) firstThrowAt = sched.now();
      const u = r();
      if (u < 0.05) board.bounceOut();
      else if (u < 0.09) board.phantom();
      else board.throwDart();
      const w = r();
      if (w < 0.06) {
        await sched.advance(between(50, 800));
        board.changeDetection();
      } else if (w < 0.1) {
        await sched.advance(between(50, 800));
        board.withdraw(r() < 0.7 ? undefined : Math.floor(r() * Math.max(1, board.dartsOnBoard)));
      }
    }
    const settle = between(400, 3000);
    await sched.advance(quick ? Math.min(settle, 500) : settle);
    if (quirks && board.dartsOnBoard > 0 && x() < CHAOS_BOARD.callOff) {
      // A hand in front of the cameras starts a takeout and leaves the darts in.
      board.startTakeout();
      await sched.advance(xBetween(300, 1500));
      board.callOffTakeout();
      await sched.advance(xBetween(200, 800));
      if (board.dartsOnBoard > 0 && x() < CHAOS_BOARD.withdrawAfterCallOff) {
        board.withdraw(Math.floor(x() * board.dartsOnBoard));
        await sched.advance(xBetween(200, 800));
      }
    }
    const end = r();
    const untilMin = (): number => Math.max(0, firstThrowAt + SIM_MIN_VISIT_MS - sched.now());
    if (end < 0.05) {
      board.manualReset();
    } else if (end < 0.08) {
      // stickTakeout takes the darts out at once.
      await sched.advance(untilMin());
      board.stickTakeout();
      await sched.advance(between(8500, 12000));
      board.manualReset();
    } else {
      board.startTakeout();
      const pulling = between(300, 2500);
      if (quirks && board.dartsOnBoard > 1 && x() < CHAOS_BOARD.pullOneByOne) {
        // Darts come out one at a time; the visit lasts until the last one is out.
        const n = board.dartsOnBoard;
        const pulls = x() < CHAOS_BOARD.pullLastToo ? n : n - 1;
        for (let p = 0; p < pulls; p++) {
          const gap = xBetween(150, 700);
          await sched.advance(p === n - 1 ? Math.max(gap, untilMin()) : gap);
          board.pullDart(Math.floor(x() * board.dartsOnBoard));
        }
        await sched.advance(Math.max(xBetween(150, 600), untilMin()));
      } else {
        await sched.advance(quick ? untilMin() : Math.max(pulling, untilMin()));
      }
      board.finishTakeout();
    }
    if (r() < 0.05) {
      await sched.advance(between(300, 1500));
      board.handInFront();
    }
    await sched.advance(between(200, 1500));
  }

  for (const t of outageTimers) sched.clearTimeout(t);
  transport.faults = {};
  transport.setReachable(true);
  await sched.advance(20000);
  return { rig, recorder, result: recorder.check(), plan };
}
