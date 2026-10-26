import { seededRandom } from '../random';
import type { TimerHandle } from '../ports';
import type { FaultPlan } from '../simulator/fake-transport';
import { ChaosRecorder, type ChaosStats } from './oracle';
import { makeRig, type Rig } from './rig';

/** One chaos run (see chaos.test.ts). Test support only. */
export function faultPlan(r: () => number): FaultPlan {
  const u = r();
  const plan: FaultPlan = {};
  if (u < 0.15) return plan; // clean network, outages only
  plan.drop = [0, 0.02, 0.05, 0.1][Math.floor(r() * 4)];
  plan.duplicate = [0, 0.05, 0.15][Math.floor(r() * 3)];
  plan.delayMs = r() < 0.5 ? [0, 0] : [0, 40 + r() * 160];
  if (r() < 0.3) plan.reorder = 0.03;
  if (r() < 0.2) plan.cutEvery = 6 + Math.floor(r() * 30);
  return plan;
}

export async function chaosRun(
  seed: number,
  options: { clean?: boolean } = {},
): Promise<{ rig: Rig; recorder: ChaosRecorder; result: { violations: string[]; stats: ChaosStats }; plan: FaultPlan }> {
  const r = seededRandom(`chaos:${seed}`);
  const plan: FaultPlan = options.clean ? {} : faultPlan(r);
  const hook: { recorder?: ChaosRecorder } = {};
  const rig = makeRig({
    seed,
    faults: plan,
    board: {
      annotate: true,
      noiseFrames: r() < 0.3,
      missStyle: r() < 0.5 ? 'outside' : 'bare',
      emptyThrows: r() < 0.8 ? 'omit' : 'array',
    },
    stateOnlySocket: r() < 0.5,
    observer: { beforeApply: (s, m) => hook.recorder?.beforeApply(s, m) },
  });
  const recorder = new ChaosRecorder(rig.board, rig.facts);
  hook.recorder = recorder;
  const { sched, board, transport } = rig;
  const between = (lo: number, hi: number): number => lo + r() * (hi - lo);
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

    const darts = r() < 0.15 ? 1 + Math.floor(r() * 2) : 3;
    for (let d = 0; d < darts; d++) {
      await sched.advance(between(250, 2500));
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
    await sched.advance(between(400, 3000));
    const end = r();
    if (end < 0.05) {
      board.manualReset();
    } else if (end < 0.08) {
      board.stickTakeout();
      await sched.advance(between(8500, 12000));
      board.manualReset();
    } else {
      board.startTakeout();
      await sched.advance(between(300, 2500));
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

