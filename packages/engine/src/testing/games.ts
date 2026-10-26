/**
 * Small game modules for engine tests only. They are deliberately simple and written in the
 * immutable style the GameModule contract asks for; the tests fold them with frozen states so
 * any mutation by the engine (or by them) throws.
 */
import type { PlayerId, PlayerRef, Standing } from '@arcade/event-schema';
import { z } from 'zod';
import type { GameEffect, GameModule, Step } from '../game-module';

type Scores = Readonly<Record<PlayerId, number>>;

function rankByScore(order: readonly PlayerId[], scores: Scores): Standing[] {
  const sorted = [...order].sort((a, b) => scores[b]! - scores[a]! || order.indexOf(a) - order.indexOf(b));
  return sorted.map((playerId) => ({
    playerId,
    rank: 1 + sorted.filter((other) => scores[other]! > scores[playerId]!).length,
    score: scores[playerId]!,
  }));
}

/**
 * The games' turn-order convention: a game keeps whose turn it is in its own state. The host asks
 * `nextPlayer` once before the first turn and after every turn, and uses the answer.
 */
function seatAfter(order: readonly PlayerId[], turnsTaken: number): PlayerId {
  return order[turnsTaken % order.length]!;
}

function total(counts: Scores): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function zeroes(players: readonly PlayerRef[]): Record<PlayerId, number> {
  return Object.fromEntries(players.map((p) => [p.playerId, 0]));
}

function hitEffect(playerId: PlayerId, pts: number): GameEffect {
  if (pts >= 50) return { kind: 'big-hit', playerId, intensity: 3 };
  return pts > 0 ? { kind: 'hit', playerId } : { kind: 'miss', playerId };
}

// ── Sum: points add up over a fixed number of rounds ────────────────────────

export interface SumState {
  order: readonly PlayerId[];
  scores: Scores;
  turnsTaken: Scores;
  rounds: number;
  /** Every scored dart, as "turn:position:label", to make order-sensitivity visible. */
  trail: readonly string[];
}

export const sumGame: GameModule<{ rounds: number }, SumState, { scores: Scores }> = {
  manifest: {
    id: 'test-sum',
    version: '1.0.0',
    name: 'Sum',
    players: { min: 1, max: 8 },
    category: 'practice',
    dartsPerTurn: 3,
  },
  options: z.object({ rounds: z.int().min(1).default(2) }),
  init: ({ players, options }) => ({
    order: players.map((p) => p.playerId),
    scores: zeroes(players),
    turnsTaken: zeroes(players),
    rounds: options.rounds,
    trail: [],
  }),
  onDart: (s, dart) => ({
    state: {
      ...s,
      scores: { ...s.scores, [dart.playerId]: s.scores[dart.playerId]! + dart.points },
      trail: [...s.trail, `${dart.turnIndex}:${dart.dartIndex}:${dart.segment.label}`],
    },
    effects: [hitEffect(dart.playerId, dart.points)],
  }),
  onTurnEnd: (s, ctx) => ({
    state: { ...s, turnsTaken: { ...s.turnsTaken, [ctx.playerId]: s.turnsTaken[ctx.playerId]! + 1 } },
  }),
  nextPlayer: (s) => (s.order.every((p) => s.turnsTaken[p]! >= s.rounds) ? null : seatAfter(s.order, total(s.turnsTaken))),
  result: (s) => (s.order.every((p) => s.turnsTaken[p]! >= s.rounds) ? rankByScore(s.order, s.scores) : null),
  view: (s) => ({ scores: s.scores }),
};

// ── Ceiling: a visit scoring more than the ceiling busts ────────────────────

export interface CeilingState {
  order: readonly PlayerId[];
  scores: Scores;
  turnStart: number;
  turnsTaken: Scores;
  rounds: number;
  ceiling: number;
  busts: number;
}

