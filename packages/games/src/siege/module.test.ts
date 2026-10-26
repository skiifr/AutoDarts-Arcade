import type { Rng } from '@arcade/engine';
import { MISS, makeSegment } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import {
  aimingThrower,
  createRng,
  makePlayers,
  runSession,
  scoredDart,
  testId,
  turnCtx,
  type DartSource,
} from '../testing';
import { RANGE, WALL, siege, siegeOptions, type Invader, type SiegeState, type SiegeView } from './module';

const [ALEX, JO, SAM] = [testId(1), testId(2), testId(3)];

function fresh(options: Record<string, unknown> = {}, names = ['Alex', 'Jo'], seed = 'siege'): SiegeState {
  return siege.init({ players: makePlayers(names), options: siegeOptions.parse(options), rng: createRng(seed) });
}

const inv = (id: string, number: number, strength = 1, distance = RANGE): Invader => ({
  id,
  number,
  strength,
  maxStrength: strength,
  distance,
});

/** Replaces each player's lane (and optionally wall). */
function withLanes(state: SiegeState, lanes: Invader[][], walls: number[] = []): SiegeState {
  return {
    ...state,
    players: state.players.map((p, i) => ({ ...p, invaders: lanes[i] ?? [], wall: walls[i] ?? p.wall })),
  };
}

const dart = (state: SiegeState, playerId: string, label: string) => siege.onDart(state, scoredDart(playerId, label), turnCtx(playerId));
const endTurn = (state: SiegeState, playerId: string, seed = 'next') => siege.onTurnEnd(state, turnCtx(playerId, seed));

/** Throws a single at the closest invader every dart. */
const sharpshooter: DartSource = ({ view }) => {
  const target = (view as SiegeView).targets[0];
  return target === undefined ? MISS : makeSegment(target, 1);
};

describe('options', () => {
  it('defaults to 10 rounds on normal', () => {
    expect(siegeOptions.parse({})).toEqual({ rounds: 10, difficulty: 'normal' });
    expect(siegeOptions.safeParse({ difficulty: 'nightmare' }).success).toBe(false);
    expect(siege.manifest.players).toEqual({ min: 2, max: 8 });
  });
});

describe('setup', () => {
  it('gives everyone a 10-brick wall and the same first wave, 3 steps out', () => {
    const state = fresh({}, ['Alex', 'Jo', 'Sam']);
    expect(state.players.map((p) => p.wall)).toEqual([WALL, WALL, WALL]);
    expect(state.wave.map((i) => i.id)).toEqual(['1.1', '1.2']);
    for (const p of state.players) expect(p.invaders).toEqual(state.wave);
    expect(state.wave.every((i) => i.distance === RANGE && i.number >= 1 && i.number <= 20)).toBe(true);
    expect(siege.nextPlayer(state, turnCtx(ALEX))).toBe(ALEX);
    expect(siege.result(state)).toBeNull();
  });

  it.each([
    ['easy', 2, 1],
    ['normal', 2, 2],
    ['hard', 3, 2],
  ] as const)('%s waves have %i invaders of strength up to %i, on distinct numbers', (difficulty, size, max) => {
    const strengths = new Set<number>();
    for (let s = 0; s < 40; s++) {
      const { wave } = fresh({ difficulty }, ['Alex', 'Jo'], `seed-${s}`);
      expect(wave).toHaveLength(size);
      expect(new Set(wave.map((i) => i.number)).size).toBe(size);
      wave.forEach((i) => strengths.add(i.strength));
    }
    expect([...strengths].sort()).toEqual(Array.from({ length: max }, (_, i) => i + 1));
  });
});

