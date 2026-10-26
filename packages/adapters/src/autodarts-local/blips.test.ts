import { describe, expect, it } from 'vitest';
import { isoFromEpochMs } from '../simulator/iso-time';
import { EPOCH, brief, makeRig, type Rig } from '../testing/rig';
import { LINK_LOSS_MS } from './adapter';
import { MIN_UNSEEN_VISIT_MS } from './visit-tracker';

/**
 * Wi-Fi blips must not end turns (Phase 2/3 integration). With no darts known and none on the
 * board, a resync infers a takeout only if the board was out of sight for at least
 * MIN_UNSEEN_VISIT_MS, measured from the last good contact: a frame, a state read, or the
 * heartbeat of a healthy open socket (the board pushes every change, so an open socket is in
 * sight), less LINK_LOSS_MS when a connection breaks. Known darts missing always infer one.
 */

const ID = '01JBX00000000000000000000V';

async function online(options: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
  const rig = makeRig(options);
  rig.adapter.start();
  await rig.sched.advance(200);
  return rig;
}

/** Board facts after the run's first resync, without connection and status noise. */
function after(rig: Rig, from: number): string[] {
  return brief(rig.facts.slice(from));
}

async function blip(rig: Rig, outageMs: number, during?: () => void): Promise<void> {
  rig.transport.setReachable(false);
  await rig.sched.advance(outageMs / 2);
  during?.();
  await rig.sched.advance(outageMs / 2);
  rig.transport.setReachable(true);
  await rig.sched.advance(3000);
}

describe('resync after an outage, nothing known and nothing on the board', () => {
  it('the threshold is 2 s (owner decision)', () => {
    expect(MIN_UNSEEN_VISIT_MS).toBe(2000);
  });

  it.each([
    // [idle before the outage, outage, inferred?]
    [0, 300, false],
    [20_000, 300, false], // a silent open socket was in sight all along
    [0, 2000, true],
    [20_000, 2000, true],
    [0, MIN_UNSEEN_VISIT_MS + 500, true],
    [20_000, 30_000, true],
  ])('idle %d ms, unreachable %d ms → inferred: %s', async (idle, outage, inferred) => {
    const rig = await online();
    await rig.sched.advance(idle);
    const from = rig.facts.length;
    await blip(rig, outage);
    expect(rig.adapter.connectionStatus().phase).toBe('online');
    expect(after(rig, from)).toEqual(inferred ? ['takeout-end inferred'] : []);
  });

  it('measures from the break, less LINK_LOSS_MS, to the resync: both sides of the threshold', async () => {
    // A healthy socket for 2.5 s, so the break (not the first resync) bounds the contact; the
    // reconnect after the network returns takes ~50 ms here (a retry is due every 10 ms).
    const quick = { backoffMs: [10], jitter: 0 };
    const measured = async (outage: number) => {
      const rig = await online({ timing: quick });
      await rig.sched.advance(2500);
      const from = rig.facts.length;
      await blip(rig, outage);
      return after(rig, from);
    };
    expect(await measured(MIN_UNSEEN_VISIT_MS - LINK_LOSS_MS - 200)).toEqual([]);
    expect(await measured(MIN_UNSEEN_VISIT_MS - LINK_LOSS_MS + 100)).toEqual(['takeout-end inferred']);
  });

  // Whatever happened just before the break, an outage of MIN_UNSEEN_VISIT_MS or more infers a
  // takeout: the outage is measured from at least LINK_LOSS_MS before the break, so it never
  // comes out shorter than the time the board was really out of sight.
  const before = {
    'an idle board': async (rig: Rig) => {
      await rig.sched.advance(0);
    },
    'a state frame and a state read just before': async (rig: Rig) => {
      rig.board.throwDart({ segment: 'S3' });
      await rig.sched.advance(100);
      rig.board.withdraw(); // a frame, then the state read that confirms it
      await rig.sched.advance(40);
    },
  };
  it.each(
    [0, 150, 650, 2500, 20_000].flatMap((idle) =>
      Object.keys(before).flatMap((what) => [MIN_UNSEEN_VISIT_MS, MIN_UNSEEN_VISIT_MS + 1, 2700].map((outage) => [idle, what, outage] as const)),
    ),
  )('idle %d ms, then %s, then %d ms unreachable → inferred', async (idle, what, outage) => {
    const rig = await online();
    await rig.sched.advance(idle);
    await before[what as keyof typeof before](rig);
    const from = rig.facts.length;
    await blip(rig, outage);
    expect(after(rig, from)).toEqual(['takeout-end inferred']);
  });

  it('a state read just before the break still counts only to LINK_LOSS_MS before it', async () => {
    const rig = await online({ timing: { backoffMs: [10], jitter: 0 } });
    rig.board.throwDart({ segment: 'S3' });
    await rig.sched.advance(100);
    rig.board.withdraw();
    await rig.sched.advance(40);
    const from = rig.facts.length;
    // Out of sight for LINK_LOSS_MS before the break, plus the outage: just over the threshold.
    await blip(rig, MIN_UNSEEN_VISIT_MS - LINK_LOSS_MS + 100);
    expect(after(rig, from)).toEqual(['takeout-end inferred']);
  });

  it('a one-dart visit thrown and pulled inside a 2.7 s Wi-Fi drop is not lost (it infers a takeout)', async () => {
    const rig = await online();
    for (const segment of ['T20', 'T20', 'T20']) {
      rig.board.throwDart({ segment });
      await rig.sched.advance(700);
    }
    rig.board.takeout();
    await rig.sched.advance(2000);
    const from = rig.facts.length;
    rig.transport.setReachable(false);
    await rig.sched.advance(300);
    rig.board.throwDart({ segment: 'S5' });
    await rig.sched.advance(1800);
    rig.board.takeout();
    await rig.sched.advance(600);
    rig.transport.setReachable(true);
    await rig.sched.advance(3000);
    expect(after(rig, from)).toEqual(['takeout-end inferred']);
  });

  it('a dart thrown during a blip continues the visit: recovered, no takeout', async () => {
    const rig = await online();
    const from = rig.facts.length;
    await blip(rig, 300, () => rig.board.throwDart({ segment: 'T20' }));
    expect(after(rig, from)).toEqual(['detect 0:T20 recovered']);
  });

  it('a dart thrown during a long outage may follow a whole visit: inferred, then recovered', async () => {
    const rig = await online();
    const from = rig.facts.length;
    await blip(rig, 8000, () => rig.board.throwDart({ segment: 'T20' }));
    expect(after(rig, from)).toEqual(['takeout-end inferred', 'detect 0:T20 recovered']);
  });

  it('a socket that died silently counts only up to its last frame or read, not its heartbeats', async () => {
    const rig = await online();
    const from = rig.facts.length;
    rig.transport.setSilent(true);
    await rig.sched.advance(4000);
    // The OS notices 4 s after the last frame, before liveness would have: the heartbeats of
    // those 4 s count (the socket looked healthy), so this is a short outage. (A real link is
    // noticed within LINK_LOSS_MS; that is what the cap is for.)
    rig.transport.setSilent(false);
    rig.transport.cutSockets();
    await rig.sched.advance(2000);
    expect(after(rig, from)).toEqual([]);

    const dead = await online();
    const from2 = dead.facts.length;
    dead.transport.setSilent(true);
    await dead.sched.advance(12_000); // liveness: 5 s, poll 2 s, retry 1 s, poll 2 s → offline
    dead.transport.setSilent(false);
    await dead.sched.advance(3000);
    expect(after(dead, from2)).toEqual(['takeout-end inferred']);
  });

  it('a device that slept (the wall clock jumped, the heartbeat came late) counts as a long outage', async () => {
    let skew = 0;
    const rig = await online({ wallSkewMs: () => skew });
    const from = rig.facts.length;
    skew = 90_000; // the device slept 90 s; the monotonic clock did not move
    rig.transport.cutSockets(); // the OS closed the socket while we slept
    await rig.sched.advance(3000);
    expect(after(rig, from)).toEqual(['takeout-end inferred']);
  });

  it('a late heartbeat (the app was frozen) asks the board straight away', async () => {
    let skew = 0;
    const rig = await online({ wallSkewMs: () => skew });
    await rig.sched.advance(2000);
    const polls = rig.transport.httpRequestsSince(0).length;
    skew = 30_000;
    await rig.sched.advance(1100);
    expect(rig.transport.httpRequestsSince(0).length).toBe(polls + 1);
  });
});

