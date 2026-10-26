import { parseArcadeEvent, type ArcadeEvent } from '@arcade/event-schema';
import type { LogStore } from '@arcade/engine';
import { LogAppendError, checkAppend } from './memory';

export type SqlValue = string | number | null;

/** The statements a transaction may run. */
export interface SqlTx {
  run(sql: string, params: readonly SqlValue[]): Promise<void>;
  all<T>(sql: string, params: readonly SqlValue[]): Promise<T[]>;
}

/**
 * The small slice of SQLite the log store needs. `transaction` must run `task` in one
 * transaction and resolve only after COMMIT (rejecting, after ROLLBACK, if the task or the
 * commit fails). `expoSqliteExecutor` adapts expo-sqlite; Node tests use node:sqlite or a
 * recording fake.
 */
export interface SqlExecutor extends SqlTx {
  exec(sql: string): Promise<void>;
  transaction(task: (tx: SqlTx) => Promise<void>): Promise<void>;
}

export const LOG_SCHEMA_VERSION = 1;

/** How long a statement waits for a lock before SQLite gives up with SQLITE_BUSY. */
export const LOG_BUSY_TIMEOUT_MS = 5000;

/**
 * Connection settings, applied when the store opens the database (before the schema):
 * - `busy_timeout`: a statement that meets a lock waits up to 5 s instead of failing at once
 *   with SQLITE_BUSY. Per connection, so `expoSqliteExecutor` sets it again on the
 *   connection each exclusive transaction opens. First, so the switch to WAL waits too.
 * - `journal_mode = WAL`: readers and the one writer don't block each other, so a load and
 *   an append overlapping in time can't fail at once. Stored in the file, so every later
 *   connection uses it. Where WAL is unavailable (an in-memory database, a web VFS without
 *   shared memory) SQLite keeps its mode, without an error.
 * - `synchronous = FULL`: an append is on disk when it resolves, the host's write-ahead rule.
 *   Also SQLite's default for new connections, which expo-sqlite does not change; it can't
 *   be set inside a transaction, so the transaction connections rely on that default.
 */
const PRAGMAS = `
PRAGMA busy_timeout = ${LOG_BUSY_TIMEOUT_MS};
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS arcade_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS arcade_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  last_seq INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS arcade_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
INSERT OR IGNORE INTO arcade_meta (key, value) VALUES ('log_schema', '${LOG_SCHEMA_VERSION}');
`;

/**
 * Durable `LogStore` on SQLite (ARCHITECTURE §5.2, §6.5). `append` writes the batch and
 * the session row in one transaction and resolves only after the commit, so the host's
 * write-ahead rule holds: an event the host has awaited is on disk. Seqs are checked
 * inside the transaction against the stored last seq. `load` validates every event with
 * the schema (zod at every boundary, §7.1).
 *
 * Appends, loads and listings run one at a time, in call order, whatever the executor does
 * with concurrent work: a read never runs inside an open append transaction on a shared
 * connection (web), so it never sees a batch that is then rolled back, and it always sees
 * the appends called before it.
 */
export class SqliteLogStore implements LogStore {
  private readonly db: SqlExecutor;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(db: SqlExecutor) {
    this.db = db;
  }

  /** Applies the connection settings and creates the tables. Called lazily by every method; safe to call more than once. */
  init(): Promise<void> {
    this.ready ??= this.db.exec(PRAGMAS + SCHEMA).catch((e: unknown) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  /** Runs `work` after everything called before it has finished, failed or not. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  append(sessionId: string, events: readonly ArcadeEvent[]): Promise<void> {
    return this.serial(() => this.appendNow(sessionId, events));
  }

  private async appendNow(sessionId: string, events: readonly ArcadeEvent[]): Promise<void> {
    await this.init();
    if (events.length === 0) return;
    await this.db.transaction(async (tx) => {
      const rows = await tx.all<{ last_seq: number }>('SELECT last_seq FROM arcade_sessions WHERE session_id = ?', [sessionId]);
      const lastSeq = rows[0]?.last_seq ?? 0;
      checkAppend(sessionId, lastSeq, events);
      for (const e of events) {
        await tx.run('INSERT INTO arcade_events (session_id, seq, event_id, type, json) VALUES (?, ?, ?, ?, ?)', [
          sessionId,
          e.seq,
          e.eventId,
          e.type,
          JSON.stringify(e),
        ]);
      }
      const last = events[events.length - 1] as ArcadeEvent;
      const closed = events.some((e) => e.type === 'SessionClosed') ? 1 : 0;
      await tx.run(
        `INSERT INTO arcade_sessions (session_id, last_seq, closed) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq, closed = MAX(closed, excluded.closed)`,
        [sessionId, last.seq, closed],
      );
    });
  }

  load(sessionId: string): Promise<ArcadeEvent[]> {
    return this.serial(async () => {
      await this.init();
      const rows = await this.db.all<{ json: string; seq: number }>(
        'SELECT json, seq FROM arcade_events WHERE session_id = ? ORDER BY seq ASC',
        [sessionId],
      );
      return rows.map((r, i) => {
        if (r.seq !== i + 1) throw new LogAppendError(`session ${sessionId} has a gap before seq ${r.seq}`);
        return parseArcadeEvent(JSON.parse(r.json));
      });
    });
  }

  listSessions(): Promise<{ sessionId: string; lastSeq: number; closed: boolean }[]> {
    return this.serial(async () => {
      await this.init();
      // Session ids are ULIDs, so their order is creation order.
      const rows = await this.db.all<{ session_id: string; last_seq: number; closed: number }>(
        'SELECT session_id, last_seq, closed FROM arcade_sessions ORDER BY session_id DESC',
        [],
      );
      return rows.map((r) => ({ sessionId: r.session_id, lastSeq: r.last_seq, closed: r.closed !== 0 }));
    });
  }
}
