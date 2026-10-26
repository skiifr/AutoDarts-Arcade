import type { GameEffect, GameModule, Rng, ScoredDart, Step, TurnCtx } from '@arcade/engine';
import type { PlayerRef, Standing } from '@arcade/event-schema';
import { z } from 'zod';
import { replaceAt, seatOf, seatsFrom, type Seat } from '../shared/seats';
import { rankStandings, winEffects, winnerHeadline } from '../shared/standings';
import type { BaseView } from '../shared/view';

/** Bricks in every wall at the start. */
export const WALL = 10;
/** Steps from the wall at which a wave appears. */
export const RANGE = 3;
const BULL = 25;

/** Waves per difficulty: how many invaders, and the strongest one can be. */
export const WAVES = {
  easy: { size: 2, maxStrength: 1 },
  normal: { size: 2, maxStrength: 2 },
  hard: { size: 3, maxStrength: 2 },
} as const;

/** Siege (original party design). Rules for players are in `rules.md`. */
export const siegeOptions = z.object({
  /** The strongest wall after this many rounds wins, if more than one is standing. */
  rounds: z.literal([5, 10, 15, 20]).default(10),
  difficulty: z.enum(['easy', 'normal', 'hard']).default('normal'),
});
export type SiegeOptions = z.infer<typeof siegeOptions>;

export interface Invader {
  /** "<round>.<n>": the same invader has the same id in every lane. */
  id: string;
  /** The board number (1–20) that hits it. */
  number: number;
  strength: number;
  maxStrength: number;
  /** Steps from the wall; it breaks through when this reaches 0. */
  distance: number;
}

export interface SiegePlayer extends Seat {
  wall: number;
  /** Closest first (older waves are always closer). */
  invaders: Invader[];
  destroyed: number;
  darts: number;
  /** The round this player's wall fell in, or null while standing. */
  fellInRound: number | null;
}

export interface SiegeState {
  options: SiegeOptions;
  players: SiegePlayer[];
  current: number;
  round: number;
  /** The wave that arrived at the start of this round. */
  wave: Invader[];
  /** Bricks each player lost at the end of the previous round. */
  breaches: { playerId: string; bricks: number }[];
  finished: boolean;
}

export interface SiegeView extends BaseView {
  gameId: 'siege';
  difficulty: SiegeOptions['difficulty'];
  range: number;
  maxWall: number;
  lanes: { playerId: string; wall: number; fallen: boolean; invaders: Invader[] }[];
  wave: Invader[];
  breaches: { playerId: string; bricks: number }[];
}

/** Draws a wave from the seeded Rng. It always makes the same number of draws. */
function spawnWave(rng: Rng, difficulty: SiegeOptions['difficulty'], round: number): Invader[] {
  const { size, maxStrength } = WAVES[difficulty];
  const pool = Array.from({ length: 20 }, (_, i) => i + 1);
  return Array.from({ length: size }, (_, i) => {
    const number = pool.splice(rng.int(0, pool.length - 1), 1)[0]!;
    const strength = rng.int(1, maxStrength);
    return { id: `${round}.${i + 1}`, number, strength, maxStrength: strength, distance: RANGE };
  });
}

const standing = (p: SiegePlayer) => p.fellInRound === null;

function init({ players, options, rng }: { players: readonly PlayerRef[]; options: SiegeOptions; rng: Rng }): SiegeState {
  const wave = spawnWave(rng, options.difficulty, 1);
  return {
    options,
    players: seatsFrom(players).map((seat) => ({
      ...seat,
      wall: WALL,
      invaders: wave,
      destroyed: 0,
      darts: 0,
      fellInRound: null,
    })),
    current: 0,
    round: 1,
    wave,
    breaches: [],
    finished: false,
  };
}

function onDart(state: SiegeState, dart: ScoredDart): Step<SiegeState> {
  if (state.finished) return { state };
  const seat = seatOf(state.players, dart.playerId);
  const player = state.players[seat]!;
  const { number, multiplier } = dart.segment;
  // The bull hits every invader; a number hits the closest invader carrying it.
  const closest = player.invaders.findIndex((inv) => inv.number === number);
  const struck = player.invaders.map((inv, i) => number === BULL || i === closest);
  let damage = 0;
  const invaders = player.invaders.map((inv, i) => {
    if (!struck[i]) return inv;
    damage += Math.min(inv.strength, multiplier);
    return { ...inv, strength: inv.strength - multiplier };
  });
  const survivors = invaders.filter((inv) => inv.strength > 0);
  const destroyed = invaders.length - survivors.length;
  const players = replaceAt(state.players, seat, {
    ...player,
    invaders: survivors,
    destroyed: player.destroyed + destroyed,
    darts: player.darts + 1,
  });

  const effects: GameEffect[] = [];
  if (destroyed >= 2) {
    effects.push({ kind: 'big-hit', playerId: player.playerId, intensity: Math.min(3, destroyed) as 2 | 3, data: { damage, destroyed } });
  } else if (damage > 0) {
    effects.push({ kind: 'hit', playerId: player.playerId, intensity: Math.min(3, damage) as 1 | 2 | 3, data: { damage, destroyed } });
  }
  return { state: { ...state, players }, effects };
}

