import type { BoardFactDraft } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { isoFromEpochMs } from '../simulator/iso-time';
import { EPOCH, brief, makeRig, ofType, type Rig } from '../testing/rig';
import { MAX_BUFFERED_FRAMES } from './adapter';
import { rebuildVisitState } from './rebuild';

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

describe('finding 2: the board’s changes land on the dart it changed', () => {
  it('phantom S20, then a real T20; the board withdraws the phantom: the phantom’s id is withdrawn', async () => {
    const rig = await online();
    rig.board.phantom('S20');
    await rig.sched.advance(300);
    rig.board.throwDart({ segment: 'T20' });
    await rig.sched.advance(300);
    rig.board.withdraw(0);
    await rig.sched.advance(300);
    const [phantom, real] = ofType(rig.facts, 'DartDetected').map((f) => f.payload.throwId);
    expect(ofType(rig.facts, 'DartWithdrawn').map((f) => f.payload.throwId)).toEqual([phantom]);
    expect(ofType(rig.facts, 'DartUpdated')).toEqual([]);
    expect([...liveDarts(rig.facts)]).toEqual([[real, 'T20']]);
  });

  it('S1, S5; the board withdraws S1, then re-reads S5 as S20: each change hits its own dart', async () => {
    const rig = await online();
    rig.board.throwDart({ segment: 'S1' });
    await rig.sched.advance(300);
    rig.board.throwDart({ segment: 'S5' });
    await rig.sched.advance(300);
    rig.board.withdraw(0);
    await rig.sched.advance(300);
    rig.board.changeDetection(0, 'S20');
    await rig.sched.advance(300);
    const [s1, s5] = ofType(rig.facts, 'DartDetected').map((f) => f.payload.throwId);
    expect(ofType(rig.facts, 'DartWithdrawn').map((f) => f.payload.throwId)).toEqual([s1]);
    expect(ofType(rig.facts, 'DartUpdated').map((f) => [f.payload.throwId, f.payload.previous.label, f.payload.segment.label])).toEqual([[s5, 'S5', 'S20']]);
  });
});

describe('crash-resume after the last dart was pulled', () => {
  it('the takeout still showing on the empty board is not a new, empty one', async () => {
    const steps = async (rig: Rig, resume?: () => void): Promise<void> => {
      rig.board.throwDart({ segment: 'T20' });
      await rig.sched.advance(300);
      rig.board.startTakeout();
      await rig.sched.advance(300);
      rig.board.pullDart();
      await rig.sched.advance(300);
      resume?.();
    };
    const first = await online({ seed: 6 });
    await steps(first);
    const restored = rebuildVisitState(first.facts, () => '01JBX00000000000000000000V');
    expect(restored.takeoutTail).toBe(true);
    // The app relaunches at once: the board was last read half a second before.
    const second = makeRig({ seed: 6, restored: { ...restored, observedAt: isoFromEpochMs(EPOCH + 400) } });
    await steps(second, () => second.adapter.start());
    await second.sched.advance(500);
    second.board.finishTakeout();
    await second.sched.advance(500);
    expect(brief(second.facts)).toEqual([]);
  });
});

