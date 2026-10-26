import { z } from 'zod';
import { CommandIdSchema, PlayerIdSchema, ThrowIdSchema } from './ids';
import { HouseRulesSchema, PlayerRefSchema } from './events';
import { SegmentSchema } from './segment';

export const COMMAND_SCHEMA_VERSION = 'arcade.command/v1';

/**
 * Commands go from the UI or a companion device to the host. The host validates them
 * and turns accepted commands into events whose `causationId` is the `commandId`, so a
 * retried command is applied at most once.
 */
function defineCommand<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({
    schema: z.literal(COMMAND_SCHEMA_VERSION),
    commandId: CommandIdSchema,
    type: z.literal(type),
    payload,
    actor: z.union([PlayerIdSchema, z.literal('operator')]),
    issuedAt: z.iso.datetime(),
  });
}

const DartIndexSchema = z.int().min(0).max(2);

export const StartSession = defineCommand(
  'StartSession',
  z.object({
    gameId: z.string().min(1),
    options: z.record(z.string(), z.unknown()),
    players: z.array(PlayerRefSchema).min(1).max(8),
    turnOrder: z.array(PlayerIdSchema).optional(),
    /** The W2 house-rule toggles. The host falls back to its configured defaults when absent. */
    houseRules: HouseRulesSchema.optional(),
    /**
     * The game's random stream (`SessionStarted.rngSeed`), for demo mode, fixtures and the
     * headless runner. The host mints a fresh one when absent.
     */
    rngSeed: z.string().min(1).optional(),
  }),
);
export const CorrectDart = defineCommand('CorrectDart', z.object({ throwId: ThrowIdSchema, segment: SegmentSchema }));
export const VoidDart = defineCommand(
  'VoidDart',
  z.object({ throwId: ThrowIdSchema, reason: z.enum(['false-detection', 'user']).default('user') }),
);
export const AddDart = defineCommand(
  'AddDart',
  z.object({
    playerId: PlayerIdSchema,
    turnIndex: z.int().min(0),
    dartIndex: DartIndexSchema,
    segment: SegmentSchema,
    reason: z.enum(['undetected', 'bounce-out', 'manual-mode']),
  }),
);
/** Ends the current turn ("Next player", also the manual-mode turn end). Before the first turn, starts it. */
export const SkipTurn = defineCommand('SkipTurn', z.object({}));
const UserPauseReasonSchema = z.enum(['menu', 'correction', 'app-background']);
export const Pause = defineCommand('Pause', z.object({ reason: UserPauseReasonSchema }));
/** Lifts the given pause, or every menu / correction / app-background pause when no reason is given. */
export const Resume = defineCommand('Resume', z.object({ reason: UserPauseReasonSchema.optional() }));
/**
 * Confirms a turn flagged `needsReview`. The host records `TurnReviewed`; if the game was paused
 * for that turn's review, it then resumes (`GameResumed{review}`) and starts the next turn.
 */
export const ConfirmTurn = defineCommand('ConfirmTurn', z.object({ turnIndex: z.int().min(0) }));
export const Rematch = defineCommand('Rematch', z.object({}));
export const CloseSession = defineCommand('CloseSession', z.object({ outcome: z.enum(['completed', 'abandoned']) }));

export const ArcadeCommandSchema = z.discriminatedUnion('type', [
  StartSession,
  CorrectDart,
  VoidDart,
  AddDart,
  SkipTurn,
  Pause,
  Resume,
  ConfirmTurn,
  Rematch,
  CloseSession,
]);
export type ArcadeCommand = z.infer<typeof ArcadeCommandSchema>;
export type ArcadeCommandType = ArcadeCommand['type'];
export type CommandOf<T extends ArcadeCommandType> = Extract<ArcadeCommand, { type: T }>;
