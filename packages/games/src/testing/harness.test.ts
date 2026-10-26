import { createRng, type GameModule } from '@arcade/engine';
import { parseArcadeEvent, type ArcadeEvent, type Standing } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  aimedDart,
  aimingThrower,
  defaultNames,
  makePlayers,
  parseDart,
  parseVisits,
  runOnHost,
  runSession,
  testId,
  tickingClock,
} from '.';

/** First to `target` points wins. A treble 1 ends the turn early; a bust-style rule for tests. */
interface ToyState {
  target: number;
  scores: { playerId: string; score: number }[];
  current: number;
  done: boolean;
}

const toy: GameModule<{ target: number }, ToyState, { targets: number[]; scores: number[] }> = {
  manifest: { id: 'toy', version: '1.0.0', name: 'Toy', players: { min: 1, max: 8 }, category: 'practice', dartsPerTurn: 3 },
  options: z.object({ target: z.int().min(1).default(100) }),
  init: ({ players, options }) => ({
    target: options.target,
    scores: players.map((p) => ({ playerId: p.playerId, score: 0 })),
    current: 0,
    done: false,
  }),
  onDart: (state, dart) => {
    const scores = state.scores.map((s) => (s.playerId === dart.playerId ? { ...s, score: s.score + dart.points } : s));
    const done = scores.some((s) => s.score >= state.target);
    const endTurn = done ? 'game-rule' : dart.segment.label === 'T1' ? 'bust' : undefined;
    return { state: { ...state, scores, done }, effects: [{ kind: 'hit', playerId: dart.playerId }], endTurn };
  },
  onTurnEnd: (state) => ({ state: { ...state, current: (state.current + 1) % state.scores.length } }),
  nextPlayer: (state) => (state.done ? null : state.scores[state.current]!.playerId),
  result: (state): Standing[] | null =>
    state.done
      ? [...state.scores]
          .sort((a, b) => b.score - a.score)
          .map((s, i) => ({ playerId: s.playerId, rank: i + 1, score: s.score }))
      : null,
  view: (state) => ({ targets: [state.current === 0 ? 19 : 25], scores: state.scores.map((s) => s.score) }),
};

const players = makePlayers(['Alex', 'Jo']);
const darts = (...visits: string[][]) => parseVisits(visits);

describe('runSession', () => {
  it('plays three darts a visit and pads a short visit with misses', () => {
    const run = runSession(toy, { players, options: { target: 500 }, darts: darts(['S20'], ['T20', 'T20', 'S1']) });
    expect(run.turns[0]!.darts).toEqual([
      { label: 'S20', points: 20, scored: true, padded: false },
      { label: 'MISS', points: 0, scored: true, padded: true },
      { label: 'MISS', points: 0, scored: true, padded: true },
    ]);
    expect(run.turns[1]!.effects).toHaveLength(3);
    expect(run.finished).toBe(false);
    expect(run.standings).toBeNull();
  });

  it('leaves a short visit short when missing darts are not misses', () => {
    const run = runSession(toy, { players, darts: darts(['S20']), padMissing: false });
    expect(run.turns[0]!.darts).toHaveLength(1);
  });

  it('honours endTurn: later darts are shown, not scored', () => {
    const run = runSession(toy, { players, darts: darts(['T1', 'T20', 'T20'], ['S5']) });
    expect(run.turns[0]!.endTurn).toBe('bust');
    expect(run.turns[0]!.darts.map((d) => d.scored)).toEqual([true, false, false]);
    expect(run.state.scores[0]!.score).toBe(3);
  });

  it('does not invent leftovers for a short visit that ended early', () => {
    const run = runSession(toy, { players, darts: darts(['T1']) });
    expect(run.turns[0]!.darts).toHaveLength(1);
  });

  it('stops at the end of the game and returns standings', () => {
    const run = runSession(toy, { players, options: { target: 50 }, darts: darts(['S20'], ['S1'], ['S10', 'S20']) });
    expect(run.finished).toBe(true);
    expect(run.turns).toHaveLength(3);
    expect(run.standings).toEqual([
      { playerId: testId(1), rank: 1, score: 50 },
      { playerId: testId(2), rank: 2, score: 1 },
    ]);
    expect(run.options).toEqual({ target: 50 });
  });

  it('counts rounds when the turn order wraps', () => {
    const run = runSession(toy, { players, darts: darts([], [], [], []) });
    expect(run.turns.map((t) => [t.name, t.roundIndex])).toEqual([
      ['Alex', 0],
      ['Jo', 0],
      ['Alex', 1],
      ['Jo', 1],
    ]);
  });

  it('asks a dart source for every dart, with the view, until maxTurns', () => {
    const seen: number[] = [];
    const run = runSession(toy, {
      players,
      maxTurns: 4,
      darts: ({ view, dartIndex }) => {
        seen.push((view as { targets: number[] }).targets[0]!);
        return dartIndex === 2 ? null : parseDart('S1');
      },
    });
    expect(run.turns).toHaveLength(4);
    expect(seen.slice(0, 4)).toEqual([19, 19, 19, 25]);
    expect(run.turns[0]!.darts[2]).toMatchObject({ padded: true });
  });

  it('freezes states so that a mutating game fails loudly', () => {
    const mutating: typeof toy = {
      ...toy,
      onDart: (state, dart) => {
        state.scores[0]!.score += dart.points;
        return { state };
      },
    };
    expect(() => runSession(mutating, { players, darts: darts(['S1']) })).not.toThrow();
    expect(() => runSession(mutating, { players, darts: darts(['S1']), freeze: true })).toThrow(TypeError);
  });

  it('round-trips states through JSON', () => {
    const run = runSession(toy, { players, darts: darts(['S1']), roundTrip: true, freeze: true });
    expect(Object.isFrozen(run.state)).toBe(true);
    expect(run.state.scores[0]!.score).toBe(1);
  });

  it('rejects a next player who is not in the session', () => {
    const lost: typeof toy = { ...toy, nextPlayer: () => testId(99) };
    expect(() => runSession(lost, { players, darts: darts(['S1']) })).toThrow(/unknown player/);
  });
});

