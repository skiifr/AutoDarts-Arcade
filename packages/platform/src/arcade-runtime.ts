import {
  LINK_LOSS_MS,
  epochMsFromIso,
  isoFromEpochMs,
  rebuildVisitState,
  reportLater,
  type BoardSource,
  type RestoredVisitState,
  type Scheduler,
  type TimerHandle,
} from '@arcade/adapters';
import {
  SessionHost,
  type Clock,
  type EngineEffect,
  type FoldOptions,
  type GameRegistry,
  type HostResult,
  type IdSource,
  type LogStore,
  type SessionState,
} from '@arcade/engine';
import {
  COMMAND_SCHEMA_VERSION,
  isBoardFact,
  type ArcadeCommand,
  type ArcadeCommandType,
  type BoardFactDraft,
  type CommandOf,
  type HouseRules,
} from '@arcade/event-schema';
import type { ContactStore } from './contact-store';
import { systemScheduler } from './runtime';

export * from './contact-store';

/**
 * Something the runtime could not do, reported to `onError`: a board fact the host refused
 * (`result`), a board fact it could not persist (`error` and `recovery`), or a failed
 * `ContactStore` read or write (`error` alone).
 */
export interface RuntimeProblem {
  fact?: BoardFactDraft;
  command?: ArcadeCommand;
  error?: unknown;
  result?: HostResult;
  /**
   * What the runtime did about a board fact it could not persist (`LogStore.append` failed):
   * - `retried`: the second append worked, nothing was lost;
   * - `resync`: it failed again, so the source's visit state was rebuilt from the log and the
   *   source re-reads the board. What the fact said comes back as recovered, and its turn is
   *   flagged for review (owner decision R);
   * - `none`: the source cannot be rebuilt (it has no visit state): the fact is lost, and this
   *   report is all that is left of it.
   */
  recovery?: 'retried' | 'resync' | 'none';
}

export interface ArcadeRuntimeOptions {
  /** Where board facts come from: the live adapter (`connectBoard`), the simulator or manual play. */
  source: BoardSource;
  store: LogStore;
  /** The app passes `gameRegistry(GAMES)`. */
  games: GameRegistry;
  clock: Clock;
  ids: IdSource;
  defaultHouseRules?: HouseRules;
  fold?: FoldOptions;
  /** `source.adapterVersion` of events caused by commands. */
  uiVersion?: string;
  /** Timers for the contact heartbeat and the recovery pauses. Default: the system's (`systemScheduler`). */
  scheduler?: Scheduler;
  /**
   * Where the last contact with the board is kept across a crash (§6.5). While the source is
   * online and a session is open, the runtime records the source's own `lastContactAt()` every
   * `CONTACT_EVERY_MS`, and `resumeSession` measures the outage from the later of it and the
   * log's last reading. Without one, a resume after a quiet spell counts the whole spell as an
   * outage, and may infer a takeout that never happened (§6.4). The app backs it with its
   * key-value storage.
   */
  contactStore?: ContactStore;
  /**
   * Board facts have no caller to answer: a fact the host refused, and a fact it could not
   * persist, are reported here (with what was done about it, `RuntimeProblem.recovery`).
   * Default: `console.error`.
   */
  onError?: (problem: RuntimeProblem) => void;
}

export type CommandPayload<T extends ArcadeCommandType> = CommandOf<T>['payload'];

/**
 * Pauses before rebuilding the source again while the storage keeps refusing appends: the
 * first rebuild is immediate, the next ones wait this long (the last value repeats), so a dead
 * disk does not turn into a reconnect loop against the board.
 */
export const RECOVERY_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000];

/**
 * How often the runtime records the last contact with an online board (`contactStore`). A crash
 * loses at most this much of it: a relaunch within 1.5 s then measures at most 1.5 s, plus this,
 * plus LINK_LOSS_MS, plus the reconnect, which stays under MIN_UNSEEN_VISIT_MS (3 s). A tiny
 * key-value write four times a second.
 */
export const CONTACT_EVERY_MS = 250;

/** A heartbeat this late means the app was frozen (suspended, asleep): it proves nothing (as the adapter's). */
const LATE_TICK_MS = 500;

