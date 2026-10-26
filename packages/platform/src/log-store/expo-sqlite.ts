import type { SqlExecutor, SqlTx, SqlValue } from './sqlite';

/**
 * The parts of expo-sqlite's async `SQLiteDatabase` this binding uses. Typed
 * structurally so that nothing here imports expo-sqlite: Node tests load this file, and
 * the app passes in the database it opened, e.g.
 *
 *   const db = await openDatabaseAsync('arcade.db');
 *   const store = new SqliteLogStore(expoSqliteExecutor(db));
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
  /** Native only: runs the task on its own connection, so no other query interleaves. */
  withExclusiveTransactionAsync?(task: (txn: ExpoStatementsLike) => Promise<void>): Promise<void>;
}

function statements(s: ExpoStatementsLike): SqlTx {
  return {
    run: async (sql, params) => {
      await s.runAsync(sql, [...params]);
    },
    all: (sql, params) => s.getAllAsync(sql, [...params]),
  };
}

/**
 * `SqlExecutor` over expo-sqlite. Transactions use `withExclusiveTransactionAsync` where
 * available (iOS, Android, Fire OS), which commits before it resolves and rolls back on
 * error; on web, `withTransactionAsync`.
 */
export function expoSqliteExecutor(db: ExpoSqliteDatabaseLike): SqlExecutor {
  const base = statements(db);
  return {
    ...base,
    exec: (sql) => db.execAsync(sql),
    transaction: async (task) => {
      if (db.withExclusiveTransactionAsync) {
        await db.withExclusiveTransactionAsync((txn) => task(statements(txn)));
      } else {
        await db.withTransactionAsync(() => task(base));
      }
    },
  };
}
