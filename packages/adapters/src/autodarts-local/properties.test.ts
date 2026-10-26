import { SegmentSchema } from '@arcade/event-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeSegment, normalizeThrow } from '../normalize';
import { parseEventFrame, parseStateData } from '../raw';
import { createUlidSource, seededRandom } from '../random';
import { BoardModel } from '../simulator/board-model';
import { show, tracker } from '../testing/snapshots';
import { rebuildVisitState } from './rebuild';
import { toSnapshot, type Snapshot } from './snapshot';
import { boardStatusOf } from './status';
import { VisitTracker, type ApplyMode, type TrackerFact } from './visit-tracker';

type Action =
  | 'throw'
  | 'bounce'
  | 'phantom'
  | 'withdraw'
  | 'withdrawFirst'
  | 'change'
  | 'startTakeout'
  | 'pull'
  | 'callOff'
  | 'finishTakeout'
  | 'hand'
  | 'reset'
  | 'stuck';
const ACTIONS: Action[] = [
  'throw',
  'throw',
  'throw',
  'bounce',
  'phantom',
  'withdraw',
  'withdrawFirst',
  'change',
  'startTakeout',
  'pull',
  'callOff',
  'finishTakeout',
  'hand',
  'reset',
  'stuck',
];

/** Board states produced by a sequence of physical actions on the board model. */
function statesOf(seed: number, actions: readonly Action[], noCoordsRate = 0): Snapshot[] {
  const board = new BoardModel({ random: seededRandom(seed), noCoordsRate });
  const states: Snapshot[] = [];
  board.onFrame((text) => {
    const env = JSON.parse(text) as { type: string; data: unknown };
    if (env.type !== 'state') return;
    const parsed = parseStateData(env.data);
    if (parsed.ok) states.push(toSnapshot(parsed.data));
  });
  for (const a of actions) {
    if (a === 'throw') board.throwDart();
    else if (a === 'bounce') board.bounceOut();
    else if (a === 'phantom') board.phantom();
    else if (a === 'withdraw') board.withdraw();
    else if (a === 'withdrawFirst') board.withdraw(0);
    else if (a === 'change') board.changeDetection();
    else if (a === 'startTakeout') board.startTakeout();
    else if (a === 'pull') board.pullDart();
    else if (a === 'callOff') board.callOffTakeout();
    else if (a === 'finishTakeout') board.finishTakeout();
    else if (a === 'hand') board.handInFront();
    else if (a === 'reset') board.manualReset();
    else board.stickTakeout();
  }
  return states;
}

function run(snaps: readonly Snapshot[], mode: (i: number) => ApplyMode = () => 'live'): TrackerFact[] {
  const t = tracker();
  t.apply(toSnapshot({ status: 'Throw', event: 'Started' }), 'resync');
  return snaps.flatMap((s, i) => t.apply(s, mode(i)));
}

/**
 * A tracker's facts for each snapshot, and the log the adapter would persist: those facts, then a
 * `BoardStatusChanged` whenever the board's status changes.
 */
function logging(t: VisitTracker): { apply: (s: Snapshot, mode: ApplyMode, awayMs?: number) => TrackerFact[]; log: { type: string; payload: unknown }[] } {
  const log: { type: string; payload: unknown }[] = [];
  let status: string | undefined;
  return {
    log,
    apply: (s, mode, awayMs) => {
      const facts = t.apply(s, mode, awayMs);
      log.push(...facts);
      const now = boardStatusOf(s);
      if (now !== undefined && now !== status) {
        status = now;
        log.push({ type: 'BoardStatusChanged', payload: { status: now } });
      }
      return facts;
    },
  };
}

const actionsArb = fc.array(fc.constantFrom(...ACTIONS), { minLength: 1, maxLength: 40 });
/** No darts without coordinates, or many. */
const noCoordsArb = fc.constantFrom(0, 0.4);

