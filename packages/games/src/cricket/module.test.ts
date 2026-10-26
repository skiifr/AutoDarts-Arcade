import { describe, expect, it } from 'vitest';
import { makePlayers, playScript, scoredDart, testId, turnCtx } from '../testing';
import { CRICKET_TARGETS, cricket, cricketOptions, type CricketState } from './module';

const ALEX = testId(1);
const JO = testId(2);
const misses = (n: number) => Array.from({ length: n }, () => ['MISS', 'MISS', 'MISS']);
const marksOf = (state: CricketState, seat: number) =>
  Object.fromEntries(CRICKET_TARGETS.map((t, i) => [t, state.players[seat]!.marks[i]]));

function play(visits: string[][], options: Record<string, unknown> = {}, players = ['Alex', 'Jo']) {
  return playScript(cricket, { description: 'rules test', players, options, visits });
}

function fresh(options: Record<string, unknown> = {}, names = ['Alex', 'Jo']): CricketState {
  return cricket.init({ players: makePlayers(names), options: cricketOptions.parse(options), rng: turnCtx(ALEX).rng });
}

/** Alex closes everything in three visits while Jo misses. */
const ALEX_CLOSES_ALL = [['T20', 'T19', 'T18'], ['MISS'], ['T17', 'T16', 'T15'], ['MISS'], ['BULL', '25']];

describe('options', () => {
  it('defaults to standard scoring and 20 rounds', () => {
    expect(cricketOptions.parse({})).toEqual({ cutThroat: false, maxRounds: 20 });
    expect(cricket.manifest.players).toEqual({ min: 2, max: 4 });
  });
});

describe('the numbers', () => {
  it('ignores 1–14 and misses', () => {
    const run = play([['S14', 'T1', 'MISS']]);
    expect(run.result.turns[0]!.effects).toEqual([]);
    expect(run.result.state.players[0]!.marks).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(run.result.state.players[0]!.darts).toBe(3);
  });
});

describe('marks', () => {
  it('counts a single 1, a double 2 and a treble 3; the outer bull 1 and the bull 2', () => {
    const run = play([['S20', 'D19', 'T18'], ['25', 'BULL', 'MISS']]);
    expect(marksOf(run.result.state, 0)).toMatchObject({ 20: 1, 19: 2, 18: 3 });
    expect(marksOf(run.result.state, 1)).toMatchObject({ 25: 3 });
  });

  it('closes a number with three marks', () => {
    const run = play([['T20']]);
    expect(run.result.turns[0]!.effects).toEqual([
      { kind: 'hit', playerId: ALEX, intensity: 3, data: { target: 20, marks: 3, points: 0, closed: true } },
    ]);
  });
});

describe('points', () => {
  it('scores extra marks on a closed number while an opponent has it open', () => {
    const run = play([['T20', 'S20', 'D20']]);
    expect(run.result.state.players[0]!.points).toBe(60);
    expect(run.result.turns[0]!.effects[2]).toEqual({
      kind: 'hit',
      playerId: ALEX,
      intensity: 2,
      data: { target: 20, marks: 0, points: 40, closed: false },
    });
  });

  it('lets one dart close and score', () => {
    const run = play([['D20', 'T20']]);
    expect(run.result.state.players[0]!.points).toBe(40);
    expect(run.result.turns[0]!.effects[1]!.data).toEqual({ target: 20, marks: 1, points: 40, closed: true });
  });

  it('scores 25 a mark on the bull', () => {
    const run = play([['BULL', 'BULL']]);
    expect(run.result.state.players[0]!.points).toBe(25);
  });

  it('scores nothing on a dead number', () => {
    const run = play([['T20'], ['T20'], ['S20']]);
    expect(run.result.state.players.map((p) => p.points)).toEqual([0, 0]);
    expect(run.result.turns[2]!.effects).toEqual([]);
    expect(run.result.view.board[0]!.dead).toBe(true);
  });

  it('keeps scoring while any one of several opponents is open', () => {
    const run = play([['T20'], ['T20'], ['MISS'], ['S20'], ['MISS'], ['T20'], ['S20']], {}, ['Alex', 'Jo', 'Sam']);
    const points = run.result.state.players.map((p) => p.points);
    expect(points).toEqual([20, 0, 0]);
  });
});

describe('winning', () => {
  it('closing all seven while level on points wins at once', () => {
    const run = play(ALEX_CLOSES_ALL);
    expect(run.result.finished).toBe(true);
    const last = run.result.turns[4]!;
    expect(last.endTurn).toBe('game-rule');
    expect(last.darts).toHaveLength(2);
    expect(last.effects.at(-1)).toEqual({ kind: 'win', playerId: ALEX, intensity: 3 });
    expect(run.standings).toEqual([
      { player: 'Alex', rank: 1, score: 0 },
      { player: 'Jo', rank: 2, score: 0 },
    ]);
    expect(run.result.view.headline).toBe('Alex wins');
  });

  it('closing all seven while behind is not enough; catching up wins', () => {
    const run = play([['T20', 'T19', 'T18'], ['T17', 'T17'], ['T17', 'T16', 'T15'], ['MISS'], ['BULL', '25', 'T19']]);
    const last = run.result.turns[4]!;
    expect(last.effects.map((e) => e.kind)).toEqual(['hit', 'hit', 'hit', 'win']);
    expect(run.standings).toEqual([
      { player: 'Alex', rank: 1, score: 57 },
      { player: 'Jo', rank: 2, score: 51 },
    ]);
  });
});

