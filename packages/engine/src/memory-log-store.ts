import type { ArcadeEvent } from '@arcade/event-schema';
import type { LogStore } from './ports';

/**
 * An in-memory `LogStore` for tests, the headless runner and demo mode. Events are copied
 * through JSON on the way in and out, as a real store would serialise them, and each append
 * must continue the session's seq without a gap or the whole append is refused.
 */
export class MemoryLogStore implements LogStore {
  private readonly sessions = new Map<string, ArcadeEvent[]>();
  /** Session ids, oldest first. */
  private readonly order: string[] = [];

  async append(sessionId: string, events: readonly ArcadeEvent[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    let expected = (existing.at(-1)?.seq ?? 0) + 1;
    for (const e of events) {
      if (e.sessionId !== sessionId) throw new Error(`event ${e.eventId} belongs to session ${e.sessionId}`);
      if (e.seq !== expected) throw new Error(`expected seq ${expected}, got ${e.seq}`);
      expected++;
    }
    const copies = JSON.parse(JSON.stringify(events)) as ArcadeEvent[];
    if (!this.sessions.has(sessionId)) this.order.push(sessionId);
    this.sessions.set(sessionId, existing.concat(copies));
  }

  async load(sessionId: string): Promise<ArcadeEvent[]> {
    return JSON.parse(JSON.stringify(this.sessions.get(sessionId) ?? [])) as ArcadeEvent[];
  }

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
