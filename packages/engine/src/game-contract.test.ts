import { DEFAULT_HOUSE_RULES, makeSegment, parseArcadeEvent, type PlayerId, type PlayerRef, type Standing } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { foldSession } from './fold';
import type { GameModule, Rng } from './game-module';
import { SessionHost } from './host';
import { gameRegistry } from './registry';
import { TEST_GAMES } from './testing/games';
import { Board, Commands, FlakyStore, counterClock, counterIds, makePlayers, types } from './testing/harness';

const [A, B, C] = makePlayers(3) as [PlayerRef, PlayerRef, PlayerRef];
const S20 = makeSegment(20, 1);
const D20 = makeSegment(20, 2);

interface SpyState {
  order: readonly PlayerId[];
  turns: number;
  out: readonly PlayerId[];
  done: boolean;
}

/** Records every call (and the Rng object it was given) in a shared journal. */
function spyGame(journal: { call: string; rng: Rng }[], opts: { openingNull?: boolean; eliminate?: PlayerId; checkoutOn?: number } = {}) {
  const game: GameModule<{ x?: number }, SpyState, SpyState> = {
    manifest: { id: 'spy', version: '1.0.0', name: 'Spy', players: { min: 1, max: 8 }, category: 'party', dartsPerTurn: 3 },
    options: z.object({ x: z.number().optional() }),
    init: ({ players, rng }) => {
      journal.push({ call: 'init', rng });
      rng.next();
      return { order: players.map((p) => p.playerId), turns: 0, out: [], done: false };
    },
    onDart: (s, dart, ctx) => {
      journal.push({ call: `onDart:${dart.turnIndex}:${dart.dartIndex}`, rng: ctx.rng });
      ctx.rng.next();
      if (opts.checkoutOn !== undefined && dart.points === opts.checkoutOn) {
        return { state: { ...s, done: true }, endTurn: 'game-rule' };
      }
      return { state: s };
    },
    onTurnEnd: (s, ctx) => {
      journal.push({ call: `onTurnEnd:${ctx.turnIndex}`, rng: ctx.rng });
      const out = opts.eliminate && ctx.playerId === opts.eliminate ? [...s.out, ctx.playerId] : s.out;
      // Siege may return endTurn here; the host must ignore it.
      return { state: { ...s, turns: s.turns + 1, out }, endTurn: 'game-rule' };
    },
    nextPlayer: (s, ctx) => {
      journal.push({ call: `nextPlayer:${ctx.turnIndex}:${ctx.dartsThisTurn.length}`, rng: ctx.rng });
      if (opts.openingNull || s.done) return null;
      const alive = s.order.filter((p) => !s.out.includes(p));
      if (s.turns === 0) return alive[0]!;
      const seat = s.order.indexOf(ctx.playerId);
      for (let i = 1; i <= s.order.length; i++) {
        const p = s.order[(seat + i) % s.order.length]!;
        if (!s.out.includes(p)) return p;
      }
      return null;
    },
    result: (s): Standing[] | null => (s.done ? s.order.map((playerId, i) => ({ playerId, rank: i + 1, score: 0 })) : null),
    view: (s) => s,
  };
  return game as unknown as GameModule;
}

function rigFor(game: GameModule) {
  const store = new FlakyStore();
  const host = new SessionHost({
    store,
    clock: counterClock(),
    ids: counterIds('0E'),
    games: gameRegistry([...TEST_GAMES, game]),
    defaultHouseRules: { ...DEFAULT_HOUSE_RULES, missingDartsAreMisses: false },
  });
  return { host, board: new Board(), cmd: new Commands(), games: gameRegistry([...TEST_GAMES, game]) };
}

