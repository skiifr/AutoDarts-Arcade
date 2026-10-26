import type { PlayerId, PlayerRef, Segment, Standing, ThrowId } from '@arcade/event-schema';
import type { ZodType } from 'zod';

/** Seeded random numbers. Built from `SessionStarted.rngSeed`, so every replay draws the same sequence. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
}

export interface ScoredDart {
  throwId: ThrowId;
  playerId: PlayerId;
  turnIndex: number;
  dartIndex: 0 | 1 | 2;
  segment: Segment;
  points: number;
}

export interface TurnCtx {
  playerId: PlayerId;
  turnIndex: number;
  roundIndex: number;
  /** Darts already scored in this turn, before the current one. */
  dartsThisTurn: readonly ScoredDart[];
  rng: Rng;
}

export type GameEffect = {
  kind: 'hit' | 'big-hit' | 'miss' | 'bust' | 'checkout' | 'eliminated' | 'lead-change' | 'win';
  playerId?: PlayerId;
  intensity?: 1 | 2 | 3;
  data?: Record<string, unknown>;
};

export interface Step<S> {
  state: S;
  effects?: GameEffect[];
  /** A game may only request an early end; the host owns turn boundaries. */
  endTurn?: 'bust' | 'game-rule';
}

export interface GameManifest {
  id: string;
  version: string;
  name: string;
  players: { min: number; max: number };
  teams?: boolean;
  category: 'party' | 'classic' | 'practice' | 'team';
  /** A physical board visit is at most 3 darts. */
  dartsPerTurn: 3;
}

/**
 * A game is pure rules over a serialisable state (ARCHITECTURE §8.2). No timers, I/O,
 * clock or Math.random: the engine folds the log through these functions on every replay.
 */
export interface GameModule<Opts = unknown, State = unknown, View = unknown> {
  manifest: GameManifest;
  /** Drives the setup screen's option controls and validates `SessionStarted.options`. */
  options: ZodType<Opts>;
  init(ctx: { players: readonly PlayerRef[]; options: Opts; rng: Rng }): State;
  onDart(state: State, dart: ScoredDart, ctx: TurnCtx): Step<State>;
  onTurnEnd(state: State, ctx: TurnCtx): Step<State>;
  /** The next player to throw, or null when the game is over. */
  nextPlayer(state: State, ctx: TurnCtx): PlayerId | null;
  result(state: State): Standing[] | null;
  /** Serialisable and UI-agnostic. */
  view(state: State): View;
}
