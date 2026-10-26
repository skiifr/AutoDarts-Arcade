import { points, type BOARD_STATUSES, type BoardFactDraft, type Segment } from '@arcade/event-schema';
import type { BoardStatusTone } from './controls';

/**
 * View model for the dart ticker (`/ticker`): a raw, honest reading of the board facts an
 * adapter emits, with no game engine in between. Pure, so it is unit-tested here and the
 * screen only renders it.
 */

export type TickerBoardStatus = (typeof BOARD_STATUSES)[number];

export const BOARD_STATUS_LABELS: Record<TickerBoardStatus, string> = {
  ready: 'Ready',
  throwing: 'Throwing',
  takeout: 'Takeout',
  'stuck-takeout': 'Stuck takeout',
  calibrating: 'Calibrating',
  stopped: 'Stopped',
  error: 'Error',
};

export interface TickerDart {
  throwId: string;
  indexInVisit: number;
  segment: Segment;
  /** First seen in a resync snapshot: the board had it while Arcade was offline. */
  recovered: boolean;
  /** The board re-read it (`DartUpdated`) after first reporting it. */
  updated: boolean;
}

export type TickerTone = 'dart' | 'takeout' | 'status' | 'connection' | 'anomaly';

export interface TickerEntry {
  /** 1, 2, 3… per ticker, for list keys. */
  n: number;
  /** The fact's `occurredAt`. */
  at: string;
  type: BoardFactDraft['type'];
  summary: string;
  tone: TickerTone;
  recovered: boolean;
  inferred: boolean;
}

export interface TickerState {
  /** Visit of the darts on the board; null after a takeout until the next dart. */
  visitKey: string | null;
  /** Darts of the current visit, in board order. */
  darts: TickerDart[];
  /** Darts of the last visit that ended (takeout, reset or a new visit), for a second look. */
  previous: TickerDart[];
  /** Between `TakeoutStarted` and `TakeoutFinished`. */
  inTakeout: boolean;
  boardStatus: TickerBoardStatus | null;
  /** The last `limit` facts, newest first. */
  entries: TickerEntry[];
  counts: { facts: number; darts: number; takeouts: number; recovered: number; inferred: number };
}

export const TICKER_LIMIT = 30;

export const EMPTY_TICKER: TickerState = {
  visitKey: null,
  darts: [],
  previous: [],
  inTakeout: false,
  boardStatus: null,
  entries: [],
  counts: { facts: 0, darts: 0, takeouts: 0, recovered: 0, inferred: 0 },
};

function dartName(segment: Segment): string {
  return segment.bed === 'miss' && segment.missSector !== undefined ? `MISS beside ${segment.missSector}` : segment.label;
}

function withPoints(segment: Segment): string {
  const p = points(segment);
  return p > 0 ? `${dartName(segment)} (${p})` : dartName(segment);
}

