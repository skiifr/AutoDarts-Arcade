import type { ArcadeEvent } from '@arcade/event-schema';
import type { LogStore } from '@arcade/engine';
import { describe, expect, it } from 'vitest';
import { expoSqliteExecutor, type ExpoSqliteDatabaseLike } from './expo-sqlite';
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

interface NodeDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: SqlValue[]): unknown; all(...params: SqlValue[]): unknown[] };
}

/** A real SQLite (Node 22's node:sqlite) behind the executor interface. */
async function nodeSqliteExecutor(): Promise<SqlExecutor & { db: NodeDb }> {
  const specifier = 'node:sqlite';
  const mod = (await import(/* @vite-ignore */ specifier)) as { DatabaseSync: new (path: string) => NodeDb };
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

contract('MemoryLogStore', async () => new MemoryLogStore());
contract('SqliteLogStore on node:sqlite', async () => new SqliteLogStore(await nodeSqliteExecutor()));

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

describe('expoSqliteExecutor', () => {
  it('uses the exclusive transaction where available and the plain one otherwise', async () => {
    const calls: string[] = [];
    const statements = {
      execAsync: async () => {
        calls.push('exec');
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
    expect(calls).toEqual(['exclusive', 'run X 1', 'plain', 'run Y 0']);
  });
});
