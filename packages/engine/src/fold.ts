import type { ArcadeEvent } from '@arcade/event-schema';
import { SessionFolder, type FoldOptions } from './folder';
import type { GameRegistry } from './registry';
import type { SessionState } from './state';

/**
 * Pure replay: folds one session's log (seq order, starting at SessionStarted) into its state.
 * Corrections are part of the log, so this is also how a correction takes effect. The same log
 * always folds to the same state; no effects are produced.
 */
export function foldSession(
  events: readonly ArcadeEvent[],
  registry: GameRegistry,
  options?: FoldOptions,
): SessionState {
  return SessionFolder.fromLog(events, registry, options).snapshot();
}
