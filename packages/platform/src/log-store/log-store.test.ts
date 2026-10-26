import type { ArcadeEvent } from '@arcade/event-schema';
import { MemoryLogStore as EngineMemoryLogStore, LogAppendError as EngineLogAppendError, type LogStore } from '@arcade/engine';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { expoSqliteExecutor, type ExpoSqliteDatabaseLike, type ExpoStatementsLike } from './expo-sqlite';
import { LogAppendError, MemoryLogStore } from './memory';
import { SqliteLogStore, type SqlExecutor, type SqlTx, type SqlValue } from './sqlite';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(n: number): string {
  let out = '';
  let v = n;
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

const S1 = ulid(1_000);
const S2 = ulid(2_000);

function ev(sessionId: string, seq: number, type: 'TakeoutStarted' | 'SessionClosed' = 'TakeoutStarted'): ArcadeEvent {
  return {
    schema: 'arcade.event/v1',
    eventId: ulid(seq + 10_000),
    sessionId,
    seq,
    type,
    payload: type === 'SessionClosed' ? { outcome: 'completed', finalStandings: [] } : { visitKey: ulid(7) },
    source: { kind: 'autodarts-local', adapterVersion: 'autodarts-local@0.1.0' },
    occurredAt: '2026-11-02T20:00:00.000Z',
    receivedAt: '2026-11-02T20:00:00.001Z',
  } as ArcadeEvent;
}

interface NodeStatement {
  run(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  /** Node 22.13+. */
  iterate?(...params: SqlValue[]): IterableIterator<unknown>;
}
interface NodeDb {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}
type NodeSqlite = { DatabaseSync: new (path: string) => NodeDb };

async function nodeSqlite(): Promise<NodeSqlite> {
  const specifier = 'node:sqlite';
  return (await import(/* @vite-ignore */ specifier)) as NodeSqlite;
}

type NodeFs = { mkdtempSync(prefix: string): string; rmSync(path: string, options: { recursive: boolean; force: boolean }): void };
async function nodeFs(): Promise<NodeFs> {
  const specifier = 'node:fs';
  return (await import(/* @vite-ignore */ specifier)) as NodeFs;
}

const tempDirs: string[] = [];
afterAll(async () => {
  const fs = await nodeFs();
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // still open somewhere (Windows): the system cleans its temp directory
    }
  }
});

/** A fresh database file in the system temp directory (node:fs and node:os, typed structurally). */
async function tempDbFile(): Promise<string> {
  const specifier = 'node:os';
  const os = (await import(/* @vite-ignore */ specifier)) as { tmpdir(): string };
  const dir = (await nodeFs()).mkdtempSync(`${os.tmpdir()}/arcade-log-`);
  tempDirs.push(dir);
  return `${dir}/arcade.db`;
}

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(() => r(), 0));

/**
 * expo-sqlite's async database, copied in behaviour over a real SQLite (node:sqlite):
 * - statements run on one connection; a read steps through its rows asynchronously, as the
 *   native module does on its own thread, so the read stays open while other work runs;
 * - `withTransactionAsync` is BEGIN, the task, COMMIT (ROLLBACK on error) on that connection;
 * - `withExclusiveTransactionAsync` opens a new connection for each call on native, and on
 *   web is defined but throws before running the task, exactly as expo-sqlite does.
 */
function expoLikeDatabase(mod: NodeSqlite, path: string, platform: 'native' | 'web'): ExpoSqliteDatabaseLike & { main: NodeDb } {
  const on = (db: NodeDb): ExpoStatementsLike => ({
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, params) => {
      db.prepare(sql).run(...params);
    },
    getAllAsync: async <T,>(sql: string, params: SqlValue[]) => {
      const statement = db.prepare(sql);
      if (!statement.iterate) return statement.all(...params).map((r) => ({ ...(r as object) })) as T[];
      const rows: T[] = [];
      for (const row of statement.iterate(...params)) {
        rows.push({ ...(row as object) } as T);
        await tick();
      }
      return rows;
    },
  });
  const main = new mod.DatabaseSync(path);
  const base = on(main);
  return {
    ...base,
    main,
    withTransactionAsync: async (task) => {
      try {
        await base.execAsync('BEGIN');
        await task();
        await base.execAsync('COMMIT');
      } catch (e) {
        await base.execAsync('ROLLBACK');
        throw e;
      }
    },
    withExclusiveTransactionAsync: async (task) => {
      if (platform === 'web') throw new Error('withExclusiveTransactionAsync is not supported on web');
      const connection = new mod.DatabaseSync(path);
      const txn = on(connection);
      let error: unknown;
      try {
        await txn.execAsync('BEGIN');
        await task(txn);
        await txn.execAsync('COMMIT');
      } catch (e) {
        await txn.execAsync('ROLLBACK');
        error = e;
      } finally {
        connection.close();
      }
      if (error) throw error;
    },
  };
}

