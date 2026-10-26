import type { BOARD_STATUSES } from '@arcade/event-schema';
import { KNOWN_STATUSES } from '../raw';
import type { Snapshot } from './snapshot';

export type BoardStatus = (typeof BOARD_STATUSES)[number];

/**
 * Board `status` → `BoardStatusChanged.status` (ARCHITECTURE §4.3 enumerations 🟡).
 * `stuck-takeout` is not a board status: the adapter derives it from a takeout that holds
 * on an empty board for more than 8 s. Returns undefined when the status says nothing
 * usable (missing or unknown); `isKnownStatus` tells the two apart.
 */
export function boardStatusOf(snap: Snapshot): BoardStatus | undefined {
  switch (snap.status) {
    case 'Throw':
      return snap.throws.length > 0 ? 'throwing' : 'ready';
    case 'Takeout':
    case 'Takeout in progress':
      return 'takeout';
    case 'Stopped':
    case 'Starting':
      return 'stopped';
    case 'Calibrating':
    case 'calibrating':
      return 'calibrating';
    case 'Error':
    case 'error':
      return 'error';
    case undefined:
      return snap.running === false ? 'stopped' : undefined;
    default:
      return undefined;
  }
}

export function isKnownStatus(status: string): boolean {
  return (KNOWN_STATUSES as readonly string[]).includes(status);
}

/** A takeout that stays on an empty board: the 2.0.2 bug (🟡[C12], RISK R13). */
export function isStuckTakeoutCandidate(snap: Snapshot): boolean {
  return snap.status === 'Takeout in progress' && snap.throws.length === 0;
}

/**
 * HomeDarts' version pattern (MIT; notice in fixtures/community/README.md): 1.0.7, v2.0.0,
 * 2.1.0-beta.5. Anything else is dropped.
 */
const VERSION_PATTERN = /^v?\d{1,4}(?:\.\d{1,6}){0,3}(?:[-+][0-9A-Za-z.-]{1,32})?$/;

/**
 * Reads `GET /api/version`. HomeDarts reads the body as plain text (`2.0.2`); a JSON
 * string or `{"version": "…"}` is accepted too. Returns undefined for anything else.
 */
export function parseVersion(body: string): string | undefined {
  let text = body.trim();
  if (text.startsWith('"') || text.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(text);
      if (typeof v === 'string') text = v.trim();
      else if (typeof v === 'object' && v !== null && typeof (v as { version?: unknown }).version === 'string') {
        text = ((v as { version: string }).version).trim();
      } else return undefined;
    } catch {
      return undefined;
    }
  }
  if (!VERSION_PATTERN.test(text)) return undefined;
  return text.startsWith('v') ? text.slice(1) : text;
}

export interface AdapterProfile {
  /** Open `/api/events?type=state` rather than the bare path. */
  stateOnlySocket: boolean;
}

/**
 * Version-specific behaviour (RISK R01). Every version opens the bare `/api/events` and the
 * adapter filters frames by `type`: both community clients (HomeDarts, DartLab) do, and so
 * does DartLab's real 2.0.2 capture. `?type=state` comes only from a static inspection of
 * the 2.0.2 binary and is unverified on a live board, so it stays opt-in
 * (`AutodartsLocalOptions.stateOnlySocket`). Kept as a function for the version-specific
 * quirks still to come.
 */
export function profileFor(version: string | undefined): AdapterProfile {
  void version;
  return { stateOnlySocket: false };
}
