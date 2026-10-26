import { describe, expect, it } from 'vitest';
import { makePlayers, playScript, scoredDart, testId, turnCtx } from '../testing';
import { countdown, countdownOptions, type CountdownState } from './module';

const ALEX = testId(1);
const JO = testId(2);
const misses = (n: number) => Array.from({ length: n }, () => ['MISS', 'MISS', 'MISS']);

function play(visits: string[][], options: Record<string, unknown> = {}, players = ['Alex', 'Jo']) {
  return playScript(countdown, { description: 'rules test', players, options, visits });
}

function fresh(options: Record<string, unknown> = {}, names = ['Alex', 'Jo']): CountdownState {
  const parsed = countdownOptions.parse(options);
  return countdown.init({ players: makePlayers(names), options: parsed, rng: turnCtx(ALEX).rng });
}

describe('options', () => {
  it('defaults to 501, double out, no double in, 20 rounds', () => {
    expect(countdownOptions.parse({})).toEqual({ start: 501, doubleIn: false, doubleOut: true, maxRounds: 20 });
  });

  it('only offers 301, 501 and 701', () => {
    expect(countdownOptions.safeParse({ start: 401 }).success).toBe(false);
    expect(countdownOptions.parse({ start: 701 }).start).toBe(701);
  });
});

describe('how to play', () => {
  it('starts everyone on the same score', () => {
    const state = fresh({ start: 301 }, ['Alex', 'Jo', 'Sam']);
    expect(state.players.map((p) => p.remaining)).toEqual([301, 301, 301]);
    expect(countdown.nextPlayer(state, turnCtx(ALEX))).toBe(ALEX);
    expect(countdown.result(state)).toBeNull();
  });

  it('takes each dart off the score: trebles ×3, doubles ×2, 25 and the bull 50', () => {
    const run = play([['T20', 'D10', 'S5'], ['25', 'BULL', 'MISS']]);
    expect(run.result.state.players.map((p) => p.remaining)).toEqual([501 - 85, 501 - 75]);
  });

  it('alternates turns and counts rounds', () => {
    const run = play([['S1'], ['S1'], ['S1']]);
    expect(run.result.turns.map((t) => t.playerId)).toEqual([ALEX, JO, ALEX]);
    expect(run.result.state.round).toBe(2);
    expect(run.result.state.current).toBe(1);
  });

  it('ends the game the moment someone reaches exactly zero', () => {
    const run = play([
      ['T20', 'T20', 'T20'],
      ['S20', 'S20', 'S20'],
      ['T20', 'T20', 'T20'],
      ['T20', 'T20', 'S20'],
      ['T20', 'T19', 'D12'],
      ['T20', 'T20', 'T20'],
    ]);
    expect(run.result.finished).toBe(true);
    expect(run.result.turns).toHaveLength(5);
    expect(run.standings).toEqual([
      { player: 'Alex', rank: 1, score: 0 },
      { player: 'Jo', rank: 2, score: 301 },
    ]);
    const last = run.result.turns[4]!;
    expect(last.endTurn).toBe('game-rule');
    expect(last.effects).toEqual([
      { kind: 'checkout', playerId: ALEX, intensity: 3, data: { checkout: 141 } },
      { kind: 'win', playerId: ALEX, intensity: 3 },
    ]);
  });
});

describe('finishing', () => {
  const to40 = [['T20', 'T20', 'T20'], ['MISS'], ['T20', 'T20', 'T20'], ['MISS'], ['T20', 'T13', 'S2']];

  it('double out: a double finishes', () => {
    const run = play([...to40, ['MISS'], ['S20', 'D10']]);
    expect(run.standings?.[0]).toEqual({ player: 'Alex', rank: 1, score: 0 });
  });

  it('double out: the bull finishes from 50', () => {
    const run = play([['T20', 'T20', 'T20'], ['MISS'], ['T20', 'T20', 'T20'], ['MISS'], ['T17', 'D20', 'MISS'], ['MISS'], ['BULL']]);
    expect(run.result.finished).toBe(true);
    expect(run.result.state.winner).toBe(0);
  });

  it('single out: any dart reaching zero finishes', () => {
    const run = play([...to40, ['MISS'], ['S20', 'S20']], { doubleOut: false });
    expect(run.result.finished).toBe(true);
    expect(run.standings?.[1]).toEqual({ player: 'Jo', rank: 2, score: 501 });
  });
});

