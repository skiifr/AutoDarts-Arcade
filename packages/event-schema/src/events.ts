import { z } from 'zod';
import {
  EventIdSchema,
  PlayerIdSchema,
  SessionIdSchema,
  ThrowIdSchema,
  UlidSchema,
  VisitKeySchema,
} from './ids';
import { CoordsSchema, SegmentSchema } from './segment';

export const EVENT_SCHEMA_VERSION = 'arcade.event/v1';

export const EventSourceSchema = z.object({
  kind: z.enum(['autodarts-local', 'simulator', 'manual', 'engine']),
  adapterVersion: z.string().min(1),
  upstreamVersion: z.string().min(1).optional(),
  /** Stable board identity if derivable. Never the board API key. */
  boardId: z.string().min(1).optional(),
  actor: z.union([PlayerIdSchema, z.literal('operator')]).optional(),
});
export type EventSource = z.infer<typeof EventSourceSchema>;

function defineEvent<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({
    schema: z.literal(EVENT_SCHEMA_VERSION),
    eventId: EventIdSchema,
    sessionId: SessionIdSchema,
    /** 1..n, gap-free, assigned by the host on append. Order by this, never by time. */
    seq: z.int().positive(),
    type: z.literal(type),
    payload,
    source: EventSourceSchema,
    occurredAt: z.iso.datetime(),
    receivedAt: z.iso.datetime(),
    causationId: UlidSchema.optional(),
    correlationId: UlidSchema.optional(),
  });
}

const DartIndexSchema = z.int().min(0).max(2);
const TurnIndexSchema = z.int().min(0);

// ── Layer 1: board facts (from adapters; know nothing about players) ─────────

export const DartDetected = defineEvent(
  'DartDetected',
  z.object({
    throwId: ThrowIdSchema,
    segment: SegmentSchema,
    coords: CoordsSchema.optional(),
    visitKey: VisitKeySchema,
    indexInVisit: DartIndexSchema,
    /** First seen in a resync snapshot (§6.4): the host scores it and flags the turn. */
    recovered: z.literal(true).optional(),
    /**
     * The adapter could not read the board's segment (§7.3, "anything else"): `segment` is a
     * miss standing in for it. A `SourceAnomaly` with the same `correlationId` keeps the raw
     * excerpt; the host flags the dart's turn `needsReview`.
     */
    pendingReview: z.literal(true).optional(),
  }),
);

export const DartUpdated = defineEvent(
  'DartUpdated',
  z.object({
    throwId: ThrowIdSchema,
    previous: SegmentSchema,
    segment: SegmentSchema,
    coords: CoordsSchema.optional(),
    /** The board re-read the dart as something the adapter could not read; see `DartDetected`. */
    pendingReview: z.literal(true).optional(),
  }),
);

export const DartWithdrawn = defineEvent('DartWithdrawn', z.object({ throwId: ThrowIdSchema }));

export const TakeoutStarted = defineEvent('TakeoutStarted', z.object({ visitKey: VisitKeySchema }));

export const TakeoutFinished = defineEvent(
  'TakeoutFinished',
  z.object({ visitKey: VisitKeySchema, inferred: z.literal(true).optional() }),
);

export const VisitReset = defineEvent(
  'VisitReset',
  z.object({ visitKey: VisitKeySchema, reason: z.literal('manual-reset') }),
);

export const BOARD_STATUSES = [
  'ready',
  'throwing',
  'takeout',
  'stuck-takeout',
  'calibrating',
  'stopped',
  'error',
] as const;

export const BoardStatusChanged = defineEvent(
  'BoardStatusChanged',
  z.object({
    status: z.enum(BOARD_STATUSES),
    health: z
      .object({
        fps: z.number().nonnegative().optional(),
        camFps: z.array(z.number().nonnegative()).optional(),
      })
      .optional(),
  }),
);

export const SourceConnectionChanged = defineEvent(
  'SourceConnectionChanged',
  z.object({
    state: z.enum(['connecting', 'resyncing', 'online', 'offline']),
    attempt: z.int().min(0).optional(),
    error: z.string().optional(),
  }),
);

export const SourceAnomaly = defineEvent(
  'SourceAnomaly',
  z.object({ rawExcerpt: z.string().max(2000), note: z.string() }),
);

// ── Layer 2: game facts (from the host; recorded at append time) ────────────

export const PlayerRefSchema = z.object({
  playerId: PlayerIdSchema,
  displayName: z.string().trim().min(1).max(24),
  /** Index into the 8-colour player palette; identity is never colour alone. */
  colorIndex: z.int().min(0).max(7),
  kind: z.enum(['profile', 'guest']),
});
export type PlayerRef = z.infer<typeof PlayerRefSchema>;

export const HouseRulesSchema = z.object({
  /** Pad a visit with misses when takeout comes before 3 darts (bounce-outs, falls). */
  missingDartsAreMisses: z.boolean(),
  /** Count a takeout with no darts as "skip turn" instead of ignoring it. */
  emptyTakeoutSkipsTurn: z.boolean(),
});
export type HouseRules = z.infer<typeof HouseRulesSchema>;

export const DEFAULT_HOUSE_RULES: HouseRules = {
  missingDartsAreMisses: true,
  emptyTakeoutSkipsTurn: false,
};