describe('your turn', () => {
  it('a single damages the closest invader carrying the number', () => {
    const state = withLanes(fresh(), [[inv('1.1', 7, 2, 1), inv('2.1', 7, 2, 2)]]);
    const step = dart(state, ALEX, 'S7');
    expect(step.state.players[0]!.invaders.map((i) => [i.id, i.strength])).toEqual([
      ['1.1', 1],
      ['2.1', 2],
    ]);
    expect(step.effects).toEqual([{ kind: 'hit', playerId: ALEX, intensity: 1, data: { damage: 1, destroyed: 0 } }]);
  });

  it('a double does 2 and a treble 3; extra damage is lost', () => {
    const state = withLanes(fresh(), [[inv('1.1', 7, 2), inv('1.2', 9, 1)]]);
    const double = dart(state, ALEX, 'D7');
    expect(double.state.players[0]!.invaders.map((i) => i.id)).toEqual(['1.2']);
    expect(double.state.players[0]!.destroyed).toBe(1);
    expect(double.effects?.[0]).toMatchObject({ kind: 'hit', intensity: 2, data: { damage: 2, destroyed: 1 } });
    const treble = dart(state, ALEX, 'T9');
    expect(treble.effects?.[0]).toMatchObject({ kind: 'hit', intensity: 1, data: { damage: 1, destroyed: 1 } });
  });

  it('the bull hits every invader: 1 for 25, 2 for the bull', () => {
    const lane = [inv('1.1', 7, 2), inv('1.2', 9, 1), inv('1.3', 3, 2)];
    const outer = dart(withLanes(fresh(), [lane]), ALEX, '25');
    expect(outer.state.players[0]!.invaders.map((i) => [i.id, i.strength])).toEqual([
      ['1.1', 1],
      ['1.3', 1],
    ]);
    expect(outer.effects?.[0]).toMatchObject({ kind: 'hit', intensity: 3, data: { damage: 3, destroyed: 1 } });
    const inner = dart(withLanes(fresh(), [lane]), ALEX, 'BULL');
    expect(inner.state.players[0]!.invaders).toEqual([]);
    expect(inner.effects).toEqual([{ kind: 'big-hit', playerId: ALEX, intensity: 3, data: { damage: 5, destroyed: 3 } }]);
    const two = dart(withLanes(fresh(), [lane.slice(0, 2)]), ALEX, 'BULL');
    expect(two.effects?.[0]).toMatchObject({ kind: 'big-hit', intensity: 2 });
  });

  it('any other dart does nothing, and only your own invaders count', () => {
    const state = withLanes(fresh(), [[inv('1.1', 7)], [inv('1.1', 8)]]);
    for (const label of ['S8', 'MISS']) {
      const step = dart(state, ALEX, label);
      expect(step.effects).toEqual([]);
      expect(step.state.players[0]!.invaders).toHaveLength(1);
      expect(step.state.players[0]!.darts).toBe(1);
    }
    expect(dart(withLanes(fresh(), [[]]), ALEX, 'BULL').effects).toEqual([]);
  });
});

