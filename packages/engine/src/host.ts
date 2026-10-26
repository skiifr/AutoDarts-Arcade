import {
  ArcadeCommandSchema,
  ArcadeEventSchema,
  DEFAULT_HOUSE_RULES,
  EVENT_SCHEMA_VERSION,
  isBoardFact,
  parseArcadeEvent,
  type ArcadeCommand,
  type ArcadeEvent,
  type BoardFactDraft,
  type CommandOf,
  type HouseRules,
  type PlayerRef,
} from '@arcade/event-schema';
import { BoardVisitTracker } from './board-tracker';
import { Batch, Decider, Rejection, reject, type RejectReason } from './decide';
import { EngineError } from './errors';
import { SessionFolder, type FoldOptions } from './folder';
import { previewIds } from './ids';
import type { Clock, IdSource, LogStore } from './ports';
import type { GameRegistry } from './registry';
import type { EngineEffect, SessionState } from './state';

export interface SessionHostDeps {
  store: LogStore;
  clock: Clock;
  ids: IdSource;
  /** Looks games up by id; the app passes `gameRegistry(GAMES)`. */
  games: GameRegistry;
  /** House rules for a StartSession that does not carry its own. Default DEFAULT_HOUSE_RULES. */
  defaultHouseRules?: HouseRules;
  fold?: FoldOptions;
  /** `source.adapterVersion` of events caused by commands. Default "ui@0.1.0". */
  uiVersion?: string;
}

export type HostResult =
  | { status: 'applied'; events: readonly ArcadeEvent[] }
  /** Valid, but there was nothing to record (for example correcting a dart to its current value). */
  | { status: 'noop' }
  /** This commandId was already applied; nothing was done again. */
  | { status: 'duplicate' }
  /** A board fact with no open session: not logged, only kept to know which darts are on the board. */
  | { status: 'not-recorded' }
  | { status: 'rejected'; reason: RejectReason; message: string };

export type PreviewResult =
  | { status: 'ok'; events: readonly ArcadeEvent[]; state: SessionState }
  | { status: 'rejected'; reason: RejectReason; message: string };

type Listener = () => void;
type EffectListener = (effects: readonly EngineEffect[]) => void;

interface SessionParams {
  gameId: string;
  options: Record<string, unknown>;
  players: readonly PlayerRef[];
  turnOrder?: readonly string[];
  houseRules?: HouseRules;
}

function rejected(e: Rejection): HostResult {
  return { status: 'rejected', reason: e.reason, message: e.message };
}

