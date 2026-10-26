import type { BoardFactDraft, EventSource } from '@arcade/event-schema';
import type { BoardGetPath } from '../endpoints';
import { Listeners, type BoardSource, type Clock, type EventsSocket, type FactListener, type HttpResponse, type IdSource, type RandomSource, type Scheduler, type TimerHandle, type Transport } from '../ports';
import { MAX_FRAME_CHARS, cleanNote, excerpt, parseEventFrame, parseStateBody, serialize } from '../raw';
import { RawFrameRing, type RawChannel } from '../ring-buffer';
import { epochMsFromIso, isoFromEpochMs } from '../simulator/iso-time';
import type { RestoredVisitState } from './rebuild';
import { toSnapshot, type Snapshot } from './snapshot';
import { boardStatusOf, isKnownStatus, isStuckTakeoutCandidate, parseVersion, profileFor, type BoardStatus } from './status';
import { VisitTracker, type ApplyMode, type TrackerFact, type VisitState } from './visit-tracker';

export const AUTODARTS_LOCAL_ADAPTER_VERSION = 'autodarts-local@0.1.0';

/**
 * Reconnect schedule. §6.4 sketches 0.5, 1, 2, 4, then 5 s; NF5 needs a resync within 2 s
 * of the board becoming reachable, which a 5 s wait cannot meet. While the board is
 * unreachable an attempt costs the board nothing, so the adapter retries after 0.25 and
 * 0.5 s and then every 0.75 s (±20 % jitter, so at most 0.9 s between attempts), and gives
 * a connection attempt 1 s. Worst case, an attempt that hangs just as the board comes back
 * times out after 1 s and the next one starts within 0.9 s: online in under 2 s. When the
 * board answers but refuses the socket or the state read three times in a row, the
 * adapter slows to §6.4's 5 s cap, which keeps a misbehaving board light. Polls while
 * online get 2 s, so a busy Pi is not mistaken for a dead one.
 */
export interface AdapterTiming {
  /** Delay before attempt n+1 after attempt n failed; the last value repeats. */
  backoffMs: readonly number[];
  /** Backoff once the board has answered but refused this many attempts in a row. */
  refusedAfter: number;
  refusedBackoffMs: number;
  /** ± fraction applied to every backoff delay. */
  jitter: number;
  /** Delay before reconnecting after an established connection is lost. */
  reconnectAfterLossMs: number;
  /** Timeout for the connection attempt: `GET /api/version` and the socket handshake. */
  connectTimeoutMs: number;
  /** Poll `GET /api/state` after this long without frames (§6.4, NF8). */
  livenessMs: number;
  /** Retry delay after one failed liveness poll; two failures in a row → offline. */
  livenessRetryMs: number;
  /** Timeout for `GET /api/state` (resync snapshot and polls). */
  requestTimeoutMs: number;
  /** A takeout on an empty board longer than this is reported as stuck (§6.3, R13). */
  stuckTakeoutMs: number;
  /**
   * Heartbeat while online. The board pushes every change and is silent otherwise, so an open,
   * healthy socket means its state is known: each heartbeat that fires on time counts as
   * contact (see `awayMs`).
   */
  contactTickMs: number;
}

export const DEFAULT_TIMING: AdapterTiming = {
  backoffMs: [250, 500, 750],
  refusedAfter: 3,
  refusedBackoffMs: 5000,
  jitter: 0.2,
  reconnectAfterLossMs: 100,
  connectTimeoutMs: 1000,
  livenessMs: 5000,
  livenessRetryMs: 1000,
  requestTimeoutMs: 2000,
  stuckTakeoutMs: 8000,
  contactTickMs: 1000,
};

/** A heartbeat this late means the app was suspended or the device slept: it proves nothing. */
const LATE_TICK_MS = 500;

/**
 * When a connection breaks, the frames the board sent in its last moments may never have
 * arrived (they were in flight, or the link died before the device noticed). Contact counts
 * only up to this long before the break.
 */
export const LINK_LOSS_MS = 1000;

export type ConnectionPhase = 'stopped' | 'connecting' | 'resyncing' | 'online' | 'offline';

export interface ConnectionStatus {
  phase: ConnectionPhase;
  attempt: number;
  error?: string;
  upstreamVersion?: string;
}