type Listener = () => void;
type EffectListener = (effects: readonly EngineEffect[]) => void;

/**
 * The app's engine room (ARCHITECTURE §5.4), framework-free: one `BoardSource` feeding one
 * `SessionHost`. Board facts go to `host.ingest` in the order the source emitted them, before
 * a session exists too (the host remembers those darts as baseline); commands are queued with
 * them, so a command and the facts around it are applied in arrival order. `subscribe` and
 * `getSnapshot` fit `useSyncExternalStore` and stay valid when `resumeSession` swaps the host.
 * The React Native AppState hook calls `appBackground` / `appForeground`.
 *
 * A board fact the log could not take is never dropped silently (RISK-REGISTER R28): the append
 * is retried once, and if it fails again the source is rebuilt from the log and re-reads the
 * board, so the fact comes back as recovered and its turn is flagged (`RuntimeProblem`).
 */
export class ArcadeRuntime {
  readonly source: BoardSource;
  private readonly o: ArcadeRuntimeOptions;
  private readonly scheduler: Scheduler;
  private current: SessionHost;
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private unsubscribeSource: (() => void) | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly effectListeners = new Set<EffectListener>();
  private detachHost: () => void = () => {};

  /**
   * Bumped whenever the source's visit state is replaced (a recovery, a resume): facts it sent
   * before that and still queued are stale, and the source reads the board again anyway.
   */
  private sourceGen = 0;
  /** Rebuilds of the source since an append last worked (for the recovery pauses). */
  private failedRecoveries = 0;
  private recoveryTimer: TimerHandle | null = null;
  /**
   * A recovery is due the next time the source starts (the runtime was stopped meanwhile), with
   * the contact from before the lost fact.
   */
  private restoreOnStart: { contactMs: number | null } | null = null;
  /** The latest SourceConnectionChanged said online. */
  private sourceOnline = false;
  /**
   * Wall-clock ms of the last contact: a fact received, or an on-time heartbeat, while the source
   * was online. The board was in sight then.
   */
  private contactMs: number | null = null;
  /**
   * Facts received and not yet through the host. A contact is only as good as the log: while
   * one is pending, the board's state at a heartbeat may hold what the log will never get.
   */
  private unsettled = 0;
  private contactTimer: TimerHandle | null = null;
  private contactArmed: { mono: number; wall: number | undefined } = { mono: 0, wall: undefined };
  /** The last contact this run recorded in the `contactStore`, and for which session. */
  private recorded: { sessionId: string; ms: number } | null = null;

  constructor(options: ArcadeRuntimeOptions) {
    this.o = options;
    this.source = options.source;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.current = new SessionHost(this.hostDeps());
    this.attach(this.current);
  }

  /** The session host in use. `resumeSession` replaces it. */
  get host(): SessionHost {
    return this.current;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Starts listening to the source and starts it. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribeSource = this.source.subscribe((fact) => this.receive(fact));
    if (this.restoreOnStart) {
      const { contactMs } = this.restoreOnStart;
      this.restoreOnStart = null;
      this.restoreSource(this.restoredState(this.current, { contactMs }));
    }
    this.source.start();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clearRecoveryTimer();
    this.setOnline(false);
    this.source.stop();
    this.unsubscribeSource?.();
    this.unsubscribeSource = null;
  }

  /** The app went to the background: pause the game (`Pause{app-background}`). */
  appBackground(): Promise<HostResult> {
    return this.command('Pause', { reason: 'app-background' });
  }

  /**
   * The app is back: re-read the board at once (iOS drops sockets while suspended, §6.4) and lift
   * the `app-background` pause.
   */
  appForeground(): Promise<HostResult> {
    if (this.running) this.source.resync?.();
    return this.command('Resume', { reason: 'app-background' });
  }

