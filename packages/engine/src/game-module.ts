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
 *
 * How the engine calls a module (the same order live and on every refold):
 * 1. `init`, with `players` in turn order and the session's one `Rng` (from `SessionStarted.rngSeed`).
 * 2. `nextPlayer` once with an opening ctx (first seat, turnIndex 0, roundIndex 0, no darts):
 *    its answer throws first; null means the game is already over.
 * 3. Per turn: `onDart` for each dart that scores, then, once the host has ended the turn,
 *    `onTurnEnd` and `nextPlayer`, whose answer throws next. Every ctx carries the same `Rng` object.
 * `result` is read after each `onDart` and each `onTurnEnd`; non-null means the game is over.
 * States must not be mutated: the engine keeps earlier states as replay checkpoints.
 */
export interface GameModule<Opts = unknown, State = unknown, View = unknown> {
  manifest: GameManifest;
  /** Drives the setup screen's option controls and validates `SessionStarted.options`. */
  options: ZodType<Opts>;
  init(ctx: { players: readonly PlayerRef[]; options: Opts; rng: Rng }): State;
  /**
   * `dart.dartIndex` is the dart's slot among the turn's scoring darts. After `endTurn`, or once
   * `result` is non-null, later darts of the visit are recorded but greyed out and not passed in.
   */
  onDart(state: State, dart: ScoredDart, ctx: TurnCtx): Step<State>;
  /** Called for every turn the host ends, also the one that finished the game. `endTurn` here is ignored. */
  onTurnEnd(state: State, ctx: TurnCtx): Step<State>;
  /** The next player to throw, or null when the game is over. The host follows it (eliminations, skips). */
  nextPlayer(state: State, ctx: TurnCtx): PlayerId | null;
  result(state: State): Standing[] | null;
  /** Serialisable and UI-agnostic. */
  view(state: State): View;
}
