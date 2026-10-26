import {
  MemoryLogStore,
  SessionHost,
  gameRegistry,
  ulidFromNumber,
  type Clock,
  type EngineEffect,
  type GameEffect,
  type GameModule,
  type GameRegistry,
  type IdSource,
  type SessionState,
} from '@arcade/engine';
import {
  COMMAND_SCHEMA_VERSION,
  MISS,
  type ArcadeCommand,
  type ArcadeCommandType,
  type ArcadeEvent,
  type CommandOf,
  type EventOf,
  type Segment,
} from '@arcade/event-schema';
import type { AnyGame, DartSource, SessionResult, SessionSpec, TurnLog } from './harness';

export interface HostSessionSpec extends Omit<SessionSpec, 'roundTrip'> {
  /** Looks the game up by id. Default: a registry of this game alone. */
  games?: GameRegistry;
}

export interface HostSessionResult<State = unknown, View = unknown> extends SessionResult<State, View> {
  /** The persisted event log, from SessionStarted to SessionClosed. */
  log: readonly ArcadeEvent[];
  /** The host's snapshot after SessionClosed. */
  session: SessionState<State, View>;
}

const DAY_MS = 86_400_000;

/**
 * ISO timestamps `stepMs` apart from 2026-01-01T00:00:00Z, without reading the clock. One day
 * is plenty for a session (about 43,000 turns at the default step); past it, it throws.
 */
export function tickingClock(stepMs = 250): Clock {
  let ms = 0;
  return () => {
    if (ms >= DAY_MS) throw new RangeError('tickingClock ran past one day');
    const pad = (v: number, width = 2) => String(v).padStart(width, '0');
    const t = ms;
    ms += stepMs;
    return `2026-01-01T${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)}.${pad(t % 1000, 3)}Z`;
  };
}

/**
 * Plays a session through the engine's `SessionHost`, with a `MemoryLogStore`, as a
 * manual-mode session: every dart is an `AddDart{reason:'manual-mode'}` command and every
 * visit ends with `SkipTurn`. It takes the same spec as `runSession` and returns the same
 * result, plus the event log, so the two can be compared turn for turn.
 *
 * - A short visit is padded with misses (`padMissing`, default true): the host only pads
 *   at an observed takeout, and a manual-mode visit has none.
 * - After the game ends a visit early, scripted darts still on the board are added too: the
 *   host records them greyed out, and they never reach `onDart`.
 * - At the end the session is closed: `completed` if the game finished, else `abandoned`.
 * - `freeze` becomes the host's `freezeGameStates`. Any input the host does not apply throws.
 */
export function runOnHost<State, View>(
  game: GameModule<unknown, State, View>,
  spec: HostSessionSpec,
): Promise<HostSessionResult<State, View>>;
export async function runOnHost(game: AnyGame, spec: HostSessionSpec): Promise<HostSessionResult> {
  const { players } = spec;
  const seed = spec.seed ?? 'arcade';
  if (seed === '') throw new RangeError('runOnHost needs a non-empty seed');
  const pad = spec.padMissing ?? true;
  const script = typeof spec.darts === 'function' ? null : spec.darts;
  const source: DartSource =
    typeof spec.darts === 'function' ? spec.darts : (r) => script![r.turnIndex]![r.dartIndex] ?? null;
  const maxTurns = Math.min(spec.maxTurns ?? 1000, script?.length ?? Infinity);

  const clock = tickingClock();
  let eventCount = 0;
  let commandCount = 0;
  /** Ids the host takes before it mints its own (see StartSession below). */
  const handOut: string[] = [];
  const ids: IdSource = () => handOut.shift() ?? ulidFromNumber(++eventCount, '0E');
  const host = new SessionHost({
    store: new MemoryLogStore(),
    clock,
    ids,
    games: spec.games ?? gameRegistry([game]),
    fold: { freezeGameStates: spec.freeze ?? false },
  });
  let effects: GameEffect[] = [];
  const isGame = (e: EngineEffect): e is Extract<EngineEffect, { type: 'game' }> => e.type === 'game';
  host.subscribeEffects((batch) => {
    // A manual-mode dart is never a correction, so no score-adjusted effects come.
    for (const e of batch.filter(isGame)) effects.push(e.effect);
  });
  const snapshot = () => host.getSnapshot()!;

  async function send<T extends ArcadeCommandType>(type: T, payload: CommandOf<T>['payload']): Promise<readonly ArcadeEvent[]> {
    const command = {
      schema: COMMAND_SCHEMA_VERSION,
      commandId: ulidFromNumber(++commandCount, '0C'),
      type,
      payload,
      actor: 'operator',
      issuedAt: clock(),
    } as ArcadeCommand;
    const result = await host.dispatch(command);
    if (result.status === 'applied') return result.events;
    throw new Error(`${game.manifest.id}: the host did not apply ${type}: ${JSON.stringify(result)}`);
  }

  async function addDart(at: { playerId: string; turnIndex: number }, dartIndex: 0 | 1 | 2, segment: Segment): Promise<string> {
    const events = await send('AddDart', { ...at, dartIndex, segment, reason: 'manual-mode' });
    return events.find((e): e is EventOf<'DartAdded'> => e.type === 'DartAdded')!.payload.throwId;
  }

  // StartSession carries no seed: the host mints the session id and then SessionStarted.rngSeed
  // from its IdSource. Handing the seed to that second id gives the game the same Rng stream as
  // `runSession` with this seed (the tests next to this file pin that order).
  handOut.push(ulidFromNumber(++eventCount, '0E'), seed);
  const options = spec.options ?? {};
  await send('StartSession', { gameId: game.manifest.id, options: options as Record<string, unknown>, players: [...players] });

  const turns: TurnLog[] = [];
  const padded = new Set<string>();
  while (turns.length < maxTurns) {
    const turn = snapshot().currentTurn;
    if (turn === null) break; // the game is over: in manual play a turn starts otherwise
    const { turnIndex, roundIndex, playerId } = turn;
    const at = { playerId, turnIndex };
    effects = [];
    for (let i = 0; i < 3; i++) {
      const dartIndex = i as 0 | 1 | 2;
      const now = snapshot();
      if (now.currentTurn!.closedBy !== null) {
        // The game ended the visit: scripted darts still on the board are recorded, greyed out.
        const leftover = script?.[turnIndex]?.[dartIndex];
        if (leftover) await addDart(at, dartIndex, leftover);
        continue;
      }
      const thrown = source({ playerId, turnIndex, roundIndex, dartIndex, view: now.view });
      const segment = thrown ?? (pad ? MISS : null);
      if (segment === null) break;
      const throwId = await addDart(at, dartIndex, segment);
      if (thrown === null) padded.add(throwId);
    }
    await send('SkipTurn', {});
    const after = snapshot();
    const ended = after.turns[turnIndex]!;
    turns.push({
      turnIndex,
      roundIndex,
      playerId,
      name: players.find((p) => p.playerId === playerId)!.displayName,
      darts: ended.darts.map((d) => ({ label: d.segment.label, points: d.points, scored: d.scored, padded: padded.has(d.throwId) })),
      endTurn: ended.closedBy,
      effects,
      view: after.view,
    });
  }

  const last = snapshot();
  await send('CloseSession', { outcome: last.finished ? 'completed' : 'abandoned' });
  const session = snapshot();
  return {
    finished: last.finished !== null,
    standings: last.standings && [...last.standings],
    turns,
    state: session.gameState,
    view: session.view,
    options: session.options,
    log: host.getLog(),
    session,
  };
}
