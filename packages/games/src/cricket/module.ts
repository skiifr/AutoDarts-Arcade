import type { GameEffect, GameModule, ScoredDart, Step, TurnCtx } from '@arcade/engine';
import type { PlayerRef, Standing } from '@arcade/event-schema';
import { z } from 'zod';
import { replaceAt, seatOf, seatsFrom, type Seat } from '../shared/seats';
import { rankStandings, winEffects, winnerHeadline } from '../shared/standings';
import type { BaseView } from '../shared/view';

/** The numbers in play, in the order the marks board lists them. 25 is the bull. */
export const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, 25] as const;
const MARKS_TO_CLOSE = 3;

/** Cricket. Rules for players are in `rules.md`. */
export const cricketOptions = z.object({
  /** Points go to the opponents who have not closed the number; lowest score wins. */
  cutThroat: z.boolean().default(false),
  /** After this many full rounds the best score wins. */
  maxRounds: z.literal([10, 15, 20, 30]).default(20),
});
export type CricketOptions = z.infer<typeof cricketOptions>;

export interface CricketPlayer extends Seat {
  /** Marks per target, in `CRICKET_TARGETS` order, 0–3. */
  marks: number[];
  points: number;
  darts: number;
  /** Marks that counted (closing or scoring), for marks-per-round. */
  marksScored: number;
}

export interface CricketState {
  options: CricketOptions;
  players: CricketPlayer[];
  current: number;
  round: number;
  winner: number | null;
  finished: boolean;
}

export interface CricketView extends BaseView {
  gameId: 'cricket';
  cutThroat: boolean;
  /** One row per target for the marks board. */
  board: {
    target: number;
    label: string;
    /** Marks per player, in turn order (0–3). */
    marks: number[];
    /** Closed by everyone: nobody can score on it any more. */
    dead: boolean;
  }[];
  players: { playerId: string; points: number; closed: number; marksPerRound: number }[];
}

const isClosed = (p: CricketPlayer, t: number) => p.marks[t]! >= MARKS_TO_CLOSE;
const closedCount = (p: CricketPlayer) => p.marks.filter((m) => m >= MARKS_TO_CLOSE).length;
const totalMarks = (p: CricketPlayer) => p.marks.reduce((sum, m) => sum + m, 0);

function init({ players, options }: { players: readonly PlayerRef[]; options: CricketOptions }): CricketState {
  return {
    options,
    players: seatsFrom(players).map((seat) => ({
      ...seat,
      marks: CRICKET_TARGETS.map(() => 0),
      points: 0,
      darts: 0,
      marksScored: 0,
    })),
    current: 0,
    round: 1,
    winner: null,
    finished: false,
  };
}

function onDart(state: CricketState, dart: ScoredDart): Step<CricketState> {
  if (state.finished) return { state };
  const seat = seatOf(state.players, dart.playerId);
  const thrower = state.players[seat]!;
  const t = CRICKET_TARGETS.indexOf(dart.segment.number as (typeof CRICKET_TARGETS)[number]);
  if (t < 0) {
    return { state: { ...state, players: replaceAt(state.players, seat, { ...thrower, darts: thrower.darts + 1 }) } };
  }

  const { cutThroat } = state.options;
  const hits = dart.segment.multiplier;
  const had = thrower.marks[t]!;
  const closing = Math.min(MARKS_TO_CLOSE - had, hits);
  // Extra marks score only while some opponent still has the number open.
  const open = state.players.some((p, i) => i !== seat && !isClosed(p, t));
  const scoring = open ? hits - closing : 0;
  const gained = scoring * dart.segment.number;

  const players = state.players.map((p, i) => {
    if (i === seat) {
      return {
        ...p,
        marks: replaceAt(p.marks, t, had + closing),
        points: cutThroat ? p.points : p.points + gained,
        darts: p.darts + 1,
        marksScored: p.marksScored + closing + scoring,
      };
    }
    return cutThroat && !isClosed(p, t) ? { ...p, points: p.points + gained } : p;
  });

  const effects: GameEffect[] = [];
  const counted = closing + scoring;
  if (counted > 0) {
    effects.push({
      kind: 'hit',
      playerId: thrower.playerId,
      intensity: Math.min(3, counted) as 1 | 2 | 3,
      data: { target: dart.segment.number, marks: closing, points: gained, closed: closing > 0 && had + closing === MARKS_TO_CLOSE },
    });
  }

  const me = players[seat]!;
  const others = players.filter((_, i) => i !== seat).map((p) => p.points);
  const notBehind = cutThroat ? me.points <= Math.min(...others) : me.points >= Math.max(...others);
  if (closedCount(me) === CRICKET_TARGETS.length && notBehind) {
    effects.push({ kind: 'win', playerId: me.playerId, intensity: 3 });
    return { state: { ...state, players, winner: seat, finished: true }, effects, endTurn: 'game-rule' };
  }
  return { state: { ...state, players }, effects };
}

