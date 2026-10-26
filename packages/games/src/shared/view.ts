import type { PlayerId } from '@arcade/event-schema';

/** One line of the W3 standings column. The UI shows it as-is, without knowing the rules. */
export interface ScoreRow {
  playerId: PlayerId;
  name: string;
  colorIndex: number;
  /** The number shown beside the name (remaining score, points, progress, wall…). */
  score: number;
  /** A short second line, e.g. "avg 45.3" or "4/7 closed". */
  detail: string;
  /** Throwing now. */
  active: boolean;
  /** Out of the game (eliminated). */
  out: boolean;
}

/**
 * The part of every reference game's view that a game-agnostic screen (or the headless
 * runner) can render. Each game adds its own stage data on top.
 */
export interface BaseView {
  gameId: string;
  /** One line for the top of the stage, e.g. "Alex needs 121". */
  headline: string;
  /** 1-based round shown as "ROUND 4 / 10". */
  round: number;
  maxRounds: number;
  finished: boolean;
  /** The player throwing now, or null once the game is over. */
  current: PlayerId | null;
  /** Board numbers worth aiming at right now, best first (25 is the bull). */
  targets: number[];
  scoreboard: ScoreRow[];
}
