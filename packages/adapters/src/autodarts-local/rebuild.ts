import type { BoardFact } from '@arcade/event-schema';
import type { IdSource } from '../ports';
import type { KnownDart, VisitState } from './visit-tracker';

type FactLike = Pick<BoardFact, 'type' | 'payload'> | { type: string; payload: unknown };

/**
 * Rebuilds the adapter's visit state from persisted layer-1 board facts, in seq order
 * (ARCHITECTURE §6.5: "The adapter's known[] is rebuilt from the last visit's events").
 * Pass the result as `restored` when resuming a session; the first connection then
 * resyncs against it. Facts of other layers are ignored.
 */
export function rebuildVisitState(events: readonly FactLike[], ids: IdSource): VisitState {
  let visitKey: string | null = null;
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

  for (const e of events as readonly BoardFact[]) {
    switch (e.type) {
      case 'DartDetected': {
        const p = e.payload;
        if (p.visitKey !== visitKey) {
          if (visitKey !== null) endVisit();
          visitKey = p.visitKey;
        }
        const dart: KnownDart = { throwId: p.throwId, segment: p.segment, indexInVisit: p.indexInVisit };
        if (p.coords) dart.coords = p.coords;
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
  return { visitKey: visitKey ?? ids(), known: known.filter(Boolean), inTakeout, recentVisits: recent };
}