export interface AutodartsLocalOptions {
  transport: Transport;
  scheduler: Scheduler;
  clock: Clock;
  ids: IdSource;
  /** Backoff jitter. */
  random: RandomSource;
  /** Visit state rebuilt from the log after a crash (`rebuildVisitState`). See also `restore()`. */
  restored?: RestoredVisitState;
  /**
   * Open `/api/events?type=state` instead of the bare path. Default: the version profile
   * (`profileFor`), which opens the bare path for every version and filters frames by type.
   */
  stateOnlySocket?: boolean;
  timing?: Partial<AdapterTiming>;
  /** Diagnostics buffer; one is created when omitted. */
  ring?: RawFrameRing;
  /** Test and diagnostics hooks, called before and after each snapshot is applied. */
  observer?: { beforeApply?(snapshot: Snapshot, mode: ApplyMode): void; afterApply?(snapshot: Snapshot, mode: ApplyMode): void };
  /**
   * Where an error thrown by a fact or status listener goes. It never unwinds the adapter.
   * Default: reported as an uncaught error, asynchronously.
   */
  onListenerError?: (err: unknown) => void;
}

/**
 * A request the transport has not settled this long after its own timeout is abandoned (the
 * attempt fails and is retried): the adapter never waits on a transport that broke its promise.
 */
export const REQUEST_WATCHDOG_SLACK_MS = 1000;

const MAX_DISTINCT_ANOMALIES = 64;
const MAX_CONFIRM_ROUNDS = 2;

/**
 * Frames kept while a resync's state read is out. A board sends a frame per change, so a handful
 * is normal; past this the oldest go (the read and the newest frames hold the latest state).
 */
export const MAX_BUFFERED_FRAMES = 64;

/**
 * The Autodarts local-API adapter (ARCHITECTURE §6). Reads `WS /api/events` and
 * `GET /api/state`, never writes to the board (decision S), and turns the board's
 * snapshots into layer-1 board facts.
 */
export class AutodartsLocalAdapter implements BoardSource {
  readonly kind = 'autodarts-local' as const;
  readonly ring: RawFrameRing;

  private readonly o: AutodartsLocalOptions;
  private readonly t: AdapterTiming;
  private readonly facts: Listeners<BoardFactDraft>;
  private readonly statusListeners: Listeners<ConnectionStatus>;
  private tracker: VisitTracker;

  private phase: ConnectionPhase = 'stopped';
  private gen = 0;
  private attempt = 0;
  private refusedInARow = 0;
  private socket: EventsSocket | null = null;
  private buffered: Snapshot[] = [];
  private upstreamVersion: string | undefined;
  private lastEmittedConn: string | undefined;
  /** Groups every fact of the resync in progress, from `resyncing` to `online` (§7.2). */
  private resyncCorrelation: string | undefined;

  private connectTimer: TimerHandle | null = null;
  private openTimer: TimerHandle | null = null;
  /** Abandons a resync that has not finished within its read's timeout plus the watchdog slack. */
  private resyncTimer: TimerHandle | null = null;
  private livenessTimer: TimerHandle | null = null;
  private stuckTimer: TimerHandle | null = null;

  private pollInFlight = false;
  private pollAgain = false;
  private pollFailures = 0;
  private confirmRounds = 0;

  /**
   * The last moment the board's state was known (monotonic and wall-clock ms; null when
   * unknown): a frame, a state read, or an on-time heartbeat of a healthy online socket.
   * `evidence` counts only frames and state reads, for when the socket itself is in doubt.
   */
  private contact: { mono: number | null; wall: number | null } = { mono: null, wall: null };
  private evidence: { mono: number | null; wall: number | null } = { mono: null, wall: null };
  private tickTimer: TimerHandle | null = null;
  private tickArmed: { mono: number; wall: number | null } = { mono: 0, wall: null };
  /** A liveness poll is out because the socket went quiet: heartbeats prove nothing meanwhile. */
  private socketInDoubt = false;

  private boardStatus: BoardStatus | undefined;
  private stuckReported = false;
  private readonly anomalyKeys = new Set<string>();
  private suppressedAnomalies = 0;

