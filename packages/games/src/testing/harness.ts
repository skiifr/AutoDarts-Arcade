import type { GameEffect, GameModule, ScoredDart, TurnCtx } from '@arcade/engine';
import { MISS, points, type PlayerId, type PlayerRef, type Segment, type Standing } from '@arcade/event-schema';
import { testId } from './players';
import { createRng } from './rng';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the harness runs any game
export type AnyGame = GameModule<any, any, any>;

export interface DartRequest {
  playerId: PlayerId;
  turnIndex: number;
  roundIndex: number;
  dartIndex: 0 | 1 | 2;
  /** The game's view just before this dart. */
  view: unknown;
}

/** Asked for each dart. Returning null means the player threw no more darts this visit. */
export type DartSource = (request: DartRequest) => Segment | null;

export interface SessionSpec {
  /** In turn order. */
  players: readonly PlayerRef[];
  /** Raw options; parsed (and defaulted) by the game's schema. */
  options?: unknown;
  seed?: string;
  /** Scripted visits in throwing order (the session stops when they run out), or a source asked for every dart. */
  darts: readonly (readonly Segment[])[] | DartSource;
  /** House rule `missingDartsAreMisses`: pad a short visit with misses. Default true. */
  padMissing?: boolean;
  /** Safety stop. Default 1000 turns. */
  maxTurns?: number;
  /** Deep-freeze every state handed to the game, so an accidental mutation throws. */
  freeze?: boolean;
  /** JSON round-trip every state handed to the game, proving it is plain data. */
  roundTrip?: boolean;
}

export interface LoggedDart {
  label: string;
  points: number;
  /** False for darts thrown after the game ended the visit (shown greyed, not scored). */
  scored: boolean;
  /** True when the dart was a miss added for a short visit. */
  padded: boolean;
}

export interface TurnLog {
  turnIndex: number;
  roundIndex: number;
  playerId: PlayerId;
  name: string;
  darts: LoggedDart[];
  endTurn: 'bust' | 'game-rule' | null;
  effects: GameEffect[];
  /** The game's view after the turn ended. */
  view: unknown;
}

export interface SessionResult<State = unknown, View = unknown> {
  /** True when the game reported that nobody is left to throw. */
  finished: boolean;
  standings: Standing[] | null;
  turns: TurnLog[];
  state: State;
  view: View;
  options: unknown;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Plays a session the way the host will (ARCHITECTURE §8.3), standing in for the engine
 * until integration: init → onDart per dart → onTurnEnd → nextPlayer, three darts per
 * visit, honouring `endTurn`. Darts after an early end are logged but not scored.
 */
export function runSession<State, View>(game: GameModule<unknown, State, View>, spec: SessionSpec): SessionResult<State, View>;
export function runSession(game: AnyGame, spec: SessionSpec): SessionResult {
  const { players } = spec;
  const pad = spec.padMissing ?? true;
  const script = typeof spec.darts === 'function' ? null : spec.darts;
  const source: DartSource =
    typeof spec.darts === 'function' ? spec.darts : (r) => script![r.turnIndex]![r.dartIndex] ?? null;
  const maxTurns = Math.min(spec.maxTurns ?? 1000, script?.length ?? Infinity);
  const prepare = (state: unknown): unknown => {
    const copy = spec.roundTrip ? JSON.parse(JSON.stringify(state)) : state;
    return spec.freeze ? deepFreeze(copy) : copy;
  };
  const seatOf = (playerId: PlayerId): number => {
    const seat = players.findIndex((p) => p.playerId === playerId);
    if (seat < 0) throw new Error(`${game.manifest.id}: nextPlayer returned unknown player ${playerId}`);
    return seat;
  };

  const options = game.options.parse(spec.options ?? {});
  const rng = createRng(spec.seed ?? 'arcade');
  let state = prepare(game.init({ players, options, rng }));
  const opening: TurnCtx = { playerId: players[0]!.playerId, turnIndex: 0, roundIndex: 0, dartsThisTurn: [], rng };
  let playerId = game.nextPlayer(state, opening);
  const turns: TurnLog[] = [];
  let throwCount = 0;
  let roundIndex = 0;
  let lastSeat = -1;

  for (let turnIndex = 0; playerId !== null && turnIndex < maxTurns; turnIndex++) {
    const seat = seatOf(playerId);
    if (lastSeat >= 0 && seat <= lastSeat) roundIndex++;
    lastSeat = seat;
    const scored: ScoredDart[] = [];
    const log: TurnLog = {
      turnIndex,
      roundIndex,
      playerId,
      name: players[seat]!.displayName,
      darts: [],
      endTurn: null,
      effects: [],
      view: null,
    };

    for (let i = 0; i < 3; i++) {
      const dartIndex = i as 0 | 1 | 2;
      if (log.endTurn !== null) {
        // The visit is over; scripted darts still on the board are shown, not scored.
        const leftover = script?.[turnIndex]?.[dartIndex];
        if (leftover) log.darts.push({ label: leftover.label, points: points(leftover), scored: false, padded: false });
        continue;
      }
      const thrown = source({ playerId, turnIndex, roundIndex, dartIndex, view: game.view(state) });
      const segment = thrown ?? (pad ? MISS : null);
      if (segment === null) break;
      const dart: ScoredDart = {
        throwId: testId(++throwCount),
        playerId,
        turnIndex,
        dartIndex,
        segment,
        points: points(segment),
      };
      const ctx: TurnCtx = { playerId, turnIndex, roundIndex, dartsThisTurn: [...scored], rng };
      const step = game.onDart(state, dart, ctx);
      state = prepare(step.state);
      scored.push(dart);
      log.darts.push({ label: segment.label, points: dart.points, scored: true, padded: thrown === null });
      log.effects.push(...(step.effects ?? []));
      log.endTurn = step.endTurn ?? null;
    }

    const endCtx: TurnCtx = { playerId, turnIndex, roundIndex, dartsThisTurn: scored, rng };
    const end = game.onTurnEnd(state, endCtx);
    state = prepare(end.state);
    log.effects.push(...(end.effects ?? []));
    log.view = game.view(state);
    turns.push(log);
    playerId = game.nextPlayer(state, endCtx);
  }

  return {
    finished: playerId === null,
    standings: game.result(state),
    turns,
    state,
    view: game.view(state),
    options,
  };
}
