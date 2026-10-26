import type { GameEffect, GameModule, ScoredDart, Step, TurnCtx } from '@arcade/engine';
import type { PlayerRef, Standing } from '@arcade/event-schema';
import { z } from 'zod';
import { replaceAt, seatOf, seatsFrom, type Seat } from '../shared/seats';
import { rankStandings, winEffects, winnerHeadline } from '../shared/standings';
import type { BaseView } from '../shared/view';
import { checkoutHint } from './checkout';

/** Countdown: classic x01. Rules for players are in `rules.md`. */
export const countdownOptions = z.object({
  /** Everyone starts here and races to exactly zero. */
  start: z.literal([301, 501, 701]).default(501),
  /** Darts only start to count after a double (the bull counts as a double). */
  doubleIn: z.boolean().default(false),
  /** The finishing dart must be a double (or the bull). */
  doubleOut: z.boolean().default(true),
  /** After this many full rounds the lowest score wins. */
  maxRounds: z.literal([10, 15, 20, 30, 50]).default(20),
});
export type CountdownOptions = z.infer<typeof countdownOptions>;

export interface CountdownPlayer extends Seat {
  remaining: number;
  /** False until a double-in player hits their opening double. */
  opened: boolean;
  darts: number;
  /** Points that counted (a bust gives its visit back). */
  scored: number;
  visits: number;
  bestVisit: number;
}

export interface CountdownVisit {
  seat: number;
  startRemaining: number;
  startOpened: boolean;
  /** Darts so far, with the points each one counted. */
  darts: { label: string; points: number }[];
  points: number;
  bust: boolean;
}

export interface CountdownState {
  options: CountdownOptions;
  players: CountdownPlayer[];
  /** Seat throwing now (or next). */
  current: number;
  round: number;
  visit: CountdownVisit | null;
  lastVisit: CountdownVisit | null;
  /** Seat that checked out, if anyone did. */
  winner: number | null;
  finished: boolean;
}

export interface CountdownView extends BaseView {
  gameId: 'countdown';
  start: number;
  doubleIn: boolean;
  doubleOut: boolean;
  players: {
    playerId: string;
    remaining: number;
    opened: boolean;
    darts: number;
    /** Three-dart average, one decimal. */
    average: number;
    bestVisit: number;
  }[];
  /** The visit in progress (or the last one, between turns). */
  visit: (CountdownVisit & { playerId: string }) | null;
  /** A one-dart finish for the current player, e.g. "D16" or "BULL". */
  finish: string | null;
  /**
   * The suggested finish within the darts left this visit, e.g. ["T20", "T19", "D12"];
   * the shortest finish with single out. Null when there is none (above 170, a bogey number,
   * not started with double in, darts used up or bust) and once the game is over.
   */
  checkout: string[] | null;
}

function startVisit(seat: number, player: CountdownPlayer): CountdownVisit {
  return { seat, startRemaining: player.remaining, startOpened: player.opened, darts: [], points: 0, bust: false };
}

function bigHit(points: number): 1 | 2 | 3 {
  if (points >= 180) return 3;
  return points >= 140 ? 2 : 1;
}

function init({ players, options }: { players: readonly PlayerRef[]; options: CountdownOptions }): CountdownState {
  return {
    options,
    players: seatsFrom(players).map((seat) => ({
      ...seat,
      remaining: options.start,
      opened: !options.doubleIn,
      darts: 0,
      scored: 0,
      visits: 0,
      bestVisit: 0,
    })),
    current: 0,
    round: 1,
    visit: null,
    lastVisit: null,
    winner: null,
    finished: false,
  };
}

function onDart(state: CountdownState, dart: ScoredDart): Step<CountdownState> {
  if (state.finished) return { state };
  const seat = seatOf(state.players, dart.playerId);
  const player = state.players[seat]!;
  const visit = state.visit ?? startVisit(seat, player);
  // The host stops scoring after a bust; a stray dart changes nothing.
  if (visit.bust) return { state };

  const isDouble = dart.segment.multiplier === 2;
  const opened = player.opened || isDouble;
  const counted = opened ? dart.points : 0;
  const remaining = player.remaining - counted;
  const darts = [...visit.darts, { label: dart.segment.label, points: counted }];
  const { doubleOut } = state.options;

  if (remaining < 0 || (doubleOut && (remaining === 1 || (remaining === 0 && !isDouble)))) {
    const players = replaceAt(state.players, seat, {
      ...player,
      remaining: visit.startRemaining,
      opened: visit.startOpened,
      darts: player.darts + 1,
      scored: player.scored - visit.points,
    });
    return {
      state: { ...state, players, visit: { ...visit, darts, points: 0, bust: true } },
      effects: [{ kind: 'bust', playerId: player.playerId, data: { score: visit.startRemaining } }],
      endTurn: 'bust',
    };
  }

  const nextVisit = { ...visit, darts, points: visit.points + counted };
  const players = replaceAt(state.players, seat, {
    ...player,
    remaining,
    opened,
    darts: player.darts + 1,
    scored: player.scored + counted,
  });

  if (remaining === 0) {
    return {
      state: { ...state, players, visit: nextVisit, winner: seat, finished: true },
      effects: [
        { kind: 'checkout', playerId: player.playerId, intensity: 3, data: { checkout: visit.startRemaining } },
        { kind: 'win', playerId: player.playerId, intensity: 3 },
      ],
      endTurn: 'game-rule',
    };
  }

  const effects: GameEffect[] =
    darts.length === 3 && nextVisit.points >= 100
      ? [{ kind: 'big-hit', playerId: player.playerId, intensity: bigHit(nextVisit.points), data: { points: nextVisit.points } }]
      : [];
  return { state: { ...state, players, visit: nextVisit }, effects };
}

