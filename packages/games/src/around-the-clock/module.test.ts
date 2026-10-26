import { describe, expect, it } from 'vitest';
import { makePlayers, playScript, scoredDart, testId, turnCtx } from '../testing';
import { aroundTheClock, aroundTheClockOptions, type AroundTheClockState } from './module';

const ALEX = testId(1);
const JO = testId(2);
const misses = (n: number) => Array.from({ length: n }, () => ['MISS', 'MISS', 'MISS']);

/** Singles from `from` to `to`, three to a visit. */
function clock(from: number, to: number): string[][] {
  const labels = Array.from({ length: to - from + 1 }, (_, i) => `S${from + i}`);
  return Array.from({ length: Math.ceil(labels.length / 3) }, (_, i) => labels.slice(i * 3, i * 3 + 3));
}

/** Alex's visits with a missed visit for Jo after each one. */
const withJoMissing = (visits: string[][]) => visits.flatMap((v) => [v, ['MISS']]);

function play(visits: string[][], options: Record<string, unknown> = {}, players = ['Alex']) {
  return playScript(aroundTheClock, { description: 'rules test', players, options, visits });
}

function fresh(options: Record<string, unknown> = {}, names = ['Alex', 'Jo']): AroundTheClockState {
  const parsed = aroundTheClockOptions.parse(options);
  return aroundTheClock.init({ players: makePlayers(names), options: parsed, rng: turnCtx(ALEX).rng });
}

describe('options', () => {
  it('defaults to finishing on the bull, no skipping, 20 rounds', () => {
    expect(aroundTheClockOptions.parse({})).toEqual({ finishOnBull: true, skipAhead: false, maxRounds: 20 });
  });
});

describe('how to play', () => {
  it('starts everyone on 1', () => {
    const state = fresh();
    expect(state.players.map((p) => p.progress)).toEqual([0, 0]);
    expect(aroundTheClock.view(state).targets).toEqual([1]);
    expect(aroundTheClock.result(state)).toBeNull();
  });

  it('moves on one number per hit, whatever the ring', () => {
    const run = play([['S1', 'D2', 'T3']]);
    expect(run.result.state.players[0]!.progress).toBe(3);
    expect(run.result.turns[0]!.effects[0]).toEqual({
      kind: 'hit',
      playerId: ALEX,
      intensity: 1,
      data: { target: 1, next: 2 },
    });
  });

  it('ignores every number except the current one', () => {
    const run = play([['S2', 'T20', 'BULL']]);
    expect(run.result.state.players[0]).toMatchObject({ progress: 0, darts: 3, hits: 0 });
    expect(run.result.turns[0]!.effects).toEqual([]);
  });

  it('finishes on the bull after 20, and the first to finish wins at once', () => {
    const run = play([...withJoMissing(clock(1, 18)), ['S19', 'S20', '25'], ['T20']], {}, ['Alex', 'Jo']);
    expect(run.result.finished).toBe(true);
    const last = run.result.turns.at(-1)!;
    expect(last.endTurn).toBe('game-rule');
    expect(last.effects.at(-1)).toEqual({ kind: 'win', playerId: ALEX, intensity: 3 });
    expect(run.standings).toEqual([
      { player: 'Alex', rank: 1, score: 21 },
      { player: 'Jo', rank: 2, score: 0 },
    ]);
  });

  it('accepts the inner bull too', () => {
    const run = play([...clock(1, 20), ['BULL']]);
    expect(run.result.finished).toBe(true);
    expect(run.result.view.headline).toBe('Alex wins');
  });
});

