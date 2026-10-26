import { sameSegment, type Coords, type Segment } from '@arcade/event-schema';
import { normalizeThrow, type NormalizedThrow } from '../normalize';
import { KNOWN_STATUSES, type RawState } from '../raw';

/** A `state` frame or `GET /api/state` body after normalization. */
export interface Snapshot {
  status?: string;
  event?: string;
  running?: boolean;
  /** At most 3 darts, in board order. */
  throws: NormalizedThrow[];
  /** Notes about the frame itself (more than 3 darts, …). */
  notes: string[];
  /** The validated raw state it came from. */
  raw: RawState;
}

export const MAX_DARTS_PER_VISIT = 3;

export function toSnapshot(raw: RawState): Snapshot {
  const rawThrows = raw.throws ?? [];
  const notes: string[] = [];
  if (rawThrows.length > MAX_DARTS_PER_VISIT) notes.push(`state lists ${rawThrows.length} darts; only the first 3 are used`);
  const snap: Snapshot = { throws: rawThrows.slice(0, MAX_DARTS_PER_VISIT).map(normalizeThrow), notes, raw };
  if (raw.status !== undefined) snap.status = raw.status;
  if (raw.event !== undefined) snap.event = raw.event;
  if (raw.running !== undefined) snap.running = raw.running;
  return snap;
}

/**
 * The board shows a takeout in progress. The status says what the board is doing now, so it
 * decides; the event (the last thing that happened) only counts when the status is missing or
 * unknown. A takeout called off returns the status to "Throw" (or "Takeout" with 3 darts) and
 * may leave the event at "Takeout started".
 */
export function takeoutBegins(s: Snapshot): boolean {
  if (s.status !== undefined && (KNOWN_STATUSES as readonly string[]).includes(s.status)) return s.status === 'Takeout in progress';
  return s.event === 'Takeout started';
}

const LIFECYCLE_EVENTS = new Set([
  'Started',
  'Stopped',
  'Starting',
  'Stopping',
  'Calibration started',
  'Calibration finished',
]);
const LIFECYCLE_STATUSES = new Set(['Stopped', 'Starting', 'Calibrating', 'calibrating']);

/** The board (re)started or calibrated: its dart list was cleared without a takeout. */
export function isLifecycle(s: Snapshot): boolean {
  return (s.event !== undefined && LIFECYCLE_EVENTS.has(s.event)) || (s.status !== undefined && LIFECYCLE_STATUSES.has(s.status));
}

/**
 * Coordinates are bull-centred, r = 1.0 at the outer double wire (170 mm) 🟡. DartLab's
 * real 2.0.2 capture repeats a dart's coordinates bit for bit in every frame, and
 * HomeDarts' doubles round them to 4 decimals, so the same dart is within float
 * rounding of itself. A board that changes its mind moves the dart across a wire, a few
 * millimetres at most.
 */
export const SAME_DART_TOLERANCE = 0.002; // ≈ 0.3 mm
export const MOVED_DART_TOLERANCE = 0.05; // ≈ 8.5 mm

export type Relation = 'same' | 'updated' | 'other' | 'unknown';

interface DartLike {
  segment: Segment;
  coords?: Coords;
}

/**
 * How a known dart relates to a dart in a snapshot:
 * - `same`: same segment, same place (or no coordinates to tell);
 * - `updated`: the board re-read this dart: new segment, nearly the same place;
 * - `other`: a different physical dart;
 * - `unknown`: different segment and no coordinates to tell an update from a new dart.
 */
export function relate(known: DartLike, seen: DartLike): Relation {
  const seg = sameSegment(known.segment, seen.segment);
  if (known.coords && seen.coords) {
    const d = Math.hypot(known.coords.x - seen.coords.x, known.coords.y - seen.coords.y);
    if (seg) return d <= SAME_DART_TOLERANCE ? 'same' : 'other';
    return d <= MOVED_DART_TOLERANCE ? 'updated' : 'other';
  }
  return seg ? 'same' : 'unknown';
}
