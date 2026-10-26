import type { BoardFactDraft } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { brief, makeRig, ofType, type Rig } from '../testing/rig';

/**
 * Adapter-level regressions for the board-adapter review (owner decision R / NF3: never lose,
 * duplicate, invent or misattribute a dart without telling the user).
 */

async function online(options: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
  const rig = makeRig(options);
  rig.adapter.start();
  await rig.sched.advance(200);
  return rig;
}

/** throwId → segment label of every dart still live (detected, not withdrawn). */
function liveDarts(facts: readonly BoardFactDraft[]): Map<string, string> {
  const live = new Map<string, string>();
  for (const f of facts) {
    if (f.type === 'DartDetected') live.set(f.payload.throwId, f.payload.segment.label);
    else if (f.type === 'DartUpdated' && live.has(f.payload.throwId)) live.set(f.payload.throwId, f.payload.segment.label);
    else if (f.type === 'DartWithdrawn') live.delete(f.payload.throwId);
  }
  return live;
}

/** throwIds whose latest DartDetected/DartUpdated carried pendingReview. */
function pending(facts: readonly BoardFactDraft[]): Set<string> {
  const ids = new Set<string>();
  for (const f of facts) {
    if (f.type !== 'DartDetected' && f.type !== 'DartUpdated') continue;
    if (f.payload.pendingReview) ids.add(f.payload.throwId);
    else ids.delete(f.payload.throwId);
  }
  return ids;
}

describe('finding 1: a takeout first seen on resync, with a dart already pulled', () => {
  it.each([0, 1, 2])('pulled dart %d is kept and flagged pending review, never withdrawn', async (pulled) => {
    const rig = await online();
    for (const segment of ['T20', 'T19', 'T18']) {
      rig.board.throwDart({ segment });
      await rig.sched.advance(700);
    }
    await rig.sched.advance(500);
    // Wi-Fi drops; the takeout starts and one dart is pulled; the link returns mid-takeout.
    rig.transport.setReachable(false);
    await rig.sched.advance(200);
    rig.board.startTakeout();
    rig.board.pullDart(pulled);
    await rig.sched.advance(1500);
    rig.transport.setReachable(true);
    await rig.sched.advance(2000);
    rig.board.finishTakeout();
    await rig.sched.advance(2000);

    expect(ofType(rig.facts, 'DartWithdrawn')).toEqual([]);
    const live = liveDarts(rig.facts);
    expect([...live.values()]).toEqual(['T20', 'T19', 'T18']);
    const detected = ofType(rig.facts, 'DartDetected');
    expect([...pending(rig.facts)]).toEqual([detected[pulled]?.payload.throwId]);
    // The takeout itself was seen (it ends the turn normally); the flag puts the turn up for review.
    expect(ofType(rig.facts, 'TakeoutFinished').map((f) => f.payload.inferred)).toEqual([undefined]);
  });

  it('pulled one at a time while online: no flags, one takeout', async () => {
    const rig = await online();
    for (const segment of ['T20', 'T19', 'T18']) {
      rig.board.throwDart({ segment });
      await rig.sched.advance(300);
    }
    rig.board.startTakeout();
    for (const i of [1, 0, 0]) {
      await rig.sched.advance(400);
      rig.board.pullDart(i);
    }
    await rig.sched.advance(400);
    rig.board.finishTakeout();
    await rig.sched.advance(400);
    expect(brief(rig.facts)).toEqual(['detect 0:T20', 'detect 1:T19', 'detect 2:T18', 'takeout-start', 'takeout-end']);
  });
});

describe('finding 4: a takeout called off with the same darts', () => {
  it('throwing(A) → (A,B) → takeout → called off → the board retracts B: B is withdrawn', async () => {
    const rig = await online();
    rig.board.throwDart({ segment: 'S1' });
    await rig.sched.advance(300);
    rig.board.phantom('S5');
    await rig.sched.advance(300);
    rig.board.startTakeout(); // a hand in front of the cameras
    await rig.sched.advance(300);
    expect(rig.board.callOffTakeout()).toBe(true); // it leaves; the darts are still in
    await rig.sched.advance(300);
    rig.board.withdraw(1); // the board retracts the phantom
    await rig.sched.advance(300);
    rig.board.startTakeout();
    await rig.sched.advance(500);
    rig.board.finishTakeout();
    await rig.sched.advance(500);
    expect([...liveDarts(rig.facts).values()]).toEqual(['S1']);
    expect(brief(rig.facts)).toEqual(['detect 0:S1', 'detect 1:S5', 'takeout-start', 'withdraw', 'takeout-start', 'takeout-end']);
  });
});