function onTurnEnd(state: SiegeState, ctx: TurnCtx): Step<SiegeState> {
  if (state.finished) return { state };
  const seat = seatOf(state.players, ctx.playerId);
  const next = state.players.findIndex((p, i) => i > seat && standing(p));
  if (next >= 0) return { state: { ...state, current: next } };
  return endRound(state, ctx.rng);
}

/** Everyone has thrown: invaders advance, walls take damage, then a new wave arrives. */
function endRound(state: SiegeState, rng: Rng): Step<SiegeState> {
  const effects: GameEffect[] = [];
  const breaches: SiegeState['breaches'] = [];
  const advanced = state.players.map((p) => {
    if (!standing(p)) return p;
    const moved = p.invaders.map((inv) => ({ ...inv, distance: inv.distance - 1 }));
    const bricks = moved.filter((inv) => inv.distance === 0).reduce((sum, inv) => sum + inv.strength, 0);
    const wall = p.wall - bricks;
    if (bricks > 0) breaches.push({ playerId: p.playerId, bricks });
    if (wall > 0) return { ...p, wall, invaders: moved.filter((inv) => inv.distance > 0) };
    effects.push({ kind: 'eliminated', playerId: p.playerId, data: { round: state.round } });
    return { ...p, wall, invaders: [], fellInRound: state.round };
  });

  const ended = { ...state, players: advanced, breaches };
  if (advanced.filter(standing).length <= 1 || state.round >= state.options.rounds) {
    const finished: SiegeState = { ...ended, finished: true };
    return { state: finished, effects: [...effects, ...winEffects(result(finished)!)] };
  }

  const round = state.round + 1;
  const wave = spawnWave(rng, state.options.difficulty, round);
  const players = advanced.map((p) => (standing(p) ? { ...p, invaders: [...p.invaders, ...wave] } : p));
  return { state: { ...ended, players, round, wave, current: players.findIndex(standing) }, effects };
}

function nextPlayer(state: SiegeState): string | null {
  return state.finished ? null : state.players[state.current]!.playerId;
}

/**
 * Standing players first, by wall; fallen players by how long they lasted. Then more
 * invaders destroyed; a full tie is shared.
 */
function result(state: SiegeState): Standing[] | null {
  if (!state.finished) return null;
  const lasted = (p: SiegePlayer) => p.fellInRound ?? state.options.rounds + 1;
  const bricks = (p: SiegePlayer) => Math.max(0, p.wall);
  return rankStandings(
    state.players,
    (a, b) => lasted(b) - lasted(a) || bricks(b) - bricks(a) || b.destroyed - a.destroyed,
    bricks,
  );
}

function view(state: SiegeState): SiegeView {
  const { players, finished } = state;
  const current = players[state.current]!;
  return {
    gameId: 'siege',
    headline: finished
      ? winnerHeadline(result(state)!, (id) => players[seatOf(players, id)]!.name)
      : `${current.name} defends · wall ${current.wall}`,
    round: state.round,
    maxRounds: state.options.rounds,
    finished,
    current: finished ? null : current.playerId,
    targets: finished ? [] : [...new Set(current.invaders.map((inv) => inv.number))],
    scoreboard: players.map((p, seat) => ({
      playerId: p.playerId,
      name: p.name,
      colorIndex: p.colorIndex,
      score: Math.max(0, p.wall),
      detail: standing(p) ? `${p.destroyed} destroyed` : `fell in round ${p.fellInRound}`,
      active: !finished && seat === state.current,
      out: !standing(p),
    })),
    difficulty: state.options.difficulty,
    range: RANGE,
    maxWall: WALL,
    lanes: players.map((p) => ({
      playerId: p.playerId,
      wall: Math.max(0, p.wall),
      fallen: !standing(p),
      invaders: p.invaders,
    })),
    wave: state.wave,
    breaches: state.breaches,
  };
}

export const siege: GameModule<SiegeOptions, SiegeState, SiegeView> = {
  manifest: {
    id: 'siege',
    version: '0.1.0',
    name: 'Siege',
    players: { min: 2, max: 8 },
    category: 'party',
    dartsPerTurn: 3,
  },
  options: siegeOptions,
  init,
  onDart,
  onTurnEnd,
  nextPlayer,
  result,
  view,
};
