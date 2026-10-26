import {
  COMMAND_SCHEMA_VERSION,
  makeSegment,
  parseArcadeEvent,
  type BoardFactDraft,
  type PlayerRef,
} from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { SessionHost, findResumableSession } from './host';
import type { EngineEffect } from './state';
import { makePlayers, makeRig, types } from './testing/harness';

const T20 = makeSegment(20, 3);
const S20 = makeSegment(20, 1);
const S5 = makeSegment(5, 1);
const S1 = makeSegment(1, 1);

const players = makePlayers(9);
const [A, B] = players as [PlayerRef, PlayerRef];

async function started(options: Record<string, unknown> = { rounds: 3 }) {
  const rig = makeRig();
  await rig.run(rig.cmd.start('test-sum', [A, B], options));
  return rig;
}

describe('SessionHost: log and identity', () => {
  it('appends valid events with gap-free seq, unique ids and the injected clock', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    const d = board.dart(S5);
    await rig.run(d, board.dart(T20), board.takeout(), cmd.correct(d.throwId, S20), board.dart(S1), cmd.pause(), cmd.resume());
    const log = rig.host.getLog();
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(new Set(log.map((e) => e.eventId)).size).toBe(log.length);
    expect(new Set(log.map((e) => e.sessionId)).size).toBe(1);
    for (const e of log) expect(parseArcadeEvent(e)).toEqual(e);
    expect(await rig.store.load(log[0]!.sessionId)).toEqual(log);
    // One clock read per input: every event of an input shares its receivedAt.
    const takeoutBatch = log.filter((e) => e.receivedAt === log.find((x) => x.type === 'TakeoutFinished')!.receivedAt);
    expect(takeoutBatch.map((e) => e.type)).toEqual(['TakeoutFinished', 'DartAdded', 'TurnEnded', 'TurnStarted']);
  });

  it('applies a repeated command at most once, also after a crash-resume', async () => {
    const rig = await started();
    const d = rig.board.dart(S5);
    await rig.run(d);
    const fix = rig.cmd.correct(d.throwId, S20);
    const [first, second] = await rig.run(fix, fix);
    expect(first!.status).toBe('applied');
    expect(second).toEqual({ status: 'duplicate' });
    const resumed = await SessionHost.resume(rig.deps, rig.host.getSnapshot()!.sessionId);
    expect(await resumed.dispatch(fix)).toEqual({ status: 'duplicate' });
    const skip = rig.cmd.skip();
    await resumed.dispatch(skip);
    expect(await resumed.dispatch(skip)).toEqual({ status: 'duplicate' });
    const events = resumed.getLog().filter((e) => e.causationId === fix.commandId);
    expect(events.map((e) => e.type)).toEqual(['DartCorrected']);
  });

  it('carries the commandId as causationId on everything a command produced', async () => {
    const rig = await started();
    const skip = rig.cmd.skip();
    const [r] = await rig.run(skip);
    // No board has reported, so this is a manual visit: "Next player" pads it.
    expect(types(r)).toEqual(['DartAdded', 'DartAdded', 'DartAdded', 'TurnEnded', 'TurnStarted']);
    for (const e of r!.status === 'applied' ? r!.events : []) expect(e.causationId).toBe(skip.commandId);
  });
});

describe('SessionHost: the game seed', () => {
  it('uses StartSession.rngSeed when given, so the game draws the same random stream every time', async () => {
    const draws = async (seed: string | undefined) => {
      const rig = makeRig();
      const [r] = await rig.run(rig.cmd.start('test-lucky', [A, B], { rounds: 2 }, undefined, seed));
      expect(r!.status).toBe('applied');
      for (let i = 0; i < 4; i++) await rig.run(rig.board.dart(S20), rig.board.takeout());
      const s = rig.host.getSnapshot()!;
      return { seed: s.rngSeed, lucky: (s.gameState as { luckyHistory: number[] }).luckyHistory };
    };
    const a = await draws('demo-seed-1');
    const b = await draws('demo-seed-1');
    expect(a.seed).toBe('demo-seed-1');
    expect(b).toEqual(a);
    expect(a.lucky).toHaveLength(5);
    expect((await draws('demo-seed-2')).lucky).not.toEqual(a.lucky);
  });

  it('mints a fresh seed when StartSession has none', async () => {
    const rig = makeRig();
    const [r] = await rig.run(rig.cmd.start('test-sum', [A, B]));
    const started = r!.status === 'applied' ? r!.events[0]! : undefined;
    expect(started?.type === 'SessionStarted' && started.payload.rngSeed).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(started?.type === 'SessionStarted' && started.payload.rngSeed).not.toBe(started?.sessionId);
  });

  it('refuses an empty seed', async () => {
    const rig = makeRig();
    const [r] = await rig.run(rig.cmd.start('test-sum', [A, B], {}, undefined, ''));
    expect(r).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });
});