/** A real SQLite (Node 22's node:sqlite) behind the executor interface. */
async function nodeSqliteExecutor(): Promise<SqlExecutor & { db: NodeDb }> {
  const mod = await nodeSqlite();
  const db = new mod.DatabaseSync(':memory:');
  const tx: SqlTx = {
    run: async (sql, params) => {
      db.prepare(sql).run(...params);
    },
    all: async <T,>(sql: string, params: readonly SqlValue[]) => db.prepare(sql).all(...params).map((r) => ({ ...(r as object) })) as T[],
  };
  return {
    ...tx,
    db,
    exec: async (sql) => db.exec(sql),
    transaction: async (task) => {
      db.exec('BEGIN');
      try {
        await task(tx);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function contract(name: string, make: () => Promise<LogStore>): void {
  describe(`${name}: LogStore contract`, () => {
    it('appends and loads in seq order', async () => {
      const store = await make();
      await store.append(S1, [ev(S1, 1), ev(S1, 2)]);
      await store.append(S1, [ev(S1, 3)]);
      expect((await store.load(S1)).map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(await store.load(S2)).toEqual([]);
    });

    it('round-trips events exactly', async () => {
      const store = await make();
      const events = [ev(S1, 1), ev(S1, 2, 'SessionClosed')];
      await store.append(S1, events);
      expect(await store.load(S1)).toEqual(events);
    });

    it('rejects gaps, repeats and events of another session, storing nothing of the batch', async () => {
      const store = await make();
      await store.append(S1, [ev(S1, 1)]);
      await expect(store.append(S1, [ev(S1, 3)])).rejects.toBeInstanceOf(LogAppendError);
      await expect(store.append(S1, [ev(S1, 2), ev(S1, 2)])).rejects.toBeInstanceOf(LogAppendError);
      await expect(store.append(S1, [ev(S2, 2)])).rejects.toBeInstanceOf(LogAppendError);
      await expect(store.append(S1, [ev(S1, 1)])).rejects.toBeInstanceOf(LogAppendError);
      expect((await store.load(S1)).map((e) => e.seq)).toEqual([1]);
      await store.append(S1, [ev(S1, 2)]);
      expect((await store.load(S1)).map((e) => e.seq)).toEqual([1, 2]);
    });

    it('lists sessions newest first with last seq and closed flag', async () => {
      const store = await make();
      await store.append(S1, [ev(S1, 1), ev(S1, 2, 'SessionClosed')]);
      await store.append(S2, [ev(S2, 1)]);
      expect(await store.listSessions()).toEqual([
        { sessionId: S2, lastSeq: 1, closed: false },
        { sessionId: S1, lastSeq: 2, closed: true },
      ]);
    });

    it('keeps concurrent appends in order', async () => {
      const store = await make();
      await Promise.all([store.append(S1, [ev(S1, 1)]), store.append(S1, [ev(S1, 2)]), store.append(S1, [ev(S1, 3)])]);
      expect((await store.load(S1)).map((e) => e.seq)).toEqual([1, 2, 3]);
    });
  });
}

describe('one MemoryLogStore', () => {
  it('platform re-exports the engine’s store and error, so there is a single implementation', () => {
    expect(MemoryLogStore).toBe(EngineMemoryLogStore);
    expect(LogAppendError).toBe(EngineLogAppendError);
  });
});

contract('MemoryLogStore (engine)', async () => new EngineMemoryLogStore());
contract('SqliteLogStore on node:sqlite', async () => new SqliteLogStore(await nodeSqliteExecutor()));
contract('SqliteLogStore on expo-sqlite as on web', async () => new SqliteLogStore(expoSqliteExecutor(expoLikeDatabase(await nodeSqlite(), ':memory:', 'web'))));
contract('SqliteLogStore on expo-sqlite as on native, in a file', async () =>
  new SqliteLogStore(expoSqliteExecutor(expoLikeDatabase(await nodeSqlite(), await tempDbFile(), 'native'))),
);

describe('SqliteLogStore specifics', () => {
  it('append resolves only after COMMIT, with every insert inside the transaction', async () => {
    const log: string[] = [];
    let openGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const fake: SqlExecutor = {
      exec: async () => {
        log.push('exec schema');
      },
      run: async (sql) => {
        log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      },
      all: async () => [],
      transaction: async (task) => {
        log.push('BEGIN');
        await task({ run: (sql, p) => fake.run(sql, p), all: () => Promise.resolve([]) });
        await gate; // the commit is slow
        log.push('COMMIT');
      },
    };
    const store = new SqliteLogStore(fake);
    let done = false;
    const p = store.append(S1, [ev(S1, 1), ev(S1, 2)]).then(() => {
      done = true;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(done).toBe(false);
    openGate();
    await p;
    expect(done).toBe(true);
    expect(log).toEqual([
      'exec schema',
      'BEGIN',
      'INSERT INTO arcade_events',
      'INSERT INTO arcade_events',
      'INSERT INTO arcade_sessions',
      'COMMIT',
    ]);
  });

  it('a failing commit rejects the append and leaves no partial batch', async () => {
    const exec = await nodeSqliteExecutor();
    const store = new SqliteLogStore({
      ...exec,
      transaction: (task) =>
        exec.transaction(async (tx) => {
          await task(tx);
          throw new Error('disk full');
        }),
    });
    await expect(store.append(S1, [ev(S1, 1)])).rejects.toThrow('disk full');
    const ok = new SqliteLogStore(exec);
    expect(await ok.load(S1)).toEqual([]);
    expect(await ok.listSessions()).toEqual([]);
  });

  it('load validates every stored event', async () => {
    const exec = await nodeSqliteExecutor();
    const store = new SqliteLogStore(exec);
    await store.append(S1, [ev(S1, 1)]);
    exec.db.exec(`UPDATE arcade_events SET json = '{"schema":"arcade.event/v1","seq":1}'`);
    await expect(store.load(S1)).rejects.toThrow();
  });
});

describe('SqliteLogStore in a database file: WAL, busy timeout, full sync', () => {
  const plain = (rows: unknown[]): unknown[] => rows.map((r) => ({ ...(r as object) }));

  it('opens with WAL, a 5 s busy timeout and full sync, and every transaction connection waits too', async () => {
    const db = expoLikeDatabase(await nodeSqlite(), await tempDbFile(), 'native');
    const exec = expoSqliteExecutor(db);
    await new SqliteLogStore(exec).init();
    expect(plain([db.main.prepare('PRAGMA journal_mode').get()])).toEqual([{ journal_mode: 'wal' }]);
    expect(plain([db.main.prepare('PRAGMA busy_timeout').get()])).toEqual([{ timeout: 5000 }]);
    expect(plain([db.main.prepare('PRAGMA synchronous').get()])).toEqual([{ synchronous: 2 }]);
    let inTransaction: unknown[] = [];
    await exec.transaction(async (tx) => {
      inTransaction = [...(await tx.all('PRAGMA journal_mode', [])), ...(await tx.all('PRAGMA busy_timeout', [])), ...(await tx.all('PRAGMA synchronous', []))];
    });
    expect(inTransaction).toEqual([{ journal_mode: 'wal' }, { timeout: 5000 }, { synchronous: 2 }]);
  });

  it('loads and appends overlapping in time never fail with SQLITE_BUSY', async (ctx) => {
    const mod = await nodeSqlite();
    const probe = new mod.DatabaseSync(':memory:');
    const canHoldReads = typeof probe.prepare('SELECT 1').iterate === 'function';
    probe.close();
    if (!canHoldReads) ctx.skip(); // node:sqlite before Node 22.13 can't keep a read open
    const file = await tempDbFile();
    // The writer, and a second store on the same file (another screen, the dev tools) that
    // steps through a long read while the writer commits on its own connection.
    const writer = new SqliteLogStore(expoSqliteExecutor(expoLikeDatabase(mod, file, 'native')));
    const reader = new SqliteLogStore(expoSqliteExecutor(expoLikeDatabase(mod, file, 'native')));
    await writer.append(S1, Array.from({ length: 30 }, (_, i) => ev(S1, i + 1)));
    const [loaded] = await Promise.all([reader.load(S1), writer.append(S1, [ev(S1, 31)]), writer.append(S1, [ev(S1, 32)])]);
    expect(loaded.length).toBeGreaterThanOrEqual(30);
    const [again] = await Promise.all([writer.load(S1), writer.append(S1, [ev(S1, 33)]), reader.listSessions()]);
    expect(again).toHaveLength(32);
    expect((await reader.load(S1)).map((e) => e.seq)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
  });
});

describe('expoSqliteExecutor', () => {
  it('uses the exclusive transaction where available and the plain one otherwise', async () => {
    const calls: string[] = [];
    const statements = {
      execAsync: async (sql: string) => {
        calls.push(`exec ${sql}`);
      },
      runAsync: async (sql: string, params: SqlValue[]) => {
        calls.push(`run ${sql} ${params.length}`);
      },
      getAllAsync: async <T,>() => [] as T[],
    };
    const native: ExpoSqliteDatabaseLike = {
      ...statements,
      withTransactionAsync: async () => {
        calls.push('plain');
      },
      withExclusiveTransactionAsync: async (task) => {
        calls.push('exclusive');
        await task(statements);
      },
    };
    await expoSqliteExecutor(native).transaction(async (tx) => tx.run('X', [1]));
    const web: ExpoSqliteDatabaseLike = {
      ...statements,
      withTransactionAsync: async (task) => {
        calls.push('plain');
        await task();
      },
    };
    await expoSqliteExecutor(web).transaction(async (tx) => tx.run('Y', []));
    expect(calls).toEqual(['exclusive', 'exec PRAGMA busy_timeout = 5000', 'run X 1', 'plain', 'run Y 0']);
  });

  it('on web, where withExclusiveTransactionAsync is defined but throws, appends use withTransactionAsync', async () => {
    const db = expoLikeDatabase(await nodeSqlite(), ':memory:', 'web');
    const exclusive = vi.spyOn(db, 'withExclusiveTransactionAsync');
    const plain = vi.spyOn(db, 'withTransactionAsync');
    const store = new SqliteLogStore(expoSqliteExecutor(db));
    await store.append(S1, [ev(S1, 1)]);
    await store.append(S1, [ev(S1, 2)]);
    expect((await store.load(S1)).map((e) => e.seq)).toEqual([1, 2]);
    expect(exclusive).toHaveBeenCalledTimes(1); // tried once, then known to be web
    expect(plain).toHaveBeenCalledTimes(2);
  });

  it('exclusive: false never tries the exclusive transaction; exclusive: true never falls back', async () => {
    const db = expoLikeDatabase(await nodeSqlite(), ':memory:', 'web');
    const exclusive = vi.spyOn(db, 'withExclusiveTransactionAsync');
    await new SqliteLogStore(expoSqliteExecutor(db, { exclusive: false })).append(S1, [ev(S1, 1)]);
    expect(exclusive).not.toHaveBeenCalled();
    await expect(new SqliteLogStore(expoSqliteExecutor(db, { exclusive: true })).append(S2, [ev(S2, 1)])).rejects.toThrow(/not supported on web/);
  });

  it('a task that fails inside the exclusive transaction is not run again', async () => {
    const db = expoLikeDatabase(await nodeSqlite(), await tempDbFile(), 'native');
    const plain = vi.spyOn(db, 'withTransactionAsync');
    let runs = 0;
    const exec = expoSqliteExecutor(db);
    await expect(
      exec.transaction(async () => {
        runs++;
        throw new Error('not supported on web'); // even with that message
      }),
    ).rejects.toThrow();
    expect(runs).toBe(1);
    expect(plain).not.toHaveBeenCalled();
  });

  it('on web a load waits for the append in flight, so it never reads a batch that is rolled back', async () => {
    const db = expoLikeDatabase(await nodeSqlite(), ':memory:', 'web');
    let loadedMeanwhile: Promise<ArcadeEvent[]> | undefined;
    const store = new SqliteLogStore(
      expoSqliteExecutor({
        ...db,
        withExclusiveTransactionAsync: undefined,
        withTransactionAsync: (task) =>
          db.withTransactionAsync(async () => {
            await task();
            loadedMeanwhile = store.load(S1); // the batch is inserted, not committed
            await tick();
            throw new Error('disk full');
          }),
      }),
    );
    await expect(store.append(S1, [ev(S1, 1), ev(S1, 2)])).rejects.toThrow('disk full');
    expect(await loadedMeanwhile).toEqual([]);
  });
});