  /**
   * Crash-resume (§6.5): rebuilds the host from the persisted log (`SessionHost.resume`) and the
   * source's visit state from the log's board facts (`rebuildVisitState`), then (re)starts the
   * source if the runtime is running; its first connection resyncs against that state, measuring
   * the outage from the last contact (the log's, or the `contactStore`'s if later). Inputs that
   * arrive meanwhile wait and go to the resumed host. Resolves with the resumed state.
   */
  resumeSession(sessionId: string): Promise<SessionState | null> {
    return this.enqueue(async () => {
      const restorable = this.source.restore !== undefined;
      const restart = this.running && restorable;
      if (restart) this.stopSource();
      try {
        const host = await SessionHost.resume(this.hostDeps(), sessionId);
        if (restorable) {
          this.restoreOnStart = null;
          this.restoreSource(this.restoredState(host, { stored: await this.storedContact(sessionId) }));
        }
        // A contact made while another session was open says nothing about this one's board.
        if (this.current.getSnapshot()?.sessionId !== sessionId) this.contactMs = null;
        this.detachHost();
        this.current = host;
        this.attach(host);
        this.notify();
        return host.getSnapshot();
      } finally {
        if (restart) this.source.start();
      }
    });
  }

  // ── inputs ─────────────────────────────────────────────────────────────────

  /** A command from the UI or a companion, applied after everything received before it. */
  dispatch(command: ArcadeCommand): Promise<HostResult> {
    return this.enqueue(() => this.current.dispatch(command));
  }

  /** Builds a command envelope (fresh commandId, the clock's issuedAt) and dispatches it. */
  command<T extends ArcadeCommandType>(type: T, payload: CommandPayload<T>, actor: ArcadeCommand['actor'] = 'operator'): Promise<HostResult> {
    const cmd = { schema: COMMAND_SCHEMA_VERSION, commandId: this.o.ids(), type, payload, actor, issuedAt: this.o.clock() } as ArcadeCommand;
    return this.dispatch(cmd);
  }

  /** Resolves once every fact and command received so far has been applied. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const q = this.queue;
      await q.then(
        () => undefined,
        () => undefined,
      );
      if (q === this.queue) break;
    }
    await this.current.whenIdle();
  }

  // ── outputs (stable across resumeSession) ───────────────────────────────────

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionState | null => this.current.getSnapshot();

  subscribeEffects(listener: EffectListener): () => void {
    this.effectListeners.add(listener);
    return () => this.effectListeners.delete(listener);
  }

  // ── board facts ────────────────────────────────────────────────────────────

  private receive(fact: BoardFactDraft): void {
    // The contact before this fact: if the log loses the fact, what the source knew from here on
    // is lost with it, and a rebuilt source must measure its outage from no later than this.
    const before = this.contactMs;
    if (fact.type === 'SourceConnectionChanged') this.setOnline(fact.payload.state === 'online');
    if (this.sourceOnline) this.noteContact(epochMsFromIso(fact.occurredAt));
    const gen = this.sourceGen;
    this.unsettled++;
    void this.enqueue(async () => {
      try {
        await this.apply(fact, gen, before);
      } finally {
        this.unsettled--;
      }
    });
  }

  private async apply(fact: BoardFactDraft, gen: number, contactBefore: number | null): Promise<void> {
    // Sent before the source was rebuilt: it reads the board again, this is stale.
    if (gen !== this.sourceGen) return;
    let result: HostResult;
    try {
      result = await this.current.ingest(fact);
    } catch (first) {
      // LogStore.append failed: the host is back where it was, but the source has moved on and
      // will not send this fact again. Try once more...
      try {
        result = await this.current.ingest(fact);
      } catch (error) {
        // ...then rebuild the source from the log, so it reads the board again (R28).
        this.report({ fact, error, recovery: this.recoverSource(contactBefore) });
        return;
      }
      this.report({ fact, error: first, recovery: 'retried' });
    }
    if (result.status === 'applied') this.failedRecoveries = 0;
    if (result.status === 'rejected') this.report({ fact, result });
  }

  /**
   * The log lost a board fact. The source's visit state is ahead of the log (a dart no turn
   * holds, a takeout that ended no turn), so it is rebuilt from the log and the source re-reads
   * the board: what the log lost comes back as recovered, or as an inferred takeout, and is
   * flagged (§6.4). Facts the source sent after the lost one are dropped with it, and so is the
   * contact they brought: the outage is measured from `contactBefore`, the last contact before
   * the lost fact (a lost inferred takeout is then inferred again). While the storage keeps
   * failing the source waits, longer each time (`RECOVERY_BACKOFF_MS`).
   */
  private recoverSource(contactBefore: number | null): RuntimeProblem['recovery'] {
    if (this.source.restore === undefined) return 'none';
    this.sourceGen++;
    this.contactMs = contactBefore;
    if (!this.running) {
      this.restoreOnStart = { contactMs: contactBefore };
      return 'resync';
    }
    this.stopSource();
    const attempt = this.failedRecoveries++;
    if (attempt === 0) {
      this.restartSource();
    } else {
      const delay = RECOVERY_BACKOFF_MS[Math.min(attempt - 1, RECOVERY_BACKOFF_MS.length - 1)]!;
      this.recoveryTimer = this.scheduler.setTimeout(() => {
        this.recoveryTimer = null;
        void this.enqueue(async () => this.restartSource());
      }, delay);
    }
    return 'resync';
  }