describe('SessionHost: write-ahead', () => {
  it('persists before it notifies, and a failed append emits nothing and changes nothing', async () => {
    const rig = await started();
    const { host, board, store } = rig;
    const calls: string[] = [];
    host.subscribe(() => calls.push(`state@${store.persisted}`));
    host.subscribeEffects(() => calls.push(`effects@${store.persisted}`));
    const before = host.getSnapshot();
    const logLength = host.getLog().length;

    store.failures = 1;
    const dart = board.dart(T20);
    await expect(host.ingest(dart)).rejects.toThrow('disk full');
    expect(calls).toEqual([]);
    expect(host.getSnapshot()).toBe(before);
    expect(host.getLog()).toHaveLength(logLength);
    expect(await store.load(before!.sessionId)).toHaveLength(logLength);

    // The adapter re-sends the fact; it gets the seq the failed append would have had.
    const ok = await host.ingest(dart);
    expect(ok.status === 'applied' && ok.events.map((e) => e.seq)).toEqual([logLength + 1, logLength + 2]);
    expect(calls).toEqual([`state@${logLength + 2}`, `effects@${logLength + 2}`]);
  });

  it('leaves the state exactly as it was when a correction fails to persist', async () => {
    const rig = await started();
    const d = rig.board.dart(S5);
    await rig.run(d, rig.board.dart(S1), rig.board.takeout());
    const before = rig.host.getSnapshot();
    rig.store.failures = 1;
    const fix = rig.cmd.correct(d.throwId, T20);
    await expect(rig.host.dispatch(fix)).rejects.toThrow('disk full');
    expect(rig.host.getSnapshot()).toBe(before);
    // Not recorded, so not a duplicate: a retry applies it.
    const retry = await rig.host.dispatch(fix);
    expect(retry.status).toBe('applied');
    expect(rig.host.getSnapshot()!.view).toEqual({ scores: { [A.playerId]: 61, [B.playerId]: 0 } });
  });

  it('keeps no session when SessionStarted fails to persist', async () => {
    const rig = makeRig();
    rig.store.failures = 1;
    await expect(rig.host.dispatch(rig.cmd.start('test-sum', [A]))).rejects.toThrow('disk full');
    expect(rig.host.getSnapshot()).toBeNull();
    expect(await rig.store.listSessions()).toEqual([]);
  });

  it('processes inputs one at a time in arrival order', async () => {
    const rig = await started();
    const { board } = rig;
    const results = await Promise.all([board.dart(S1), board.dart(S5), board.dart(T20), board.takeout()].map((f) => rig.host.ingest(f)));
    expect(results.map(types)).toEqual([
      ['DartDetected', 'DartThrown'],
      ['DartDetected', 'DartThrown'],
      ['DartDetected', 'DartThrown'],
      ['TakeoutFinished', 'TurnEnded', 'TurnStarted'],
    ]);
  });
});

