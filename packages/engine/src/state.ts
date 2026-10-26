import type {
  BOARD_STATUSES,
  HouseRules,
  PauseReason,
  PlayerId,
  PlayerRef,
  Segment,
  Standing,
  ThrowId,
} from '@arcade/event-schema';
import type { GameEffect } from './game-module';

/** Where a dart in a turn came from. */
export type DartOrigin = 'detected' | 'recovered' | 'undetected' | 'bounce-out' | 'manual-mode';
export type VoidReason = 'false-detection' | 'duplicate' | 'source-withdrawn' | 'user';
/** Why a recorded dart was not scored. */
export type GreyReason = 'bust' | 'game-rule' | 'finished' | 'overflow';
export type TurnEndReason = 'takeout' | 'bust' | 'game-rule' | 'manual-skip';
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export type ConnectionState = 'unknown' | 'connecting' | 'resyncing' | 'online' | 'offline';

export interface DartView {
  throwId: ThrowId;
  /** 0-based slot among the turn's live (not voided) darts. This is the `dartIndex` the game saw. */
  position: number;
  segment: Segment;
  points: number;
  origin: DartOrigin;
  /** An automatic miss added at an observed takeout by the `missingDartsAreMisses` house rule. */
  padded: boolean;
  /** The board's reading could not be understood; the dart stands as a miss and its turn is flagged. */
  pendingReview: boolean;
  /** False when the dart is recorded but greyed out (after a bust, after the game ended, a 4th dart). */
  scored: boolean;
  greyedBy: GreyReason | null;
  /** Changed after it was recorded, by the board or by a person: the W3 "adjusted" chip. */
  adjusted: boolean;
}

export interface VoidedDartView {
  throwId: ThrowId;
  segment: Segment;
  origin: DartOrigin;
  reason: VoidReason;
}

export interface TurnView {
  turnIndex: number;
  playerId: PlayerId;
  roundIndex: number;
  /** Live darts in throw order. */
  darts: readonly DartView[];
  voidedDarts: readonly VoidedDartView[];
  ended: boolean;
  endReason: TurnEndReason | null;
  /**
   * Flagged by owner decision R (recovered darts, an inferred takeout, a board reset, a 4th dart)
   * or because a dart could not be read (`pendingReview`).
   */
  needsReview: boolean;
  reviewed: boolean;
  /** Why the game stopped scoring this visit early, if it did. Derived on every fold. */
  closedBy: 'bust' | 'game-rule' | 'finished' | null;
  /** The whole turn came after the game was already over, so nothing in it was scored. */
  afterFinish: boolean;
  /** Sum of the points of the scored darts. */
  points: number;
}

/** A board dart that arrived during a review pause; it goes to the next turn once that starts. */
export interface HeldDartView {
  throwId: ThrowId;
  segment: Segment;
  visitKey: string;
  recovered: boolean;
}

export type SessionPhase =
  /** Darts were on the board when the game started; they are baseline and the first turn waits for a takeout. */
  | 'awaiting-clear-board'
  | 'playing'
  /** A turn ended at an inferred takeout. No turn starts until a person sends ConfirmTurn. */
  | 'awaiting-review'
  /** The game says it is over. The result is provisional until SessionClosed{completed}. */
  | 'finished'
  | 'closed';

export interface SessionState<State = unknown, View = unknown> {
  sessionId: string;
  /** Seq of the last event folded. */
  lastSeq: number;
  startedAt: string;
  gameId: string;
  /** The game version recorded at session start. */
  gameVersion: string;
  /** True when the registry's module has a different version from the one that recorded the session. */
  gameVersionMismatch: boolean;
  gameName: string;
  options: Readonly<Record<string, unknown>>;
  houseRules: HouseRules;
  rngSeed: string;
  /** In turn order. */
  players: readonly PlayerRef[];
  turnOrder: readonly PlayerId[];

  phase: SessionPhase;
  /** The turn in progress, if any. */
  currentTurn: TurnView | null;
  currentPlayerId: PlayerId | null;
  /** Index of the turn in progress, else of the last turn; null before the first turn. */
  turnIndex: number | null;
  roundIndex: number | null;
  dartsThisTurn: readonly DartView[];
  /** Between turns (during a review pause): who the game says throws next. */
  nextPlayerId: PlayerId | null;

  /** Every active pause, oldest first. Board darts still score during any pause except `review`. */
  paused: readonly PauseReason[];
  isPaused: boolean;

  turns: readonly TurnView[];
  /** Turns flagged `needsReview` with no `TurnReviewed` yet. */
  needsReview: readonly number[];
  reviewedTurns: readonly number[];
  /** The turn whose review is holding the game, while phase is `awaiting-review`. */
  awaitingReviewTurn: number | null;
  heldDarts: readonly HeldDartView[];
  /** Live darts that were on the board when the game started. */
  baselineDarts: number;

  /** Set while the game says it is over. A correction can withdraw it. */
  finished: { standings: readonly Standing[]; provisional: boolean } | null;
  /** `GameModule.result()` of the current state. */
  standings: readonly Standing[] | null;
  /** `CloseSession{completed}` (and Rematch) would be accepted: finished, and no unreviewed turn. */
  canComplete: boolean;
  closed: { outcome: 'completed' | 'abandoned'; finalStandings: readonly Standing[] } | null;

  board: { connection: ConnectionState; status: BoardStatus | 'unknown' };

  gameState: State;
  view: View;
}

/**
 * What the host hands the effects runtime after an append. Game effects come only from events
 * that were just appended; a correction's refold is silent apart from one `score-adjusted`.
 */
export type EngineEffect =
  | { type: 'game'; seq: number; effect: GameEffect }
  | { type: 'score-adjusted'; seq: number; throwIds: readonly ThrowId[] };