describe('end of the round', () => {
  it('waits until everyone standing has thrown', () => {
    const step = endTurn(fresh(), ALEX);
    expect(step.state.current).toBe(1);
    expect(step.state.round).toBe(1);
    expect(step.state.players[0]!.invaders[0]!.distance).toBe(RANGE);
  });

  it('moves invaders forward, breaks bricks by remaining strength, then sends the next wave', () => {
    const state = withLanes(fresh(), [
      [inv('1.1', 7, 2, 1), inv('1.2', 9, 1, 2)],
      [inv('1.1', 7, 1, 1)],
    ]);
    const step = endTurn(state, JO);
    const [alex, jo] = step.state.players;
    expect(alex!.wall).toBe(WALL - 2);
    expect(jo!.wall).toBe(WALL - 1);
    expect(step.state.breaches).toEqual([
      { playerId: ALEX, bricks: 2 },
      { playerId: JO, bricks: 1 },
    ]);
    expect(step.state.round).toBe(2);
    expect(step.state.current).toBe(0);
    expect(step.state.wave.map((i) => i.id)).toEqual(['2.1', '2.2']);
    expect(alex!.invaders.map((i) => [i.id, i.distance])).toEqual([
      ['1.2', 1],
      ['2.1', RANGE],
      ['2.2', RANGE],
    ]);
    expect(jo!.invaders.map((i) => i.id)).toEqual(['2.1', '2.2']);
    expect(step.effects).toEqual([]);
  });

  it('knocks out a player whose wall falls, who then misses their turns', () => {
    const state = withLanes(fresh({}, ['Alex', 'Jo', 'Sam']), [[], [inv('1.1', 7, 2, 1)], []], [WALL, 2, WALL]);
    const step = endTurn(state, SAM);
    const jo = step.state.players[1]!;
    expect(jo).toMatchObject({ wall: 0, fellInRound: 1, invaders: [] });
    expect(step.effects).toEqual([{ kind: 'eliminated', playerId: JO, data: { round: 1 } }]);
    expect(step.state.finished).toBe(false);
    expect(endTurn(step.state, ALEX).state.current).toBe(2);
    const view = siege.view(step.state);
    expect(view.scoreboard[1]).toMatchObject({ score: 0, detail: 'fell in round 1', out: true });
    expect(view.lanes[1]).toMatchObject({ wall: 0, fallen: true });
  });

  it('starts the next round with the first player still standing', () => {
    let state = fresh({}, ['Alex', 'Jo', 'Sam']);
    state = { ...state, players: state.players.map((p, i) => (i === 0 ? { ...p, fellInRound: 1, invaders: [] } : p)) };
    expect(endTurn(state, SAM).state.current).toBe(1);
  });
});

describe('winning', () => {
  it('the last player standing wins at once', () => {
    const state = withLanes(fresh(), [[], [inv('1.1', 7, 2, 1)]], [WALL, 1]);
    const step = endTurn(state, JO);
    expect(step.state.finished).toBe(true);
    expect(step.effects).toEqual([
      { kind: 'eliminated', playerId: JO, data: { round: 1 } },
      { kind: 'win', playerId: ALEX, intensity: 3 },
    ]);
    expect(siege.result(step.state)).toEqual([
      { playerId: ALEX, rank: 1, score: WALL },
      { playerId: JO, rank: 2, score: 0 },
    ]);
    expect(siege.nextPlayer(step.state, turnCtx(ALEX))).toBeNull();
  });

  it('if every wall falls in the same round, more invaders destroyed ranks first', () => {
    const lanes = [[inv('1.1', 7, 2, 1)], [inv('1.1', 7, 2, 1)]];
    const state = withLanes(fresh(), lanes, [1, 1]);
    const ranked = { ...state, players: state.players.map((p, i) => ({ ...p, destroyed: i })) };
    expect(siege.result(endTurn(ranked, JO).state)).toEqual([
      { playerId: JO, rank: 1, score: 0 },
      { playerId: ALEX, rank: 2, score: 0 },
    ]);
    expect(siege.result(endTurn(state, JO).state)?.map((s) => s.rank)).toEqual([1, 1]);
  });

  it('after the last round the strongest wall wins, then more destroyed, then a shared place', () => {
    const last = { ...fresh({ rounds: 5 }, ['Alex', 'Jo', 'Sam']), round: 5 };
    const walls = withLanes(last, [[], [], []], [4, 7, 7]);
    const scored = { ...walls, players: walls.players.map((p, i) => ({ ...p, destroyed: [9, 3, 5][i]! })) };
    const step = endTurn(scored, SAM);
    expect(step.state.finished).toBe(true);
    expect(step.state.round).toBe(5);
    expect(step.state.wave).toEqual(last.wave);
    expect(siege.result(step.state)).toEqual([
      { playerId: SAM, rank: 1, score: 7 },
      { playerId: JO, rank: 2, score: 7 },
      { playerId: ALEX, rank: 3, score: 4 },
    ]);
    const tied = endTurn(withLanes(last, [[], [], []]), SAM);
    expect(tied.effects?.map((e) => e.kind)).toEqual(['win', 'win', 'win']);
    expect(siege.view(tied.state).headline).toBe('Alex and Jo and Sam share the win');
  });

  it('after the finish: darts are ignored and play does not move on', () => {
    const state = { ...fresh(), finished: true };
    expect(dart(state, ALEX, 'BULL')).toEqual({ state });
    expect(endTurn(state, ALEX)).toEqual({ state });
  });
});