/** A throwing listener must not undo a persisted append: report its error outside this call. */
function rethrowLater(err: unknown): void {
  const queue = (globalThis as { queueMicrotask?: (task: () => void) => void }).queueMicrotask;
  if (queue) {
    queue(() => {
      throw err;
    });
  } else {
    void Promise.reject(err);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The single writer of a session's log (ARCHITECTURE §5.4, §7.1). Takes board facts from the
 * adapters and commands from the UI, one at a time in arrival order; assigns eventId, gap-free
 * seq and receivedAt; derives and records the layer-2 game facts; persists through
 * `LogStore.append` and only then publishes the new state and effects. If the append fails,
 * nothing is published and the state does not move.
 *
 * `subscribe` and `getSnapshot` fit React's `useSyncExternalStore`; `getSnapshot` returns the
 * same object until the state changes.
 */
export class SessionHost {
  private readonly deps: SessionHostDeps;
  private folder: SessionFolder | null = null;
  private log: ArcadeEvent[] = [];
  private snapshot: SessionState | null = null;
  private readonly tracker = new BoardVisitTracker();
  private readonly appliedCommands = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly effectListeners = new Set<EffectListener>();
  private queue: Promise<unknown> = Promise.resolve();
  /** True while an append is in flight: the live folder then holds events that are not yet persisted. */
  private appending = false;

  constructor(deps: SessionHostDeps) {
    this.deps = deps;
  }

  /** Rebuilds a host from a persisted session (crash-resume): load, validate, fold. Emits nothing. */
  static async resume(deps: SessionHostDeps, sessionId: string): Promise<SessionHost> {
    const raw = await deps.store.load(sessionId);
    if (raw.length === 0) throw new EngineError('host', `session ${sessionId} has no events`);
    const events = raw.map((e) => parseArcadeEvent(e));
    const host = new SessionHost(deps);
    host.folder = SessionFolder.fromLog(events, deps.games, deps.fold);
    host.log = events;
    for (const e of events) if (isBoardFact(e)) host.tracker.observe(e as BoardFactDraft);
    host.snapshot = host.folder.snapshot();
    return host;
  }

  // ── Inputs ─────────────────────────────────────────────────────────────────

  /** A layer-1 board fact from an adapter. */
  ingest(fact: BoardFactDraft): Promise<HostResult> {
    return this.enqueue(() => this.processFact(fact));
  }

  /** A command from the UI or a companion. Validated here with `ArcadeCommandSchema`. */
  dispatch(command: ArcadeCommand | unknown): Promise<HostResult> {
    return this.enqueue(() => this.processCommand(command));
  }

  /** Resolves once every input received so far has been processed. */
  whenIdle(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Dry run (W4 preview): the state the command would lead to, without appending anything or
   * notifying anyone. Works on a copy of the persisted state, so it ignores inputs still queued.
   */
  preview(command: ArcadeCommand | unknown): PreviewResult {
    const parsed = ArcadeCommandSchema.safeParse(command);
    if (!parsed.success) return { status: 'rejected', reason: 'invalid', message: parsed.error.message };
    const cmd = parsed.data;
    if (cmd.type === 'StartSession' || cmd.type === 'Rematch') {
      return { status: 'rejected', reason: 'not-previewable', message: `${cmd.type} cannot be previewed` };
    }
    const folder = this.folder;
    if (!folder) return { status: 'rejected', reason: 'no-session', message: 'no session' };
    if (folder.closed) return { status: 'rejected', reason: 'session-closed', message: 'the session is closed' };
    const scratch = this.appending ? SessionFolder.fromLog(this.log, this.deps.games, this.deps.fold) : folder.clone();
    const batch = new Batch(scratch, folder.sessionId!, previewIds(), this.log.at(-1)!.receivedAt);
    try {
      new Decider(batch, this.uiVersion).decideCommand(cmd);
    } catch (e) {
      if (e instanceof Rejection) return { status: 'rejected', reason: e.reason, message: e.message };
      throw e;
    }
    return { status: 'ok', events: batch.events, state: scratch.snapshot() };
  }

  // ── Outputs ────────────────────────────────────────────────────────────────

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionState | null => this.snapshot;

  /** Effects for newly appended events, delivered after the state listeners. */
  subscribeEffects(listener: EffectListener): () => void {
    this.effectListeners.add(listener);
    return () => this.effectListeners.delete(listener);
  }

  /** The persisted log of the current session. */
  getLog(): readonly ArcadeEvent[] {
    return this.log;
  }

  // ── Processing ─────────────────────────────────────────────────────────────

  private get uiVersion(): string {
    return this.deps.uiVersion ?? 'ui@0.1.0';
  }

  private enqueue(task: () => Promise<HostResult>): Promise<HostResult> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private openFolder(): SessionFolder | null {
    return this.folder && !this.folder.closed ? this.folder : null;
  }

  private async processFact(fact: BoardFactDraft): Promise<HostResult> {
    const folder = this.openFolder();
    if (!folder) {
      this.tracker.observe(fact);
      return { status: 'not-recorded' };
    }
    const check = ArcadeEventSchema.safeParse({
      ...fact,
      schema: EVENT_SCHEMA_VERSION,
      eventId: '00000000000000000000000000',
      sessionId: folder.sessionId,
      seq: 1,
      receivedAt: fact.occurredAt,
    });
    if (!check.success || !isBoardFact(check.data)) {
      return { status: 'rejected', reason: 'invalid', message: check.error?.message ?? 'not a board fact' };
    }
    // Log the validated copy: zod has dropped anything the schema does not know.
    const { type, payload, source, occurredAt, causationId, correlationId } = check.data;
    const clean = {
      type,
      payload,
      source,
      occurredAt,
      ...(causationId !== undefined ? { causationId } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    } as BoardFactDraft;
    const result = await this.commit(folder, (batch, decider) => {
      const appended = batch.emit(clean);
      decider.deriveFromFact(appended);
    });
    if (result.status === 'applied') this.tracker.observe(fact);
    return result;
  }

  private async processCommand(input: unknown): Promise<HostResult> {
    const parsed = ArcadeCommandSchema.safeParse(input);
    if (!parsed.success) return { status: 'rejected', reason: 'invalid', message: parsed.error.message };
    const cmd = parsed.data;
    if (this.appliedCommands.has(cmd.commandId) || this.folder?.causationIds.has(cmd.commandId)) {
      return { status: 'duplicate' };
    }
    try {
      if (cmd.type === 'StartSession') {
        if (this.openFolder()) reject('session-open', 'close the current session first');
        return await this.startSession(cmd.payload, cmd);
      }
      if (cmd.type === 'Rematch') return await this.rematch(cmd);
    } catch (e) {
      if (e instanceof Rejection) return rejected(e);
      throw e;
    }
    if (!this.folder) return { status: 'rejected', reason: 'no-session', message: 'no session' };
    const folder = this.openFolder();
    if (!folder) return { status: 'rejected', reason: 'session-closed', message: 'the session is closed' };
    const result = await this.commit(folder, (_batch, decider) => decider.decideCommand(cmd));
    if (result.status === 'applied') this.appliedCommands.add(cmd.commandId);
    return result;
  }

  /**
   * Runs one decision against the live folder, appends what it produced, then publishes. A
   * rejected decision or a failed append rebuilds the folder from the persisted log, so the
   * state is exactly what it was before the input.
   */
  private async commit(folder: SessionFolder, decide: (batch: Batch, decider: Decider) => void): Promise<HostResult> {
    const sessionId = folder.sessionId!;
    const firstSeq = folder.lastSeq + 1;
    const batch = new Batch(folder, sessionId, this.deps.ids, this.deps.clock());
    try {
      decide(batch, new Decider(batch, this.uiVersion));
    } catch (e) {
      if (batch.events.length > 0) this.rebuild();
      if (e instanceof Rejection) return rejected(e);
      throw e;
    }
    if (batch.events.length === 0) return { status: 'noop' };
    this.appending = true;
    try {
      await this.deps.store.append(sessionId, batch.events);
    } catch (e) {
      this.rebuild();
      throw e;
    } finally {
      this.appending = false;
    }
    this.log.push(...batch.events);
    this.publish(folder, batch.events, firstSeq);
    return { status: 'applied', events: batch.events };
  }

  private rebuild(): void {
    this.folder = SessionFolder.fromLog(this.log, this.deps.games, this.deps.fold);
  }

  private publish(folder: SessionFolder, events: readonly ArcadeEvent[], firstSeq: number): void {
    this.snapshot = folder.snapshot();
    const effects: EngineEffect[] = folder.drainEffects(firstSeq).map((e) => ({ type: 'game', ...e }));
    const adjusted: string[] = [];
    let adjustedSeq = 0;
    for (const e of events) {
      const isCorrection =
        e.type === 'DartCorrected' ||
        e.type === 'DartVoided' ||
        (e.type === 'DartAdded' && !folder.dart(e.payload.throwId)!.live && !folder.dart(e.payload.throwId)!.padded);
      if (isCorrection) {
        adjusted.push(e.payload.throwId);
        adjustedSeq ||= e.seq;
      }
    }
    if (adjusted.length > 0) effects.push({ type: 'score-adjusted', seq: adjustedSeq, throwIds: adjusted });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        rethrowLater(err);
      }
    }
    if (effects.length === 0) return;
    for (const listener of [...this.effectListeners]) {
      try {
        listener(effects);
      } catch (err) {
        rethrowLater(err);
      }
    }
  }

  private async startSession(params: SessionParams, cmd: ArcadeCommand): Promise<HostResult> {
    const { games, ids } = this.deps;
    const game = games(params.gameId) ?? reject('unknown-game', `no game "${params.gameId}"`);
    const options = game.options.safeParse(params.options);
    if (!options.success) reject('invalid-options', options.error.message);
    const { min, max } = game.manifest.players;
    if (params.players.length < min || params.players.length > max) {
      reject('player-count', `${game.manifest.name} takes ${min}–${max} players`);
    }
    const playerIds = params.players.map((p) => p.playerId);
    const turnOrder = [...(params.turnOrder ?? playerIds)];
    const sorted = [...playerIds].sort();
    const orderSorted = [...turnOrder].sort();
    if (new Set(playerIds).size !== playerIds.length || orderSorted.join() !== sorted.join()) {
      reject('invalid-turn-order', 'turnOrder must list every player exactly once');
    }

    const sessionId = ids();
    const folder = new SessionFolder(games, this.deps.fold);
    const batch = new Batch(folder, sessionId, ids, this.deps.clock());
    const decider = new Decider(batch, this.uiVersion);
    batch.emit({
      type: 'SessionStarted',
      payload: {
        gameId: game.manifest.id,
        gameVersion: game.manifest.version,
        options: isPlainRecord(options.data) ? options.data : params.options,
        players: [...params.players],
        turnOrder,
        rngSeed: ids(),
        houseRules: params.houseRules ?? this.deps.defaultHouseRules ?? DEFAULT_HOUSE_RULES,
      },
      source: decider.manual(cmd.actor),
      occurredAt: cmd.issuedAt,
      causationId: cmd.commandId,
    });
    // Darts already in the board are recorded as baseline: never scored, and the first turn
    // waits until the board is clear (ARCHITECTURE §6.3).
    for (const d of this.tracker.onBoard()) {
      batch.emit({
        type: 'DartDetected',
        payload: {
          throwId: d.throwId,
          segment: d.segment,
          ...(d.coords ? { coords: d.coords } : {}),
          visitKey: d.visitKey,
          indexInVisit: d.indexInVisit,
          ...(d.recovered ? { recovered: true as const } : {}),
          ...(d.pendingReview ? { pendingReview: true as const } : {}),
        },
        source: d.source,
        occurredAt: d.occurredAt,
        causationId: cmd.commandId,
      });
    }
    if (folder.baselineLive() === 0) decider.startNextTurn(cmd.commandId);

    await this.deps.store.append(sessionId, batch.events);
    this.folder = folder;
    this.log = [...batch.events];
    this.appliedCommands.add(cmd.commandId);
    this.publish(folder, batch.events, 1);
    return { status: 'applied', events: batch.events };
  }

  private async rematch(cmd: CommandOf<'Rematch'>): Promise<HostResult> {
    const folder = this.folder ?? reject('no-session', 'no session to rematch');
    const events: ArcadeEvent[] = [];
    if (!folder.closed) {
      const closing = await this.commit(folder, (batch, decider) => {
        decider.assertCanComplete();
        batch.emit({
          type: 'SessionClosed',
          payload: { outcome: 'completed', finalStandings: [...(folder.standings() ?? [])] },
          source: decider.manual(cmd.actor),
          occurredAt: cmd.issuedAt,
          causationId: cmd.commandId,
        });
      });
      if (closing.status !== 'applied') return closing;
      events.push(...closing.events);
    }
    const p = folder.started.payload;
    const started = await this.startSession(
      { gameId: p.gameId, options: p.options, players: p.players, turnOrder: p.turnOrder, houseRules: p.houseRules },
      cmd,
    );
    if (started.status !== 'applied') return started;
    return { status: 'applied', events: [...events, ...started.events] };
  }
}

/** The newest session that has no SessionClosed: the one W0/W1 offers to resume. */
export async function findResumableSession(store: LogStore): Promise<string | null> {
  const sessions = await store.listSessions();
  return sessions.find((s) => !s.closed && s.lastSeq > 0)?.sessionId ?? null;
}

export function createSessionHost(deps: SessionHostDeps): SessionHost {
  return new SessionHost(deps);
}
