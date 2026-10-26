import type { GameModule, ScoredDart, Step, TurnCtx } from '@arcade/engine';
import type { PlayerRef, Standing } from '@arcade/event-schema';
import { z } from 'zod';
import { replaceAt, seatOf, seatsFrom, type Seat } from '../shared/seats';
import { rankStandings, winEffects, winnerHeadline } from '../shared/standings';
import type { BaseView } from '../shared/view';

const BULL = 25;

/** Around the Clock. Rules for players are in `rules.md`. */
export const aroundTheClockOptions = z.object({
  /** After 20, hit the bull (either ring) to finish. */
  finishOnBull: z.boolean().default(true),
  /** A double moves you on two numbers and a treble three (never past the bull). */
  skipAhead: z.boolean().default(false),
  /** After this many full rounds the furthest player wins. */
  maxRounds: z.literal([10, 15, 20, 30]).default(20),
});
export type AroundTheClockOptions = z.infer<typeof aroundTheClockOptions>;

export interface AroundTheClockPlayer extends Seat {
  /** Targets completed; the next target is `sequence[progress]`. */
  progress: number;
  darts: number;
  hits: number;
}

export interface AroundTheClockState {
  options: AroundTheClockOptions;
  /** The targets in order: 1–20, then the bull if it is on. */
  sequence: number[];
  players: AroundTheClockPlayer[];
  current: number;
  round: number;
  winner: number | null;
  finished: boolean;
}

export interface AroundTheClockView extends BaseView {
  gameId: 'around-the-clock';
  sequence: number[];
  players: {
    playerId: string;
    progress: number;
    /** "7", "BULL", or "Done". */
    target: string;
    darts: number;
    /** Hits per dart, as a whole percentage. */
    hitRate: number;
  }[];
}

const label = (target: number | undefined) => (target === undefined ? 'Done' : target === BULL ? 'BULL' : String(target));

function init({ players, options }: { players: readonly PlayerRef[]; options: AroundTheClockOptions }): AroundTheClockState {
  const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
  return {
    options,
    sequence: options.finishOnBull ? [...numbers, BULL] : numbers,
    players: seatsFrom(players).map((seat) => ({ ...seat, progress: 0, darts: 0, hits: 0 })),
    current: 0,
    round: 1,
    winner: null,
    finished: false,
  };
}

function onDart(state: AroundTheClockState, dart: ScoredDart): Step<AroundTheClockState> {
  if (state.finished) return { state };
  const seat = seatOf(state.players, dart.playerId);
  const player = state.players[seat]!;
  const target = state.sequence[player.progress]!;
  if (dart.segment.number !== target) {
    return { state: { ...state, players: replaceAt(state.players, seat, { ...player, darts: player.darts + 1 }) } };
  }

  const total = state.sequence.length;
  const steps = state.options.skipAhead ? dart.segment.multiplier : 1;
  // Skipping ahead can carry you to the bull, never past it.
  const limit = target !== BULL && state.options.finishOnBull ? total - 1 : total;
  const progress = Math.min(player.progress + steps, limit);
  const players = replaceAt(state.players, seat, { ...player, progress, darts: player.darts + 1, hits: player.hits + 1 });
  const hit = {
    kind: 'hit' as const,
    playerId: player.playerId,
    intensity: Math.min(3, progress - player.progress) as 1 | 2 | 3,
    data: { target, next: state.sequence[progress] ?? null },
  };
  if (progress < total) return { state: { ...state, players }, effects: [hit] };
  return {
    state: { ...state, players, winner: seat, finished: true },
    effects: [hit, { kind: 'win', playerId: player.playerId, intensity: 3 }],
    endTurn: 'game-rule',
  };
}

function onTurnEnd(state: AroundTheClockState, ctx: TurnCtx): Step<AroundTheClockState> {
  if (state.finished) return { state };
  const seat = seatOf(state.players, ctx.playerId);
  const next = (seat + 1) % state.players.length;
  if (next > seat) return { state: { ...state, current: next } };
  if (state.round < state.options.maxRounds) return { state: { ...state, current: next, round: state.round + 1 } };
  const finished: AroundTheClockState = { ...state, current: next, finished: true };
  return { state: finished, effects: winEffects(result(finished)!) };
}

function nextPlayer(state: AroundTheClockState): string | null {
  return state.finished ? null : state.players[state.current]!.playerId;
}

/** The finisher first, then the furthest round the clock; equal progress shares the place. */
function result(state: AroundTheClockState): Standing[] | null {
  if (!state.finished) return null;
  return rankStandings(
    state.players,
    (a, b) => b.progress - a.progress,
    (p) => p.progress,
  );
}

function view(state: AroundTheClockState): AroundTheClockView {
  const { players, finished, sequence } = state;
  const current = players[state.current]!;
  const target = sequence[current.progress]!;
  return {
    gameId: 'around-the-clock',
    headline: finished
      ? winnerHeadline(result(state)!, (id) => players[seatOf(players, id)]!.name)
      : `${current.name}: aim for ${label(target)}`,
    round: state.round,
    maxRounds: state.options.maxRounds,
    finished,
    current: finished ? null : current.playerId,
    targets: finished ? [] : [target],
    scoreboard: players.map((p, seat) => ({
      playerId: p.playerId,
      name: p.name,
      colorIndex: p.colorIndex,
      score: p.progress,
      detail: `next ${label(sequence[p.progress])}`,
      active: !finished && seat === state.current,
      out: false,
    })),
    sequence,
    players: players.map((p) => ({
      playerId: p.playerId,
      progress: p.progress,
      target: label(sequence[p.progress]),
      darts: p.darts,
      hitRate: p.darts > 0 ? Math.round((p.hits / p.darts) * 100) : 0,
    })),
  };
}

export const aroundTheClock: GameModule<AroundTheClockOptions, AroundTheClockState, AroundTheClockView> = {
  manifest: {
    id: 'around-the-clock',
    version: '1.0.0',
    name: 'Around the Clock',
    players: { min: 1, max: 8 },
    category: 'practice',
    dartsPerTurn: 3,
  },
  options: aroundTheClockOptions,
  init,
  onDart,
  onTurnEnd,
  nextPlayer,
  result,
  view,
};
