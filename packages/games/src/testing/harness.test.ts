import type { GameModule } from '@arcade/engine';
import type { Standing } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  aimedDart,
  aimingThrower,
  createRng,
  defaultNames,
  makePlayers,
  parseDart,
  parseVisits,
  runSession,
  testId,
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

describe('createRng', () => {
  it('repeats for a seed and differs between seeds', () => {
    const a = createRng('abc');
    const b = createRng('abc');
    const c = createRng('abd');
    const seq = (r: ReturnType<typeof createRng>) => Array.from({ length: 5 }, () => r.next());
    const first = seq(a);
    expect(seq(b)).toEqual(first);
    expect(seq(c)).not.toEqual(first);
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('draws integers across the whole inclusive range', () => {
    const rng = createRng('range');
    const seen = new Set(Array.from({ length: 500 }, () => rng.int(1, 6)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
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