describe('bust', () => {
  const to40 = [['T20', 'T20', 'T20'], ['MISS'], ['T20', 'T20', 'T20'], ['MISS'], ['T20', 'T13', 'S2']];

  it('below zero: the turn ends and the score goes back to the turn start', () => {
    const run = play([...to40, ['MISS'], ['S20', 'T20', 'S20']]);
    const turn = run.result.turns[6]!;
    expect(turn.endTurn).toBe('bust');
    expect(turn.effects).toEqual([{ kind: 'bust', playerId: ALEX, data: { score: 40 } }]);
    expect(turn.darts.map((d) => d.scored)).toEqual([true, true, false]);
    const alex = run.result.state.players[0]!;
    expect(alex.remaining).toBe(40);
    expect(alex.scored).toBe(461);
    expect(alex.darts).toBe(11);
    expect(run.result.state.lastVisit).toMatchObject({ bust: true, points: 0 });
  });

  it('double out: leaving exactly 1 is a bust', () => {
    const run = play([...to40, ['MISS'], ['S19', 'S20']]);
    expect(run.result.turns[6]!.endTurn).toBe('bust');
    expect(run.result.state.players[0]!.remaining).toBe(40);
  });

  it('double out: reaching zero with a single is a bust', () => {
    const run = play([...to40, ['MISS'], ['S20', 'S20']]);
    expect(run.result.turns[6]!.endTurn).toBe('bust');
    expect(run.result.finished).toBe(false);
  });

  it('single out: below zero still busts, and exactly 1 is fine', () => {
    const run = play([...to40, ['MISS'], ['T20'], ['MISS'], ['S19', 'S20', 'MISS'], ['MISS'], ['S1']], { doubleOut: false });
    expect(run.result.turns[6]!.endTurn).toBe('bust');
    expect(run.result.turns[8]!.endTurn).toBeNull();
    expect(run.result.state.players[0]!.remaining).toBe(0);
    expect(run.result.finished).toBe(true);
  });

  it('ignores a stray dart the host sends after a bust', () => {
    let state = fresh({ start: 301 });
    state = countdown.onDart(state, scoredDart(ALEX, 'T20'), turnCtx(ALEX)).state;
    state = { ...state, players: state.players.map((p, i) => (i === 0 ? { ...p, remaining: 10 } : p)) };
    const bust = countdown.onDart(state, scoredDart(ALEX, 'S20', 1), turnCtx(ALEX));
    expect(bust.endTurn).toBe('bust');
    expect(countdown.onDart(bust.state, scoredDart(ALEX, 'D5', 2), turnCtx(ALEX))).toEqual({ state: bust.state });
  });
});

describe('double in', () => {
  it('counts nothing until a double, then the double and everything after it', () => {
    const run = play([['T20', 'D10', 'S5']], { doubleIn: true });
    const alex = run.result.state.players[0]!;
    expect(alex.remaining).toBe(501 - 25);
    expect(alex.opened).toBe(true);
    expect(run.result.state.lastVisit?.darts).toEqual([
      { label: 'T20', points: 0 },
      { label: 'D10', points: 20 },
      { label: 'S5', points: 5 },
    ]);
  });

  it('opens on the bull', () => {
    const run = play([['BULL', 'S1']], { doubleIn: true });
    expect(run.result.state.players[0]!.remaining).toBe(501 - 51);
  });

  it('shows who still needs a double to start', () => {
    const run = play([['T20', 'T20', 'T20']], { doubleIn: true });
    const view = run.result.view;
    expect(view.headline).toBe('Jo needs a double to start');
    expect(view.scoreboard[0]!.detail).toBe('not started');
    expect(view.finish).toBeNull();
    expect(view.targets).toEqual([20]);
    expect(run.result.state.players[0]!.remaining).toBe(501);
  });
});

