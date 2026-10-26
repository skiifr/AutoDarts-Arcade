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

  const endVisit = (keep = true): void => {
    // Like the tracker: darts voided by a manual reset are not remembered.
    if (keep && known.length > 0) recent.unshift(known);
    recent.length = Math.min(recent.length, 2);
    visitKey = null;
    known = [];
    inTakeout = false;
  };

  for (const e of events as readonly (BoardFact & { occurredAt?: string })[]) {
    if (e.occurredAt !== undefined && isContact(e)) observedAt = e.occurredAt;
    switch (e.type) {
      case 'DartDetected': {
        const p = e.payload;
        if (p.visitKey !== visitKey) {
          if (visitKey !== null) endVisit();
          visitKey = p.visitKey;
        }
        const dart: KnownDart = { throwId: p.throwId, segment: p.segment, indexInVisit: p.indexInVisit };
        if (p.coords) dart.coords = p.coords;
        // Flagged where the last visit's dart was: the tracker's suspected ghost, which stays flagged.
        const prev = recent[0]?.[p.indexInVisit];
        if (p.pendingReview && dart.coords && prev?.coords && relate(prev, dart) === 'same') dart.suspectedGhost = true;
        known[p.indexInVisit] = dart;
        break;
      }
      case 'DartUpdated': {
        const p = e.payload;
        known = known.map((k) =>
          k.throwId === p.throwId ? { ...k, segment: p.segment, ...(p.coords ? { coords: p.coords } : {}) } : k,
        );
        break;
      }
      case 'DartWithdrawn':
        known = known.filter((k) => k.throwId !== e.payload.throwId);
        break;
      case 'TakeoutStarted':
        if (visitKey === null) visitKey = e.payload.visitKey;
        if (e.payload.visitKey === visitKey) inTakeout = true;
        break;
      case 'TakeoutFinished':
        if (visitKey === null || e.payload.visitKey === visitKey) endVisit();
        break;
      case 'VisitReset':
        if (visitKey === null || e.payload.visitKey === visitKey) endVisit(false);
        break;
      default:
        break;
    }
  }
  const state: RestoredVisitState = { visitKey: visitKey ?? ids(), known: known.filter(Boolean), inTakeout, recentVisits: recent };
  if (observedAt !== undefined) state.observedAt = observedAt;
  return state;
}
