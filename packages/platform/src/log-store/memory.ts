/**
 * The in-memory `LogStore` is the engine's: one implementation, which the platform's
 * `LogStore` contract tests run against alongside `SqliteLogStore`. `checkAppend` and
 * `LogAppendError` are shared with the SQLite store, so both refuse a bad batch the same way.
 */
export { LogAppendError, MemoryLogStore, checkAppend } from '@arcade/engine';