describe('known darts missing from the snapshot always infer a takeout', () => {
  it('even after the shortest blip', async () => {
    const rig = await online();
    rig.board.throwDart({ segment: 'S5' });
    await rig.sched.advance(100);
    const from = rig.facts.length;
    await blip(rig, 400, () => rig.board.takeout());
    expect(after(rig, from)).toEqual(['takeout-end inferred']);
  });
});

describe('crash-resume: the outage counts from the log’s last contact', () => {
  it.each([
    ['1 s ago', 1000, false],
    ['2 s ago', 2000, true],
    ['60 s ago', 60_000, true],
    ['unknown', undefined, true],
  ])('board last read %s, nothing known, empty board → inferred: %s', async (_label, ago, inferred) => {
    const restored = {
      visitKey: ID,
      known: [],
      inTakeout: false,
      recentVisits: [],
      ...(ago === undefined ? {} : { observedAt: isoFromEpochMs(EPOCH - ago) }),
    };
    const rig = makeRig({ restored });
    rig.adapter.start();
    await rig.sched.advance(200);
    expect(brief(rig.facts)).toEqual(inferred ? ['takeout-end inferred'] : []);
  });

  it('restore() swaps in the rebuilt state on a stopped adapter only', async () => {
    const rig = await online();
    expect(() => rig.adapter.restore({ visitKey: ID, known: [], inTakeout: false, recentVisits: [] })).toThrow(/stopped/);
    rig.adapter.stop();
    rig.adapter.restore({ visitKey: ID, known: [], inTakeout: false, recentVisits: [], observedAt: isoFromEpochMs(EPOCH + rig.sched.now()) });
    expect(rig.adapter.visitState().visitKey).toBe(ID);
    const from = rig.facts.length;
    rig.adapter.start();
    await rig.sched.advance(200);
    expect(after(rig, from)).toEqual([]);
  });
});