describe('properties', () => {
  it('idempotency: duplicated and re-delivered snapshots add nothing', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e6 }),
        actionsArb,
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 40, maxLength: 40 }),
        noCoordsArb,
        (seed, actions, reps, rate) => {
          const states = statesOf(seed, actions, rate);
          const once = run(states);
          const repeated = states.flatMap((s, i) => Array.from({ length: reps[i % reps.length] as number }, () => s));
          expect(run(repeated)).toEqual(once);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a snapshot applied twice in a row never emits on the second application', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), actionsArb, fc.boolean(), noCoordsArb, (seed, actions, resync, rate) => {
        const t = tracker();
        for (const s of statesOf(seed, actions, rate)) {
          t.apply(s, resync ? 'resync' : 'live');
          expect(t.apply(s, 'live')).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('crash-resume: rebuildVisitState from the facts so far is the tracker’s own state, after any history', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e6 }),
        actionsArb,
        fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }),
        noCoordsArb,
        (seed, actions, resyncs, rate) => {
          const t = tracker();
          const board = logging(t);
          board.apply(toSnapshot({ status: 'Throw', event: 'Started' }), 'resync');
          statesOf(seed, actions, rate).forEach((s, i) => {
            board.apply(s, resyncs[i % resyncs.length] ? 'resync' : 'live', 1000);
            const rebuilt = rebuildVisitState(board.log, () => '01JBX00000000000000000000V');
            const own = t.state();
            expect(rebuilt.known).toEqual(own.known);
            expect(rebuilt.recentVisits).toEqual(own.recentVisits);
            expect(rebuilt.takeoutTail).toBe(own.takeoutTail);
            if (own.known.length > 0) expect(rebuilt.visitKey).toBe(own.visitKey);
            // A takeout called off with 3 darts leaves no fact, so the rebuilt state may still
            // be in it; the next snapshot ends it. The other way round never.
            if (own.inTakeout) expect(rebuilt.inTakeout).toBe(true);
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it('crash-resume: a tracker resumed from the rebuilt state goes on as the original would', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), actionsArb, fc.nat(), noCoordsArb, (seed, actions, at, rate) => {
        const states = statesOf(seed, actions, rate);
        const t = tracker();
        const board = logging(t);
        board.apply(toSnapshot({ status: 'Throw', event: 'Started' }), 'resync');
        const crash = at % (states.length + 1);
        for (const s of states.slice(0, crash)) board.apply(s, 'live');
        // A new launch mints ids of its own.
        const relaunch = createUlidSource({ now: () => 1_893_456_000_000, random: seededRandom('relaunch') });
        const restored = rebuildVisitState(board.log, relaunch);
        // The one known gap: a takeout called off with 3 darts logs nothing (see rebuild.ts and
        // the test below), so the resumed tracker may still be in it.
        if (restored.inTakeout !== t.state().inTakeout) return;
        const resumed = new VisitTracker(relaunch, restored);
        // Darts known before the crash keep their ids in both; later ones are named in detection order.
        const namer = (): ((fs: TrackerFact[]) => string[]) => {
          const names = new Map<string, string>();
          return (fs) =>
            fs.flatMap((f) => {
              if (f.type === 'DartDetected') names.set(f.payload.throwId, `new#${names.size}`);
              if (f.type !== 'DartUpdated' && f.type !== 'DartWithdrawn') return [];
              return [names.get(f.payload.throwId) ?? f.payload.throwId];
            });
        };
        const [mineIds, theirIds] = [namer(), namer()];
        // The resumed adapter's first read is a resync; the original sees the same board.
        states.slice(crash).forEach((s, i) => {
          const mode: ApplyMode = i === 0 ? 'resync' : 'live';
          const mine = t.apply(s, mode, 1000);
          const theirs = resumed.apply(s, mode, 1000);
          expect(show(theirs)).toEqual(show(mine));
          expect(theirIds(theirs)).toEqual(mineIds(mine));
        });
      }),
      { numRuns: 300 },
    );
  });

  // Arbitrary board states, including impossible ones, applied live or as resyncs.
  const dartArb = fc.record({
    segment: fc.oneof(
      fc.record({ number: fc.integer({ min: 0, max: 26 }), multiplier: fc.integer({ min: 0, max: 3 }) }),
      fc.constantFrom(
        { name: 'M12', bed: 'Outside', multiplier: 0, number: 12 },
        { name: 'M', number: 0, multiplier: 0 },
        { name: 'Bull', number: 25, bed: 'Double', multiplier: 2 },
        { name: '25', number: 25, bed: 'Single', multiplier: 1 },
      ),
      fc.anything(),
    ),
    coords: fc.option(fc.record({ x: fc.constantFrom(0.1, 0.2, -0.3, 0.5), y: fc.constantFrom(0.6, -0.2, 0.9) }), { nil: undefined }),
  });
  const stateArb = fc.record({
    status: fc.constantFrom('Throw', 'Takeout', 'Takeout in progress', 'Stopped', 'Starting', 'Weird'),
    event: fc.constantFrom('Throw detected', 'Takeout started', 'Takeout finished', 'Manual reset', 'Started', 'Stopped'),
    throws: fc.option(fc.array(dartArb, { maxLength: 5 }), { nil: undefined }),
  });

  it('no duplicate throwId, positions stay 0..2, every dart schema-valid — for any input', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(stateArb, fc.boolean()), { maxLength: 30 }), (steps) => {
        const t = tracker();
        const ids = new Set<string>();
        for (const [state, resync] of steps) {
          const parsed = parseStateData(state);
          if (!parsed.ok) continue;
          for (const f of t.apply(toSnapshot(parsed.data), resync ? 'resync' : 'live')) {
            if (f.type !== 'DartDetected') continue;
            expect(ids.has(f.payload.throwId)).toBe(false);
            ids.add(f.payload.throwId);
            expect(f.payload.indexInVisit).toBeGreaterThanOrEqual(0);
            expect(f.payload.indexInVisit).toBeLessThanOrEqual(2);
            expect(SegmentSchema.safeParse(f.payload.segment).success).toBe(true);
          }
          expect(t.state().known.length).toBeLessThanOrEqual(3);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('normalization never throws and always yields a valid segment', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(SegmentSchema.safeParse(normalizeSegment(raw).segment).success).toBe(true);
        expect(SegmentSchema.safeParse(normalizeThrow(raw).segment).success).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('frame parsing never throws', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json(), fc.anything().map((v) => JSON.stringify({ type: 'state', data: v }) ?? '')), (text) => {
        expect(['state', 'other', 'invalid']).toContain(parseEventFrame(text).kind);
      }),
      { numRuns: 1000 },
    );
  });
});
