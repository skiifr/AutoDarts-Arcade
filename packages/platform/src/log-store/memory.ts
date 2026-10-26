import type { ArcadeEvent } from '@arcade/event-schema';
import type { LogStore } from '@arcade/engine';

/** Rejected appends: the log is append-only, gap-free and single-session per call. */
export class LogAppendError extends Error {
  override name = 'LogAppendError';
}

/**
 * Checks a batch against the session's last stored seq: every event belongs to the
 * session and seqs continue without gaps or repeats (ARCHITECTURE §7.1).
 */
export function checkAppend(sessionId: string, lastSeq: number, events: readonly ArcadeEvent[]): void {
  let expected = lastSeq + 1;
  for (const e of events) {
    if (e.sessionId !== sessionId) throw new LogAppendError(`event ${e.eventId} belongs to session ${e.sessionId}, not ${sessionId}`);
    if (e.seq !== expected) throw new LogAppendError(`expected seq ${expected}, got ${e.seq}`);
    expected++;
  }
}

/** In-memory `LogStore` for tests, demo mode and the headless runner. */
export class MemoryLogStore implements LogStore {
  private readonly sessions = new Map<string, ArcadeEvent[]>();

  async append(sessionId: string, events: readonly ArcadeEvent[]): Promise<void> {
    const log = this.sessions.get(sessionId) ?? [];
    checkAppend(sessionId, log.at(-1)?.seq ?? 0, events);
    // Store copies, so later mutation by the caller cannot rewrite history.
    const copies = events.map((e) => structuredCloneJson(e));
    this.sessions.set(sessionId, [...log, ...copies]);
  }

  async load(sessionId: string): Promise<ArcadeEvent[]> {
    return (this.sessions.get(sessionId) ?? []).map((e) => structuredCloneJson(e));
  }

  async listSessions(): Promise<{ sessionId: string; lastSeq: number; closed: boolean }[]> {
    return [...this.sessions.entries()]
      .map(([sessionId, log]) => ({
        sessionId,
        lastSeq: log.at(-1)?.seq ?? 0,
        closed: log.some((e) => e.type === 'SessionClosed'),
      }))
      .sort((a, b) => (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0));
  }
}

function structuredCloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
