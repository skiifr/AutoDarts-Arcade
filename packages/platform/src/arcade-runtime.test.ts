import { ManualSource, SimulatorSource, seededRandom, type BoardSource, type FactListener } from '@arcade/adapters';
import { ulidFromNumber } from '@arcade/engine';
import { isBoardFact, makeSegment, type BoardFactDraft } from '@arcade/event-schema';
import { describe, expect, it, vi } from 'vitest';
import { createArcadeRuntime } from './arcade-runtime';
import { MemoryContactStore } from './contact-store';
import { REGISTRY, incarnate, makePlayers, makeWorld, type World } from './testing/pipeline';

const PLAYERS = makePlayers(2);
const COUNTDOWN = { gameId: 'countdown', options: { start: 301, maxRounds: 10 }, players: PLAYERS, rngSeed: 'runtime-test' };

async function onlineWorld(seed = 'rt'): Promise<{ world: World; inc: ReturnType<typeof incarnate> }> {
  const world = makeWorld(seed);
  const inc = incarnate(world, 0);
  inc.runtime.start();
  await world.sched.advance(200);
  return { world, inc };
}

const boardFacts = (facts: readonly { type: string }[]) => facts.filter((f) => f.type !== 'SourceConnectionChanged' && f.type !== 'BoardStatusChanged');

