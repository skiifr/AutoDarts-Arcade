import type { BoardGetPath } from '../endpoints';
import type { EventsSocket, EventsSocketHandlers, HttpResponse, RandomSource, Scheduler, TimerHandle, Transport } from '../ports';
import type { BoardModel } from './board-model';

/** Faults applied to frames on their way from the board model to the adapter. */
export interface FaultPlan {
  /** Probability a frame is lost. */
  drop?: number;
  /** Probability a frame is delivered twice. */
  duplicate?: number;
  /** Extra per-frame delay range in ms; frames stay in order unless `reorder` hits. */
  delayMs?: readonly [number, number];
  /** Probability a frame is held back past the frames after it. */
  reorder?: number;
  /** Close the socket after this many delivered frames (like the fault proxy's --cut-every). */
  cutEvery?: number;
  /**
   * A dropped frame also breaks the socket, 0–300 ms later. A TCP stream cannot skip data: on a
   * real network a frame is only lost with the connection it was on. Without this, `drop` loses
   * frames from a socket that stays healthy (a stress test of the self-healing poll).
   */
  dropBreaksSocket?: boolean;
}

export interface FakeTransportOptions {
  board: BoardModel;
  scheduler: Scheduler;
  random: RandomSource;
  faults?: FaultPlan;
  /** One-way network latency in ms for requests and socket opens. */
  latencyMs?: number;
}

export interface RequestRecord {
  kind: 'GET' | 'WS';
  path: string;
  at: number;
}

interface OpenSocket {
  handlers: EventsSocketHandlers;
  unsubscribe: () => void;
  pending: Set<TimerHandle>;
  lastDeliveryAt: number;
  delivered: number;
  closed: boolean;
}

/**
 * An in-memory `Transport` over a `BoardModel`, with fault injection and reachability
 * control for the chaos suite and the resync and idle-load tests. Uses the injected
 * scheduler, so Vitest fake timers drive it.
 */
export class FakeBoardTransport implements Transport {
  readonly requests: RequestRecord[] = [];
  faults: FaultPlan;

  private readonly board: BoardModel;
  private readonly scheduler: Scheduler;
  private readonly random: RandomSource;
  private readonly latency: number;
  private reachable = true;
  /** The board answers HTTP but refuses the event socket. */
  refuseSockets = false;
  /** Half-open connection: sockets stay open but deliver nothing, and requests time out. */
  private silent = false;
  private readonly sockets = new Set<OpenSocket>();
  /** Every frame actually handed to the adapter (after faults). */
  readonly deliveredFrames: string[] = [];

  constructor(options: FakeTransportOptions) {
    this.board = options.board;
    this.scheduler = options.scheduler;
    this.random = options.random;
    this.faults = options.faults ?? {};
    this.latency = options.latencyMs ?? 5;
  }

  get isReachable(): boolean {
    return this.reachable;
  }

  get openSockets(): number {
    return this.sockets.size;
  }

  /** Board or network goes away: open sockets die, requests fail until it comes back. */
  setReachable(reachable: boolean): void {
    this.reachable = reachable;
    if (!reachable) for (const s of [...this.sockets]) this.closeSocket(s, { code: 1006, error: 'network unreachable' });
  }

  /**
   * A dead network path that nothing notices: open sockets stay "open" but go quiet,
   * requests never answer (the caller's timeout fires). Only liveness polls detect it.
   */
  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  /** Delivers an arbitrary frame to every open socket (oversized, malformed, …). */
  inject(text: string): void {
    for (const s of this.sockets) if (!s.closed) s.handlers.onMessage(text);
  }

  /** Cut open sockets while the board stays reachable (a proxy cut, a board restart). */
  cutSockets(): void {
    for (const s of [...this.sockets]) this.closeSocket(s, { code: 1006, error: 'connection reset' });
  }

  httpRequestsSince(t: number): RequestRecord[] {
    return this.requests.filter((r) => r.kind === 'GET' && r.at >= t);
  }

