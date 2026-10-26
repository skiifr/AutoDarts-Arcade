/**
 * Where the runtime keeps the last time the board was in sight, so a crash-resume can measure
 * the outage from it (ARCHITECTURE §6.4 "Contact", §6.5). The session log only holds board
 * facts, and an idle board sends none: the heartbeats that proved it was in sight are not in
 * the log. Without this, a resume after a quiet spell counted the whole spell as an outage and
 * inferred a takeout that never happened.
 *
 * A contact belongs to one session: the visit state a resume rebuilds comes from that
 * session's log, and a contact made while another session was open says nothing about it.
 * The app backs this with its key-value storage; one record (the latest) is enough.
 */
export interface ContactStore {
  /** The last contact recorded while `sessionId` was open (ISO-8601), if any. */
  get(sessionId: string): Promise<string | undefined>;
  set(sessionId: string, at: string): Promise<void>;
}

/** An in-memory `ContactStore` (tests, the headless runner, demo mode). Keeps the latest record only. */
export class MemoryContactStore implements ContactStore {
  private last: { sessionId: string; at: string } | null = null;
  /** Writes so far (tests). */
  writes = 0;

  async get(sessionId: string): Promise<string | undefined> {
    return this.last?.sessionId === sessionId ? this.last.at : undefined;
  }

  async set(sessionId: string, at: string): Promise<void> {
    this.last = { sessionId, at };
    this.writes++;
  }
}
