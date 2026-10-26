import type { SqlExecutor, SqlTx, SqlValue } from './sqlite';

/**
 * The parts of expo-sqlite's async `SQLiteDatabase` this binding uses. Typed
 * structurally so that nothing here imports expo-sqlite: Node tests load this file, and
 * the app passes in the database it opened, e.g.
 *
 *   const db = await openDatabaseAsync('arcade.db');
 *   const store = new SqliteLogStore(expoSqliteExecutor(db, { exclusive: Platform.OS !== 'web' }));
 *
 * `expo-sqlite.typecheck.ts` checks that expo-sqlite's real type fits.
 */
export interface ExpoStatementsLike {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SqlValue[]): Promise<unknown>;
  getAllAsync<T>(source: string, params: SqlValue[]): Promise<T[]>;
}

export interface ExpoSqliteDatabaseLike extends ExpoStatementsLike {
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  /**
   * Native: runs the task on a new connection of its own, so no other query interleaves.
   * Web: defined, but throws "not supported on web" before running the task.
   */
  withExclusiveTransactionAsync?(task: (txn: ExpoStatementsLike) => Promise<void>): Promise<void>;
}

export interface ExpoSqliteExecutorOptions {
  /**
   * Whether transactions use `withExclusiveTransactionAsync`. Pass `Platform.OS !== 'web'`.
   * Left out, the binding tries it, and if expo-sqlite answers that it is not supported on
   * web, uses `withTransactionAsync` from then on.
   */
  exclusive?: boolean;
}

function statements(s: ExpoStatementsLike): SqlTx {
  return {
    run: async (sql, params) => {
      await s.runAsync(sql, [...params]);
    },
    all: (sql, params) => s.getAllAsync(sql, [...params]),
  };
}

const WEB_UNSUPPORTED = /not supported on web/i;

/**
 * `SqlExecutor` over expo-sqlite. Both kinds of transaction commit before they resolve and
 * roll back on error.
 * - **iOS, Android, Fire OS:** `withExclusiveTransactionAsync`, on its own connection.
 * - **Web:** `withTransactionAsync` on the one connection. expo-sqlite defines the exclusive
 *   kind there too, but it throws. The plain kind is enough because `SqliteLogStore` runs
 *   its appends, loads and listings one at a time, so nothing else can run inside an open
 *   transaction and see its uncommitted rows. (The memory store would also work on web, but
 *   would lose the log on every reload, and this keeps one code path on every platform.)
 */
export function expoSqliteExecutor(db: ExpoSqliteDatabaseLike, options: ExpoSqliteExecutorOptions = {}): SqlExecutor {
  const base = statements(db);
  /** Known once a call has shown it: undefined until then, unless the caller said. */
  let exclusive = options.exclusive;
  return {
    ...base,
    exec: (sql) => db.execAsync(sql),
    transaction: async (task) => {
      if (exclusive !== false && db.withExclusiveTransactionAsync) {
        let started = false;
        try {
          await db.withExclusiveTransactionAsync((txn) => {
            started = true;
            return task(statements(txn));
          });
          exclusive = true;
          return;
        } catch (e) {
          // Fall back only when expo-sqlite refused before the task ran, the way it does on web.
          const web = !started && exclusive === undefined && e instanceof Error && WEB_UNSUPPORTED.test(e.message);
          if (!web) throw e;
          exclusive = false;
        }
      }
      await db.withTransactionAsync(() => task(base));
    },
  };
}