/** Two turns; keeps every number it draws in its state, so a replayed turn draws the same again. */
interface DiceState {
  players: string[];
  turns: number;
  draws: number[];
}

const dice: GameModule<object, DiceState, { targets: number[] }> = {
  manifest: { id: 'dice', version: '1.0.0', name: 'Dice', players: { min: 1, max: 8 }, category: 'practice', dartsPerTurn: 3 },
  options: z.object({}),
  init: ({ players, rng }) => ({ players: players.map((p) => p.playerId), turns: 0, draws: [rng.next()] }),
  onDart: (state, _dart, ctx) => ({ state: { ...state, draws: [...state.draws, ctx.rng.int(1, 6)] } }),
  onTurnEnd: (state, ctx) => ({ state: { ...state, turns: state.turns + 1, draws: [...state.draws, ctx.rng.next()] } }),
  nextPlayer: (state) => (state.turns >= 2 ? null : state.players[state.turns % state.players.length]!),
  result: (state) => (state.turns >= 2 ? state.players.map((playerId) => ({ playerId, rank: 1, score: 0 })) : null),
  view: () => ({ targets: [20] }),
};

describe('the Rng', () => {
  /** What `dice` draws from the engine's generator for two visits of three darts. */
  const expected = (seed: string) => {
    const rng = createRng(seed);
    const visit = () => [rng.int(1, 6), rng.int(1, 6), rng.int(1, 6), rng.next()];
    return [rng.next(), ...visit(), ...visit()];
  };

  it("is the engine's generator for the seed, one stream through init, darts and turn ends", async () => {
    const spec = { players, seed: 'abc', darts: darts(['S1'], ['S2']) };
    expect(runSession(dice, spec).state.draws).toEqual(expected('abc'));
    expect((await runOnHost(dice, spec)).state.draws).toEqual(expected('abc'));
  });

  it('defaults the seed to "arcade"', async () => {
    expect(runSession(dice, { players, darts: darts([], []) }).state.draws).toEqual(expected('arcade'));
    expect((await runOnHost(dice, { players, darts: darts([], []) })).state.draws).toEqual(expected('arcade'));
  });
});

