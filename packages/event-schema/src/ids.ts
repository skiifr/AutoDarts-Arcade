import { z } from 'zod';

/** Crockford base32 ULID: 26 chars, lexically time-sortable. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const UlidSchema = z.string().regex(ULID_PATTERN, 'must be a ULID');

export const SessionIdSchema = UlidSchema;
export const EventIdSchema = UlidSchema;
/** Stable for profiles, per-session for guests. */
export const PlayerIdSchema = UlidSchema;
/** Minted by the adapter on first sighting of a dart, or by the host for a manual dart. */
export const ThrowIdSchema = UlidSchema;
/** Minted by the adapter at the start of each board visit. */
export const VisitKeySchema = UlidSchema;
export const CommandIdSchema = UlidSchema;

export type PlayerId = z.infer<typeof PlayerIdSchema>;
export type ThrowId = z.infer<typeof ThrowIdSchema>;