export const SessionStarted = defineEvent(
  'SessionStarted',
  z
    .object({
      gameId: z.string().min(1),
      gameVersion: z.string().min(1),
      options: z.record(z.string(), z.unknown()),
      players: z.array(PlayerRefSchema).min(1).max(8),
      turnOrder: z.array(PlayerIdSchema).min(1),
      /** Makes randomised games replay-deterministic. */
      rngSeed: z.string().min(1),
      houseRules: HouseRulesSchema,
    })
    .superRefine((p, ctx) => {
      const ids = p.players.map((pl) => pl.playerId).sort();
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: 'custom', message: 'duplicate playerId', path: ['players'] });
      }
      const order = [...p.turnOrder].sort();
      if (order.length !== ids.length || order.some((id, i) => id !== ids[i])) {
        ctx.addIssue({ code: 'custom', message: 'turnOrder must list every player exactly once', path: ['turnOrder'] });
      }
    }),
);

export const TurnStarted = defineEvent(
  'TurnStarted',
  z.object({ playerId: PlayerIdSchema, turnIndex: TurnIndexSchema, roundIndex: z.int().min(0) }),
);

export const DartThrown = defineEvent(
  'DartThrown',
  z.object({
    throwId: ThrowIdSchema,
    playerId: PlayerIdSchema,
    turnIndex: TurnIndexSchema,
    dartIndex: DartIndexSchema,
    segment: SegmentSchema,
    origin: z.enum(['detected', 'recovered']),
  }),
);

export const DartCorrected = defineEvent(
  'DartCorrected',
  z.object({
    throwId: ThrowIdSchema,
    previous: SegmentSchema,
    segment: SegmentSchema,
    reason: z.enum(['user', 'source-update']),
  }),
);

export const DartVoided = defineEvent(
  'DartVoided',
  z.object({
    throwId: ThrowIdSchema,
    reason: z.enum(['false-detection', 'duplicate', 'source-withdrawn', 'user']),
  }),
);

export const DartAdded = defineEvent(
  'DartAdded',
  z.object({
    throwId: ThrowIdSchema,
    playerId: PlayerIdSchema,
    turnIndex: TurnIndexSchema,
    dartIndex: DartIndexSchema,
    segment: SegmentSchema,
    reason: z.enum(['undetected', 'bounce-out', 'manual-mode']),
  }),
);

export const TurnEnded = defineEvent(
  'TurnEnded',
  z.object({
    playerId: PlayerIdSchema,
    turnIndex: TurnIndexSchema,
    reason: z.enum(['takeout', 'bust', 'game-rule', 'manual-skip']),
    needsReview: z.literal(true).optional(),
  }),
);

export const PAUSE_REASONS = ['menu', 'correction', 'board-offline', 'app-background', 'review'] as const;
/**
 * `review`: a takeout may have happened while the board was offline (`TakeoutFinished{inferred}`).
 * The host ends the turn flagged `needsReview` and starts no new turn until a person confirms it
 * (`ConfirmTurn` → `TurnReviewed` → `GameResumed{review}`).
 */
export const PauseReasonSchema = z.enum(PAUSE_REASONS);
export type PauseReason = z.infer<typeof PauseReasonSchema>;

export const GamePaused = defineEvent('GamePaused', z.object({ reason: PauseReasonSchema }));
export const GameResumed = defineEvent('GameResumed', z.object({ reason: PauseReasonSchema }));

/** A person checked a `needsReview` turn (and corrected it if needed). Clears the flag for that turn. */
export const TurnReviewed = defineEvent(
  'TurnReviewed',
  z.object({ playerId: PlayerIdSchema, turnIndex: TurnIndexSchema }),
);

export const StandingSchema = z.object({
  playerId: PlayerIdSchema,
  rank: z.int().min(1),
  score: z.number().finite(),
});
export type Standing = z.infer<typeof StandingSchema>;

export const GameFinished = defineEvent(
  'GameFinished',
  z.object({ standings: z.array(StandingSchema).min(1), provisional: z.literal(true) }),
);

export const SessionClosed = defineEvent(
  'SessionClosed',
  z.object({ outcome: z.enum(['completed', 'abandoned']), finalStandings: z.array(StandingSchema) }),
);

// ── Unions ──────────────────────────────────────────────────────────────────

export const BOARD_FACT_SCHEMAS = [
  DartDetected,
  DartUpdated,
  DartWithdrawn,
  TakeoutStarted,
  TakeoutFinished,
  VisitReset,
  BoardStatusChanged,
  SourceConnectionChanged,
  SourceAnomaly,
] as const;

export const GAME_FACT_SCHEMAS = [
  SessionStarted,
  TurnStarted,
  DartThrown,
  DartCorrected,
  DartVoided,
  DartAdded,
  TurnEnded,
  TurnReviewed,
  GamePaused,
  GameResumed,
  GameFinished,
  SessionClosed,
] as const;

export const ArcadeEventSchema = z.discriminatedUnion('type', [...BOARD_FACT_SCHEMAS, ...GAME_FACT_SCHEMAS]);
export type ArcadeEvent = z.infer<typeof ArcadeEventSchema>;
export type ArcadeEventType = ArcadeEvent['type'];
export type EventOf<T extends ArcadeEventType> = Extract<ArcadeEvent, { type: T }>;

export const BOARD_FACT_TYPES: ReadonlySet<ArcadeEventType> = new Set(
  BOARD_FACT_SCHEMAS.map((s) => s.shape.type.value),
);
export const GAME_FACT_TYPES: ReadonlySet<ArcadeEventType> = new Set(
  GAME_FACT_SCHEMAS.map((s) => s.shape.type.value),
);

export function isBoardFact(event: ArcadeEvent): boolean {
  return BOARD_FACT_TYPES.has(event.type);
}
