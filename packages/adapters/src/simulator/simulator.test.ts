import { ULID_PATTERN, type BoardFactDraft } from '@arcade/event-schema';
import { describe, expect, it } from 'vitest';
import { createUlidSource, seededRandom } from '../random';
import { BoardFactDraftSchemaCheck } from '../testing/schema-check';
import { BoardModel, rawSegmentOf } from './board-model';
import { SimulatorSource, scriptToFacts } from './dart-source';
import { coordsFor, parseLabel, randomSegment } from './geometry';
import { isoFromEpochMs } from './iso-time';
import { SCENARIOS, runScenario } from './scenarios';
import { VirtualScheduler } from './virtual-scheduler';
import { normalizeSegment } from '../normalize';

const EPOCH = 1_793_649_600_000;

function ids(seed = 's') {
  return createUlidSource({ now: () => EPOCH, random: seededRandom(seed) });
}

describe('scriptToFacts (engine tests and demo scripts)', () => {
  it('turns a script into valid board facts', () => {
    const facts = scriptToFacts(
      [{ dart: 'T20' }, { dart: 'D16' }, { recovered: 'M12' }, { takeout: true }, { dart: 'BULL' }, { update: 0, to: '25' }, { inferredTakeout: true }, { reset: true }],
      { ids: ids(), clock: () => isoFromEpochMs(EPOCH) },
    );
    const check = new BoardFactDraftSchemaCheck();
    for (const f of facts) check.assert(f);
    expect(facts.map((f) => f.type)).toEqual([
      'DartDetected',
      'BoardStatusChanged',
      'DartDetected',
      'DartDetected',
      'BoardStatusChanged',
      'TakeoutStarted',
      'TakeoutFinished',
      'BoardStatusChanged',
      'DartDetected',
      'BoardStatusChanged',
      'DartUpdated',
      'TakeoutFinished',
      'BoardStatusChanged',
      'VisitReset',
    ]);
    const darts = facts.filter((f): f is Extract<BoardFactDraft, { type: 'DartDetected' }> => f.type === 'DartDetected');
    expect(darts.map((d) => [d.payload.indexInVisit, d.payload.segment.label, d.payload.recovered ?? false])).toEqual([
      [0, 'T20', false],
      [1, 'D16', false],
      [2, 'MISS', true],
      [0, 'BULL', false],
    ]);
    expect(facts.every((f) => f.source.kind === 'simulator')).toBe(true);
  });

  it('is deterministic for a seed', () => {
    const a = scriptToFacts([{ dart: 'S1' }, { takeout: true }], { ids: ids('x'), clock: () => 't', random: seededRandom(1) });
    const b = scriptToFacts([{ dart: 'S1' }, { takeout: true }], { ids: ids('x'), clock: () => 't', random: seededRandom(1) });
    expect(a).toEqual(b);
  });
});

describe('SimulatorSource (demo mode)', () => {
  it('plays seeded random visits on the scheduler', async () => {
    const sched = new VirtualScheduler();
    const src = new SimulatorSource({ scheduler: sched, clock: () => isoFromEpochMs(EPOCH + sched.now()), ids: ids(), random: seededRandom(3), autoplay: true });
    const facts: BoardFactDraft[] = [];
    const check = new BoardFactDraftSchemaCheck();
    src.subscribe((f) => {
      check.assert(f);
      facts.push(f);
    });
    src.start();
    await sched.advance(60_000);
    src.stop();
    const darts = facts.filter((f) => f.type === 'DartDetected').length;
    const takeouts = facts.filter((f) => f.type === 'TakeoutFinished').length;
    expect(darts).toBeGreaterThan(15);
    expect(takeouts).toBeGreaterThan(4);
    expect(darts).toBeLessThanOrEqual(3 * (takeouts + 1));
    await sched.advance(60_000);
    expect(facts.filter((f) => f.type === 'DartDetected').length).toBe(darts);
  });

  it('plays a script with waits and can be driven by hand', async () => {
    const sched = new VirtualScheduler();
    const src = new SimulatorSource({ scheduler: sched, clock: () => 't', ids: ids(), random: seededRandom(1), script: [{ wait: 1000 }, { dart: 'T19' }] });
    const types: string[] = [];
    src.subscribe((f) => types.push(f.type === 'DartDetected' ? `dart ${f.payload.segment.label}` : f.type));
    src.start();
    await sched.advance(500);
    expect(types).toEqual(['SourceConnectionChanged', 'BoardStatusChanged']);
    await sched.advance(600);
    expect(types.at(-2)).toBe('dart T19');
    src.throwDart('S3');
    src.takeout();
    expect(types).toContain('dart S3');
    expect(types.at(-2)).toBe('TakeoutFinished');
  });
});

