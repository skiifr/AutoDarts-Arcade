import { points, type PlayerId, type PlayerRef, type Segment, type Standing } from '@arcade/event-schema';
import { EngineError } from './errors';
import type { GameEffect, GameModule, ScoredDart, TurnCtx } from './game-module';
import { SeededRng, createRng, type RngState } from './rng';
import type { GreyReason } from './state';

/** The parts of a turn the game pass reads. Owned and mutated by the structure pass. */
export interface PassDart {
  readonly throwId: string;
  readonly segment: Segment;
  readonly voided: unknown;
  /** Effects of scoring this dart are emitted (a live throw, not a correction or padding). */
  readonly live: boolean;
  /** Seq of the event that created the dart; its effects are attributed to it. */
  readonly createdSeq: number;
}

export interface PassTurn {
  readonly turnIndex: number;
  readonly playerId: PlayerId;
  readonly roundIndex: number;
  readonly entries: readonly PassDart[];
  readonly end: { readonly seq: number } | null;
}

export interface DartStatus {
  scored: boolean;
  greyedBy: GreyReason | null;
}

export interface TurnResult {
  statuses: ReadonlyMap<string, DartStatus>;
  closedBy: 'bust' | 'game-rule' | 'finished' | null;
  afterFinish: boolean;
  points: number;
  effects: readonly { seq: number; effect: GameEffect }[];
}

export interface FinishInfo {
  standings: readonly Standing[];
  /** Turn in which the game ended; -1 if it was over straight after `init`. */
  turnIndex: number;
}

interface Checkpoint {
  state: unknown;
  rng: RngState;
  finished: FinishInfo | null;
  next: PlayerId | null;
}

export interface GamePassOptions {
  /** Keep a checkpoint every N turns so a change only replays from the nearest one. 0 = from the start. */
  snapshotEvery: number;
  /** Deep-freeze every state a game returns, so a module that mutates its input throws (tests, dev). */
  freezeStates: boolean;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Folds the turn structure through a `GameModule`. Every game call happens in one fixed order:
 * `init`; `nextPlayer` once with an opening ctx (first seat, turn 0, round 0, no darts) to name
 * who throws first; then per turn `onDart` for each scoring dart and, once the turn has ended,
 * `onTurnEnd` and `nextPlayer`. Each turn starts from the state the previous one left, and the
 * one Rng object (seeded from `SessionStarted.rngSeed`) is rewound with the state, so live play
 * and a full refold make identical calls and draw the same numbers.
 */
export class GamePass {
  private readonly game: GameModule;
  private readonly opts: GamePassOptions;
  private readonly players: ReadonlySet<PlayerId>;
  /** Keyed by turn index: the state just before that turn. Turn 0 always exists. */
  private readonly checkpoints: Map<number, Checkpoint>;
  private readonly results: TurnResult[];
  private dirtyFrom: number | null = 0;
  private recomputedFrom: number | null = null;

  state: unknown = undefined;
  finished: FinishInfo | null = null;
  /** Who the game says throws next: after init, then after each ended turn (null while a turn is live). */
  next: PlayerId | null = null;
  /** The session's single Rng object: passed to init and in every TurnCtx. */
  private readonly rng: SeededRng;
  private tail: { turn: number; cp: Checkpoint } | null = null;

  private constructor(
    game: GameModule,
    opts: GamePassOptions,
    players: ReadonlySet<PlayerId>,
    rng: SeededRng,
    checkpoints: Map<number, Checkpoint>,
    results: TurnResult[],
  ) {
    this.game = game;
    this.opts = opts;
    this.players = players;
    this.rng = rng;
    this.checkpoints = checkpoints;
    this.results = results;
  }

  /** Runs `init` and the opening `nextPlayer`. */
  static start(
    game: GameModule,
    init: { players: readonly PlayerRef[]; options: unknown; seed: string },
    opts: GamePassOptions,
  ): GamePass {
    const players = new Set(init.players.map((p) => p.playerId));
    const pass = new GamePass(game, opts, players, createRng(init.seed), new Map(), []);
    pass.state = pass.freeze(game.init({ players: init.players, options: init.options, rng: pass.rng }));
    const standings = game.result(pass.state);
    if (standings !== null) {
      pass.finished = { standings, turnIndex: -1 };
    } else {
      const opening: TurnCtx = {
        playerId: init.players[0]!.playerId,
        turnIndex: 0,
        roundIndex: 0,
        dartsThisTurn: [],
        rng: pass.rng,
      };
      pass.next = pass.askNext(opening, -1);
    }
    pass.checkpoints.set(0, pass.checkpoint());
    return pass;
  }

  /** An independent copy for a dry run. Checkpoints and results are immutable, so they are shared. */
  clone(): GamePass {
    const copy = new GamePass(
      this.game,
      this.opts,
      this.players,
      SeededRng.fromState(this.rng.getState()),
      new Map(this.checkpoints),
      this.results.slice(),
    );
    copy.state = this.state;
    copy.finished = this.finished;
    copy.next = this.next;
    copy.dirtyFrom = this.dirtyFrom;
    copy.tail = this.tail;
    return copy;
  }

  /** `nextPlayer`, checked; a null answer finishes the game. */
  private askNext(ctx: TurnCtx, turnIndex: number): PlayerId | null {
    const next = this.game.nextPlayer(this.state, ctx);
    if (next === null) {
      this.finished = { standings: this.game.result(this.state) ?? [], turnIndex };
      return null;
    }
    if (!this.players.has(next)) {
      throw new EngineError('game-contract', `nextPlayer returned "${next}", who is not in this session`);
    }
    return next;
  }

