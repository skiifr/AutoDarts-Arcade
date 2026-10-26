import { makeSegment, miss, type BoardFactDraft, type EventSource } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TICKER,
  IDLE_CONNECTION,
  connectionBadge,
  tickerReduce,
  tickerTime,
  trackConnection,
  type ConnectionView,
  type LinkStatusLike,
  type TickerState,
} from './factTicker';

const source: EventSource = { kind: 'autodarts-local', adapterVersion: 'autodarts-local@0.1.0', upstreamVersion: '2.0.2' };
const at = '2026-10-26T15:42:12.345Z';
const V1 = '01JAAAAAAAAAAAAAAAAAAAAAV1';
const V2 = '01JAAAAAAAAAAAAAAAAAAAAAV2';
const tid = (n: number) => `01JAAAAAAAAAAAAAAAAAAAAT${String(n).padStart(2, '0')}`;

function dart(n: number, visitKey: string, indexInVisit: number, label: 'T20' | 'S5' | 'S1' | 'D16' | 'MISS', recovered = false): BoardFactDraft {
  const segment =
    label === 'T20' ? makeSegment(20, 3) : label === 'S5' ? makeSegment(5, 1, 'single-outer') : label === 'S1' ? makeSegment(1, 1, 'single-outer') : label === 'D16' ? makeSegment(16, 2) : miss(12);
  const payload: Extract<BoardFactDraft, { type: 'DartDetected' }>['payload'] = { throwId: tid(n), segment, visitKey, indexInVisit };
  if (recovered) payload.recovered = true;
  return { type: 'DartDetected', payload, source, occurredAt: at };
}

const fact = (type: BoardFactDraft['type'], payload: unknown): BoardFactDraft => ({ type, payload, source, occurredAt: at }) as BoardFactDraft;
const run = (facts: BoardFactDraft[], limit?: number): TickerState => facts.reduce((s, f) => tickerReduce(s, f, limit), EMPTY_TICKER);
const labels = (s: TickerState) => s.darts.map((d) => d.segment.label);

describe('fact ticker', () => {
  it('shows a visit filling up, then clears it on takeout', () => {
    const s = run([
      fact('BoardStatusChanged', { status: 'throwing' }),
      dart(1, V1, 0, 'T20'),
      dart(2, V1, 1, 'S5'),
      dart(3, V1, 2, 'MISS'),
      fact('TakeoutStarted', { visitKey: V1 }),
    ]);
    expect(labels(s)).toEqual(['T20', 'S5', 'MISS']);
    expect(s.inTakeout).toBe(true);
    expect(s.boardStatus).toBe('throwing');
    expect(s.entries.map((e) => e.summary)).toEqual([
      'takeout started · 3 darts on the board',
      'MISS beside 12 · dart 3',
      'S5 (5) · dart 2',
      'T20 (60) · dart 1',
      'status: Throwing',
    ]);

    const cleared = tickerReduce(s, fact('TakeoutFinished', { visitKey: V1 }));
    expect(cleared.darts).toEqual([]);
    expect(cleared.previous.map((d) => d.segment.label)).toEqual(['T20', 'S5', 'MISS']);
    expect(cleared.visitKey).toBeNull();
    expect(cleared.inTakeout).toBe(false);
    expect(cleared.counts).toMatchObject({ facts: 6, darts: 3, takeouts: 1, inferred: 0 });
    expect(cleared.entries[0]).toMatchObject({ type: 'TakeoutFinished', summary: 'board clear', tone: 'takeout', inferred: false });
  });

  it('marks recovered darts and inferred takeouts', () => {
    const s = run([dart(1, V1, 0, 'T20'), fact('TakeoutFinished', { visitKey: V1, inferred: true }), dart(2, V2, 0, 'D16', true)]);
    expect(s.entries[0]).toMatchObject({ type: 'DartDetected', recovered: true, inferred: false });
    expect(s.entries[1]).toMatchObject({ type: 'TakeoutFinished', inferred: true, recovered: false });
    expect(s.entries[1]?.summary).toMatch(/inferred/);
    expect(s.darts).toMatchObject([{ segment: { label: 'D16' }, recovered: true }]);
    expect(s.counts).toMatchObject({ recovered: 1, inferred: 1 });
  });

  it('starts a new visit when a dart arrives with another visit key', () => {
    const s = run([dart(1, V1, 0, 'T20'), dart(2, V1, 1, 'S5'), dart(3, V2, 0, 'S1')]);
    expect(labels(s)).toEqual(['S1']);
    expect(s.previous.map((d) => d.segment.label)).toEqual(['T20', 'S5']);
    expect(s.visitKey).toBe(V2);
  });

  it('keeps one chip per position when a dart is reported twice', () => {
    const s = run([dart(1, V1, 0, 'T20'), dart(1, V1, 0, 'T20'), dart(2, V1, 1, 'S5')]);
    expect(labels(s)).toEqual(['T20', 'S5']);
  });

  it('applies re-reads and withdrawals', () => {
    const s = run([
      dart(1, V1, 0, 'S5'),
      dart(2, V1, 1, 'T20'),
      fact('DartUpdated', { throwId: tid(1), previous: makeSegment(5, 1, 'single-outer'), segment: makeSegment(1, 1, 'single-outer') }),
      fact('DartWithdrawn', { throwId: tid(2) }),
    ]);
    expect(s.darts).toMatchObject([{ segment: { label: 'S1' }, updated: true }]);
    expect(s.entries.map((e) => e.summary).slice(0, 2)).toEqual(['T20 withdrawn (dart 2)', 'S5 → S1 (1)']);
  });

  it('summarises connection changes, anomalies and resets', () => {
    const s = run([
      fact('SourceConnectionChanged', { state: 'offline', attempt: 3, error: 'board unreachable: timeout' }),
      fact('SourceAnomaly', { note: 'unknown board status "Foo"', rawExcerpt: '{}' }),
      dart(1, V1, 0, 'T20'),
      fact('VisitReset', { visitKey: V1, reason: 'manual-reset' }),
      fact('BoardStatusChanged', { status: 'stuck-takeout', health: { fps: 12.5 } }),
    ]);
    expect(s.darts).toEqual([]);
    expect(s.previous.map((d) => d.segment.label)).toEqual(['T20']);
    expect(s.boardStatus).toBe('stuck-takeout');
    expect(s.entries.map((e) => [e.tone, e.summary])).toEqual([
      ['status', 'status: Stuck takeout · 12.5 fps'],
      ['takeout', 'manual reset on the board'],
      ['dart', 'T20 (60) · dart 1'],
      ['anomaly', 'unknown board status "Foo"'],
      ['connection', 'offline (try 3): board unreachable: timeout'],
    ]);
  });

  it('keeps only the newest facts', () => {
    const facts = Array.from({ length: 40 }, (_, i) => fact('BoardStatusChanged', { status: i % 2 ? 'ready' : 'throwing' }));
    const s = run(facts, 30);
    expect(s.entries).toHaveLength(30);
    expect(s.entries[0]?.n).toBe(40);
    expect(s.entries.at(-1)?.n).toBe(11);
    expect(s.counts.facts).toBe(40);
  });

  it('formats times as local clock time to a tenth of a second', () => {
    expect(tickerTime(at)).toMatch(/^\d\d:\d\d:12\.3$/);
    expect(tickerTime('not a time')).toBe('not a time'.slice(11, 21));
  });
});

