import type { z } from 'zod';
import type { ArcadeEventType, BOARD_FACT_SCHEMAS, EventOf } from './events';

/**
 * The part of an event its producer fills in. The host adds `schema`, `eventId`,
 * `sessionId`, `seq` and `receivedAt` when it appends the event to the log.
 */
export type EventDraft<T extends ArcadeEventType = ArcadeEventType> = T extends ArcadeEventType
  ? Pick<EventOf<T>, 'type' | 'payload' | 'source' | 'occurredAt'> &
      Partial<Pick<EventOf<T>, 'causationId' | 'correlationId'>>
  : never;

export type BoardFact = z.infer<(typeof BOARD_FACT_SCHEMAS)[number]>;
export type BoardFactType = BoardFact['type'];

/** What a source adapter emits: a layer-1 board fact, before the host appends it. */
export type BoardFactDraft = EventDraft<BoardFactType>;
