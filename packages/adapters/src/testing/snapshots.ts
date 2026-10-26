import type { Coords } from '@arcade/event-schema';
import { toSnapshot, type Snapshot } from '../autodarts-local/snapshot';
import { VisitTracker, type TrackerFact, type VisitState } from '../autodarts-local/visit-tracker';
import { createUlidSource, seededRandom } from '../random';
import { parseStateData } from '../raw';
import { rawSegmentOf } from '../simulator/board-model';
import { parseLabel } from '../simulator/geometry';

/** Test support: compact board snapshots and a tracker with deterministic ids. */

export interface DartSpec {
  label: string;
  coords?: Coords;
  /** Use the bare `{"name":"M"}` miss shape. */
  bare?: boolean;
}

/** `d('T20', 0.01, 0.6)`: a dart; omit x/y for a dart without coordinates. */
export function d(label: string, x?: number, y?: number, bare = false): DartSpec {
  return x === undefined || y === undefined ? { label, bare } : { label, coords: { x, y }, bare };
}

export function snap(status: string, event: string, darts?: readonly DartSpec[], extra: Record<string, unknown> = {}): Snapshot {
  const data: Record<string, unknown> = { connected: true, running: true, status, event, ...extra };
  if (darts !== undefined) {
    data.numThrows = darts.length;
    data.throws = darts.map((x) => ({
      bouncer: false,
      ...(x.coords ? { coords: x.coords } : {}),
      segment: rawSegmentOf(parseLabel(x.label), x.bare ? 'bare' : 'outside'),
    }));
  } else data.numThrows = 0;
  const parsed = parseStateData(data);
  if (!parsed.ok) throw new Error(parsed.note);
  return toSnapshot(parsed.data);
}

export const throwing = (...darts: DartSpec[]): Snapshot => snap(darts.length >= 3 ? 'Takeout' : 'Throw', 'Throw detected', darts);
export const takeoutStarted = (...darts: DartSpec[]): Snapshot => snap('Takeout in progress', 'Takeout started', darts.length ? darts : undefined);
export const takeoutFinished = (): Snapshot => snap('Throw', 'Takeout finished');
export const manualReset = (): Snapshot => snap('Throw', 'Manual reset');

export function tracker(restored?: VisitState): VisitTracker {
  return new VisitTracker(createUlidSource({ now: () => 1_793_649_600_000, random: seededRandom('tracker') }), restored);
}

/** Compact view of tracker facts (`review`: `pendingReview`). */
export function show(facts: readonly TrackerFact[]): string[] {
  return facts.map((f) => {
    switch (f.type) {
      case 'DartDetected':
        return `detect ${f.payload.indexInVisit}:${f.payload.segment.label}${f.payload.recovered ? ' recovered' : ''}${f.payload.pendingReview ? ' review' : ''}${f.anomaly ? ' anomaly' : ''}`;
      case 'DartUpdated':
        return `update ${f.payload.previous.label}->${f.payload.segment.label}${f.payload.pendingReview ? ' review' : ''}`;
      case 'DartWithdrawn':
        return 'withdraw';
      case 'TakeoutStarted':
        return 'takeout-start';
      case 'TakeoutFinished':
        return f.payload.inferred ? 'takeout-end inferred' : 'takeout-end';
      case 'VisitReset':
        return 'reset';
      case 'SourceAnomaly':
        return 'anomaly';
    }
  });
}