  constructor(options: AutodartsLocalOptions) {
    this.o = options;
    this.t = { ...DEFAULT_TIMING, ...options.timing };
    this.facts = new Listeners<BoardFactDraft>(options.onListenerError);
    this.statusListeners = new Listeners<ConnectionStatus>(options.onListenerError);
    this.ring = options.ring ?? new RawFrameRing();
    this.tracker = new VisitTracker(options.ids, options.restored);
    this.restoreContact(options.restored);
  }

  // ── public API ───────────────────────────────────────────────────────────

  subscribe(listener: FactListener): () => void {
    return this.facts.add(listener);
  }

  /** Live connection status for the UI (every retry, not only logged transitions). */
  onConnectionStatus(listener: (status: ConnectionStatus) => void): () => void {
    return this.statusListeners.add(listener);
  }

  connectionStatus(): ConnectionStatus {
    return this.statusOf();
  }

  /** The last board status reported, for the health sampler. */
  currentBoardStatus(): BoardStatus | undefined {
    return this.stuckReported ? 'stuck-takeout' : this.boardStatus;
  }

  /**
   * The last good contact with the board (ISO, the wall clock), as the adapter would count it if
   * the link broke now: a frame, a state read, or an on-time heartbeat of a healthy socket, no
   * later than LINK_LOSS_MS ago; once a liveness poll is out (the socket went quiet), only the
   * last frame or read. A half-open socket goes unnoticed until liveness fires, so for up to
   * `livenessMs` the value may run that much late. Undefined before any contact.
   */
  lastContactAt(): string | undefined {
    const from = this.phase === 'online' && this.socketInDoubt ? this.evidence : this.contact;
    const now = this.wallNow();
    let wall = from.wall;
    if (wall !== null && now !== null && this.phase === 'online') wall = Math.min(wall, now - LINK_LOSS_MS);
    return wall === null ? undefined : isoFromEpochMs(wall);
  }

  get version(): string | undefined {
    return this.upstreamVersion;
  }

  visitState(): VisitState {
    return this.tracker.state();
  }

  /**
   * Crash-resume (§6.5): continue from the visit state rebuilt from the session's log
   * (`rebuildVisitState`) instead of a fresh one. Only while stopped; the next `start()`
   * resyncs against it, judging the outage from the log's last contact.
   */
  restore(state: RestoredVisitState): void {
    if (this.phase !== 'stopped') throw new Error('restore() needs a stopped adapter');
    this.tracker = new VisitTracker(this.o.ids, state);
    this.restoreContact(state);
  }

  start(): void {
    if (this.phase !== 'stopped') return;
    this.attempt = 0;
    this.connect(1);
  }

  stop(): void {
    this.endContact();
    this.gen++;
    this.teardown();
    this.clear('connectTimer');
    this.phase = 'stopped';
    this.notifyStatus();
  }

  /**
   * Re-attach now, e.g. when the app returns to the foreground (§6.4: iOS drops sockets
   * on suspension). The fresh connection runs a full resync.
   */
  resync(): void {
    if (this.phase === 'stopped') return;
    this.endContact();
    this.gen++;
    this.teardown();
    this.clear('connectTimer');
    this.connect(1);
  }

  diagnostics(): { status: ConnectionStatus; visit: VisitState; suppressedAnomalies: number; rawJsonl: string } {
    return {
      status: this.statusOf(),
      visit: this.tracker.state(),
      suppressedAnomalies: this.suppressedAnomalies,
      rawJsonl: this.ring.exportJsonl(),
    };
  }

  // ── connection lifecycle (§6.4) ──────────────────────────────────────────

  private connect(attempt: number): void {
    const gen = ++this.gen;
    this.attempt = attempt;
    this.phase = 'connecting';
    this.emitConnection('connecting');
    this.get('/api/version', gen, this.t.connectTimeoutMs).then(
      (res) => {
        if (gen !== this.gen) return;
        if (res.status >= 200 && res.status < 300) {
          const v = parseVersion(res.body);
          if (v === undefined) this.anomalyOnce('version endpoint answered with no version', res.body);
          else this.upstreamVersion = v;
        } else {
          this.anomalyOnce(`version endpoint answered HTTP ${res.status}`, res.body);
        }
        this.openSocket(gen);
      },
      (err: unknown) => {
        if (gen === this.gen) this.attemptFailed(`board unreachable: ${errorText(err)}`, false);
      },
    );
  }