describe('createArcadeRuntime', () => {
  it('passes the adapter’s facts to the host in order, from before StartSession on', async () => {
    const { world, inc } = await onlineWorld();
    world.board.throwDart({ segment: 'T20' });
    await world.sched.advance(100);
    await inc.runtime.whenIdle();
    expect(inc.runtime.getSnapshot()).toBeNull(); // no session yet: remembered, not logged
    const started = await inc.runtime.command('StartSession', COUNTDOWN);
    expect(started.status).toBe('applied');
    let s = inc.runtime.getSnapshot()!;
    expect(s.phase).toBe('awaiting-clear-board');
    expect(s.baselineDarts).toBe(1);

    world.board.takeout();
    for (const seg of ['S20', 'S1', 'D10']) {
      await world.sched.advance(800);
      world.board.throwDart({ segment: seg });
    }
    await world.sched.advance(800);
    world.board.takeout();
    await world.sched.advance(800);
    await inc.runtime.whenIdle();
    s = inc.runtime.getSnapshot()!;
    expect(s.turns[0]!.darts.map((d) => d.segment.label)).toEqual(['S20', 'S1', 'D10']);
    expect(s.turns[0]!.needsReview).toBe(false);
    expect(s.currentPlayerId).toBe(PLAYERS[1]!.playerId);

    // Every fact the adapter emitted after the session began is in the log, in order.
    const log = inc.runtime.host.getLog();
    const logged = log.filter((e) => isBoardFact(e) && e.causationId === undefined).map((e) => [e.type, e.payload]);
    const firstLogged = inc.facts.findIndex((f) => f.type === logged[0]![0] && JSON.stringify(f.payload) === JSON.stringify(logged[0]![1]));
    expect(inc.facts.slice(firstLogged).map((f) => [f.type, f.payload])).toEqual(logged);
    expect(inc.errors).toEqual([]);
  });

  it('appBackground pauses, appForeground re-reads the board and resumes', async () => {
    const { world, inc } = await onlineWorld();
    await inc.runtime.command('StartSession', COUNTDOWN);
    const sockets = () => world.transport.requests.filter((r) => r.kind === 'WS').length;
    const before = sockets();
    const paused = await inc.runtime.appBackground();
    expect(paused.status === 'applied' && paused.events.map((e) => [e.type, e.payload])).toEqual([['GamePaused', { reason: 'app-background' }]]);
    expect(inc.runtime.getSnapshot()!.paused).toEqual(['app-background']);
    // A dart thrown while the app was away comes back on the resync as recovered.
    world.board.throwDart({ segment: 'T19' });
    world.transport.cutSockets();
    await world.sched.advance(50);
    const resumed = await inc.runtime.appForeground();
    expect(resumed.status === 'applied' && resumed.events.map((e) => e.type)).toEqual(['GameResumed']);
    await world.sched.advance(200);
    await inc.runtime.whenIdle();
    expect(sockets()).toBeGreaterThan(before);
    const s = inc.runtime.getSnapshot()!;
    expect(s.paused).toEqual([]);
    expect(s.dartsThisTurn.map((d) => [d.segment.label, d.origin])).toEqual([['T19', 'recovered']]);
  });

  it('appBackground / appForeground without a session are refused by the host, harmlessly', async () => {
    const { inc } = await onlineWorld();
    expect(await inc.runtime.appBackground()).toMatchObject({ status: 'rejected', reason: 'no-session' });
    expect(await inc.runtime.appForeground()).toMatchObject({ status: 'rejected', reason: 'no-session' });
  });

  it('resumeSession after a crash: same state, the adapter continues the visit it was in', async () => {
    const { world, inc } = await onlineWorld('crash');
    await inc.runtime.command('StartSession', COUNTDOWN);
    world.board.throwDart({ segment: 'S20' });
    await world.sched.advance(600);
    world.board.throwDart({ segment: 'S5' });
    await world.sched.advance(100);
    await inc.runtime.whenIdle();
    const before = inc.runtime.getSnapshot()!;
    const sessionId = before.sessionId;

    // The app dies; the board stays as it is. Relaunch on the same storage.
    inc.runtime.stop();
    const next = incarnate(world, 1);
    const changes: number[] = [];
    next.runtime.subscribe(() => changes.push(next.runtime.getSnapshot()?.lastSeq ?? 0));
    const resumed = await next.runtime.resumeSession(sessionId);
    expect(resumed?.turns).toEqual(before.turns);
    expect(resumed?.gameState).toEqual(before.gameState);
    expect(changes.length).toBeGreaterThan(0);
    expect(next.adapter.visitState().known.map((k) => k.segment.label)).toEqual(['S20', 'S5']);

    next.runtime.start();
    await world.sched.advance(200);
    world.board.throwDart({ segment: 'T20' });
    await world.sched.advance(100);
    await next.runtime.whenIdle();
    const s = next.runtime.getSnapshot()!;
    // The darts the log knew are not detected again; the new one is plain live.
    expect(s.dartsThisTurn.map((d) => [d.segment.label, d.origin])).toEqual([
      ['S20', 'detected'],
      ['S5', 'detected'],
      ['T20', 'detected'],
    ]);
    expect(boardFacts(next.facts).map((f) => f.type)).toEqual(['DartDetected']);
  });

  it('resumeSession while running restarts the source around the swap, and queues inputs meanwhile', async () => {
    const { world, inc } = await onlineWorld('swap');
    await inc.runtime.command('StartSession', COUNTDOWN);
    const sessionId = inc.runtime.getSnapshot()!.sessionId;
    const oldHost = inc.runtime.host;
    const resuming = inc.runtime.resumeSession(sessionId);
    const skip = inc.runtime.command('SkipTurn', {});
    await resuming;
    expect(inc.runtime.host).not.toBe(oldHost);
    expect((await skip).status).toBe('applied');
    expect(inc.adapter.connectionStatus().phase).not.toBe('stopped');
    await world.sched.advance(200);
    expect(inc.adapter.connectionStatus().phase).toBe('online');
    expect(inc.runtime.getSnapshot()!.currentPlayerId).toBe(PLAYERS[1]!.playerId);
  });

  it('reports facts the host refused, and keeps going', async () => {
    const listeners = new Set<FactListener>();
    const source: BoardSource = {
      kind: 'simulator',
      start: () => {},
      stop: () => {},
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const world = makeWorld('bad');
    const problems: string[] = [];
    const runtime = createArcadeRuntime({ source, store: world.store, games: REGISTRY, clock: world.clock, ids: incIds(), onError: (p) => problems.push(p.result?.status ?? 'thrown') });
    runtime.start();
    await runtime.command('StartSession', COUNTDOWN);
    const emit = (f: BoardFactDraft) => listeners.forEach((l) => l(f));
    emit({ type: 'TakeoutStarted', payload: { visitKey: 'not-a-ulid' }, source: { kind: 'simulator', adapterVersion: 'x' }, occurredAt: world.clock() } as BoardFactDraft);
    emit({ type: 'TakeoutStarted', payload: { visitKey: '01JBX00000000000000000000V' }, source: { kind: 'simulator', adapterVersion: 'x' }, occurredAt: world.clock() } as BoardFactDraft);
    await runtime.whenIdle();
    expect(problems).toEqual(['rejected']);
    expect(runtime.host.getLog().at(-1)?.type).toBe('TakeoutStarted');
  });

  it('works with the simulator and with manual play (no board)', async () => {
    const world = makeWorld('sim');
    const sim = new SimulatorSource({ scheduler: world.sched, clock: world.clock, ids: incIds(), random: seededRandom('sim') });
    const runtime = createArcadeRuntime({ source: sim, store: world.store, games: REGISTRY, clock: world.clock, ids: incIds() });
    runtime.start();
    await runtime.command('StartSession', COUNTDOWN);
    sim.throwDart('T20');
    sim.throwDart('T20');
    sim.takeout();
    await runtime.whenIdle();
    expect(runtime.getSnapshot()!.turns[0]!.darts.map((d) => d.segment.label)).toEqual(['T20', 'T20', 'MISS']);

    const manual = createArcadeRuntime({ source: new ManualSource(), store: world.store, games: REGISTRY, clock: world.clock, ids: incIds() });
    manual.start();
    await manual.command('StartSession', COUNTDOWN);
    await manual.command('AddDart', { playerId: PLAYERS[0]!.playerId, turnIndex: 0, dartIndex: 0, segment: makeSegment(20, 3), reason: 'manual-mode' });
    await manual.command('SkipTurn', {});
    expect(manual.getSnapshot()!.turns[0]!.darts.map((d) => d.segment.label)).toEqual(['T20', 'MISS', 'MISS']);
    // No board to re-read and nothing paused: a no-op.
    expect(await manual.appForeground()).toEqual({ status: 'noop' });
  });
});

/**
 * A failed `LogStore.append` of a board fact (RISK-REGISTER R28). The adapter has moved on and
 * will not send the fact again, so the runtime retries the append once, and if that fails too it
 * rebuilds the adapter's visit state from the log and resyncs: whatever the fact said comes back
 * from the board as recovered, and its turn is flagged. Never a silent loss.
 */
describe('a failed log append of a board fact', () => {
  const isDart = (events: readonly { type: string }[]) => events.some((e) => e.type === 'DartDetected');

  async function playing(seed: string) {
    const { world, inc } = await onlineWorld(seed);
    await inc.runtime.command('StartSession', COUNTDOWN);
    const throwDart = async (segment: string) => {
      world.board.throwDart({ segment });
      await world.sched.advance(700);
      await inc.runtime.whenIdle();
    };
    const takeout = async () => {
      world.board.startTakeout();
      await world.sched.advance(1000);
      world.board.finishTakeout();
      await world.sched.advance(1000);
      await inc.runtime.whenIdle();
    };
    return { world, inc, throwDart, takeout };
  }

  it('is retried once: the dart is logged as it was, and the hiccup is reported', async () => {
    const { world, inc, throwDart, takeout } = await playing('append-once');
    await throwDart('T20');
    world.store.failNext = 1;
    await throwDart('T20');
    await throwDart('T20');
    await takeout();
    const t0 = inc.runtime.getSnapshot()!.turns[0]!;
    expect(t0.darts.map((d) => [d.segment.label, d.origin])).toEqual([
      ['T20', 'detected'],
      ['T20', 'detected'],
      ['T20', 'detected'],
    ]);
    expect(t0.needsReview).toBe(false);
    expect(inc.problems.map((p) => [p.fact?.type, p.recovery])).toEqual([['DartDetected', 'retried']]);
    expect(inc.errors).toEqual([]);
  });

  it('that fails twice: the adapter is rebuilt from the log and resyncs, so the dart comes back recovered and its turn is flagged', async () => {
    const { world, inc, throwDart, takeout } = await playing('append-twice');
    await throwDart('T20');
    world.store.failNext = 2; // the storage hiccups on the second dart, and on its retry
    await throwDart('T20');
    await throwDart('T20');
    await takeout();
    const s = inc.runtime.getSnapshot()!;
    expect(s.turns[0]!.darts.map((d) => [d.segment.label, d.origin])).toEqual([
      ['T20', 'detected'],
      ['T20', 'recovered'],
      ['T20', 'detected'],
    ]);
    expect(s.turns[0]!.points).toBe(180);
    expect(s.turns[0]!.needsReview).toBe(true);
    expect(s.currentPlayerId).toBe(PLAYERS[1]!.playerId);
    expect(inc.problems.map((p) => [p.fact?.type, p.recovery])).toEqual([['DartDetected', 'resync']]);
  });

  it('drops what the adapter sent after the lost fact and reads it again: nothing counted twice', async () => {
    const { world, inc, throwDart } = await playing('append-queued');
    // The first dart's appends hang until we fail them, while the second dart arrives behind it.
    const pending: (() => void)[] = [];
    let held = 0;
    const inner = world.store.inner;
    const store = world.store as { append: typeof world.store.append };
    const append = store.append.bind(world.store);
    store.append = (sessionId, events) =>
      isDart(events) && held++ < 2
        ? new Promise<void>((_, reject) => pending.push(() => reject(new Error('SQLITE_BUSY'))))
        : append(sessionId, events);
    world.board.throwDart({ segment: 'S20' });
    await world.sched.advance(700);
    world.board.throwDart({ segment: 'S5' });
    await world.sched.advance(700);
    expect(pending.length).toBe(1);
    pending.shift()!();
    await world.sched.advance(10);
    expect(pending.length).toBe(1);
    pending.shift()!();
    await world.sched.advance(500);
    await inc.runtime.whenIdle();
    await throwDart('S1');
    const darts = inc.runtime.getSnapshot()!.turns[0]!.darts;
    expect(darts.map((d) => [d.segment.label, d.origin])).toEqual([
      ['S20', 'recovered'],
      ['S5', 'recovered'],
      ['S1', 'detected'],
    ]);
    const logged = (await inner.load(inc.runtime.getSnapshot()!.sessionId)).filter((e) => e.type === 'DartDetected');
    expect(logged.length).toBe(3);
  });

  it('while the storage keeps failing, waits with growing pauses instead of hammering the board, and recovers with it', async () => {
    const { world, inc, throwDart, takeout } = await playing('append-down');
    await throwDart('S20');
    world.store.failRate = 1;
    const t0 = world.sched.now();
    await throwDart('S5');
    await world.sched.advance(10_000);
    const sockets = world.transport.requests.filter((r) => r.kind === 'WS' && r.at >= t0).length;
    expect(sockets).toBeGreaterThan(1);
    expect(sockets).toBeLessThanOrEqual(6);
    world.store.failRate = 0;
    await world.sched.advance(12_000);
    await throwDart('S1');
    await takeout();
    const t = inc.runtime.getSnapshot()!.turns[0]!;
    expect(t.darts.map((d) => [d.segment.label, d.origin])).toEqual([
      ['S20', 'detected'],
      ['S5', 'recovered'],
      ['S1', 'detected'],
    ]);
    expect(t.needsReview).toBe(true);
    expect(inc.errors).toEqual([]);
  });

  it('reports every problem with console.error unless the app passes onError', async () => {
    const world = makeWorld('console');
    const listeners = new Set<FactListener>();
    const source: BoardSource = {
      kind: 'simulator',
      start: () => {},
      stop: () => {},
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const runtime = createArcadeRuntime({ source, store: world.store, games: REGISTRY, clock: world.clock, ids: incIds(), scheduler: world.sched });
    runtime.start();
    await runtime.command('StartSession', COUNTDOWN);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      world.store.failNext = 2;
      listeners.forEach((l) => l({ type: 'TakeoutStarted', payload: { visitKey: '01JBX00000000000000000000V' }, source: { kind: 'simulator', adapterVersion: 'x' }, occurredAt: world.clock() } as BoardFactDraft));
      await runtime.whenIdle();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toMatch(/TakeoutStarted/);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Crash-resume on an idle board (§6.5). The log holds board facts only, and an idle board sends
 * none, so the log's last contact can be long before the crash. The runtime keeps its own
 * (`ContactStore`, written every 2 s while the board is online) and the resume measures the
 * outage from the later of the two: a quick restart on an idle, empty board infers nothing.
 */
describe('crash-resume measures the outage from the last contact (ContactStore)', () => {
  async function idleThenCrash(seed: string, idleMs: number, resumeAfterMs: number, contacts = new MemoryContactStore()) {
    const world = makeWorld(seed);
    const inc = incarnate(world, 0, { contacts });
    inc.runtime.start();
    await world.sched.advance(500);
    await inc.runtime.command('StartSession', COUNTDOWN);
    const sessionId = inc.runtime.getSnapshot()!.sessionId;
    await world.sched.advance(300);
    for (const seg of ['S1', 'S2', 'S3']) {
      world.board.throwDart({ segment: seg });
      await world.sched.advance(800);
    }
    world.board.startTakeout();
    await world.sched.advance(1000);
    world.board.finishTakeout();
    await world.sched.advance(idleMs); // player 2 walks up; nothing happens on the board
    await inc.runtime.whenIdle();
    const before = inc.runtime.getSnapshot()!;
    inc.kill(); // the app dies
    await world.sched.advance(resumeAfterMs);
    const next = incarnate(world, 1, { contacts });
    await next.runtime.resumeSession(sessionId);
    next.runtime.start();
    await world.sched.advance(2000);
    await next.runtime.whenIdle();
    return { world, contacts, before, after: next.runtime.getSnapshot()! };
  }

  it.each([1000, 8000, 60_000])('idle %i ms after a takeout, a crash and an immediate restart: the waiting player keeps the turn', async (idleMs) => {
    const { before, after, contacts } = await idleThenCrash(`idle-${idleMs}`, idleMs, 0);
    expect(before.phase).toBe('playing');
    expect(after.phase).toBe('playing');
    expect(after.currentPlayerId).toBe(PLAYERS[1]!.playerId);
    expect(after.turns.map((t) => t.needsReview)).toEqual([false, false]);
    expect(after.awaitingReviewTurn).toBeNull();
    if (idleMs > 2000) expect(contacts.writes).toBeGreaterThan(0);
  });

  it('a restart after the board was out of sight long enough for a whole visit still infers a takeout, flagged', async () => {
    const { after } = await idleThenCrash('idle-long-down', 8000, 6000);
    expect(after.phase).toBe('awaiting-review');
    expect(after.turns[1]!.needsReview).toBe(true);
  });

  it('writes the contact at most every 2 s, only while the board is online and a session is open, and keeps it per session', async () => {
    const contacts = new MemoryContactStore();
    const world = makeWorld('contact-writes');
    const inc = incarnate(world, 0, { contacts });
    inc.runtime.start();
    await world.sched.advance(10_000);
    expect(contacts.writes).toBe(0); // no session yet
    await inc.runtime.command('StartSession', COUNTDOWN);
    const sessionId = inc.runtime.getSnapshot()!.sessionId;
    await world.sched.advance(10_000);
    expect(contacts.writes).toBeGreaterThanOrEqual(4);
    expect(contacts.writes).toBeLessThanOrEqual(5);
    const at = await contacts.get(sessionId);
    expect(world.simMs(at!)).toBeGreaterThan(world.sched.now() - 2100);
    world.transport.setReachable(false);
    await world.sched.advance(50);
    const offline = contacts.writes;
    await world.sched.advance(10_000);
    expect(contacts.writes).toBe(offline);
    expect(await contacts.get('01JBX0000000000000000OTHER')).toBeUndefined();
  });
});

/** Sequential ULIDs; each call gets its own prefix, so sources never collide. */
let sources = 0;
function incIds(): () => string {
  const prefix = ulidFromNumber(++sources).slice(-3);
  let n = 0;
  return () => ulidFromNumber(++n, prefix);
}