describe('finding 6: a malformed throw, or any unexpected error, never wedges the adapter', () => {
  const HOSTILE_STATE = '{"connected":true,"running":true,"status":"Throw","event":"Throw detected","numThrows":1,"throws":[{"segment":{"name":"M","multiplier":{"toString":0,"valueOf":0}}}]}';

  /** A rig whose `GET /api/state` answers `body()` instead of the board's state while it returns a string. */
  function stateRig(body: () => string | undefined, options: Parameters<typeof makeRig>[0] = {}): Rig {
    return makeRig({
      ...options,
      wrapTransport: (inner) => ({
        openEvents: (o, h) => inner.openEvents(o, h),
        get: async (path, o) => {
          const res = await inner.get(path, o);
          const b = path === '/api/state' ? body() : undefined;
          return b === undefined ? res : { ...res, body: b };
        },
      }),
    });
  }

  it('the reviewer’s throw on the resync read: online, the dart a miss pending review', async () => {
    const rig = stateRig(() => HOSTILE_STATE);
    rig.adapter.start();
    await rig.sched.advance(500);
    expect(rig.adapter.connectionStatus().phase).toBe('online');
    const [dart] = ofType(rig.facts, 'DartDetected');
    expect(dart?.payload).toMatchObject({ segment: { label: 'MISS' }, pendingReview: true });
    expect(ofType(rig.facts, 'SourceAnomaly').some((f) => /miss hint with multiplier/.test(f.payload.note))).toBe(true);
  });

  it('the same throw in a frame and in liveness polls: reported, and the polls keep coming', async () => {
    let hostile = false;
    const rig = stateRig(() => (hostile ? HOSTILE_STATE : undefined));
    rig.adapter.start();
    await rig.sched.advance(200);
    rig.transport.inject(`{"type":"state","data":${HOSTILE_STATE}}`);
    await rig.sched.advance(200);
    hostile = true;
    const t0 = rig.sched.now();
    await rig.sched.advance(60_000);
    expect(rig.adapter.connectionStatus().phase).toBe('online');
    expect(rig.transport.httpRequestsSince(t0).filter((r) => r.path === '/api/state').length).toBeGreaterThanOrEqual(10);
  });

  it('an error thrown while applying a snapshot becomes a SourceAnomaly, on every path', async () => {
    let fail = true;
    const rig = makeRig({
      observer: {
        beforeApply: () => {
          if (fail) throw new Error('boom');
        },
      },
    });
    rig.adapter.start();
    await rig.sched.advance(500);
    expect(rig.adapter.connectionStatus().phase).toBe('online'); // the resync
    rig.board.throwDart({ segment: 'T20' }); // a frame
    await rig.sched.advance(6000); // and liveness polls
    expect(rig.adapter.connectionStatus().phase).toBe('online');
    const polls = rig.transport.httpRequestsSince(0).filter((r) => r.path === '/api/state').length;
    await rig.sched.advance(30_000);
    expect(rig.transport.httpRequestsSince(0).filter((r) => r.path === '/api/state').length).toBeGreaterThan(polls + 3);
    expect(ofType(rig.facts, 'SourceAnomaly').map((f) => f.payload.note)).toContain('internal error while applying a board state: boom');
    // Once the error stops, the next read heals the stream.
    fail = false;
    await rig.sched.advance(6000);
    expect(ofType(rig.facts, 'DartDetected').map((f) => f.payload.segment.label)).toEqual(['T20']);
  });

  it('a resync stuck past its timeout plus 1 s is abandoned and retried', async () => {
    const rig = makeRig();
    const adapter = rig.adapter as unknown as { fetchResyncSnapshot: (gen: number) => void };
    const real = adapter.fetchResyncSnapshot.bind(rig.adapter);
    let stuck = 1;
    adapter.fetchResyncSnapshot = (gen) => {
      if (stuck-- > 0) return; // a bug: the read is never made
      real(gen);
    };
    rig.adapter.start();
    await rig.sched.advance(2900);
    expect(rig.adapter.connectionStatus().phase).toBe('resyncing');
    await rig.sched.advance(1500);
    expect(rig.adapter.connectionStatus().phase).toBe('online');
    expect(ofType(rig.facts, 'SourceConnectionChanged').map((f) => [f.payload.state, f.payload.error])).toContainEqual(['offline', 'resync did not finish within 3000 ms']);
  });

  it('frames buffered during a slow resync are capped', async () => {
    let applied = 0;
    const rig = makeRig({
      observer: { beforeApply: () => void applied++ },
      wrapTransport: (inner) => ({
        openEvents: (o, h) => inner.openEvents(o, h),
        get: (path, o) => (path === '/api/state' && applied === 0 ? new Promise((r) => setTimeoutOn(rig, () => r(inner.get(path, o)), 1500)) : inner.get(path, o)),
      }),
    });
    rig.adapter.start();
    await rig.sched.advance(100);
    for (let i = 0; i < 500; i++) rig.transport.inject(`{"type":"state","data":${rig.board.stateJson()}}`);
    await rig.sched.advance(3000);
    expect(rig.adapter.connectionStatus().phase).toBe('online');
    expect(applied).toBeLessThanOrEqual(MAX_BUFFERED_FRAMES + 3);
    expect(ofType(rig.facts, 'SourceAnomaly').some((f) => /oldest dropped/.test(f.payload.note))).toBe(true);
  });
});