  private openSocket(gen: number): void {
    this.buffered = [];
    const stateOnly = this.o.stateOnlySocket ?? profileFor(this.upstreamVersion).stateOnlySocket;
    this.openTimer = this.o.scheduler.setTimeout(() => {
      this.openTimer = null;
      if (gen === this.gen && this.phase === 'connecting') this.attemptFailed('socket open timed out', true);
    }, this.t.connectTimeoutMs);
    this.socket = this.o.transport.openEvents(
      { stateOnly },
      {
        onOpen: () => {
          if (gen !== this.gen) return;
          this.clear('openTimer');
          this.phase = 'resyncing';
          this.resyncCorrelation = this.o.ids();
          this.emitConnection('resyncing');
          this.fetchResyncSnapshot(gen);
          // Whatever goes wrong in the resync, it cannot hold the adapter in `resyncing`.
          const limit = this.t.requestTimeoutMs + REQUEST_WATCHDOG_SLACK_MS;
          this.resyncTimer = this.o.scheduler.setTimeout(() => {
            this.resyncTimer = null;
            if (gen === this.gen && this.phase === 'resyncing') this.attemptFailed(`resync did not finish within ${limit} ms`, true);
          }, limit);
        },
        onMessage: (text) => {
          if (gen === this.gen) this.onFrame(text);
        },
        onRejectedFrame: (info) => {
          if (gen === this.gen) this.anomalyOnce(`transport dropped a ${info.reason} frame`, `${info.size} bytes`);
        },
        onClose: (info) => {
          if (gen !== this.gen) return;
          this.socket = null;
          const why = info.error ?? (info.code !== undefined ? `code ${info.code}` : 'closed');
          if (this.phase === 'connecting') this.attemptFailed(`socket refused: ${why}`, true);
          else this.connectionLost(`socket closed: ${why}`);
        },
      },
    );
  }

  private fetchResyncSnapshot(gen: number): void {
    const failed = (why: string): void => {
      if (this.buffered.length > 0) this.finishResync(null);
      else this.attemptFailed(`state read failed${why}`, true);
    };
    this.get('/api/state', gen).then(
      (res) => {
        if (gen !== this.gen) return;
        const read = this.safely('reading the resync state', res, () => {
          const parsed = res.status === 200 ? parseStateBody(res.body) : null;
          if (parsed && !parsed.ok) this.anomalyOnce(parsed.note, res.body);
          return { status: res.status, snap: parsed?.ok ? toSnapshot(parsed.data) : null };
        });
        if (gen !== this.gen) return;
        if (read?.snap) this.finishResync(read.snap);
        else failed(` (HTTP ${read?.status ?? 'unreadable'})`);
      },
      (err: unknown) => {
        if (gen === this.gen) failed(`: ${errorText(err)}`);
      },
    );
  }

  /**
   * Applies what arrived while resyncing. The first observation is the resync snapshot
   * (§6.4); later frames and the GET result are applied only if they are plain progress,
   * otherwise a confirming poll follows.
   */
  private finishResync(snapshot: Snapshot | null): void {
    const queue = snapshot ? [...this.buffered, snapshot] : [...this.buffered];
    this.buffered = [];
    this.clear('resyncTimer');
    const correlationId = this.resyncCorrelation ?? this.o.ids();
    let needsConfirm = false;
    const awayMs = this.awayMs();
    this.markContact(true);
    queue.forEach((snap, i) => {
      if (i === 0) this.applySnapshot(snap, 'resync', correlationId, awayMs);
      else if (this.safely('classifying a frame', snap.raw, () => this.tracker.classifyFrame(snap)) === 'apply') this.applySnapshot(snap, 'live');
      else needsConfirm = true;
    });
    this.phase = 'online';
    this.refusedInARow = 0;
    this.pollFailures = 0;
    this.emitConnection('online');
    this.resyncCorrelation = undefined;
    this.attempt = 0;
    this.socketInDoubt = false;
    this.armLiveness();
    this.armTick();
    if (needsConfirm) this.requestPoll();
  }

