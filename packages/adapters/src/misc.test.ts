import { describe, expect, it } from 'vitest';
import { rebuildVisitState } from './autodarts-local/rebuild';
import { BoardHealthSampler, healthFact, parseCamsStats, parseStateStats } from './health';
import { ManualSource } from './manual';
import { seededRandom } from './random';
import { RawFrameRing } from './ring-buffer';
import { BoardModel } from './simulator/board-model';
import { scriptToFacts } from './simulator/dart-source';
import { FakeBoardTransport } from './simulator/fake-transport';
import { VirtualScheduler } from './simulator/virtual-scheduler';
import { createUlidSource } from './random';

describe('board-health sampler (§9.7)', () => {
  it('parses the stats endpoints (HomeDarts recordings)', () => {
    expect(parseStateStats('{"fps": 12.5}')).toBe(12.5);
    expect(parseCamsStats('{"fps":[29.9,30,29.8]}')).toEqual([29.9, 30, 29.8]);
    expect(parseCamsStats('[{"fps":29.9},{"fps":30}]')).toEqual([29.9, 30]);
    expect(parseStateStats('{"fps":"fast"}')).toBeUndefined();
    expect(parseCamsStats('{"fps":[1,null]}')).toBeUndefined();
    expect(parseCamsStats('nope')).toBeUndefined();
  });

  it('samples both endpoints every 30 s while running, and nothing once stopped', async () => {
    const sched = new VirtualScheduler();
    const board = new BoardModel({ random: seededRandom(1), cameras: 3 });
    const transport = new FakeBoardTransport({ board, scheduler: sched, random: seededRandom(2) });
    const sampler = new BoardHealthSampler({ transport, scheduler: sched, clock: () => 't' });
    const samples: unknown[] = [];
    sampler.onSample((s) => samples.push(s));
    sampler.start();
    await sched.advance(95_000);
    expect(samples).toHaveLength(3);
    expect(samples[0]).toMatchObject({ at: 't', fps: expect.any(Number), camFps: [expect.any(Number), expect.any(Number), expect.any(Number)] });
    expect(transport.requests.map((r) => r.path)).toEqual(Array(3).fill(['/api/state/stats', '/api/cams/stats']).flat());
    sampler.stop();
    await sched.advance(120_000);
    expect(samples).toHaveLength(3);
  });

  it('reports a failed read as an error sample and keeps going', async () => {
    const sched = new VirtualScheduler();
    const transport = new FakeBoardTransport({ board: new BoardModel({ random: seededRandom(1) }), scheduler: sched, random: seededRandom(2) });
    transport.setReachable(false);
    const sampler = new BoardHealthSampler({ transport, scheduler: sched, clock: () => 't' });
    const s = await (async () => {
      const p = sampler.sample();
      await sched.advance(100);
      return p;
    })();
    expect(s.error).toMatch(/EHOSTUNREACH/);
    expect(s.fps).toBeUndefined();
  });

  it('turns a sample into a loggable BoardStatusChanged with health', () => {
    const f = healthFact({ at: '2026-11-02T20:00:00.000Z', fps: 12, camFps: [30, 29] }, 'ready', { kind: 'autodarts-local', adapterVersion: 'x' });
    expect(f).toMatchObject({ type: 'BoardStatusChanged', payload: { status: 'ready', health: { fps: 12, camFps: [30, 29] } } });
    expect(healthFact({ at: 't', error: 'down' }, 'ready', { kind: 'autodarts-local', adapterVersion: 'x' })).toBeNull();
  });
});

describe('raw-frame ring buffer', () => {
  it('caps entries and characters, truncates and redacts', () => {
    const ring = new RawFrameRing({ maxEntries: 3, maxChars: 1000, maxEntryChars: 100 });
    for (let i = 0; i < 5; i++) ring.push(`t${i}`, 'WS /api/events', `{"i":${i}}`);
    expect(ring.snapshot().map((e) => e.at)).toEqual(['t2', 't3', 't4']);
    ring.push('t5', 'GET /api/state', `{"api_key":"abc","pad":"${'x'.repeat(500)}"}`);
    const last = ring.snapshot().at(-1);
    expect(last?.data).not.toContain('abc');
    expect(last?.truncatedFrom).toBeGreaterThan(500);
    expect(ring.totalChars).toBeLessThanOrEqual(1000);
    expect(ring.exportJsonl().split('\n')).toHaveLength(3);
  });
});

describe('rebuildVisitState', () => {
  const ids = createUlidSource({ now: () => 1_793_649_600_000, random: seededRandom('rb') });

  it('restores the open visit, its darts and an ongoing takeout', () => {
    const facts = scriptToFacts([{ dart: 'T20' }, { takeout: true }, { dart: 'S1' }, { dart: 'D2' }, { update: 1, to: 'D3' }, { withdraw: 0 }], { ids, clock: () => 't' });
    const state = rebuildVisitState(facts, ids);
    expect(state.known.map((k) => [k.indexInVisit, k.segment.label])).toEqual([[1, 'D3']]);
    expect(state.inTakeout).toBe(false);
    expect(state.recentVisits[0]?.map((k) => k.segment.label)).toEqual(['T20']);
  });

  it('starts a fresh visit after a takeout or reset', () => {
    const facts = scriptToFacts([{ dart: 'T20' }, { reset: true }], { ids, clock: () => 't' });
    const state = rebuildVisitState(facts, () => '01JBX00000000000000000000V');
    expect(state).toEqual({ visitKey: '01JBX00000000000000000000V', known: [], inTakeout: false, recentVisits: [], observedAt: 't' });
  });

  it('remembers when the board was last read, ignoring facts that do not come from a reading', () => {
    let n = 0;
    const clock = () => `2026-11-02T20:00:0${n++}.000Z`;
    const facts = scriptToFacts(
      [{ dart: 'T20' }, { status: 'stuck-takeout' }, { connection: 'offline' }, { connection: 'connecting' }],
      { ids, clock },
    );
    expect(facts.map((f) => f.type)).toEqual(['DartDetected', 'BoardStatusChanged', 'BoardStatusChanged', 'SourceConnectionChanged', 'SourceConnectionChanged']);
    // The dart (t=0) and the "throwing" status (t=1) were readings; stuck-takeout and the connection changes were not.
    expect(rebuildVisitState(facts, ids).observedAt).toBe('2026-11-02T20:00:01.000Z');
    const undated = facts.map((f) => ({ type: f.type, payload: f.payload }));
    expect(rebuildVisitState(undated, ids).observedAt).toBeUndefined();
  });
});

describe('ManualSource', () => {
  it('emits no board facts at all', () => {
    const src = new ManualSource();
    const seen: unknown[] = [];
    src.subscribe((f) => seen.push(f));
    src.start();
    expect(src.isRunning).toBe(true);
    src.stop();
    expect(seen).toEqual([]);
    expect(src.kind).toBe('manual');
  });
});