function onTurnEnd(state: CountdownState, ctx: TurnCtx): Step<CountdownState> {
  const seat = seatOf(state.players, ctx.playerId);
  const { visit } = state;
  let players = state.players;
  if (visit !== null) {
    const player = players[visit.seat]!;
    players = replaceAt(players, visit.seat, {
      ...player,
      visits: player.visits + 1,
      bestVisit: Math.max(player.bestVisit, visit.points),
    });
  }
  const ended: CountdownState = { ...state, players, visit: null, lastVisit: visit ?? state.lastVisit };
  if (state.finished) return { state: ended };

  const next = (seat + 1) % players.length;
  if (next > seat) return { state: { ...ended, current: next } };
  // A full round is over: everyone has had the same number of visits.
  if (state.round < state.options.maxRounds) return { state: { ...ended, current: next, round: state.round + 1 } };
  const finished: CountdownState = { ...ended, current: next, finished: true };
  return { state: finished, effects: winEffects(result(finished)!) };
}

function nextPlayer(state: CountdownState): string | null {
  return state.finished ? null : state.players[state.current]!.playerId;
}

/** Lowest remaining first; a tie goes to the higher best visit, then is shared. */
function result(state: CountdownState): Standing[] | null {
  if (!state.finished) return null;
  return rankStandings(
    state.players,
    (a, b) => a.remaining - b.remaining || b.bestVisit - a.bestVisit,
    (p) => p.remaining,
  );
}

/** A one-dart finish, if the score allows one. */
function oneDartFinish(remaining: number, doubleOut: boolean): { label: string; number: number } | null {
  if (remaining === 50) return { label: 'BULL', number: 25 };
  if (doubleOut) return remaining <= 40 && remaining % 2 === 0 ? { label: `D${remaining / 2}`, number: remaining / 2 } : null;
  if (remaining === 25) return { label: '25', number: 25 };
  return remaining <= 20 ? { label: `S${remaining}`, number: remaining } : null;
}

/** Where to aim without a one-dart finish: set up a double (leave 40, or make an odd score even). */
function setUp(player: CountdownPlayer, doubleOut: boolean): number {
  if (!player.opened || !doubleOut || player.remaining > 60) return 20;
  return player.remaining > 40 ? player.remaining - 40 : 1;
}

function view(state: CountdownState): CountdownView {
  const { options, players, finished } = state;
  const current = players[state.current]!;
  const finish = !finished && current.opened ? oneDartFinish(current.remaining, options.doubleOut) : null;
  let headline: string;
  if (finished) {
    headline = winnerHeadline(result(state)!, (id) => players[seatOf(players, id)]!.name);
  } else if (current.opened) {
    headline = `${current.name} needs ${current.remaining}`;
  } else {
    headline = `${current.name} needs a double to start`;
  }
  const visit = state.visit ?? state.lastVisit;
  // A visit in progress always belongs to the current player; a bust leaves no darts.
  const dartsLeft = state.visit === null ? 3 : state.visit.bust ? 0 : 3 - state.visit.darts.length;
  return {
    gameId: 'countdown',
    headline,
    round: state.round,
    maxRounds: options.maxRounds,
    finished,
    current: finished ? null : current.playerId,
    targets: finished ? [] : [finish ? finish.number : setUp(current, options.doubleOut)],
    scoreboard: players.map((p, seat) => ({
      playerId: p.playerId,
      name: p.name,
      colorIndex: p.colorIndex,
      score: p.remaining,
      detail: p.opened ? `avg ${average(p)}` : 'not started',
      active: !finished && seat === state.current,
      out: false,
    })),
    start: options.start,
    doubleIn: options.doubleIn,
    doubleOut: options.doubleOut,
    players: players.map((p) => ({
      playerId: p.playerId,
      remaining: p.remaining,
      opened: p.opened,
      darts: p.darts,
      average: average(p),
      bestVisit: p.bestVisit,
    })),
    visit: visit ? { ...visit, playerId: players[visit.seat]!.playerId } : null,
    finish: finish?.label ?? null,
    checkout: finished || !current.opened ? null : checkoutHint(current.remaining, { doubleOut: options.doubleOut, dartsLeft }),
  };
}

function average(p: CountdownPlayer): number {
  return p.darts > 0 ? Math.round((p.scored / p.darts) * 30) / 10 : 0;
}

export const countdown: GameModule<CountdownOptions, CountdownState, CountdownView> = {
  manifest: {
    id: 'countdown',
    version: '1.0.0',
    name: 'Countdown',
    players: { min: 1, max: 8 },
    category: 'classic',
    dartsPerTurn: 3,
  },
  options: countdownOptions,
  init,
  onDart,
  onTurnEnd,
  nextPlayer,
  result,
  view,
};