  private attemptFailed(error: string, refused: boolean): void {
    this.gen++; // ignore late callbacks from this attempt's socket and requests
    this.teardown();
    this.phase = 'offline';
    this.refusedInARow = refused ? this.refusedInARow + 1 : 0;
    const n = this.attempt;
    const base =
      this.refusedInARow >= this.t.refusedAfter
        ? this.t.refusedBackoffMs
        : (this.t.backoffMs[Math.min(n - 1, this.t.backoffMs.length - 1)] ?? 1000);
    const delay = Math.max(0, base * (1 + (this.o.random() * 2 - 1) * this.t.jitter));
    // The retry is armed before anyone hears about the failure.
    this.connectTimer = this.o.scheduler.setTimeout(() => {
      this.connectTimer = null;
      this.connect(n + 1);
    }, delay);
    this.emitConnection('offline', error);
  }

  private connectionLost(error: string, socketWasQuiet = false): void {
    // A socket that went quiet may have been dead since its last frame: heartbeats since then
    // proved nothing.
    if (socketWasQuiet) this.capContact(this.evidence);
    else this.endContact();
    this.gen++;
    this.teardown();
    this.phase = 'offline';
    this.attempt = 0;
    this.connectTimer = this.o.scheduler.setTimeout(() => {
      this.connectTimer = null;
      this.connect(1);
    }, this.t.reconnectAfterLossMs);
    this.emitConnection('offline', error);
  }

  private teardown(): void {
    this.clear('openTimer');
    this.clear('resyncTimer');
    this.clear('livenessTimer');
    this.clear('stuckTimer');
    this.clear('tickTimer');
    this.socketInDoubt = false;
    this.pollInFlight = false;
    this.pollAgain = false;
    this.confirmRounds = 0;
    this.buffered = [];
    this.resyncCorrelation = undefined;
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
  }

  // ── frames and polls ─────────────────────────────────────────────────────

  private onFrame(text: string): void {
    this.record('WS /api/events', text);
    this.pollFailures = 0; // a frame proves the socket is alive
    if (this.phase === 'online') {
      this.markContact(false);
      this.socketInDoubt = false;
    }
    if (text.length > MAX_FRAME_CHARS) {
      this.anomalyOnce(`frame over ${MAX_FRAME_CHARS} chars dropped`, text);
      return;
    }
    const snap = this.safely('reading a frame', text, () => {
      const parsed = parseEventFrame(text);
      if (parsed.kind === 'invalid') {
        this.anomalyOnce(parsed.note, text);
        return null;
      }
      // motion_state, cam_state, stats, cam_stats: they show the socket is alive but say nothing
      // about the darts, so they do not hold off the liveness poll (the self-healing read).
      if (parsed.kind === 'other') return null;
      return toSnapshot(parsed.data);
    });
    if (snap === null) return;
    if (snap === undefined) {
      // Unreadable for a reason we did not foresee: read the board's state instead.
      this.requestPoll();
      return;
    }
    if (this.phase === 'online') {
      this.markContact(true);
      this.armLiveness();
    }
    if (this.phase === 'resyncing') {
      if (this.buffered.length >= MAX_BUFFERED_FRAMES) {
        this.buffered.shift();
        this.anomalyOnce(`more than ${MAX_BUFFERED_FRAMES} frames during a resync: the oldest dropped`, '');
      }
      this.buffered.push(snap);
      return;
    }
    if (this.phase !== 'online') return;
    if (this.safely('classifying a frame', snap.raw, () => this.tracker.classifyFrame(snap)) === 'apply') this.applySnapshot(snap, 'live');
    else this.requestPoll();
  }

