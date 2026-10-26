import { SegmentSchema } from '@arcade/event-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeSegment, normalizeThrow } from '../normalize';
import { parseEventFrame, parseStateData } from '../raw';
import { seededRandom } from '../random';
import { BoardModel } from '../simulator/board-model';
import { tracker } from '../testing/snapshots';
import { toSnapshot, type Snapshot } from './snapshot';
import type { ApplyMode, TrackerFact } from './visit-tracker';

type Action = 'throw' | 'bounce' | 'phantom' | 'withdraw' | 'change' | 'startTakeout' | 'finishTakeout' | 'hand' | 'reset' | 'stuck';
const ACTIONS: Action[] = ['throw', 'throw', 'throw', 'bounce', 'phantom', 'withdraw', 'change', 'startTakeout', 'finishTakeout', 'hand', 'reset', 'stuck'];

/** Board states produced by a sequence of physical actions on the board model. */
function statesOf(seed: number, actions: readonly Action[]): Snapshot[] {
  const board = new BoardModel({ random: seededRandom(seed) });
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
    else if (a === 'change') board.changeDetection();
    else if (a === 'startTakeout') board.startTakeout();
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

const actionsArb = fc.array(fc.constantFrom(...ACTIONS), { minLength: 1, maxLength: 40 });

describe('properties', () => {
  it('idempotency: duplicated and re-delivered snapshots add nothing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), actionsArb, fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 40, maxLength: 40 }), (seed, actions, reps) => {
        const states = statesOf(seed, actions);
        const once = run(states);
        const repeated = states.flatMap((s, i) => Array.from({ length: reps[i % reps.length] as number }, () => s));
        expect(run(repeated)).toEqual(once);
      }),
      { numRuns: 300 },
    );
  });

  it('a snapshot applied twice in a row never emits on the second application', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), actionsArb, fc.boolean(), (seed, actions, resync) => {
        const t = tracker();
        for (const s of statesOf(seed, actions)) {
          t.apply(s, resync ? 'resync' : 'live');
          expect(t.apply(s, 'live')).toEqual([]);
        }
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
