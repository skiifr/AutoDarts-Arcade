import { rebuildVisitState, reportLater, type BoardSource } from '@arcade/adapters';
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
  /**
   * Board facts have no caller to answer: a fact the host refused or could not persist is
   * reported here (default: ignored). The host's state is then exactly what it was before it.
   */
  onError?: (problem: { fact?: BoardFactDraft; command?: ArcadeCommand; error?: unknown; result?: HostResult }) => void;
}

export type CommandPayload<T extends ArcadeCommandType> = CommandOf<T>['payload'];

type Listener = () => void;
type EffectListener = (effects: readonly EngineEffect[]) => void;

/**
 * The app's engine room (ARCHITECTURE §5.4), framework-free: one `BoardSource` feeding one
 * `SessionHost`. Board facts go to `host.ingest` in the order the source emitted them, before
 * a session exists too (the host remembers those darts as baseline); commands are queued with
 * them, so a command and the facts around it are applied in arrival order. `subscribe` and
 * `getSnapshot` fit `useSyncExternalStore` and stay valid when `resumeSession` swaps the host.
 * The React Native AppState hook calls `appBackground` / `appForeground`.
 */
export class ArcadeRuntime {
  readonly source: BoardSource;
  private readonly o: ArcadeRuntimeOptions;
  private current: SessionHost;
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private unsubscribeSource: (() => void) | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly effectListeners = new Set<EffectListener>();
  private detachHost: () => void = () => {};

  constructor(options: ArcadeRuntimeOptions) {
    this.o = options;
    this.source = options.source;
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
    this.unsubscribeSource = this.source.subscribe((fact) => this.ingest(fact));
    this.source.start();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
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
   * source if the runtime is running; its first connection resyncs against that state. Inputs
   * that arrive meanwhile wait and go to the resumed host. Resolves with the resumed state.
   */
  resumeSession(sessionId: string): Promise<SessionState | null> {
    return this.enqueue(async () => {
      const restorable = this.source.restore !== undefined;
      const restart = this.running && restorable;
      if (restart) this.source.stop();
      try {
        const host = await SessionHost.resume(this.hostDeps(), sessionId);
        if (restorable) {
          const facts = host.getLog().filter((e) => isBoardFact(e));
          this.source.restore!(rebuildVisitState(facts, this.o.ids));
        }
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

  // ── internals ──────────────────────────────────────────────────────────────

  private ingest(fact: BoardFactDraft): void {
    void this.enqueue(async () => {
      try {
        const result = await this.current.ingest(fact);
        if (result.status === 'rejected') this.o.onError?.({ fact, result });
      } catch (error) {
        this.o.onError?.({ fact, error });
      }
    });
  }

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
