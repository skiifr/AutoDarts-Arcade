export type EngineErrorCode =
  /** The log breaks an invariant: a seq gap, a missing SessionStarted, a dart in an unknown turn. */
  | 'corrupt-log'
  /** `SessionStarted.gameId` is not in the registry. */
  | 'unknown-game'
  /** `SessionStarted.options` no longer validate against the game's options schema. */
  | 'invalid-options'
  /** A game module broke its contract (for example `nextPlayer` named someone not in the session). */
  | 'game-contract'
  /** The host was asked to do something it cannot (for example resume a session with no events). */
  | 'host';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