describe('runOnHost', () => {
  const ofType = <T extends ArcadeEvent['type']>(log: readonly ArcadeEvent[], type: T) =>
    log.filter((e): e is Extract<ArcadeEvent, { type: T }> => e.type === type);

  it("plays the same session as runSession, through the engine's SessionHost", async () => {
    const spec = { players, options: { target: 50 }, seed: 'host', darts: darts(['S20'], ['T1', 'T20', 'S5'], ['S10', 'S20'], ['S1']) };
    const harness = runSession(toy, spec);
    const run = await runOnHost(toy, spec);
    expect(run.turns).toEqual(harness.turns);
    expect(run.turns.map((t) => t.darts.map((d) => [d.label, d.scored, d.padded]))).toEqual([
      [['S20', true, false], ['MISS', true, true], ['MISS', true, true]],
      [['T1', true, false], ['T20', false, false], ['S5', false, false]],
      [['S10', true, false], ['S20', true, false]],
    ]);
    expect(run.turns.map((t) => t.endTurn)).toEqual([null, 'bust', 'game-rule']);
    expect(run).toMatchObject({ finished: true, standings: harness.standings, state: harness.state, view: harness.view, options: { target: 50 } });
    expect(run.session).toMatchObject({ phase: 'closed', closed: { outcome: 'completed', finalStandings: harness.standings } });
  });

  it('logs a valid manual-mode session: AddDart per dart, SkipTurn per visit, the seed as rngSeed', async () => {
    const { log } = await runOnHost(toy, { players, seed: 'abc', darts: darts(['S1', 'S2', 'S3'], ['S4']) });
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    for (const e of log) expect(parseArcadeEvent(e)).toEqual(e);
    expect(ofType(log, 'SessionStarted')[0]!.payload).toMatchObject({ gameId: 'toy', rngSeed: 'abc' });
    const added = ofType(log, 'DartAdded');
    expect(added.map((e) => [e.payload.segment.label, e.payload.reason, e.source.kind])).toEqual(
      ['S1', 'S2', 'S3', 'S4', 'MISS', 'MISS'].map((label) => [label, 'manual-mode', 'manual']),
    );
    expect(ofType(log, 'TurnEnded').map((e) => e.payload.reason)).toEqual(['manual-skip', 'manual-skip']);
    expect(new Set(log.map((e) => e.eventId)).size).toBe(log.length);
  });

  it('stops after maxTurns and abandons the session', async () => {
    const run = await runOnHost(toy, { players, maxTurns: 3, darts: () => parseDart('T1') });
    expect(run.turns.map((t) => [t.name, t.darts.length, t.endTurn])).toEqual([
      ['Alex', 1, 'bust'],
      ['Jo', 1, 'bust'],
      ['Alex', 1, 'bust'],
    ]);
    expect(run).toMatchObject({ finished: false, standings: null });
    expect(run.session.closed).toEqual({ outcome: 'abandoned', finalStandings: [] });
    expect(run.log.at(-2)).toMatchObject({ type: 'TurnStarted', payload: { turnIndex: 3 } });
  });

  it('leaves a short visit short when missing darts are not misses', async () => {
    const run = await runOnHost(toy, { players, darts: darts(['S20']), padMissing: false });
    expect(run.turns[0]!.darts).toHaveLength(1);
  });

  it('freezes game states so that a mutating game fails loudly', async () => {
    const mutating: typeof toy = {
      ...toy,
      onDart: (state, dart) => {
        state.scores[0]!.score += dart.points;
        return { state };
      },
    };
    await expect(runOnHost(mutating, { players, darts: darts(['S1']), freeze: true })).rejects.toThrow(TypeError);
  });

  it('throws when the host refuses an input', async () => {
    await expect(runOnHost(toy, { players, options: { target: 0 }, darts: darts([]) })).rejects.toThrow(
      /toy: the host did not apply StartSession: .*invalid-options/,
    );
    await expect(runOnHost(toy, { players, games: () => undefined, darts: darts([]) })).rejects.toThrow(/unknown-game/);
    await expect(runOnHost(toy, { players, seed: '', darts: darts([]) })).rejects.toThrow(RangeError);
  });
});

describe('tickingClock', () => {
  it('ticks valid ISO timestamps without reading the clock, for one day', () => {
    const clock = tickingClock(3_723_004);
    expect([clock(), clock(), clock()]).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T01:02:03.004Z', '2026-01-01T02:04:06.008Z']);
    expect(tickingClock()()).toBe('2026-01-01T00:00:00.000Z');
    const halfDays = tickingClock(43_200_000);
    expect([halfDays(), halfDays()]).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T12:00:00.000Z']);
    expect(() => halfDays()).toThrow(RangeError);
  });
});

describe('dart labels', () => {
  it('parses every label kind, in any case', () => {
    expect(['T20', 'd16', 's5', '25', 'bull', 'Miss'].map((l) => parseDart(l).label)).toEqual([
      'T20',
      'D16',
      'S5',
      '25',
      'BULL',
      'MISS',
    ]);
  });

  it('rejects anything else', () => {
    for (const bad of ['T25', 'S0', 'S21', 'X5', '']) expect(() => parseDart(bad)).toThrow(RangeError);
  });
});

describe('players', () => {
  it('builds guests with ULID-shaped ids in turn order', () => {
    expect(makePlayers(defaultNames(2))).toEqual([
      { playerId: '00000000000000000000000001', displayName: 'Player 1', colorIndex: 0, kind: 'guest' },
      { playerId: '00000000000000000000000002', displayName: 'Player 2', colorIndex: 1, kind: 'guest' },
    ]);
  });
});

describe('aiming thrower', () => {
  it('lands on the number, its double and treble, its neighbours or off the board', () => {
    const rng = createRng('aim');
    const labels = new Set(Array.from({ length: 400 }, () => aimedDart(rng, 20).label));
    expect([...labels].sort()).toEqual(['D20', 'MISS', 'S1', 'S20', 'S5', 'T20']);
  });

  it('aims at the bull too', () => {
    const rng = createRng('bull');
    const labels = Array.from({ length: 400 }, () => aimedDart(rng, 25).label);
    expect(labels).toContain('BULL');
    expect(labels).toContain('25');
    expect(labels).toContain('MISS');
    expect(labels.some((l) => l.startsWith('S'))).toBe(true);
  });

  it('follows the view, falls back to 20, and repeats for a seed', () => {
    const throwAt = (view: unknown, seed: string) => {
      const source = aimingThrower(seed);
      return Array.from({ length: 30 }, () =>
        source({ playerId: testId(1), turnIndex: 0, roundIndex: 0, dartIndex: 0, view })!.number,
      );
    };
    expect(throwAt({ targets: [3] }, 's').filter((n) => n === 3).length).toBeGreaterThan(5);
    expect(throwAt({}, 's').filter((n) => n === 20).length).toBeGreaterThan(5);
    expect(throwAt({ targets: [3] }, 's')).toEqual(throwAt({ targets: [3] }, 's'));
  });
});