describe('SessionHost: crash-resume, preview, subscribers', () => {
  it('resumes from LogStore.load in exactly the same state', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    const d = board.dart(S5);
    await rig.run(d, board.takeout(), board.dart(T20), board.connection('offline'), cmd.correct(d.throwId, S1), cmd.pause());
    const resumed = await SessionHost.resume(rig.deps, rig.host.getSnapshot()!.sessionId);
    expect(resumed.getSnapshot()).toStrictEqual(rig.host.getSnapshot());
    expect(resumed.getLog()).toEqual(rig.host.getLog());
    await expect(SessionHost.resume(rig.deps, '7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).rejects.toThrow(/no events/);
  });

  it('previews a command without appending or notifying, and the real command lands on that state', async () => {
    const rig = await started();
    const { host, board, cmd } = rig;
    const d = board.dart(S5);
    await rig.run(d, board.dart(S1));
    const calls: string[] = [];
    host.subscribe(() => calls.push('state'));
    const before = host.getSnapshot();
    const fix = cmd.correct(d.throwId, T20);
    const preview = host.preview(fix);
    expect(preview.status).toBe('ok');
    if (preview.status !== 'ok') return;
    expect(preview.events.map((e) => e.type)).toEqual(['DartCorrected']);
    expect(preview.state.view).toEqual({ scores: { [A.playerId]: 61, [B.playerId]: 0 } });
    expect(host.getSnapshot()).toBe(before);
    expect(calls).toEqual([]);
    expect(rig.store.persisted).toBe(host.getLog().length);
    await host.dispatch(fix);
    expect(host.getSnapshot()).toStrictEqual(preview.state);

    expect(host.preview(cmd.correct(board.dart(S1).throwId, T20))).toMatchObject({ status: 'rejected', reason: 'unknown-dart' });
    expect(host.preview(cmd.rematch())).toMatchObject({ status: 'rejected', reason: 'not-previewable' });
    expect(host.preview({ nonsense: true })).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });

  it('emits game effects only for new events, and one score-adjusted signal for a correction', async () => {
    const rig = await started();
    const { host, board, cmd } = rig;
    const fx: EngineEffect[][] = [];
    host.subscribeEffects((e) => fx.push([...e]));
    const t20 = board.dart(T20);
    await rig.run(t20, board.dart(S5), board.takeout());
    expect(fx.map((batch) => batch.map((e) => (e.type === 'game' ? e.effect.kind : e.type)))).toEqual([['big-hit'], ['hit']]);
    fx.length = 0;
    await rig.run(cmd.correct(t20.throwId, S20), board.update(t20.throwId, T20, S1));
    expect(fx).toEqual([[{ type: 'score-adjusted', seq: expect.any(Number), throwIds: [t20.throwId] }]]);

    const resumed = await SessionHost.resume(rig.deps, host.getSnapshot()!.sessionId);
    const after: EngineEffect[][] = [];
    resumed.subscribeEffects((e) => after.push([...e]));
    await resumed.ingest(board.dart(S1));
    expect(after.map((b) => b.map((e) => e.type === 'game' && e.effect.kind))).toEqual([['hit']]);
  });

  it('keeps getSnapshot stable between changes, as useSyncExternalStore requires', async () => {
    const rig = await started();
    const { host, board, cmd } = rig;
    let calls = 0;
    const unsubscribe = host.subscribe(() => calls++);
    const s1 = host.getSnapshot();
    expect(host.getSnapshot()).toBe(s1);
    const d = board.dart(S5);
    await rig.run(d);
    const s2 = host.getSnapshot();
    expect(s2).not.toBe(s1);
    expect(calls).toBe(1);
    await rig.run(cmd.correct(d.throwId, S5));
    expect(host.getSnapshot()).toBe(s2);
    expect(calls).toBe(1);
    // Turns that did not change keep their view objects.
    await rig.run(board.takeout(), board.dart(S1));
    const s3 = host.getSnapshot()!;
    await rig.run(board.dart(S1));
    expect(host.getSnapshot()!.turns[0]).toBe(s3.turns[0]);
    expect(calls).toBe(4);
    unsubscribe();
    await rig.run(board.dart(S1));
    expect(calls).toBe(4);
  });
});

describe('SessionHost: commands', () => {
  it('pauses and resumes on command, keeping each reason separately; board darts still score', async () => {
    const rig = await started();
    const { cmd, board } = rig;
    const out = await rig.run(cmd.pause('menu'), cmd.pause('menu'), cmd.pause('app-background'), board.dart(S5));
    expect(out.map(types)).toEqual([['GamePaused'], [], ['GamePaused'], ['DartDetected', 'DartThrown']]);
    expect(rig.host.getSnapshot()!.paused).toEqual(['menu', 'app-background']);
    const [one, all, none] = await rig.run(cmd.resume('app-background'), cmd.resume(), cmd.resume());
    expect(types(one)).toEqual(['GameResumed']);
    expect(types(all)).toEqual(['GameResumed']);
    expect(none).toEqual({ status: 'noop' });
    expect(rig.host.getSnapshot()!.isPaused).toBe(false);
  });

  it('Resume does not lift a board-offline or review pause', async () => {
    const rig = await started();
    const { board, cmd } = rig;
    await rig.run(board.connection('offline'));
    const [r] = await rig.run(cmd.resume());
    expect(r).toEqual({ status: 'noop' });
    expect(rig.host.getSnapshot()!.paused).toEqual(['board-offline']);
  });

  it('Rematch closes the finished session and starts another with the same players', async () => {
    const rig = await started({ rounds: 1 });
    const { host, board, cmd } = rig;
    // B's dart after the end is not scored, but it is still in the board at the rematch.
    await rig.run(board.dart(S20), board.takeout(), board.dart(S5), board.takeout(), board.dart(S1));
    const first = host.getSnapshot()!;
    expect(first.phase).toBe('finished');
    const [r] = await rig.run(cmd.rematch());
    expect(types(r)).toEqual(['SessionClosed', 'SessionStarted', 'DartDetected']);
    const next = host.getSnapshot()!;
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.players).toEqual(first.players);
    expect(next.options).toEqual(first.options);
    expect(next.rngSeed).not.toBe(first.rngSeed);
    expect(next.phase).toBe('awaiting-clear-board');
    const sessions = await rig.store.listSessions();
    expect(sessions.map((s) => [s.sessionId, s.closed])).toEqual([
      [next.sessionId, false],
      [first.sessionId, true],
    ]);
    expect(await findResumableSession(rig.store)).toBe(next.sessionId);
    expect(host.getLog()[0]!.type).toBe('SessionStarted');
  });

  it('rejects commands it cannot apply, with a reason', async () => {
    const rig = makeRig();
    const { cmd, host } = rig;
    expect(await host.dispatch({ type: 'Nope' })).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(await host.dispatch(cmd.skip())).toMatchObject({ status: 'rejected', reason: 'no-session' });
    expect(await host.dispatch(cmd.rematch())).toMatchObject({ status: 'rejected', reason: 'no-session' });
    expect(await host.dispatch(cmd.start('chess', [A]))).toMatchObject({ status: 'rejected', reason: 'unknown-game' });
    expect(await host.dispatch(cmd.start('test-sum', [A], { rounds: 0 }))).toMatchObject({ status: 'rejected', reason: 'invalid-options' });
    expect(await host.dispatch(cmd.start('test-race', [A]))).toMatchObject({ status: 'rejected', reason: 'player-count' });
    expect(await host.dispatch(cmd.start('test-sum', players))).toMatchObject({ status: 'rejected', reason: 'invalid' });
    const badOrder = {
      schema: COMMAND_SCHEMA_VERSION,
      commandId: '3D000000000000000000000001',
      type: 'StartSession',
      payload: { gameId: 'test-sum', options: {}, players: [A, B], turnOrder: [A.playerId, A.playerId] },
      actor: 'operator',
      issuedAt: '2026-11-02T20:00:00.000Z',
    };
    expect(await host.dispatch(badOrder)).toMatchObject({ status: 'rejected', reason: 'invalid-turn-order' });

    expect((await host.dispatch(cmd.start('test-sum', [A, B]))).status).toBe('applied');
    expect(await host.dispatch(cmd.start('test-sum', [A, B]))).toMatchObject({ status: 'rejected', reason: 'session-open' });
    expect((await host.dispatch(cmd.close('abandoned'))).status).toBe('applied');
    expect(await host.dispatch(cmd.skip())).toMatchObject({ status: 'rejected', reason: 'session-closed' });
    expect(await host.ingest(rig.board.dart(S1))).toEqual({ status: 'not-recorded' });
    expect(host.preview(cmd.skip())).toMatchObject({ status: 'rejected', reason: 'session-closed' });
    expect(await findResumableSession(rig.store)).toBeNull();
  });

  it('honours an explicit turn order', async () => {
    const rig = makeRig();
    const start = rig.cmd.start('test-sum', [A, B]);
    if (start.type === 'StartSession') start.payload.turnOrder = [B.playerId, A.playerId];
    await rig.run(start);
    const s = rig.host.getSnapshot()!;
    expect(s.turnOrder).toEqual([B.playerId, A.playerId]);
    expect(s.players.map((p) => p.playerId)).toEqual([B.playerId, A.playerId]);
    expect(s.currentPlayerId).toBe(B.playerId);
  });

  it('logs the validated copy of a board fact, without keys the schema does not know', async () => {
    const rig = await started();
    const f = rig.board.dart(S1);
    const noisy = { ...f, debug: 'x', payload: { ...f.payload, rawFrame: { a: 1 } } } as unknown as BoardFactDraft;
    const r = await rig.host.ingest(noisy);
    expect(types(r)).toEqual(['DartDetected', 'DartThrown']);
    const logged = rig.host.getLog().find((e) => e.type === 'DartDetected')!;
    expect(Object.keys(logged.payload).sort()).toEqual(['indexInVisit', 'segment', 'throwId', 'visitKey']);
    expect('debug' in logged).toBe(false);
  });

  it('rejects a malformed board fact without touching the log', async () => {
    const rig = await started();
    const bad = { ...rig.board.dart(S1), payload: { ...rig.board.dart(S1).payload, segment: { ...S1, label: 'T20' } } };
    const r = await rig.host.ingest(bad as BoardFactDraft);
    expect(r).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(rig.host.getLog()).toHaveLength(2);
  });
});
