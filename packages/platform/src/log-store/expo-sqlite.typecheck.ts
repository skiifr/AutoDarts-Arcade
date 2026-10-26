// Compile-time only: proves expo-sqlite's real database type fits the structural binding.
// `import type` is erased, so neither Node tests nor the app bundle load expo-sqlite here.
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ExpoSqliteDatabaseLike } from './expo-sqlite';

export type ExpoSqliteFits = SQLiteDatabase extends ExpoSqliteDatabaseLike ? true : never;
export const expoSqliteFits: ExpoSqliteFits = true;