describe('BoardModel', () => {
  it('produces the community frame shapes and omits throws on an empty board', () => {
    const board = new BoardModel({ random: seededRandom(1) });
    const frames: string[] = [];
    board.onFrame((f) => frames.push(f));
    board.throwDart({ segment: 'M12' });
    board.throwDart({ segment: 'BULL' });
    board.throwDart({ segment: '25' });
    board.takeout();
    const first = JSON.parse(frames[0] as string) as { type: string; data: { throws: { segment: unknown }[]; event: string } };
    expect(first.type).toBe('state');
    expect(first.data.event).toBe('Throw detected');
    expect(first.data.throws[0]?.segment).toEqual({ bed: 'Outside', multiplier: 0, name: 'M12', number: 12 });
    const third = JSON.parse(frames[2] as string) as { data: { status: string } };
    expect(third.data.status).toBe('Takeout');
    const last = JSON.parse(frames.at(-1) as string) as { data: Record<string, unknown> };
    expect(last.data).toEqual({ connected: true, event: 'Takeout finished', numThrows: 0, running: true, status: 'Throw' });
  });

  it('records ground truth: undetected darts, phantoms, withdrawals and visits', () => {
    const board = new BoardModel({ random: seededRandom(2) });
    board.throwDart({ segment: 'T20' });
    board.bounceOut();
    board.phantom('S1');
    board.withdraw();
    board.throwDart({ segment: 'S5' });
    board.throwDart({ segment: 'S5' });
    board.throwDart({ segment: 'D1' }); // a fourth dart: the board does not list it
    board.takeout();
    board.stickTakeout();
    board.throwDart(); // not counted while stuck
    board.manualReset();
    expect(board.physical.map((p) => p.outcome)).toEqual(['detected', 'bounce-out', 'detected', 'detected', 'undetected', 'undetected']);
    expect(board.detections.find((d) => d.phantom)?.withdrawn).toBe(true);
    expect(board.visits.map((v) => [v.endedBy, v.finalDetections.length])).toEqual([
      ['takeout', 3],
      ['reset', 0],
      [undefined, 0],
    ]);
  });

  it('uses the bare miss shape and empty throws arrays when asked', () => {
    const board = new BoardModel({ random: seededRandom(3), missStyle: 'bare', emptyThrows: 'array' });
    expect(JSON.parse(board.stateJson())).toMatchObject({ throws: [] });
    board.throwDart({ segment: 'M7' });
    expect((JSON.parse(board.stateJson()) as { throws: { segment: unknown }[] }).throws[0]?.segment).toEqual({ name: 'M', number: 0, multiplier: 0 });
  });

  it('every generated raw segment normalizes back to itself', () => {
    const r = seededRandom(4);
    for (let i = 0; i < 2000; i++) {
      const seg = randomSegment(r);
      const back = normalizeSegment(rawSegmentOf(seg)).segment;
      expect({ ...back, missSector: undefined }).toEqual({ ...seg, missSector: undefined });
    }
  });

  it('places darts inside their bed in Autodarts coordinates', () => {
    const r = seededRandom(5);
    const t20 = coordsFor(parseLabel('T20'), r);
    expect(Math.hypot(t20.x, t20.y)).toBeGreaterThan(0.58);
    expect(Math.hypot(t20.x, t20.y)).toBeLessThan(0.63);
    expect(t20.y).toBeGreaterThan(0.5); // y points at the 20
    expect(coordsFor(parseLabel('T5'), r).x).toBeLessThan(0); // 5 is left of 20
    expect(Math.hypot(...Object.values(coordsFor(parseLabel('MISS'), r)))).toBeGreaterThan(1);
  });
});

describe('scenarios', () => {
  it.each(Object.keys(SCENARIOS))('%s runs on the board model', async (name) => {
    const sched = new VirtualScheduler();
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(name);
    const board = new BoardModel({ random: seededRandom(name), now: () => sched.now(), ...scenario.board });
    const run = runScenario(board, scenario, sched, seededRandom(name));
    await sched.advance(40_000);
    run.stop();
    if (name !== 'idle') expect(board.detections.length + board.physical.length).toBeGreaterThan(0);
    await sched.advance(1000);
    expect(sched.pendingTimers).toBe(0);
  });
});

describe('ids and time', () => {
  it('ULIDs are valid, unique and ordered within one millisecond', () => {
    const next = createUlidSource({ now: () => EPOCH, random: seededRandom(1) });
    const all = Array.from({ length: 1000 }, () => next());
    expect(all.every((u) => ULID_PATTERN.test(u))).toBe(true);
    expect(new Set(all).size).toBe(1000);
    expect([...all].sort()).toEqual(all);
  });

  it('isoFromEpochMs matches Date#toISOString', () => {
    for (const ms of [0, 951_782_400_000, EPOCH, EPOCH + 86_399_999, 4_102_444_800_123]) {
      expect(isoFromEpochMs(ms)).toBe(new Date(ms).toISOString());
    }
  });
});
