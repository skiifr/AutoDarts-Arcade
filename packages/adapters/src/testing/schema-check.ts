import { ArcadeEventSchema, type BoardFactDraft } from '@arcade/event-schema';

const SESSION = '01JBX0000000000000000000S0';
const EVENT = '01JBX0000000000000000000E0';

/**
 * Checks an adapter draft against the full `arcade.event/v1` schema by filling in the
 * fields the host adds on append. Any adapter output that the host could not persist
 * fails the test that produced it.
 */
export class BoardFactDraftSchemaCheck {
  private seq = 0;

  assert(draft: BoardFactDraft): void {
    const event = { ...draft, schema: 'arcade.event/v1', eventId: EVENT, sessionId: SESSION, seq: ++this.seq, receivedAt: draft.occurredAt };
    const r = ArcadeEventSchema.safeParse(event);
    if (!r.success) {
      throw new Error(`adapter emitted an invalid ${draft.type}: ${r.error.message}\n${JSON.stringify(draft)}`);
    }
  }
}