function onTurnEnd(state: CricketState, ctx: TurnCtx): Step<CricketState> {
  if (state.finished) return { state };
  const seat = seatOf(state.players, ctx.playerId);
  const next = (seat + 1) % state.players.length;
  if (next > seat) return { state: { ...state, current: next } };
  if (state.round < state.options.maxRounds) return { state: { ...state, current: next, round: state.round + 1 } };
  const finished: CricketState = { ...state, current: next, finished: true };
  return { state: finished, effects: winEffects(result(finished)!) };
}

function nextPlayer(state: CricketState): string | null {
  return state.finished ? null : state.players[state.current]!.playerId;
}

/** The winner first, then by points (fewest in cut-throat), then by marks; a full tie is shared. */
function result(state: CricketState): Standing[] | null {
  if (!state.finished) return null;
  const better = state.options.cutThroat ? 1 : -1;
  const seats = state.players.map((p, seat) => ({ ...p, seat }));
  return rankStandings(
    seats,
    (a, b) =>
      Number(b.seat === state.winner) - Number(a.seat === state.winner) ||
      better * (a.points - b.points) ||
      totalMarks(b) - totalMarks(a),
    (p) => p.points,
  );
}

function view(state: CricketState): CricketView {
  const { players, finished } = state;
  const current = players[state.current]!;
  const targets = CRICKET_TARGETS.filter((_, t) => !isClosed(current, t));
  const scoreOn = CRICKET_TARGETS.filter((_, t) => players.some((p) => p !== current && !isClosed(p, t)));
  const rounds = (p: CricketPlayer) => Math.max(1, Math.ceil(p.darts / 3));
  return {
    gameId: 'cricket',
    headline: finished
      ? winnerHeadline(result(state)!, (id) => players[seatOf(players, id)]!.name)
      : `${current.name} to throw`,
    round: state.round,
    maxRounds: state.options.maxRounds,
    finished,
    current: finished ? null : current.playerId,
    targets: finished ? [] : targets.length > 0 ? [...targets] : scoreOn,
    scoreboard: players.map((p, seat) => ({
      playerId: p.playerId,
      name: p.name,
      colorIndex: p.colorIndex,
      score: p.points,
      detail: `${closedCount(p)}/${CRICKET_TARGETS.length} closed`,
      active: !finished && seat === state.current,
      out: false,
    })),
    cutThroat: state.options.cutThroat,
    board: CRICKET_TARGETS.map((target, t) => ({
      target,
      label: target === 25 ? 'BULL' : String(target),
      marks: players.map((p) => p.marks[t]!),
      dead: players.every((p) => isClosed(p, t)),
    })),
    players: players.map((p) => ({
      playerId: p.playerId,
      points: p.points,
      closed: closedCount(p),
      marksPerRound: Math.round((p.marksScored / rounds(p)) * 10) / 10,
    })),
  };
}

export const cricket: GameModule<CricketOptions, CricketState, CricketView> = {
  manifest: {
    id: 'cricket',
    version: '1.0.0',
    name: 'Cricket',
    players: { min: 2, max: 4 },
    category: 'classic',
    dartsPerTurn: 3,
  },
  options: cricketOptions,
  init,
  onDart,
  onTurnEnd,
  nextPlayer,
  result,
  view,
};