describe('view', () => {
  it('shows the lanes and aims at the closest invaders', () => {
    const state = withLanes(fresh(), [[inv('1.1', 7, 2, 1), inv('1.2', 9), inv('2.1', 7)], []]);
    const view = siege.view(state);
    expect(view.headline).toBe('Alex defends · wall 10');
    expect(view.targets).toEqual([7, 9]);
    expect(view.current).toBe(ALEX);
    expect(view.lanes[0]!.invaders).toHaveLength(3);
    expect(view.scoreboard[0]).toMatchObject({ score: WALL, detail: '0 destroyed', active: true, out: false });
    expect(view).toMatchObject({ range: RANGE, maxWall: WALL, difficulty: 'normal', round: 1, maxRounds: 10 });
  });

  it('has no current player or targets once finished', () => {
    const view = siege.view({ ...fresh(), finished: true });
    expect(view.current).toBeNull();
    expect(view.targets).toEqual([]);
    expect(view.headline).toBe('Alex and Jo share the win');
  });
});

describe('determinism and the seeded Rng', () => {
  const play = (seed: string, darts: DartSource, options = {}) =>
    runSession(siege, { players: makePlayers(['Alex', 'Jo', 'Sam']), options, seed, darts, freeze: true, roundTrip: true });

  it('replays the same game from the same seed', () => {
    const a = play('abc', aimingThrower('t'));
    const b = play('abc', aimingThrower('t'));
    expect(b.turns).toEqual(a.turns);
    expect(b.state).toEqual(a.state);
    expect(a.finished).toBe(true);
  });

  it('a different seed sends different waves', () => {
    expect(play('abc', aimingThrower('t')).turns[0]!.view).not.toEqual(play('abd', aimingThrower('t')).turns[0]!.view);
  });

  it('waves depend only on the seed, not on how anyone throws', () => {
    const wavesByRound = (run: ReturnType<typeof play>) =>
      Object.fromEntries(run.turns.map((t) => [(t.view as SiegeView).round, (t.view as SiegeView).wave]));
    const sharp = wavesByRound(play('waves', sharpshooter, { difficulty: 'easy', rounds: 5 }));
    const blind = wavesByRound(play('waves', () => MISS, { difficulty: 'easy', rounds: 5 }));
    expect(Object.keys(sharp)).toEqual(['1', '2', '3', '4', '5']);
    expect(blind).toEqual(sharp);
  });

  it('draws from the Rng only when a wave arrives, two draws per invader', () => {
    let draws = 0;
    const base = createRng('count');
    const counting: Rng = {
      next: () => (draws++, base.next()),
      int: (min, max) => (draws++, base.int(min, max)),
    };
    const state = siege.init({ players: makePlayers(['Alex', 'Jo']), options: siegeOptions.parse({ difficulty: 'hard' }), rng: counting });
    expect(draws).toBe(6);
    const afterDart = siege.onDart(state, scoredDart(ALEX, 'BULL'), turnCtx(ALEX)).state;
    const afterAlex = siege.onTurnEnd(afterDart, { ...turnCtx(ALEX), rng: counting }).state;
    expect(draws).toBe(6);
    siege.onTurnEnd(afterAlex, { ...turnCtx(JO), rng: counting });
    expect(draws).toBe(12);
  });

  it('a sharp player outlasts a blind one', () => {
    const duel = runSession(siege, {
      players: makePlayers(['Alex', 'Jo']),
      seed: 'duel',
      darts: (r) => (r.playerId === ALEX ? sharpshooter(r) : MISS),
    });
    expect(duel.finished).toBe(true);
    expect(duel.standings?.[0]).toMatchObject({ playerId: ALEX, rank: 1 });
    expect(duel.state.players[1]!.fellInRound).not.toBeNull();
  });
});