describe('round limit', () => {
  it('ends after the last full round, lowest score first', () => {
    const run = play([['T20'], ['S20'], ...misses(18)], { maxRounds: 10 });
    expect(run.result.finished).toBe(true);
    expect(run.result.turns).toHaveLength(20);
    expect(run.result.state.round).toBe(10);
    expect(run.standings).toEqual([
      { player: 'Alex', rank: 1, score: 441 },
      { player: 'Jo', rank: 2, score: 481 },
    ]);
    expect(run.result.turns[19]!.effects).toEqual([{ kind: 'win', playerId: ALEX, intensity: 3 }]);
    expect(run.result.view.headline).toBe('Alex wins');
  });

  it('breaks a level score with the higher best turn', () => {
    const run = play([['S20', 'S20'], ['T20'], ['S20'], ...misses(17)], { maxRounds: 10 });
    expect(run.standings).toEqual([
      { player: 'Jo', rank: 1, score: 441 },
      { player: 'Alex', rank: 2, score: 441 },
    ]);
  });

  it('shares the place when both are level', () => {
    const run = play(misses(20), { maxRounds: 10 });
    expect(run.standings?.map((s) => s.rank)).toEqual([1, 1]);
    expect(run.result.view.headline).toBe('Alex and Jo share the win');
    expect(run.result.turns[19]!.effects.map((e) => e.kind)).toEqual(['win', 'win']);
  });

  it('works solo: one turn per round', () => {
    const run = play(misses(10), { maxRounds: 10 }, ['Alex']);
    expect(run.result.finished).toBe(true);
    expect(run.standings).toEqual([{ player: 'Alex', rank: 1, score: 501 }]);
  });
});

describe('big turns', () => {
  it.each([
    [['T20', 'T20', 'T20'], 3],
    [['T20', 'T20', 'S20'], 2],
    [['T20', 'S20', 'S20'], 1],
  ])('%j celebrates with intensity %i', (visit, intensity) => {
    const run = play([visit]);
    expect(run.result.turns[0]!.effects).toEqual([
      { kind: 'big-hit', playerId: ALEX, intensity, data: { points: run.result.state.players[0]!.bestVisit } },
    ]);
  });

  it('does not celebrate 99', () => {
    expect(play([['T20', 'T13', 'MISS']]).result.turns[0]!.effects).toEqual([]);
  });

  it('waits for the third dart', () => {
    let state = fresh();
    for (const [i, label] of ['T20', 'T20'].entries()) {
      const step = countdown.onDart(state, scoredDart(ALEX, label, i as 0 | 1), turnCtx(ALEX));
      expect(step.effects).toEqual([]);
      state = step.state;
    }
    expect(countdown.onDart(state, scoredDart(ALEX, 'MISS', 2), turnCtx(ALEX)).effects?.[0]).toMatchObject({ kind: 'big-hit', intensity: 1 });
  });
});

describe('turn handling', () => {
  it('a turn with no darts still passes play on and keeps the last visit', () => {
    let state = fresh();
    state = countdown.onDart(state, scoredDart(ALEX, 'S20'), turnCtx(ALEX)).state;
    state = countdown.onTurnEnd(state, turnCtx(ALEX)).state;
    const skipped = countdown.onTurnEnd(state, turnCtx(JO)).state;
    expect(skipped.current).toBe(0);
    expect(skipped.round).toBe(2);
    expect(skipped.lastVisit).toEqual(state.lastVisit);
    expect(skipped.players[1]!.visits).toBe(0);
  });

  it('after the finish: darts are ignored and play does not move on', () => {
    let state = fresh({ start: 301 });
    state = { ...state, players: state.players.map((p, i) => (i === 0 ? { ...p, remaining: 40 } : p)) };
    state = countdown.onDart(state, scoredDart(ALEX, 'D20'), turnCtx(ALEX)).state;
    expect(countdown.onDart(state, scoredDart(ALEX, 'S1', 1), turnCtx(ALEX))).toEqual({ state });
    const ended = countdown.onTurnEnd(state, turnCtx(ALEX));
    expect(ended.state.current).toBe(0);
    expect(ended.effects).toBeUndefined();
    expect(countdown.nextPlayer(ended.state, turnCtx(ALEX))).toBeNull();
  });

  it('rejects a dart from someone who is not in the game', () => {
    expect(() => countdown.onDart(fresh(), scoredDart(testId(9), 'S1'), turnCtx(testId(9)))).toThrow(RangeError);
  });
});

