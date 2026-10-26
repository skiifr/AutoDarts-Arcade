import type { BoardFact } from '@arcade/event-schema';
import type { IdSource } from '../ports';
import { relate } from './snapshot';
import type { KnownDart, VisitState } from './visit-tracker';

type FactLike = (Pick<BoardFact, 'type' | 'payload'> | { type: string; payload: unknown }) & { occurredAt?: string };

/** Visit state to resume from, with the last time the board was seen. */
export interface RestoredVisitState extends VisitState {
  /**
   * When the board's state was last known (ISO, the adapter's clock): the latest fact that
   * came from reading the board. The resumed adapter measures the outage from here; when it
   * is absent the outage counts as long enough to hide a whole visit.
   */
  observedAt?: string;
}

/** A takeout seen ending, whose board event depends on the board status logged after it. */
const TAKEOUT_END = 'takeout end';

/** Facts that are only emitted while reading the board's state. */
function isContact(e: FactLike): boolean {
  switch (e.type) {
    case 'DartDetected':
    case 'DartUpdated':
    case 'DartWithdrawn':
    case 'TakeoutStarted':
    case 'TakeoutFinished':
    case 'VisitReset':
      return true;
    case 'BoardStatusChanged':
      // stuck-takeout comes from a timer, not from a reading.
      return (e.payload as { status?: string }).status !== 'stuck-takeout';
    case 'SourceConnectionChanged':
      return (e.payload as { state?: string }).state === 'online';
    default:
      return false;
  }
}

/**
 * Rebuilds the adapter's visit state from persisted layer-1 board facts, in seq order
 * (ARCHITECTURE §6.5: "The adapter's known[] is rebuilt from the last visit's events").
 * Pass the result as `restored` (or to `restore()`) when resuming a session; the first
 * connection then resyncs against it. Facts of other layers are ignored.
 */
export function rebuildVisitState(events: readonly FactLike[], ids: IdSource): RestoredVisitState {
  let visitKey: string | null = null;
  let observedAt: string | undefined;
  let known: KnownDart[] = [];
  let inTakeout = false;
  const recent: KnownDart[][] = [];

  /** The board status last logged, and whether the last visit's takeout still shows (`takeoutTail`). */
  let boardStatus: string | undefined;
  let tail = false;
  /** The open visit has had darts (even if all were withdrawn since: `allWithdrawn`). */
  let hadDarts = false;
  /**
   * The board's event as the last board fact implies it (`boardEvent`). Snapshots that changed
   * nothing logged nothing, so this is a guess; unknown after an inferred takeout.
   */
  let boardEvent: string | undefined;

  const endVisit = (keep = true): void => {
    // Like the tracker: darts voided by a manual reset are not remembered.
    if (keep && known.length > 0) recent.unshift(known);
    recent.length = Math.min(recent.length, 2);
    visitKey = null;
    known = [];
    inTakeout = false;
    hadDarts = false;
  };

  for (const e of events as readonly (BoardFact & { occurredAt?: string })[]) {
    if (e.occurredAt !== undefined && isContact(e)) observedAt = e.occurredAt;
    switch (e.type) {
      case 'DartDetected': {
        const p = e.payload;
        tail = false;
        if (p.visitKey !== visitKey) {
          if (visitKey !== null) endVisit();
          visitKey = p.visitKey;
        }
        hadDarts = true;
        boardEvent = 'Throw detected';
        const dart: KnownDart = { throwId: p.throwId, segment: p.segment, indexInVisit: p.indexInVisit };
        if (p.coords) dart.coords = p.coords;
        // Flagged where the last visit's dart was: the tracker's suspected ghost, which stays flagged.
        // (Ghosts are a new visit's leading darts, whose index is their place on the board.)
        const prev = recent[0]?.[p.indexInVisit];
        if (p.pendingReview && dart.coords && prev?.coords && relate(prev, dart) === 'same') dart.suspectedGhost = true;
        // The tracker keeps darts in board order, which is the order they were detected in: the
        // board appends new darts, and a withdrawal leaves the others in place.
        const at = known.findIndex((k) => k.throwId === p.throwId);
        if (at >= 0) known[at] = dart;
        else known.push(dart);
        break;
      }
      case 'DartUpdated': {
        const p = e.payload;
        // A re-read is a "Throw detected"; a flag alone (the segment unchanged) says nothing of the board.
        if (p.previous.label !== p.segment.label) boardEvent = 'Throw detected';
        // A flagged update leaves the dart in doubt for the rest of its visit. The log cannot tell
        // an unreadable re-read (which a later clean re-read settles) from a doubtful dart (which
        // nothing settles), so the rebuilt state keeps the doubt: more flags, never fewer (decision R).
        known = known.map((k) =>
          k.throwId === p.throwId
            ? { ...k, segment: p.segment, ...(p.coords ? { coords: p.coords } : {}), ...(p.pendingReview ? { inDoubt: true as const } : {}) }
            : k,
        );
        break;
      }
      case 'DartWithdrawn':
        known = known.filter((k) => k.throwId !== e.payload.throwId);
        break;
      case 'TakeoutStarted':
        tail = false;
        boardEvent = 'Takeout started';
        if (visitKey === null) visitKey = e.payload.visitKey;
        if (e.payload.visitKey === visitKey) inTakeout = true;
        break;
      case 'TakeoutFinished':
        if (visitKey === null || e.payload.visitKey === visitKey) {
          // Ended while the board still showed the takeout (its status logged no change, and no
          // new takeout followed): the last dart came out before the board's "Takeout finished".
          tail = boardStatus === 'takeout' && known.length > 0;
          // Seen ending: "Takeout finished", or, if the board still shows the takeout, "Takeout started"
          // (settled at the end, once the board status that follows is known).
          boardEvent = e.payload.inferred ? undefined : TAKEOUT_END;
          endVisit();
        }
        break;
      case 'VisitReset':
        tail = false;
        boardEvent = 'Manual reset';
        if (visitKey === null || e.payload.visitKey === visitKey) endVisit(false);
        break;
      case 'BoardStatusChanged': {
        const status = e.payload.status;
        // The board back to throwing ends a takeout it called off with the darts still in. (With
        // 3 darts it returns to "Takeout", which logs nothing new: the rebuilt state is then
        // still in the takeout, and the next snapshot ends it, flagging the darts left if any
        // went missing. More flags, never fewer.)
        if (status === 'throwing' || status === 'ready') inTakeout = false;
        if (status !== 'stuck-takeout') {
          boardStatus = status;
          if (status !== 'takeout') tail = false;
        }
        break;
      }
      default:
        break;
    }
  }
  const state: RestoredVisitState = { visitKey: visitKey ?? ids(), known: known.filter(Boolean), inTakeout, recentVisits: recent };
  if (tail) state.takeoutTail = true;
  if (hadDarts && state.known.length === 0) state.allWithdrawn = true;
  const event = boardEvent === TAKEOUT_END ? (tail ? 'Takeout started' : 'Takeout finished') : boardEvent;
  if (event !== undefined) state.boardEvent = event;
  if (observedAt !== undefined) state.observedAt = observedAt;
  return state;
}