describe('connection view', () => {
  const step = (statuses: LinkStatusLike[]): ConnectionView[] => {
    const out: ConnectionView[] = [];
    statuses.reduce<ConnectionView>((prev, st) => {
      const next = trackConnection(prev, st);
      out.push(next);
      return next;
    }, IDLE_CONNECTION);
    return out;
  };

  it('counts tries while connecting the first time', () => {
    const views = step([
      { phase: 'connecting', attempt: 1 },
      { phase: 'connecting', attempt: 2 },
    ]);
    expect(views.map(connectionBadge)).toEqual([
      { tone: 'connecting', label: 'Connecting' },
      { tone: 'connecting', label: 'Connecting · try 2' },
    ]);
  });

  it('stays "offline, retrying" through an outage and counts the reconnect', () => {
    const views = step([
      { phase: 'connecting', attempt: 1 },
      { phase: 'resyncing', attempt: 1 },
      { phase: 'online', attempt: 0 },
      { phase: 'offline', attempt: 0, error: 'socket closed: code 1006' },
      { phase: 'connecting', attempt: 1 },
      { phase: 'offline', attempt: 1, error: 'board unreachable: timeout' },
      { phase: 'connecting', attempt: 2 },
      { phase: 'resyncing', attempt: 2 },
      { phase: 'online', attempt: 0 },
    ]);
    expect(views.map((v) => connectionBadge(v).label)).toEqual([
      'Connecting',
      'Resyncing',
      'Online',
      'Offline · retrying (try 1)',
      'Offline · retrying (try 1)',
      'Offline · retrying (try 1)',
      'Offline · retrying (try 2)',
      'Resyncing',
      'Online',
    ]);
    expect(views[6]?.error).toBe('board unreachable: timeout');
    expect(views.at(-1)).toMatchObject({ outage: false, reconnects: 1, everOnline: true });
    expect(connectionBadge(views[4] as ConnectionView).tone).toBe('offline');
  });

  it('resets when stopped', () => {
    const [, stopped] = step([
      { phase: 'online', attempt: 0 },
      { phase: 'stopped', attempt: 0 },
    ]);
    expect(stopped).toEqual(IDLE_CONNECTION);
    expect(connectionBadge(stopped as ConnectionView)).toEqual({ tone: 'offline', label: 'Not connected' });
  });
});
