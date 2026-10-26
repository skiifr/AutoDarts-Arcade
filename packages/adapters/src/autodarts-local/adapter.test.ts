import { describe, expect, it } from 'vitest';
import { isAllowedBoardRequest } from '../endpoints';
import { brief, makeRig, ofType, type Rig } from '../testing/rig';
import type { ConnectionStatus } from './adapter';
import { rebuildVisitState } from './rebuild';

async function onlineRig(options: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
  const rig = makeRig(options);
  rig.adapter.start();
  await rig.sched.advance(100);
  return rig;
}

const states = (rig: Rig): string[] => ofType(rig.facts, 'SourceConnectionChanged').map((f) => f.payload.state);

describe('autodarts-local adapter: a normal visit', () => {
  it('connects, resyncs, goes online and reports a visit', async () => {
    const rig = await onlineRig();
    expect(states(rig)).toEqual(['connecting', 'resyncing', 'online']);
    expect(rig.adapter.version).toBe('2.0.2');
    expect(rig.transport.requests.map((r) => `${r.kind} ${r.path}`)).toEqual(['GET /api/version', 'WS /api/events', 'GET /api/state']);

    for (const s of ['T20', 'M12', 'BULL']) {
      rig.board.throwDart({ segment: s });
      await rig.sched.advance(50);
    }
    rig.board.startTakeout();
    await rig.sched.advance(50);
    rig.board.finishTakeout();
    await rig.sched.advance(50);

    expect(brief(rig.facts)).toEqual(['detect 0:T20', 'detect 1:MISS', 'detect 2:BULL', 'takeout-start', 'takeout-end']);
    expect(ofType(rig.facts, 'DartDetected')[1]?.payload.segment).toEqual({ number: 0, multiplier: 0, bed: 'miss', label: 'MISS', missSector: 12 });
    expect(ofType(rig.facts, 'BoardStatusChanged').map((f) => f.payload.status)).toEqual(['ready', 'throwing', 'takeout', 'ready']);
    const afterVersion = rig.facts.slice(1);
    expect(afterVersion.every((f) => f.source.upstreamVersion === '2.0.2' && f.source.adapterVersion === 'autodarts-local@0.1.0')).toBe(true);
  });

  it.each(['1.0.7', '2.0.2', '2.1.0-beta.5', 'garbage'])('opens the bare events path for version %s', async (version) => {
    const rig = await onlineRig({ board: { version, noiseFrames: true } });
    expect(rig.transport.requests.find((r) => r.kind === 'WS')?.path).toBe('/api/events');
    // Frames of other types share the socket and are filtered out.
    rig.board.throwDart({ segment: 'S7' });
    rig.board.startTakeout();
    rig.board.finishTakeout();
    await rig.sched.advance(50);
    expect(rig.transport.deliveredFrames.some((f) => f.startsWith('{"type":"motion_state"'))).toBe(true);
    expect(brief(rig.facts).filter((f) => !f.startsWith('anomaly version'))).toEqual(['detect 0:S7', 'takeout-start', 'takeout-end']);
  });

  it('opens /api/events?type=state only when asked to', async () => {
    const rig = await onlineRig({ stateOnlySocket: true });
    expect(rig.transport.requests.find((r) => r.kind === 'WS')?.path).toBe('/api/events?type=state');
  });

  it('confirms a withdrawal with a poll before retracting the dart', async () => {
    const rig = await onlineRig();
    rig.board.throwDart({ segment: 'S1' });
    rig.board.phantom('S7');
    await rig.sched.advance(50);
    const before = rig.transport.httpRequestsSince(0).length;
    rig.board.withdraw();
    await rig.sched.advance(50);
    expect(rig.transport.httpRequestsSince(0).length).toBe(before + 1);
    expect(brief(rig.facts)).toEqual(['detect 0:S1', 'detect 1:S7', 'withdraw']);
  });

  it('a manual reset: VisitReset first, then a DartWithdrawn for each of the visit’s darts', async () => {
    const rig = await onlineRig();
    rig.board.throwDart({ segment: 'S5' });
    rig.board.throwDart({ segment: 'T20' });
    await rig.sched.advance(50);
    rig.board.manualReset();
    await rig.sched.advance(50);
    expect(brief(rig.facts)).toEqual(['detect 0:S5', 'detect 1:T20', 'reset', 'withdraw', 'withdraw']);
    const [reset] = ofType(rig.facts, 'VisitReset');
    const darts = ofType(rig.facts, 'DartDetected');
    expect(reset?.payload.visitKey).toBe(darts[0]?.payload.visitKey);
    expect(ofType(rig.facts, 'DartWithdrawn').map((f) => f.payload.throwId)).toEqual(darts.map((f) => f.payload.throwId));
  });

  it('gives every fact of one resync, from resyncing to online, one correlationId', async () => {
    const rig = await onlineRig();
    rig.board.throwDart({ segment: 'S5' });
    await rig.sched.advance(50);
    rig.transport.setReachable(false);
    await rig.sched.advance(6000);
    rig.board.throwDart({ segment: 'T20' });
    rig.transport.inject('{"type":"state","data":{"throws":"many"}}'); // nobody listening: dropped
    rig.transport.setReachable(true);
    await rig.sched.advance(2000);
    const lastState = (state: string): number =>
      rig.facts.reduce((at, f, i) => (f.type === 'SourceConnectionChanged' && f.payload.state === state ? i : at), -1);
    const from = lastState('resyncing');
    const to = lastState('online');
    const resync = rig.facts.slice(from, to + 1);
    expect(resync.map((f) => f.type)).toEqual(['SourceConnectionChanged', 'DartDetected', 'SourceConnectionChanged']);
    expect(ofType(resync, 'DartDetected')[0]?.payload.recovered).toBe(true);
    const ids = new Set(resync.map((f) => f.correlationId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // Facts outside a resync are not grouped.
    expect(rig.facts.slice(0, from).filter((f) => f.type === 'DartDetected').every((f) => f.correlationId === undefined)).toBe(true);
    // The first connection's resync is grouped too.
    const first = rig.facts.slice(0, rig.facts.findIndex((f) => f.type === 'SourceConnectionChanged' && f.payload.state === 'online') + 1);
    expect(first.map((f) => (f.type === 'SourceConnectionChanged' ? f.payload.state : f.type))).toEqual([
      'connecting',
      'resyncing',
      'BoardStatusChanged',
      'online',
    ]);
    expect(first[0]?.correlationId).toBeUndefined();
    expect(first[1]?.correlationId).toBeDefined();
    expect(new Set(first.slice(1).map((f) => f.correlationId)).size).toBe(1);
  });

  it('reports a re-read dart as DartUpdated', async () => {
    const rig = await onlineRig();
    rig.board.throwDart({ segment: 'T20' });
    await rig.sched.advance(50);
    rig.board.changeDetection(0, 'S20');
    await rig.sched.advance(50);
    expect(brief(rig.facts)).toEqual(['detect 0:T20', 'update T20->S20']);
  });
});

describe('connection lifecycle (§6.4)', () => {
  it('logs one offline → connecting → offline → resyncing → online cycle per outage', async () => {
    const rig = await onlineRig();
    const live: ConnectionStatus[] = [];
    rig.adapter.onConnectionStatus((s) => live.push(s));
    rig.transport.setReachable(false);
    await rig.sched.advance(20_000);
    rig.transport.setReachable(true);
    await rig.sched.advance(2000);
    expect(states(rig)).toEqual(['connecting', 'resyncing', 'online', 'offline', 'connecting', 'offline', 'resyncing', 'online']);
    // The UI still sees every retry.
    expect(live.filter((s) => s.phase === 'connecting').length).toBeGreaterThan(10);
    expect(Math.max(...live.map((s) => s.attempt))).toBeGreaterThan(10);
  });

  it('two failed liveness polls on a half-open connection → offline', async () => {
    const rig = await onlineRig();
    rig.transport.setSilent(true);
    await rig.sched.advance(5000 + 2000 + 1000 + 2000 + 50);
    expect(states(rig).at(-2)).toBe('offline');
    const offline = ofType(rig.facts, 'SourceConnectionChanged').find((f) => f.payload.state === 'offline');
    expect(offline?.payload.error).toMatch(/liveness/);
    rig.transport.setSilent(false);
    await rig.sched.advance(3000);
    expect(states(rig).at(-1)).toBe('online');
  });

  it('polls GET /api/state every 5 s while idle and diffs it (self-healing)', async () => {
    const rig = await onlineRig({ faults: { drop: 1 } });
    rig.board.throwDart({ segment: 'D16' });
    await rig.sched.advance(4800);
    expect(brief(rig.facts)).toEqual([]);
    await rig.sched.advance(300);
    expect(brief(rig.facts)).toEqual(['detect 0:D16']);
  });

  it('does not poll while frames keep the socket busy', async () => {
    const rig = await onlineRig();
    const t0 = rig.sched.now();
    for (let i = 0; i < 6; i++) {
      await rig.sched.advance(3000);
      if (i % 3 === 2) rig.board.takeout();
      else rig.board.throwDart();
    }
    expect(rig.transport.httpRequestsSince(t0).filter((r) => r.path === '/api/state').length).toBeLessThanOrEqual(1);
  });

  it('slows to the 5 s cap when the board answers but refuses the socket', async () => {
    const rig = makeRig();
    rig.transport.refuseSockets = true;
    rig.adapter.start();
    await rig.sched.advance(30_000);
    const ws = rig.transport.requests.filter((r) => r.kind === 'WS').map((r) => r.at);
    const gaps = ws.slice(1).map((t, i) => t - (ws[i] as number));
    expect(gaps.slice(0, 2).every((g) => g < 1000)).toBe(true);
    expect(gaps.slice(3).every((g) => g >= 4000)).toBe(true);
    expect(ws.length).toBeLessThan(12);
  });

  it('resync() re-attaches at once and flags darts thrown meanwhile', async () => {
    const rig = await onlineRig({ faults: { drop: 1 } });
    rig.board.throwDart({ segment: 'T19' });
    rig.adapter.resync();
    await rig.sched.advance(100);
    // 100 ms is too short for a whole visit to come and go: the dart continues the visit.
    expect(brief(rig.facts)).toEqual(['detect 0:T19 recovered']);
  });

  it('stop() closes the socket and goes quiet', async () => {
    const rig = await onlineRig();
    rig.adapter.stop();
    await rig.sched.advance(30_000);
    expect(rig.transport.openSockets).toBe(0);
    expect(rig.sched.pendingTimers).toBe(0);
    expect(rig.adapter.connectionStatus().phase).toBe('stopped');
  });
});

describe('stuck takeout (R13)', () => {
  it('reports stuck-takeout after 8 s on an empty board, and never resets the board', async () => {
    const rig = await onlineRig();
    rig.board.throwDart({ segment: 'S3' });
    await rig.sched.advance(50);
    rig.board.stickTakeout();
    await rig.sched.advance(7900);
    expect(ofType(rig.facts, 'BoardStatusChanged').map((f) => f.payload.status)).not.toContain('stuck-takeout');
    await rig.sched.advance(200);
    expect(ofType(rig.facts, 'BoardStatusChanged').at(-1)?.payload.status).toBe('stuck-takeout');
    expect(rig.adapter.currentBoardStatus()).toBe('stuck-takeout');
    rig.board.manualReset();
    await rig.sched.advance(100);
    expect(ofType(rig.facts, 'BoardStatusChanged').at(-1)?.payload.status).toBe('ready');
    expect(rig.transport.requests.every((r) => isAllowedBoardRequest(r.kind, r.path))).toBe(true);
  });

  it('a normal takeout is not stuck', async () => {
    const rig = await onlineRig();
    rig.board.throwDart();
    rig.board.startTakeout();
    await rig.sched.advance(2000);
    rig.board.finishTakeout();
    await rig.sched.advance(10_000);
    expect(ofType(rig.facts, 'BoardStatusChanged').map((f) => f.payload.status)).not.toContain('stuck-takeout');
  });
});

describe('frame and payload limits', () => {
  it('drops an oversized frame with an anomaly and keeps going', async () => {
    const rig = await onlineRig();
    rig.transport.inject(`{"type":"state","data":{"status":"${'x'.repeat(300 * 1024)}"}}`);
    rig.board.throwDart({ segment: 'S9' });
    await rig.sched.advance(50);
    expect(brief(rig.facts)).toEqual(['anomaly frame over 262144 chars dropped', 'detect 0:S9']);
    expect(ofType(rig.facts, 'SourceAnomaly')[0]?.payload.rawExcerpt.length).toBeLessThanOrEqual(512);
  });

  it('reports each kind of malformed frame once', async () => {
    const rig = await onlineRig();
    for (let i = 0; i < 5; i++) rig.transport.inject('{not json');
    rig.transport.inject('{"type":"state","data":{"throws":"many"}}');
    await rig.sched.advance(10);
    expect(ofType(rig.facts, 'SourceAnomaly').map((f) => f.payload.note)).toEqual(['frame is not JSON', expect.stringMatching(/^invalid state/)]);
    expect(rig.adapter.diagnostics().suppressedAnomalies).toBe(4);
  });

  it('reports an unknown status once and keeps the last known status', async () => {
    const rig = await onlineRig();
    rig.transport.inject('{"type":"state","data":{"status":"Hibernating","event":"Throw detected","numThrows":0}}');
    rig.transport.inject('{"type":"state","data":{"status":"Hibernating","event":"Throw detected","numThrows":0}}');
    await rig.sched.advance(10);
    expect(ofType(rig.facts, 'SourceAnomaly').map((f) => f.payload.note)).toEqual(['unknown board status "Hibernating"']);
    expect(rig.adapter.currentBoardStatus()).toBe('ready');
  });

  it('an unreadable dart is a miss pending review, correlated with its anomaly', async () => {
    const rig = await onlineRig();
    rig.transport.inject(
      '{"type":"state","data":{"status":"Throw","event":"Throw detected","numThrows":1,"throws":[{"coords":{"x":0.1,"y":0.2},"segment":{"name":"X9","number":40,"multiplier":7}}]}}',
    );
    await rig.sched.advance(10);
    const anomaly = ofType(rig.facts, 'SourceAnomaly').find((a) => a.correlationId !== undefined);
    const [dart] = ofType(rig.facts, 'DartDetected');
    expect(dart?.payload.segment.label).toBe('MISS');
    expect(dart?.payload.pendingReview).toBe(true);
    expect(anomaly?.payload.note).toMatch(/pending review/);
    expect(anomaly?.correlationId).toBeDefined();
    expect(dart?.correlationId).toBe(anomaly?.correlationId);
  });
});

describe('diagnostics ring buffer', () => {
  it('holds only allowlisted channels', async () => {
    const rig = await onlineRig();
    rig.board.throwDart();
    await rig.sched.advance(6000);
    const entries = rig.adapter.ring.snapshot();
    expect(entries.length).toBeGreaterThan(3);
    for (const e of entries) {
      const [kind, path] = e.channel.split(' ') as ['GET' | 'WS', string];
      expect(isAllowedBoardRequest(kind, path)).toBe(true);
    }
    expect(rig.adapter.diagnostics().rawJsonl.split('\n')).toHaveLength(entries.length);
  });
});

describe('crash resume (§6.5)', () => {
  it('rebuilds known darts from the log and resyncs against them', async () => {
    const first = await onlineRig({ seed: 7 });
    first.board.throwDart({ segment: 'T20' });
    first.board.throwDart({ segment: 'S1' });
    await first.sched.advance(50);
    const restored = rebuildVisitState(first.facts, () => '01JBX00000000000000000000V');
    expect(restored.known.map((k) => k.segment.label)).toEqual(['T20', 'S1']);
    expect(restored.visitKey).toBe(ofType(first.facts, 'DartDetected')[0]?.payload.visitKey);

    // The app is killed; the player throws a third dart; the app relaunches. The second
    // rig shares the seed, so its board model reproduces the same darts and coordinates.
    const second = makeRig({ seed: 7, restored });
    second.board.throwDart({ segment: 'T20' });
    second.board.throwDart({ segment: 'S1' });
    second.board.throwDart({ segment: 'D3' });
    second.adapter.start();
    await second.sched.advance(100);
    expect(brief(second.facts)).toEqual(['detect 2:D3 recovered']);
    expect(ofType(second.facts, 'DartDetected')[0]?.payload.visitKey).toBe(restored.visitKey);
  });

  it('a takeout during the crash is inferred', async () => {
    const first = await onlineRig({ seed: 8 });
    first.board.throwDart({ segment: 'T20' });
    await first.sched.advance(50);
    const second = makeRig({ seed: 8, restored: rebuildVisitState(first.facts, () => '01JBX00000000000000000000V') });
    second.adapter.start();
    await second.sched.advance(100);
    expect(brief(second.facts)).toEqual(['takeout-end inferred']);
  });
});
