import type { ArcadeEvent } from '@arcade/event-schema';
import type { LogStore } from './ports';

/** A refused append: the log is append-only, gap-free and one session per call (ARCHITECTURE §7.1). */
export class LogAppendError extends Error {
  override name = 'LogAppendError';
}

/**
 * Checks a batch against the session's last stored seq: every event belongs to the session
 * and the seqs continue without a gap or a repeat. Every `LogStore` runs this before it
 * stores anything, so a refused batch leaves nothing behind.
 */
export function checkAppend(sessionId: string, lastSeq: number, events: readonly ArcadeEvent[]): void {
  let expected = lastSeq + 1;
  for (const e of events) {
    if (e.sessionId !== sessionId) throw new LogAppendError(`event ${e.eventId} belongs to session ${e.sessionId}, not ${sessionId}`);
    if (e.seq !== expected) throw new LogAppendError(`expected seq ${expected}, got ${e.seq}`);
    expected++;
  }
}

/**
 * The in-memory `LogStore`, for tests, the headless runner and demo mode; platform re-exports
 * it, so there is exactly one. Events are copied through JSON on the way in and out, as a real
 * store would serialise them, and an append that does not continue the session's seq is
 * refused whole (`LogAppendError`).
 */
export class MemoryLogStore implements LogStore {
  private readonly sessions = new Map<string, ArcadeEvent[]>();
  /** Session ids, oldest first. */
  private readonly order: string[] = [];

  async append(sessionId: string, events: readonly ArcadeEvent[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    checkAppend(sessionId, existing.at(-1)?.seq ?? 0, events);
    if (events.length === 0) return;
    // Store copies, so later mutation by the caller cannot rewrite history.
    const copies = JSON.parse(JSON.stringify(events)) as ArcadeEvent[];
    if (!this.sessions.has(sessionId)) this.order.push(sessionId);
    this.sessions.set(sessionId, existing.concat(copies));
  }

  async load(sessionId: string): Promise<ArcadeEvent[]> {
    return JSON.parse(JSON.stringify(this.sessions.get(sessionId) ?? [])) as ArcadeEvent[];
  }

  /** Newest first: the order the sessions were first appended to. */
  async listSessions(): Promise<{ sessionId: string; lastSeq: number; closed: boolean }[]> {
    return [...this.order].reverse().map((sessionId) => {
      const events = this.sessions.get(sessionId)!;
      return {
        sessionId,
        lastSeq: events.at(-1)?.seq ?? 0,
        closed: events.some((e) => e.type === 'SessionClosed'),
      };
    });
  }
}