describe('cut-throat', () => {
  it('gives extra marks to opponents who are open, and the lowest score wins', () => {
    const run = play(
      [['T20', 'S20', 'MISS'], ['T19', 'T19'], ['T19', 'T18', 'T17'], ['MISS'], ['T16', 'T15', 'BULL'], ['MISS'], ['25', 'S20', 'S18']],
      { cutThroat: true },
    );
    expect(run.result.turns[0]!.effects[1]!.data).toMatchObject({ points: 20 });
    const last = run.result.turns[6]!;
    expect(last.effects.map((e) => e.kind)).toEqual(['hit', 'hit', 'hit', 'win']);
    expect(run.standings).toEqual([
      { player: 'Alex', rank: 1, score: 57 },
      { player: 'Jo', rank: 2, score: 58 },
    ]);
  });

  it('wins when everything is closed and nobody has fewer points', () => {
    const run = play(ALEX_CLOSES_ALL, { cutThroat: true });
    expect(run.result.finished).toBe(true);
  });
});

describe('round limit', () => {
  it('ends after the last full round, best score first', () => {
    const run = play([['T20', 'S20'], ...misses(19)], { maxRounds: 10 });
    expect(run.result.finished).toBe(true);
    expect(run.result.turns).toHaveLength(20);
    expect(run.standings).toEqual([
      { player: 'Alex', rank: 1, score: 20 },
      { player: 'Jo', rank: 2, score: 0 },
    ]);
    expect(run.result.turns[19]!.effects).toEqual([{ kind: 'win', playerId: ALEX, intensity: 3 }]);
  });

  it('breaks level points with more marks, then shares the place', () => {
    const marks = play([['S20'], ['D20'], ...misses(18)], { maxRounds: 10 });
    expect(marks.standings?.map((s) => [s.player, s.rank])).toEqual([
      ['Jo', 1],
      ['Alex', 2],
    ]);
    const level = play(misses(20), { maxRounds: 10 });
    expect(level.standings?.map((s) => s.rank)).toEqual([1, 1]);
  });

  it('in cut-throat the lowest score wins', () => {
    const run = play([['T20', 'S20'], ...misses(19)], { maxRounds: 10, cutThroat: true });
    expect(run.standings).toEqual([
      { player: 'Alex', rank: 1, score: 0 },
      { player: 'Jo', rank: 2, score: 20 },
    ]);
  });
});

describe('turn handling', () => {
  it('reports no result until the game is over', () => {
    expect(cricket.result(fresh())).toBeNull();
    expect(cricket.nextPlayer(fresh(), turnCtx(ALEX))).toBe(ALEX);
  });

  it('after the win: darts are ignored and play does not move on', () => {
    const { state } = play(ALEX_CLOSES_ALL).result;
    expect(cricket.onDart(state, scoredDart(JO, 'T20'), turnCtx(JO))).toEqual({ state });
    expect(cricket.onTurnEnd(state, turnCtx(ALEX))).toEqual({ state });
    expect(cricket.nextPlayer(state, turnCtx(ALEX))).toBeNull();
  });
});

describe('view', () => {
  it('lists the marks board and what to aim at', () => {
    const run = play([['T20', 'T19', 'T18']]);
    const view = run.result.view;
    expect(view.board.map((r) => r.label)).toEqual(['20', '19', '18', '17', '16', '15', 'BULL']);
    expect(view.board[0]).toEqual({ target: 20, label: '20', marks: [3, 0], dead: false });
    expect(view.current).toBe(JO);
    expect(view.headline).toBe('Jo to throw');
    expect(view.targets).toEqual([20, 19, 18, 17, 16, 15, 25]);
    expect(view.scoreboard[0]).toMatchObject({ score: 0, detail: '3/7 closed', active: false });
    expect(view.players[0]).toEqual({ playerId: ALEX, points: 0, closed: 3, marksPerRound: 9 });
    expect(view.players[1]!.marksPerRound).toBe(0);
  });

  it('points a player who has closed everything at the numbers they can score on', () => {
    const state = fresh();
    const closed = {
      ...state,
      players: state.players.map((p, i) => ({ ...p, marks: i === 0 ? [3, 3, 3, 3, 3, 3, 3] : [3, 0, 0, 0, 0, 0, 3] })),
    };
    expect(cricket.view(closed).targets).toEqual([19, 18, 17, 16, 15]);
  });

  it('aims at nothing once finished', () => {
    const view = play(ALEX_CLOSES_ALL).result.view;
    expect(view.targets).toEqual([]);
    expect(view.current).toBeNull();
  });
});