  private restartSource(): void {
    if (!this.running) return;
    this.restoreSource(this.restoredState(this.current, { contactMs: this.contactMs }));
    this.source.start();
  }

  /** Stops the source on the runtime's behalf (it emits nothing about it). */
  private stopSource(): void {
    this.clearRecoveryTimer();
    this.setOnline(false);
    this.source.stop();
  }

  private restoreSource(state: RestoredVisitState): void {
    this.sourceGen++;
    this.source.restore!(state);
  }

  /**
   * The source's visit state from `host`'s log, with the last time the board was in sight, the
   * latest of:
   * - the log's own (`observedAt`, the latest reading it holds);
   * - this run's contact (`contactMs`, only while it plays this very session);
   * - `stored`, the source's `lastContactAt()` recorded before a crash.
   * The connection ended (a crash, or the runtime let it go), so, as for any connection that ends
   * (§6.4), the log's reading and this run's contact count only up to LINK_LOSS_MS before them:
   * frames the board sent just before may never have arrived. `stored` already counts so (the
   * adapter's `lastContactAt` applies its own contact rules) and is taken as it is. The adapter's
   * `restore()` takes the result as `observedAt`.
   */
  private restoredState(host: SessionHost, known: { contactMs?: number | null; stored?: string | undefined }): RestoredVisitState {
    const state = rebuildVisitState(host.getLog().filter((e) => isBoardFact(e)), this.o.ids);
    const fromLog = state.observedAt === undefined ? undefined : epochMsFromIso(state.observedAt);
    const storedMs = known.stored === undefined ? undefined : epochMsFromIso(known.stored);
    const playing = this.current.getSnapshot()?.sessionId;
    const sameSession = playing !== undefined && host.getSnapshot()?.sessionId === playing;
    const liveMs = known.contactMs === undefined ? this.contactMs : known.contactMs;
    const live = sameSession && liveMs !== null ? liveMs : undefined;
    const ended = (ms: number | undefined): number | undefined => (ms === undefined ? undefined : ms - LINK_LOSS_MS);
    const contacts = [ended(fromLog), ended(live), storedMs].filter((ms): ms is number => ms !== undefined);
    if (contacts.length > 0) state.observedAt = isoFromEpochMs(Math.max(...contacts));
    return state;
  }

  private noteContact(ms: number | undefined): void {
    if (ms !== undefined && (this.contactMs === null || ms > this.contactMs)) this.contactMs = ms;
  }

  // ── contact heartbeat (ContactStore) ────────────────────────────────────────

  private setOnline(online: boolean): void {
    this.sourceOnline = online;
    if (online) this.armContactTick();
    else if (this.contactTimer !== null) {
      this.scheduler.clearTimeout(this.contactTimer);
      this.contactTimer = null;
    }
  }

  private armContactTick(): void {
    if (this.o.contactStore === undefined || this.contactTimer !== null) return;
    this.contactArmed = { mono: this.scheduler.now(), wall: epochMsFromIso(this.o.clock()) };
    this.contactTimer = this.scheduler.setTimeout(() => this.contactTick(), CONTACT_EVERY_MS);
  }