describe('options in play', () => {
  it('without the bull, hitting 20 finishes', () => {
    const run = play(clock(1, 20), { finishOnBull: false });
    expect(run.result.state.sequence).toHaveLength(20);
    expect(run.result.finished).toBe(true);
    expect(run.standings).toEqual([{ player: 'Alex', rank: 1, score: 20 }]);
  });

  it('skip ahead: a double moves on two and a treble three', () => {
    const run = play([['D1', 'T3', 'S6']], { skipAhead: true });
    expect(run.result.state.players[0]!.progress).toBe(6);
    expect(run.result.turns[0]!.effects.map((e) => e.intensity)).toEqual([2, 3, 1]);
  });

  it('skip ahead never jumps the bull', () => {
    const state = fresh({ skipAhead: true });
    const at19 = { ...state, players: state.players.map((p) => ({ ...p, progress: 18 })) };
    const step = aroundTheClock.onDart(at19, scoredDart(ALEX, 'T19'), turnCtx(ALEX));
    expect(step.state.players[0]!.progress).toBe(20);
    expect(step.state.finished).toBe(false);
    expect(step.effects?.[0]).toMatchObject({ intensity: 2, data: { target: 19, next: 25 } });
    const done = aroundTheClock.onDart(step.state, scoredDart(ALEX, 'BULL', 1), turnCtx(ALEX));
    expect(done.state.finished).toBe(true);
    expect(done.state.players[0]!.progress).toBe(21);
  });

  it('skip ahead without the bull: a skip past 20 finishes', () => {
    const state = fresh({ skipAhead: true, finishOnBull: false });
    const at19 = { ...state, players: state.players.map((p) => ({ ...p, progress: 18 })) };
    const step = aroundTheClock.onDart(at19, scoredDart(ALEX, 'T19'), turnCtx(ALEX));
    expect(step.endTurn).toBe('game-rule');
    expect(step.effects?.[0]).toMatchObject({ data: { target: 19, next: null } });
  });
});

describe('round limit', () => {
  it('ends after the last full round, furthest first, level players sharing', () => {
    const three = play(
      [['S1', 'S2'], ['S1'], ['S1'], ...misses(27)],
      { maxRounds: 10 },
      ['Alex', 'Jo', 'Sam'],
    );
    expect(three.result.finished).toBe(true);
    expect(three.result.turns).toHaveLength(30);
    expect(three.standings).toEqual([
      { player: 'Alex', rank: 1, score: 2 },
      { player: 'Jo', rank: 2, score: 1 },
      { player: 'Sam', rank: 2, score: 1 },
    ]);
    expect(three.result.turns.at(-1)!.effects).toEqual([{ kind: 'win', playerId: ALEX, intensity: 3 }]);
  });
});

describe('turn handling', () => {
  it('passes play round the table', () => {
    const run = play([['S1'], ['S1'], ['S2']], {}, ['Alex', 'Jo']);
    expect(run.result.turns.map((t) => t.playerId)).toEqual([ALEX, JO, ALEX]);
    expect(run.result.state.round).toBe(2);
  });

  it('after the finish: darts are ignored and play does not move on', () => {
    const { state } = play([...clock(1, 20), ['25']]).result;
    expect(aroundTheClock.onDart(state, scoredDart(ALEX, 'S1'), turnCtx(ALEX))).toEqual({ state });
    expect(aroundTheClock.onTurnEnd(state, turnCtx(ALEX))).toEqual({ state });
    expect(aroundTheClock.nextPlayer(state, turnCtx(ALEX))).toBeNull();
  });
});

describe('view', () => {
  it('shows each player’s next number and hit rate', () => {
    const run = play([['S1', 'MISS', 'S2'], ['MISS']], {}, ['Alex', 'Jo']);
    const view = run.result.view;
    expect(view.headline).toBe('Alex: aim for 3');
    expect(view.targets).toEqual([3]);
    expect(view.scoreboard.map((r) => [r.score, r.detail, r.active])).toEqual([
      [2, 'next 3', true],
      [0, 'next 1', false],
    ]);
    expect(view.players[0]).toEqual({ playerId: ALEX, progress: 2, target: '3', darts: 3, hitRate: 67 });
    expect(aroundTheClock.view(fresh()).players[0]!.hitRate).toBe(0);
  });

  it('calls the last target BULL and a finished clock Done', () => {
    const atBull = play(clock(1, 20)).result.view;
    expect(atBull.headline).toBe('Alex: aim for BULL');
    expect(atBull.targets).toEqual([25]);
    const done = play([...clock(1, 20), ['25']]).result.view;
    expect(done.players[0]!.target).toBe('Done');
    expect(done.targets).toEqual([]);
    expect(done.current).toBeNull();
  });
});