  /** One `GET /api/state` at a time: liveness, self-healing and frame confirmation. */
  private requestPoll(): void {
    if (this.phase !== 'online') return;
    if (this.pollInFlight) {
      this.pollAgain = true;
      return;
    }
    this.clear('livenessTimer');
    this.pollInFlight = true;
    const gen = this.gen;
    const changesAtIssue = this.tracker.changeCount;
    this.get('/api/state', gen).then(
      (res) => {
        if (gen !== this.gen) return;
        this.pollInFlight = false;
        this.pollFailures = 0;
        const snap = this.safely('reading a state poll', res, () => {
          const parsed = res.status === 200 ? parseStateBody(res.body) : null;
          if (parsed?.ok) return toSnapshot(parsed.data);
          this.anomalyOnce(parsed && !parsed.ok ? parsed.note : `state poll answered HTTP ${res.status}`, res.body);
          return null;
        });
        if (snap) {
          this.markContact(true);
          this.socketInDoubt = false;
          const fresh = this.tracker.changeCount === changesAtIssue;
          const plain = (): boolean => this.safely('classifying a state poll', snap.raw, () => this.tracker.classifyFrame(snap)) === 'apply';
          if (fresh || this.confirmRounds >= MAX_CONFIRM_ROUNDS || plain()) {
            this.confirmRounds = 0;
            this.applySnapshot(snap, 'live');
          } else {
            // Frames moved the state on while the poll was in flight: ask again.
            this.confirmRounds++;
            this.pollAgain = true;
          }
        }
        // Whatever the read held, liveness goes on.
        if (gen !== this.gen) return;
        this.armLiveness();
        if (this.pollAgain) {
          this.pollAgain = false;
          this.requestPoll();
        }
      },
      (err: unknown) => {
        if (gen !== this.gen) return;
        this.pollInFlight = false;
        this.pollAgain = false;
        this.pollFailures++;
        if (this.pollFailures >= 2) this.connectionLost(`liveness: ${errorText(err)}`, true);
        else this.livenessTimer = this.o.scheduler.setTimeout(() => this.livenessFired(), this.t.livenessRetryMs);
      },
    );
  }

  private armLiveness(): void {
    this.clear('livenessTimer');
    if (this.phase !== 'online' || this.pollInFlight) return;
    this.livenessTimer = this.o.scheduler.setTimeout(() => this.livenessFired(), this.t.livenessMs);
  }

  private livenessFired(): void {
    this.livenessTimer = null;
    this.socketInDoubt = true;
    this.requestPoll();
  }

  // ── contact: how long the board was out of sight (decision R, MIN_UNSEEN_VISIT_MS) ──

  private wallNow(): number | null {
    return epochMsFromIso(this.o.clock()) ?? null;
  }

  private markContact(evidence: boolean): void {
    const at = { mono: this.o.scheduler.now(), wall: this.wallNow() };
    this.contact = at;
    if (evidence) this.evidence = { ...at };
  }

  /**
   * The connection ends (it broke, or we let it go): contact counts only up to LINK_LOSS_MS before
   * now, whatever arrived last. A frame or read that came in during that second proves the board's
   * state when it was sent, but the frames after it may be the ones lost with the link, and it may
   * itself have been late; counting it would make the outage come out shorter than the time the
   * board was really out of sight.
   */
  private endContact(): void {
    if (this.phase !== 'online') return;
    this.capContact(this.contact);
  }

  /** Sets contact to `from`, but no later than LINK_LOSS_MS before now. */
  private capContact(from: { mono: number | null; wall: number | null }): void {
    const wall = this.wallNow();
    const cap = (v: number | null, now: number | null): number | null => (v === null || now === null ? v : Math.min(v, now - LINK_LOSS_MS));
    this.contact = { mono: cap(from.mono, this.o.scheduler.now()), wall: cap(from.wall, wall) };
  }

  private restoreContact(state: RestoredVisitState | undefined): void {
    const wall = state?.observedAt === undefined ? null : (epochMsFromIso(state.observedAt) ?? null);
    this.contact = { mono: null, wall };
    this.evidence = { mono: null, wall };
  }

  /**
   * How long the board has been out of sight: since the last contact, on the monotonic and on
   * the wall clock, whichever is longer (the monotonic clock may stop while the device sleeps;
   * the wall clock survives a crash). Undefined when neither is known: then anything may
   * have happened.
   */
  private awayMs(): number | undefined {
    const spans: number[] = [];
    if (this.contact.mono !== null) spans.push(this.o.scheduler.now() - this.contact.mono);
    const wall = this.wallNow();
    if (this.contact.wall !== null && wall !== null && wall >= this.contact.wall) spans.push(wall - this.contact.wall);
    return spans.length === 0 ? undefined : Math.max(...spans);
  }