export const ceilingGame: GameModule<{ rounds: number; ceiling: number }, CeilingState, { scores: Scores; busts: number }> = {
  manifest: {
    id: 'test-ceiling',
    version: '1.0.0',
    name: 'Ceiling',
    players: { min: 1, max: 8 },
    category: 'classic',
    dartsPerTurn: 3,
  },
  options: z.object({ rounds: z.int().min(1).default(3), ceiling: z.int().min(1).default(60) }),
  init: ({ players, options }) => ({
    order: players.map((p) => p.playerId),
    scores: zeroes(players),
    turnStart: 0,
    turnsTaken: zeroes(players),
    rounds: options.rounds,
    ceiling: options.ceiling,
    busts: 0,
  }),
  onDart: (s, dart, ctx): Step<CeilingState> => {
    const turnStart = ctx.dartsThisTurn.length === 0 ? s.scores[dart.playerId]! : s.turnStart;
    const score = s.scores[dart.playerId]! + dart.points;
    if (score - turnStart > s.ceiling) {
      return {
        state: { ...s, turnStart, scores: { ...s.scores, [dart.playerId]: turnStart }, busts: s.busts + 1 },
        effects: [{ kind: 'bust', playerId: dart.playerId }],
        endTurn: 'bust',
      };
    }
    return {
      state: { ...s, turnStart, scores: { ...s.scores, [dart.playerId]: score } },
      effects: [hitEffect(dart.playerId, dart.points)],
    };
  },
  onTurnEnd: (s, ctx) => ({
    state: { ...s, turnsTaken: { ...s.turnsTaken, [ctx.playerId]: s.turnsTaken[ctx.playerId]! + 1 } },
  }),
  nextPlayer: (s) => (s.order.every((p) => s.turnsTaken[p]! >= s.rounds) ? null : seatAfter(s.order, total(s.turnsTaken))),
  result: (s) => (s.order.every((p) => s.turnsTaken[p]! >= s.rounds) ? rankByScore(s.order, s.scores) : null),
  view: (s) => ({ scores: s.scores, busts: s.busts }),
};

// ── Race: the first to reach the target wins on that dart ───────────────────

export interface RaceState {
  order: readonly PlayerId[];
  scores: Scores;
  target: number;
  winner: PlayerId | null;
  turns: number;
}

export const raceGame: GameModule<{ target: number }, RaceState, RaceState> = {
  manifest: {
    id: 'test-race',
    version: '1.0.0',
    name: 'Race',
    players: { min: 2, max: 8 },
    category: 'party',
    dartsPerTurn: 3,
  },
  options: z.object({ target: z.int().min(1).default(100) }),
  init: ({ players, options }) => ({
    order: players.map((p) => p.playerId),
    scores: zeroes(players),
    target: options.target,
    winner: null,
    turns: 0,
  }),
  onDart: (s, dart) => {
    const score = s.scores[dart.playerId]! + dart.points;
    const won = score >= s.target;
    return {
      state: { ...s, scores: { ...s.scores, [dart.playerId]: score }, winner: won ? dart.playerId : s.winner },
      effects: won ? [{ kind: 'win', playerId: dart.playerId }] : [hitEffect(dart.playerId, dart.points)],
    };
  },
  onTurnEnd: (s) => ({ state: { ...s, turns: s.turns + 1 } }),
  nextPlayer: (s) => (s.winner ? null : seatAfter(s.order, s.turns)),
  result: (s) => (s.winner ? rankByScore(s.order, s.scores) : null),
  view: (s) => s,
};

// ── Lucky: a random "lucky number" scores double; uses the seeded Rng ───────

export interface LuckyState {
  order: readonly PlayerId[];
  scores: Scores;
  lucky: number;
  luckyHistory: readonly number[];
  turnsTaken: number;
  rounds: number;
}

export const luckyGame: GameModule<{ rounds: number }, LuckyState, LuckyState> = {
  manifest: {
    id: 'test-lucky',
    version: '1.0.0',
    name: 'Lucky',
    players: { min: 1, max: 8 },
    category: 'party',
    dartsPerTurn: 3,
  },
  options: z.object({ rounds: z.int().min(1).default(3) }),
  init: ({ players, options, rng }) => {
    const lucky = rng.int(1, 20);
    return { order: players.map((p) => p.playerId), scores: zeroes(players), lucky, luckyHistory: [lucky], turnsTaken: 0, rounds: options.rounds };
  },
  onDart: (s, dart) => {
    const pts = dart.segment.number === s.lucky ? dart.points * 2 : dart.points;
    return { state: { ...s, scores: { ...s.scores, [dart.playerId]: s.scores[dart.playerId]! + pts } } };
  },
  onTurnEnd: (s, ctx) => {
    const lucky = ctx.rng.int(1, 20);
    return { state: { ...s, lucky, luckyHistory: [...s.luckyHistory, lucky], turnsTaken: s.turnsTaken + 1 } };
  },
  nextPlayer: (s) => (s.turnsTaken >= s.rounds * s.order.length ? null : seatAfter(s.order, s.turnsTaken)),
  result: (s) => (s.turnsTaken >= s.rounds * s.order.length ? rankByScore(s.order, s.scores) : null),
  view: (s) => s,
};

export const TEST_GAMES = [sumGame, ceilingGame, raceGame, luckyGame] as unknown as readonly GameModule[];
