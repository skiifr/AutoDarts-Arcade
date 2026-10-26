import { ManualSource, SimulatorSource, seededRandom, type BoardSource, type FactListener } from '@arcade/adapters';
import { ulidFromNumber } from '@arcade/engine';
import { isBoardFact, makeSegment, type BoardFactDraft } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { createArcadeRuntime } from './arcade-runtime';
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

/** Sequential ULIDs; each call gets its own prefix, so sources never collide. */
let sources = 0;
function incIds(): () => string {
  const prefix = ulidFromNumber(++sources).slice(-3);
  let n = 0;
  return () => ulidFromNumber(++n, prefix);
}