describe('view', () => {
  it('shows the current player, their score and the turn so far', () => {
    let state = fresh();
    expect(countdown.view(state).visit).toBeNull();
    state = countdown.onDart(state, scoredDart(ALEX, 'T20'), turnCtx(ALEX)).state;
    const view = countdown.view(state);
    expect(view.headline).toBe('Alex needs 441');
    expect(view.current).toBe(ALEX);
    expect(view.visit).toMatchObject({ playerId: ALEX, startRemaining: 501, points: 60 });
    expect(view.scoreboard.map((r) => [r.score, r.active, r.detail])).toEqual([
      [441, true, 'avg 180'],
      [501, false, 'avg 0'],
    ]);
    expect(view.players[0]).toEqual({ playerId: ALEX, remaining: 441, opened: true, darts: 1, average: 180, bestVisit: 0 });
  });

  it.each([
    [32, true, 'D16', 16],
    [50, true, 'BULL', 25],
    [41, true, null, 1],
    [57, true, null, 17],
    [61, true, null, 20],
    [7, false, 'S7', 7],
    [25, false, '25', 25],
    [50, false, 'BULL', 25],
    [45, false, null, 20],
  ])('on %i (double out %s) suggests %s and aims at %i', (remaining, doubleOut, finish, target) => {
    const state = fresh({ doubleOut });
    const at = { ...state, players: state.players.map((p) => ({ ...p, remaining })) };
    expect(countdown.view(at).finish).toBe(finish);
    expect(countdown.view(at).targets).toEqual([target]);
  });

  it('has no current player or targets once finished', () => {
    const view = play(misses(20), { maxRounds: 10 }).result.view;
    expect(view.current).toBeNull();
    expect(view.targets).toEqual([]);
    expect(view.scoreboard.every((r) => !r.active)).toBe(true);
    expect(view.visit).toMatchObject({ playerId: JO });
    expect(view.checkout).toBeNull();
  });
});

describe('checkout hint', () => {
  const at = (remaining: number, options: Record<string, unknown> = {}) => {
    const state = fresh(options);
    return { ...state, players: state.players.map((p) => ({ ...p, remaining })) };
  };

  it('suggests the chart route for a three-dart finish at the start of a visit', () => {
    expect(countdown.view(at(141)).checkout).toEqual(['T20', 'T19', 'D12']);
    expect(countdown.view(at(170)).checkout).toEqual(['T20', 'T20', 'BULL']);
  });

  it('has none above 170 or on a bogey number', () => {
    expect(countdown.view(at(171)).checkout).toBeNull();
    expect(countdown.view(at(169)).checkout).toBeNull();
    expect(countdown.view(at(501)).checkout).toBeNull();
  });

  it('follows the darts left in the visit and stays live after each dart', () => {
    let state = at(141);
    state = countdown.onDart(state, scoredDart(ALEX, 'T20'), turnCtx(ALEX)).state;
    expect(countdown.view(state).checkout).toEqual(['T19', 'D12']);
    state = countdown.onDart(state, scoredDart(ALEX, 'S5', 1), turnCtx(ALEX)).state;
    // 76 left with one dart: no single-dart finish.
    expect(countdown.view(state).checkout).toBeNull();
  });

  it('has none after a bust, whatever the score went back to', () => {
    const state = at(40);
    const bust = countdown.onDart(state, scoredDart(ALEX, 'T20'), turnCtx(ALEX));
    expect(bust.endTurn).toBe('bust');
    expect(countdown.view(bust.state).headline).toBe('Alex needs 40');
    expect(countdown.view(bust.state).checkout).toBeNull();
  });

  it('shows the shortest finish with single out', () => {
    expect(countdown.view(at(60, { doubleOut: false })).checkout).toEqual(['T20']);
    expect(countdown.view(at(180, { doubleOut: false })).checkout).toEqual(['T20', 'T20', 'T20']);
  });

  it('has none before a double-in player has started', () => {
    const state = at(40, { doubleIn: true });
    expect(countdown.view(state).checkout).toBeNull();
    expect(countdown.view({ ...state, players: state.players.map((p) => ({ ...p, opened: true })) }).checkout).toEqual(['D20']);
  });
});
