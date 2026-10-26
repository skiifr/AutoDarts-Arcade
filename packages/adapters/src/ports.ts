import type { BoardFactDraft } from '@arcade/event-schema';
import type { RestoredVisitState } from './autodarts-local/rebuild';
import type { BoardGetPath } from './endpoints';

/**
 * Everything an adapter needs from the outside world is injected through these ports, so
 * the adapters stay pure TypeScript and run the same in the app, in Node tests and in the
 * dev tools (ARCHITECTURE §5.3). Implementations live in packages/platform; tests use
 * the simulator's fake transport and Vitest's fake timers.
 */

export interface HttpResponse {
  status: number;
  /** Response body as text. The transport has already enforced its size cap. */
  body: string;
}

export interface EventsSocketHandlers {
  onOpen(): void;
  /** One text frame. The transport has already dropped binary and oversized frames. */
  onMessage(text: string): void;
  /** A frame the transport refused to deliver (too large, or not text). */
  onRejectedFrame?(info: { reason: 'oversize' | 'binary'; size: number }): void;
  /** Called exactly once, whether the socket failed to open or closed later. */
  onClose(info: { code?: number; reason?: string; error?: string }): void;
}

export interface EventsSocket {
  close(): void;
}

/**
 * Read-only access to one board. The board address is bound when the transport is
 * created; paths are restricted to the allowlist in ./endpoints by the type and, at
 * runtime, by the platform implementation.
 */
export interface Transport {
  /** Rejects on network failure or timeout; resolves with any HTTP status. */
  get(path: BoardGetPath, options?: { timeoutMs?: number }): Promise<HttpResponse>;
  /** Opens `WS /api/events` (bare by default), with `?type=state` only when `stateOnly` is set. */
  openEvents(options: { stateOnly: boolean }, handlers: EventsSocketHandlers): EventsSocket;
}

export type TimerHandle = unknown;

/** Timers and a monotonic clock. Vitest fake timers drive this in tests. */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** Monotonic milliseconds, for durations only. */
  now(): number;
}

/** Current time as an ISO-8601 string (same shape as the engine's `Clock`). */
export type Clock = () => string;

/** Mints a new ULID (same shape as the engine's `IdSource`). */
export type IdSource = () => string;

/** Uniform in [0, 1). Used for backoff jitter and the simulator; seeded in tests. */
export type RandomSource = () => number;

export type FactListener = (fact: BoardFactDraft) => void;

/** A source of layer-1 board facts: the board adapter, the simulator or manual play. */
export interface BoardSource {
  readonly kind: 'autodarts-local' | 'simulator' | 'manual';
  start(): void;
  stop(): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: FactListener): () => void;
  /** Re-read the board now (the app came back to the foreground). Sources without a board omit it. */
  resync?(): void;
  /**
   * Crash-resume: continue from the visit state rebuilt from the session's log
   * (`rebuildVisitState`). Called while stopped. Sources without visit state omit it.
   */
  restore?(state: RestoredVisitState): void;
  /**
   * When the source last knew the board's state for sure (ISO, its wall clock), as it would count
   * it if the link broke now. Persist it with the session and pass it back as
   * `RestoredVisitState.observedAt` on a crash-resume when it is later than the log's own, so a
   * quick relaunch does not count as a long outage. Sources without a board omit it.
   */
  lastContactAt?(): string | undefined;
}

/** Reports an error outside the current call stack (as an uncaught error), without unwinding it. */
export function reportLater(err: unknown): void {
  const queue = (globalThis as { queueMicrotask?: (task: () => void) => void }).queueMicrotask;
  if (queue) {
    queue(() => {
      throw err;
    });
  } else {
    void Promise.reject(err);
  }
}

/**
 * Small listener set shared by the sources. A listener that throws never reaches the emitter:
 * the source's own state machine (timers, retries) must not unwind half-way because a
 * subscriber failed. The error goes to `onError` (default: reported as uncaught, later).
 */
export class Listeners<T> {
  private readonly set = new Set<(value: T) => void>();
  private readonly onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void = reportLater) {
    this.onError = onError;
  }

  add(listener: (value: T) => void): () => void {
    this.set.add(listener);
    return () => {
      this.set.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.set]) {
      try {
        listener(value);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  get size(): number {
    return this.set.size;
  }
}