  get(path: BoardGetPath, options?: { timeoutMs?: number }): Promise<HttpResponse> {
    this.requests.push({ kind: 'GET', path, at: this.scheduler.now() });
    return new Promise((resolve, reject) => {
      if (this.silent) {
        this.scheduler.setTimeout(() => reject(new Error('timeout')), options?.timeoutMs ?? 1500);
        return;
      }
      if (!this.reachable) {
        this.scheduler.setTimeout(() => reject(new Error('connect EHOSTUNREACH')), this.latency);
        return;
      }
      // The board serves the request after one latency; the answer arrives after another.
      this.scheduler.setTimeout(() => {
        if (!this.reachable) {
          reject(new Error('connection reset'));
          return;
        }
        const body = this.body(path);
        this.scheduler.setTimeout(() => {
          if (this.reachable) resolve({ status: 200, body });
          else reject(new Error('connection reset'));
        }, this.latency);
      }, this.latency);
    });
  }

  openEvents(options: { stateOnly: boolean }, handlers: EventsSocketHandlers): EventsSocket {
    this.requests.push({ kind: 'WS', path: options.stateOnly ? '/api/events?type=state' : '/api/events', at: this.scheduler.now() });
    const sock: OpenSocket = { handlers, unsubscribe: () => {}, pending: new Set(), lastDeliveryAt: 0, delivered: 0, closed: false };
    const openTimer = this.scheduler.setTimeout(() => {
      sock.pending.delete(openTimer);
      if (sock.closed) return;
      if (this.silent) return; // the handshake never completes; the caller's timeout fires
      if (!this.reachable || this.refuseSockets) {
        sock.closed = true;
        handlers.onClose({ code: 1006, error: this.reachable ? 'unexpected server response: 503' : 'connect EHOSTUNREACH' });
        return;
      }
      this.sockets.add(sock);
      sock.unsubscribe = this.board.onFrame((text) => this.route(sock, text, options.stateOnly));
      handlers.onOpen();
    }, this.latency * 2);
    sock.pending.add(openTimer);
    return {
      close: () => {
        if (sock.closed) return;
        this.closeSocket(sock, { code: 1000 }, false);
        // Like a real WebSocket, a client-side close still reports onClose, asynchronously.
        this.scheduler.setTimeout(() => handlers.onClose({ code: 1000, reason: 'client close' }), 0);
      },
    };
  }

  private body(path: BoardGetPath): string {
    switch (path) {
      case '/api/state':
        return this.board.stateJson();
      case '/api/version':
        return this.board.versionText();
      case '/api/state/stats':
        return this.board.statsJson();
      case '/api/cams/stats':
        return this.board.camsStatsJson();
    }
  }

  private route(sock: OpenSocket, text: string, stateOnly: boolean): void {
    if (this.silent) return;
    if (stateOnly && !text.startsWith('{"type":"state"')) return;
    const f = this.faults;
    if (f.drop !== undefined && this.random() < f.drop) {
      if (f.dropBreaksSocket) {
        const timer = this.scheduler.setTimeout(() => {
          sock.pending.delete(timer);
          this.closeSocket(sock, { code: 1006, error: 'connection lost' });
        }, this.random() * 300);
        sock.pending.add(timer);
      }
      return;
    }
    const copies = f.duplicate !== undefined && this.random() < f.duplicate ? 2 : 1;
    for (let c = 0; c < copies; c++) {
      const now = this.scheduler.now();
      const [lo, hi] = f.delayMs ?? [0, 0];
      const extra = lo + this.random() * (hi - lo);
      let at = now + this.latency + extra;
      if (f.reorder !== undefined && this.random() < f.reorder) at += 50 + this.random() * 400;
      else at = Math.max(at, sock.lastDeliveryAt);
      sock.lastDeliveryAt = Math.max(sock.lastDeliveryAt, at);
      const timer = this.scheduler.setTimeout(() => {
        sock.pending.delete(timer);
        if (sock.closed) return;
        this.deliveredFrames.push(text);
        sock.handlers.onMessage(text);
        sock.delivered++;
        if (f.cutEvery !== undefined && sock.delivered % f.cutEvery === 0) {
          this.closeSocket(sock, { code: 1006, error: 'cut by fault plan' });
        }
      }, at - now);
      sock.pending.add(timer);
    }
  }

  private closeSocket(sock: OpenSocket, info: { code?: number; error?: string }, notify = true): void {
    if (sock.closed) return;
    sock.closed = true;
    sock.unsubscribe();
    for (const t of sock.pending) this.scheduler.clearTimeout(t);
    sock.pending.clear();
    this.sockets.delete(sock);
    if (notify) sock.handlers.onClose(info);
  }
}