/** Folds one board fact into the ticker. */
export function tickerReduce(state: TickerState, fact: BoardFactDraft, limit = TICKER_LIMIT): TickerState {
  let { visitKey, darts, previous, inTakeout, boardStatus } = state;
  /** The current visit ends: keep its darts as the previous visit. */
  const endVisit = (): void => {
    if (darts.length > 0) previous = darts;
    visitKey = null;
    darts = [];
    inTakeout = false;
  };
  const counts = { ...state.counts, facts: state.counts.facts + 1 };
  let summary: string;
  let tone: TickerTone;
  let recovered = false;
  let inferred = false;

  switch (fact.type) {
    case 'DartDetected': {
      const p = fact.payload;
      recovered = p.recovered === true;
      if (p.visitKey !== visitKey) {
        endVisit();
        visitKey = p.visitKey;
      }
      const dart: TickerDart = { throwId: p.throwId, indexInVisit: p.indexInVisit, segment: p.segment, recovered, updated: false };
      darts = [...darts.filter((d) => d.throwId !== p.throwId && d.indexInVisit !== p.indexInVisit), dart].sort(
        (a, b) => a.indexInVisit - b.indexInVisit,
      );
      counts.darts++;
      if (recovered) counts.recovered++;
      summary = `${withPoints(p.segment)} · dart ${p.indexInVisit + 1}`;
      tone = 'dart';
      break;
    }
    case 'DartUpdated': {
      const p = fact.payload;
      darts = darts.map((d) => (d.throwId === p.throwId ? { ...d, segment: p.segment, updated: true } : d));
      summary = `${dartName(p.previous)} → ${withPoints(p.segment)}`;
      tone = 'dart';
      break;
    }
    case 'DartWithdrawn': {
      const gone = darts.find((d) => d.throwId === fact.payload.throwId);
      darts = darts.filter((d) => d.throwId !== fact.payload.throwId);
      summary = gone ? `${dartName(gone.segment)} withdrawn (dart ${gone.indexInVisit + 1})` : 'a dart was withdrawn';
      tone = 'dart';
      break;
    }
    case 'TakeoutStarted':
      inTakeout = true;
      summary = `takeout started · ${darts.length} dart${darts.length === 1 ? '' : 's'} on the board`;
      tone = 'takeout';
      break;
    case 'TakeoutFinished':
      inferred = fact.payload.inferred === true;
      if (inferred) counts.inferred++;
      counts.takeouts++;
      summary = inferred ? 'board clear · inferred: the takeout may have happened while offline' : 'board clear';
      endVisit();
      tone = 'takeout';
      break;
    case 'VisitReset':
      summary = 'manual reset on the board';
      endVisit();
      tone = 'takeout';
      break;
    case 'BoardStatusChanged': {
      const p = fact.payload;
      boardStatus = p.status;
      const fps = p.health?.fps !== undefined ? ` · ${p.health.fps} fps` : '';
      summary = `status: ${BOARD_STATUS_LABELS[p.status]}${fps}`;
      tone = 'status';
      break;
    }
    case 'SourceConnectionChanged': {
      const p = fact.payload;
      summary = `${p.state}${p.attempt !== undefined ? ` (try ${p.attempt})` : ''}${p.error ? `: ${p.error}` : ''}`;
      tone = 'connection';
      break;
    }
    case 'SourceAnomaly':
      summary = fact.payload.note;
      tone = 'anomaly';
      break;
  }

  const entry: TickerEntry = { n: counts.facts, at: fact.occurredAt, type: fact.type, summary, tone, recovered, inferred };
  return { visitKey, darts, previous, inTakeout, boardStatus, counts, entries: [entry, ...state.entries].slice(0, Math.max(1, limit)) };
}

/** `2026-10-26T15:42:12.345Z` → `15:42:12.3` in local time. */
export function tickerTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 21);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
}

// ── Connection ───────────────────────────────────────────────────────────────

/** Structurally the adapter's `ConnectionStatus` (ui-kit does not depend on adapters). */
export interface LinkStatusLike {
  phase: 'stopped' | 'connecting' | 'resyncing' | 'online' | 'offline';
  attempt: number;
  error?: string;
}

export interface ConnectionView {
  phase: LinkStatusLike['phase'];
  attempt: number;
  /** The last error reported while not online. */
  error?: string;
  /**
   * Set from the first `offline` until the next `online`. The adapter alternates between
   * connecting and offline on every retry; this keeps the display steady meanwhile.
   */
  outage: boolean;
  everOnline: boolean;
  /** Times the connection came back after being online. */
  reconnects: number;
}

export const IDLE_CONNECTION: ConnectionView = { phase: 'stopped', attempt: 0, outage: false, everOnline: false, reconnects: 0 };

export function trackConnection(prev: ConnectionView, status: LinkStatusLike): ConnectionView {
  if (status.phase === 'stopped') return { ...IDLE_CONNECTION };
  if (status.phase === 'online') {
    return { phase: 'online', attempt: status.attempt, outage: false, everOnline: true, reconnects: prev.reconnects + (prev.everOnline && prev.phase !== 'online' ? 1 : 0) };
  }
  const next: ConnectionView = {
    ...prev,
    phase: status.phase,
    attempt: status.attempt,
    outage: prev.outage || status.phase === 'offline',
  };
  if (status.error !== undefined) next.error = status.error;
  return next;
}

/** Short label and pill tone for a connection, with the retry count. */
export function connectionBadge(c: ConnectionView): { tone: BoardStatusTone; label: string } {
  switch (c.phase) {
    case 'stopped':
      return { tone: 'offline', label: 'Not connected' };
    case 'online':
      return { tone: 'online', label: 'Online' };
    case 'resyncing':
      return { tone: 'connecting', label: 'Resyncing' };
    case 'connecting':
    case 'offline':
      if (c.outage) return { tone: 'offline', label: `Offline · retrying (try ${Math.max(1, c.attempt)})` };
      return { tone: 'connecting', label: c.attempt > 1 ? `Connecting · try ${c.attempt}` : 'Connecting' };
  }
}