  /**
   * While the source is online the board's state is known: it pushes every change, and the
   * adapter reconnects at once when it cannot. So an on-time heartbeat is contact. A late one
   * (the app was frozen) proves nothing, as in the adapter. What is stored is the source's own
   * `lastContactAt()`: the adapter's contact rules, LINK_LOSS_MS included, already applied. A
   * source without one stores the heartbeat less LINK_LOSS_MS, which comes to the same rule.
   *
   * The record only moves forward while the board stays online. The adapter's own goes back to
   * its last frame or read while a liveness poll is out (an idle socket, every 5 s, for as long
   * as the read takes); recording that would make a crash in the next moment look like a 5 s
   * outage, though a crash just before the poll measures from the heartbeats. Both are the
   * heartbeat's limit on a socket that died without closing (§6.4).
   */
  private contactTick(): void {
    this.contactTimer = null;
    if (!this.running || !this.sourceOnline) return;
    const wall = epochMsFromIso(this.o.clock());
    const limit = CONTACT_EVERY_MS + LATE_TICK_MS;
    const onTime =
      this.scheduler.now() - this.contactArmed.mono <= limit &&
      (wall === undefined || this.contactArmed.wall === undefined || wall - this.contactArmed.wall <= limit);
    const snapshot = this.current.getSnapshot();
    // With a fact still on its way to the log, the board's state now may be more than the log
    // will ever hold: no contact until it is through.
    if (onTime && wall !== undefined && this.unsettled === 0) {
      this.noteContact(wall);
      if (snapshot !== null && snapshot.closed === null) {
        const at = this.source.lastContactAt ? this.source.lastContactAt() : isoFromEpochMs(wall - LINK_LOSS_MS);
        const ms = at === undefined ? undefined : epochMsFromIso(at);
        const last = this.recorded?.sessionId === snapshot.sessionId ? this.recorded.ms : undefined;
        if (at !== undefined && ms !== undefined && (last === undefined || ms > last)) {
          this.recorded = { sessionId: snapshot.sessionId, ms };
          this.o.contactStore!.set(snapshot.sessionId, at).catch((error: unknown) => this.report({ error }));
        }
      }
    }
    this.armContactTick();
  }

  private async storedContact(sessionId: string): Promise<string | undefined> {
    try {
      return await this.o.contactStore?.get(sessionId);
    } catch (error) {
      this.report({ error });
      return undefined;
    }
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      this.scheduler.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private report(problem: RuntimeProblem): void {
    try {
      (this.o.onError ?? logProblem)(problem);
    } catch (err) {
      reportLater(err);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private hostDeps() {
    const o = this.o;
    return {
      store: o.store,
      clock: o.clock,
      ids: o.ids,
      games: o.games,
      ...(o.defaultHouseRules ? { defaultHouseRules: o.defaultHouseRules } : {}),
      ...(o.fold ? { fold: o.fold } : {}),
      ...(o.uiVersion ? { uiVersion: o.uiVersion } : {}),
    };
  }

  private attach(host: SessionHost): void {
    const offState = host.subscribe(() => this.notify());
    const offEffects = host.subscribeEffects((effects) => {
      for (const l of [...this.effectListeners]) guarded(() => l(effects));
    });
    this.detachHost = () => {
      offState();
      offEffects();
    };
  }

  private notify(): void {
    for (const l of [...this.listeners]) guarded(l);
  }
}

/** The default `onError`: board facts have no caller to tell, so the problem goes to the console. */
function logProblem(p: RuntimeProblem): void {
  const what = p.fact?.type ?? p.command?.type;
  let message: string;
  if (what === undefined) message = 'the contact store failed';
  else if (p.result?.status === 'rejected') message = `${what} refused (${p.result.reason}): ${p.result.message}`;
  else message = `${what} could not be stored (recovery: ${p.recovery ?? 'none'})`;
  console.error(`[arcade-runtime] ${message}`, p.error ?? '');
}

/** One listener's error must not keep the others from hearing about the change. */
function guarded(listener: () => void): void {
  try {
    listener();
  } catch (err) {
    reportLater(err);
  }
}

export function createArcadeRuntime(options: ArcadeRuntimeOptions): ArcadeRuntime {
  return new ArcadeRuntime(options);
}