  private armTick(): void {
    this.clear('tickTimer');
    if (this.phase !== 'online') return;
    this.tickArmed = { mono: this.o.scheduler.now(), wall: this.wallNow() };
    this.tickTimer = this.o.scheduler.setTimeout(() => this.tick(), this.t.contactTickMs);
  }

  private tick(): void {
    this.tickTimer = null;
    if (this.phase !== 'online') return;
    const limit = this.t.contactTickMs + LATE_TICK_MS;
    const wall = this.wallNow();
    const onTime =
      this.o.scheduler.now() - this.tickArmed.mono <= limit &&
      (wall === null || this.tickArmed.wall === null || wall - this.tickArmed.wall <= limit);
    if (onTime) {
      if (!this.socketInDoubt && this.socket !== null) this.markContact(false);
    } else if (!this.pollInFlight) {
      // We were frozen (suspended, asleep): ask the board what happened meanwhile.
      this.socketInDoubt = true;
      this.requestPoll();
    }
    this.armTick();
  }

  /** A GET bounded twice: by the transport's timeout and, should it never settle, by a watchdog. */
  private get(path: BoardGetPath, gen: number, timeoutMs = this.t.requestTimeoutMs): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      let done = false;
      const watchdog = this.o.scheduler.setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`no answer to GET ${path} within ${timeoutMs + REQUEST_WATCHDOG_SLACK_MS} ms`));
      }, timeoutMs + REQUEST_WATCHDOG_SLACK_MS);
      const settle = (): boolean => {
        if (done) return false;
        done = true;
        this.o.scheduler.clearTimeout(watchdog);
        return true;
      };
      let request: Promise<HttpResponse>;
      try {
        request = this.o.transport.get(path, { timeoutMs });
      } catch (err) {
        request = Promise.reject(err);
      }
      request.then(
        (res) => {
          if (!settle()) return;
          if (gen === this.gen) this.record(`GET ${path}`, res.body);
          resolve(res);
        },
        (err: unknown) => {
          if (settle()) reject(err);
        },
      );
    });
  }

  // ── applying snapshots ───────────────────────────────────────────────────

  /**
   * Applies a snapshot. An error thrown on the way (a bug, a hook) becomes a SourceAnomaly: the
   * snapshot is skipped and the adapter carries on; the next read heals the stream.
   */
  private applySnapshot(snap: Snapshot, mode: ApplyMode, correlationId?: string, awayMs?: number): void {
    this.safely('applying a board state', snap.raw, () => {
      for (const note of snap.notes) this.anomalyOnce(note, snap.raw);
      for (const t of snap.throws) for (const note of t.notes) this.anomalyOnce(note, snap.raw);
      this.o.observer?.beforeApply?.(snap, mode);
      const facts = this.tracker.apply(snap, mode, awayMs);
      for (const f of facts) this.emitTrackerFact(f, correlationId);
      this.handleStatus(snap, correlationId);
      this.o.observer?.afterApply?.(snap, mode);
    });
  }

  /** Runs `fn`; an error it throws is reported once as a SourceAnomaly and `undefined` returned. */
  private safely<T>(what: string, raw: unknown, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.anomalyOnce(`internal error while ${what}: ${errorText(err)}`, raw);
      return undefined;
    }
  }

  private emitTrackerFact(f: TrackerFact, correlationId: string | undefined): void {
    if ((f.type === 'DartDetected' || f.type === 'DartUpdated') && f.anomaly) {
      // The dart is kept as a miss with `pendingReview` (the host flags its turn); the
      // anomaly that explains it shares its correlationId.
      const cid = correlationId ?? this.o.ids();
      this.emit({ type: 'SourceAnomaly', payload: { note: f.anomaly.note, rawExcerpt: f.anomaly.rawExcerpt } }, cid);
      this.emit({ type: f.type, payload: f.payload } as FactBody, cid);
      return;
    }
    this.emit({ type: f.type, payload: f.payload } as FactBody, correlationId);
  }

  private handleStatus(snap: Snapshot, correlationId?: string): void {
    if (snap.status !== undefined && !isKnownStatus(snap.status)) {
      this.anomalyOnce(`unknown board status "${snap.status.slice(0, 40)}"`, snap.status);
    }
    if (isStuckTakeoutCandidate(snap)) {
      if (!this.stuckReported && this.stuckTimer === null) {
        this.stuckTimer = this.o.scheduler.setTimeout(() => {
          this.stuckTimer = null;
          this.stuckReported = true;
          this.emit({ type: 'BoardStatusChanged', payload: { status: 'stuck-takeout' } });
        }, this.t.stuckTakeoutMs);
      }
    } else {
      this.clear('stuckTimer');
      if (this.stuckReported) {
        this.stuckReported = false;
        this.boardStatus = undefined; // force a fresh status below
      }
    }
    const status = boardStatusOf(snap);
    if (status !== undefined && status !== this.boardStatus && !this.stuckReported) {
      this.boardStatus = status;
      this.emit({ type: 'BoardStatusChanged', payload: { status } }, correlationId);
    }
  }

  // ── emission ─────────────────────────────────────────────────────────────

  private source(): EventSource {
    const s: EventSource = { kind: 'autodarts-local', adapterVersion: AUTODARTS_LOCAL_ADAPTER_VERSION };
    if (this.upstreamVersion !== undefined) s.upstreamVersion = this.upstreamVersion;
    return s;
  }

  private emit(body: FactBody, correlationId = this.resyncCorrelation): void {
    // Every anomaly, whoever wrote it, leaves with its secrets redacted and its note capped.
    const clean: FactBody =
      body.type === 'SourceAnomaly' ? { type: body.type, payload: { note: cleanNote(body.payload.note), rawExcerpt: excerpt(body.payload.rawExcerpt) } } : body;
    const draft = { ...clean, source: this.source(), occurredAt: this.o.clock() } as BoardFactDraft;
    if (correlationId !== undefined) draft.correlationId = correlationId;
    this.facts.emit(draft);
  }

  /**
   * Logged connection transitions: every change of state, except that retries during one
   * outage are not logged (the live status listener still sees each one).
   */
  private emitConnection(state: 'connecting' | 'resyncing' | 'online' | 'offline', error?: string): void {
    this.notifyStatus(error);
    if (state === 'connecting' && this.attempt > 1) return;
    if (state === this.lastEmittedConn) return;
    this.lastEmittedConn = state;
    const payload: { state: typeof state; attempt?: number; error?: string } = { state };
    if (state !== 'online' && this.attempt > 0) payload.attempt = this.attempt;
    if (error !== undefined) payload.error = cleanNote(error, 200);
    this.emit({ type: 'SourceConnectionChanged', payload });
  }

  private notifyStatus(error?: string): void {
    const status = this.statusOf();
    if (error !== undefined) status.error = error;
    this.statusListeners.emit(status);
  }

  private statusOf(): ConnectionStatus {
    const s: ConnectionStatus = { phase: this.phase, attempt: this.attempt };
    if (this.upstreamVersion !== undefined) s.upstreamVersion = this.upstreamVersion;
    return s;
  }

  /** Frame- and enum-level anomalies are reported once per distinct note. */
  private anomalyOnce(note: string, raw: unknown): void {
    if (this.anomalyKeys.has(note)) {
      this.suppressedAnomalies++;
      return;
    }
    if (this.anomalyKeys.size < MAX_DISTINCT_ANOMALIES) this.anomalyKeys.add(note);
    else {
      this.suppressedAnomalies++;
      return;
    }
    this.emit({ type: 'SourceAnomaly', payload: { note, rawExcerpt: excerpt(raw) } });
  }

  private record(channel: RawChannel, text: string): void {
    this.ring.push(this.o.clock(), channel, text);
  }

  private clear(name: 'connectTimer' | 'openTimer' | 'resyncTimer' | 'livenessTimer' | 'stuckTimer' | 'tickTimer'): void {
    const h = this[name];
    if (h !== null) {
      this.o.scheduler.clearTimeout(h);
      this[name] = null;
    }
  }
}

type FactBody = BoardFactDraft extends infer D ? (D extends BoardFactDraft ? Pick<D, 'type' | 'payload'> : never) : never;

/** A short description of anything thrown. Never throws itself. */
function errorText(err: unknown): string {
  try {
    const message: unknown = err instanceof Error ? err.message : err;
    return (typeof message === 'string' ? message : serialize(message, 160)).slice(0, 160);
  } catch {
    return 'an unreadable error';
  }
}