  markDirty(turnIndex: number): void {
    this.dirtyFrom = this.dirtyFrom === null ? turnIndex : Math.min(this.dirtyFrom, turnIndex);
  }

  result(turnIndex: number): TurnResult | undefined {
    return this.results[turnIndex];
  }

  /**
   * Re-runs the game from the nearest checkpoint at or before the earliest changed turn. Besides
   * the every-N checkpoints it keeps one at the start of the last turn, so a live dart replays
   * only the turn in progress.
   */
  ensure(turns: readonly PassTurn[]): void {
    if (this.dirtyFrom === null) return;
    const from = Math.min(this.dirtyFrom, turns.length);
    this.dirtyFrom = null;

    let start = 0;
    for (const key of this.checkpoints.keys()) if (key <= from && key > start) start = key;
    let cp = this.checkpoints.get(start)!;
    if (this.tail && this.tail.turn <= from && this.tail.turn > start) {
      start = this.tail.turn;
      cp = this.tail.cp;
    }
    for (const key of [...this.checkpoints.keys()]) if (key > start) this.checkpoints.delete(key);
    this.state = cp.state;
    this.rng.setState(cp.rng);
    this.finished = cp.finished;
    this.next = cp.next;
    // Turns before `from` did not change, so replaying them gives the same results: keep the
    // existing objects (views built from them stay referentially equal).
    const unchanged = this.results.slice(start, from);
    this.results.length = start;
    this.recomputedFrom = this.recomputedFrom === null ? from : Math.min(this.recomputedFrom, from);

    const every = this.opts.snapshotEvery;
    for (let t = start; t < turns.length; t++) {
      if (t > start && every > 0 && t % every === 0) this.checkpoints.set(t, this.checkpoint());
      if (t === turns.length - 1) this.tail = { turn: t, cp: this.checkpoint() };
      const result = this.runTurn(turns[t]!);
      this.results[t] = unchanged[t - start] ?? result;
    }
  }

  /** Effects attributed to events with seq >= `fromSeq`, from the turns replayed since the last drain. */
  drainEffects(fromSeq: number): { seq: number; effect: GameEffect }[] {
    const from = this.recomputedFrom;
    this.recomputedFrom = null;
    if (from === null) return [];
    const out: { seq: number; effect: GameEffect }[] = [];
    for (let t = from; t < this.results.length; t++) {
      for (const e of this.results[t]!.effects) if (e.seq >= fromSeq) out.push(e);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  resetDrain(): void {
    this.recomputedFrom = null;
  }

  private checkpoint(): Checkpoint {
    return { state: this.state, rng: this.rng.getState(), finished: this.finished, next: this.next };
  }

  private freeze<T>(value: T): T {
    return this.opts.freezeStates ? deepFreeze(value) : value;
  }

  private runTurn(turn: PassTurn): TurnResult {
    const statuses = new Map<string, DartStatus>();
    const effects: { seq: number; effect: GameEffect }[] = [];
    const live = turn.entries.filter((d) => !d.voided);
    this.next = null;

    if (this.finished !== null) {
      for (const d of live) statuses.set(d.throwId, { scored: false, greyedBy: 'finished' });
      return { statuses, closedBy: null, afterFinish: true, points: 0, effects };
    }

    const base = { playerId: turn.playerId, turnIndex: turn.turnIndex, roundIndex: turn.roundIndex, rng: this.rng };
    const scored: ScoredDart[] = [];
    let closedBy: TurnResult['closedBy'] = null;
    let total = 0;

    for (const d of live) {
      if (closedBy !== null) {
        statuses.set(d.throwId, { scored: false, greyedBy: closedBy });
        continue;
      }
      if (scored.length >= 3) {
        statuses.set(d.throwId, { scored: false, greyedBy: 'overflow' });
        continue;
      }
      const dart: ScoredDart = {
        throwId: d.throwId,
        playerId: turn.playerId,
        turnIndex: turn.turnIndex,
        dartIndex: scored.length as 0 | 1 | 2,
        segment: d.segment,
        points: points(d.segment),
      };
      const ctx: TurnCtx = { ...base, dartsThisTurn: scored.slice() };
      const step = this.game.onDart(this.state, dart, ctx);
      this.state = this.freeze(step.state);
      if (d.live && step.effects) for (const effect of step.effects) effects.push({ seq: d.createdSeq, effect });
      scored.push(dart);
      total += dart.points;
      statuses.set(d.throwId, { scored: true, greyedBy: null });
      if (step.endTurn) closedBy = step.endTurn;
      const standings = this.game.result(this.state);
      if (standings !== null) {
        this.finished = { standings, turnIndex: turn.turnIndex };
        closedBy ??= 'finished';
      }
    }

    if (turn.end !== null) {
      const ctx: TurnCtx = { ...base, dartsThisTurn: scored.slice() };
      const step = this.game.onTurnEnd(this.state, ctx);
      this.state = this.freeze(step.state);
      // `endTurn` from onTurnEnd means nothing: the turn is already over.
      if (step.effects) for (const effect of step.effects) effects.push({ seq: turn.end.seq, effect });
      if (this.finished === null) {
        const standings = this.game.result(this.state);
        if (standings !== null) {
          this.finished = { standings, turnIndex: turn.turnIndex };
          this.game.nextPlayer(this.state, ctx);
        } else {
          this.next = this.askNext(ctx, turn.turnIndex);
        }
      } else {
        // Finished during the visit (for example a checkout). nextPlayer is still asked after
        // every onTurnEnd, so the call order (and the Rng stream) matches the games' harness.
        this.game.nextPlayer(this.state, ctx);
      }
    }

    return { statuses, closedBy, afterFinish: false, points: total, effects };
  }
}
