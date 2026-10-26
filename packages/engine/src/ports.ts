import type { ArcadeEvent } from '@arcade/event-schema';

/**
 * Durable, append-only event storage (ARCHITECTURE §6.5). The host awaits `append` before
 * it emits effects, so an implementation must not resolve until the events are durable.
 */
export interface LogStore {
  append(sessionId: string, events: readonly ArcadeEvent[]): Promise<void>;
  /** Every event of a session, in seq order. Empty if the session is unknown. */
  load(sessionId: string): Promise<ArcadeEvent[]>;
  /** Known sessions, newest first. `closed` is true once a SessionClosed event is stored. */
  listSessions(): Promise<{ sessionId: string; lastSeq: number; closed: boolean }[]>;
}

/** Current time as an ISO-8601 string. Injected: pure packages never read the clock. */
export type Clock = () => string;

/** Mints a new ULID. Injected so tests and replays are deterministic. */
export type IdSource = () => string;