describe('the GameModule call contract (turn-order convention of the games)', () => {
  it('calls init, then nextPlayer with an opening ctx, then onDart…, onTurnEnd, nextPlayer per turn — on one Rng', async () => {
    const journal: { call: string; rng: Rng }[] = [];
    const { host, board, cmd } = rigFor(spyGame(journal));
    await host.dispatch(cmd.start('spy', [A, B]));
    await host.ingest(board.dart(S20));
    await host.ingest(board.dart(S20));
    await host.ingest(board.takeout());
    // The live host may replay the open turn from its checkpoint; the last pass is the full order.
    const calls = journal.map((j) => j.call);
    const lastInit = calls.lastIndexOf('init');
    expect(calls.slice(lastInit, lastInit + 2)).toEqual(['init', 'nextPlayer:0:0']);
    const finalPass = calls.slice(calls.lastIndexOf('onDart:0:0'));
    expect(finalPass).toEqual(['onDart:0:0', 'onDart:0:1', 'onTurnEnd:0', 'nextPlayer:0:2']);
    expect(new Set(journal.map((j) => j.rng)).size).toBe(1);

    journal.length = 0;
    foldSession(host.getLog(), rigFor(spyGame(journal)).games);
    expect(journal.map((j) => j.call)).toEqual(['init', 'nextPlayer:0:0', 'onDart:0:0', 'onDart:0:1', 'onTurnEnd:0', 'nextPlayer:0:2']);
    expect(new Set(journal.map((j) => j.rng)).size).toBe(1);
  });

  it('starts with the player the opening nextPlayer names, and ignores endTurn from onTurnEnd', async () => {
    const { host, board, cmd } = rigFor(spyGame([]));
    const [start] = [await host.dispatch(cmd.start('spy', [A, B, C]))];
    expect(types(start)).toEqual(['SessionStarted', 'TurnStarted']);
    expect(host.getSnapshot()!.currentPlayerId).toBe(A.playerId);
    await host.ingest(board.dart(S20));
    const end = await host.ingest(board.takeout());
    expect(types(end)).toEqual(['TakeoutFinished', 'TurnEnded', 'TurnStarted']);
    expect(host.getSnapshot()!.turns[0]!.closedBy).toBeNull();
  });

  it('a null opening nextPlayer means the game is over before it starts', async () => {
    const { host, cmd } = rigFor(spyGame([], { openingNull: true }));
    const start = await host.dispatch(cmd.start('spy', [A, B]));
    expect(types(start)).toEqual(['SessionStarted']);
    expect(host.getSnapshot()!.phase).toBe('finished');
  });

  it('follows nextPlayer through eliminations instead of rotating turnOrder, counting rounds on wrap', async () => {
    const { host, board, cmd } = rigFor(spyGame([], { eliminate: B.playerId }));
    await host.dispatch(cmd.start('spy', [A, B, C]));
    for (let i = 0; i < 5; i++) {
      await host.ingest(board.dart(S20));
      await host.ingest(board.takeout());
    }
    expect(host.getSnapshot()!.turns.map((t) => [t.playerId, t.roundIndex])).toEqual([
      [A.playerId, 0],
      [B.playerId, 0],
      [C.playerId, 0],
      [A.playerId, 1],
      [C.playerId, 1],
      [A.playerId, 2],
    ]);
  });

  it("finishes after a turn whose checkout returned endTurn:'game-rule'", async () => {
    const { host, board, cmd } = rigFor(spyGame([], { checkoutOn: 40 }));
    await host.dispatch(cmd.start('spy', [A, B]));
    const win = await host.ingest(board.dart(D20));
    expect(types(win)).toEqual(['DartDetected', 'DartThrown', 'GameFinished']);
    const after = await host.ingest(board.dart(S20));
    expect(types(after)).toEqual(['DartDetected', 'DartThrown']);
    const end = await host.ingest(board.takeout());
    expect(types(end)).toEqual(['TakeoutFinished', 'TurnEnded']);
    const s = host.getSnapshot()!;
    expect(s.turns[0]!.darts.map((d) => d.greyedBy)).toEqual([null, 'game-rule']);
    expect(s.finished).toMatchObject({ provisional: true });
  });

  it('rejects a nextPlayer answer naming someone outside the session', () => {
    const bad = { ...(spyGame([]) as GameModule<unknown, SpyState, unknown>), nextPlayer: () => 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ' };
    const games = gameRegistry([bad as GameModule]);
    const start = {
      schema: 'arcade.event/v1',
      eventId: counterIds('9')(),
      sessionId: counterIds('8')(),
      seq: 1,
      type: 'SessionStarted',
      payload: {
        gameId: 'spy',
        gameVersion: '1.0.0',
        options: {},
        players: [A],
        turnOrder: [A.playerId],
        rngSeed: 'seed',
        houseRules: DEFAULT_HOUSE_RULES,
      },
      source: { kind: 'manual', adapterVersion: 'ui@0.1.0' },
      occurredAt: '2026-11-02T20:00:00.000Z',
      receivedAt: '2026-11-02T20:00:00.000Z',
    };
    expect(() => foldSession([parseArcadeEvent(start)], games)).toThrow(/nextPlayer returned/);
  });
});