function setTimeoutOn(rig: Rig, fn: () => void, ms: number): void {
  rig.sched.setTimeout(fn, ms);
}

describe('finding 2, without coordinates: the board removes a dart that is not the last one', () => {
  it('the dart left is flagged pending review, never re-mapped silently', async () => {
    const rig = await online({ board: { noCoordsRate: 1 } });
    rig.board.throwDart({ segment: 'S1' });
    await rig.sched.advance(300);
    rig.board.throwDart({ segment: 'S5' });
    await rig.sched.advance(300);
    rig.board.withdraw(0);
    await rig.sched.advance(300);
    const [s1, s5] = ofType(rig.facts, 'DartDetected').map((f) => f.payload.throwId);
    expect(ofType(rig.facts, 'DartWithdrawn').map((f) => f.payload.throwId)).toEqual([s1]);
    expect([...pending(rig.facts)]).toEqual([s5]);
    expect([...liveDarts(rig.facts)]).toEqual([[s5, 'S5']]);
  });
});

describe('a visit boundary the app did not see still ends the visit (e2e seeds 387, 1725, 1421, 1900, 267, 955)', () => {
  /** Board facts after `from`, keyed by visit: the visitKeys in the order they appear. */
  const keys = (facts: readonly BoardFactDraft[]): string[] => [
    ...new Set(facts.flatMap((f) => (f.type === 'DartDetected' || f.type === 'TakeoutFinished' || f.type === 'VisitReset' ? [f.payload.visitKey] : []))),
  ];

  async function betweenVisits(): Promise<Rig> {
    const rig = await online();
    rig.board.throwDart({ segment: 'T20' });
    await rig.sched.advance(300);
    rig.board.takeout();
    await rig.sched.advance(1000);
    return rig;
  }

  it('a reset after the board withdrew every dart ends the visit', async () => {
    const rig = await online();
    rig.board.throwDart({ segment: 'S1' });
    await rig.sched.advance(300);
    rig.board.withdraw();
    await rig.sched.advance(300);
    rig.board.manualReset();
    await rig.sched.advance(300);
    rig.board.throwDart({ segment: 'S2' });
    await rig.sched.advance(300);
    expect(brief(rig.facts)).toEqual(['detect 0:S1', 'withdraw', 'reset', 'detect 0:S2']);
    expect(keys(rig.facts)).toHaveLength(2);
  });

  it.each([
    ['its takeout', (rig: Rig) => rig.board.takeout()],
    ['its reset', (rig: Rig) => rig.board.manualReset()],
  ])('a visit whose darts were all withdrawn: %s during a short outage ends it', async (_label, end) => {
    const rig = await online();
    rig.board.throwDart({ segment: 'S1' });
    await rig.sched.advance(300);
    rig.board.withdraw();
    await rig.sched.advance(300);
    const from = rig.facts.length;
    rig.transport.setReachable(false);
    await rig.sched.advance(100);
    end(rig);
    await rig.sched.advance(200);
    rig.transport.setReachable(true);
    await rig.sched.advance(1000);
    expect(brief(rig.facts.slice(from))).toEqual(['takeout-end inferred']);
  });

  it.each([
    ['thrown and reset', (rig: Rig) => (rig.board.throwDart({ segment: 'S7' }), rig.board.manualReset())],
    ['thrown and withdrawn', (rig: Rig) => (rig.board.throwDart({ segment: 'S7' }), rig.board.withdraw())],
  ])('between visits, a dart %s inside a short outage: a visit may have passed, inferred', async (_label, during) => {
    const rig = await betweenVisits();
    const from = rig.facts.length;
    rig.transport.setReachable(false);
    await rig.sched.advance(100);
    during(rig);
    await rig.sched.advance(200);
    rig.transport.setReachable(true);
    await rig.sched.advance(1000);
    expect(brief(rig.facts.slice(from))).toEqual(['takeout-end inferred']);
  });

  it('between visits, a short outage in which nothing happened: nothing', async () => {
    const rig = await betweenVisits();
    const from = rig.facts.length;
    rig.transport.setReachable(false);
    await rig.sched.advance(300);
    rig.transport.setReachable(true);
    await rig.sched.advance(1000);
    expect(brief(rig.facts.slice(from))).toEqual([]);
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
