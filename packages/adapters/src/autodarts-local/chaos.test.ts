import { describe, expect, it } from 'vitest';
import { chaosRun } from '../testing/chaos';
import type { ChaosStats } from '../testing/oracle';

/**
 * Adapter chaos suite (ROADMAP P2): seeded runs of
 * board model → fault injection → fake transport → autodarts-local adapter.
 * Each run plays random visits with bounce-outs, phantom and re-read detections,
 * withdrawals of any dart, empty, stuck and called-off takeouts, darts pulled one at a time,
 * darts without coordinates, visits as short as 3 s and manual resets, while the network
 * drops, duplicates, delays and reorders frames, cuts the socket and goes away for anything
 * from a blink to several visits. The oracle then demands: no invented darts, no dart
 * emitted twice, every dart seen online present, every physical dart one identity (a
 * withdrawal or update hits the dart the board changed), and every board visit either
 * exactly right or flagged for review.
 *
 * CHAOS_SEEDS (environment) runs more seeds, e.g. CHAOS_SEEDS=5000 for a soak.
 */

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(env.CHAOS_SEEDS ?? 1000);
/** The first seed (CHAOS_FROM), to soak seeds the default run does not cover. */
const FROM = Number(env.CHAOS_FROM ?? 0);

const zero = (): ChaosStats => ({
  boardVisits: 0,
  detections: 0,
  flaggedVisits: 0,
  inferredTakeouts: 0,
  recoveredDarts: 0,
  pulledDarts: 0,
  calledOffTakeouts: 0,
  noCoordsDetections: 0,
  identityChecks: 0,
});

describe('adapter chaos suite', () => {
  it(`${RUNS} seeded runs: zero invented, duplicated, lost, misattributed or silently wrong darts`, async () => {
    const failures: string[] = [];
    const total = zero();
    for (let seed = FROM; seed < FROM + RUNS; seed++) {
      const { result, plan } = await chaosRun(seed);
      const { violations, stats } = result;
      for (const k of Object.keys(total) as (keyof ChaosStats)[]) total[k] += stats[k];
      if (violations.length > 0) failures.push(`seed ${seed} ${JSON.stringify(plan)}: ${violations.slice(0, 3).join(' | ')}`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // The suite must actually exercise recovery and the board's odd ways, not just quiet networks.
    const scale = RUNS / 1000;
    expect(total.inferredTakeouts).toBeGreaterThan(100 * scale);
    expect(total.recoveredDarts).toBeGreaterThan(100 * scale);
    expect(total.detections).toBeGreaterThan(10000 * scale);
    expect(total.pulledDarts).toBeGreaterThan(1000 * scale);
    expect(total.calledOffTakeouts).toBeGreaterThan(300 * scale);
    expect(total.noCoordsDetections).toBeGreaterThan(500 * scale);
    expect(total.identityChecks).toBeGreaterThan(50_000 * scale);
  }, 300_000);

  it("seed 7489: a new dart 0.34 mm from the last visit's first dart is counted pending review, not dropped as a ghost", async () => {
    const { rig, result } = await chaosRun(7489, { boardQuirks: false });
    expect(result.violations).toEqual([]);
    const flagged = rig.facts.filter((f) => f.type === 'DartDetected' && f.payload.pendingReview);
    expect(flagged.map((f) => f.type === 'DartDetected' && f.payload.segment.label)).toEqual(['S4']);
    expect(rig.facts.some((f) => f.type === 'SourceAnomaly' && /where the previous visit's darts were/.test(f.payload.note))).toBe(true);
  });

  it('flags nothing on a clean network: 200 runs, every visit exact', async () => {
    const total = zero();
    for (let seed = 0; seed < 200; seed++) {
      const { result } = await chaosRun(10_000 + seed, { clean: true });
      for (const k of Object.keys(total) as (keyof ChaosStats)[]) total[k] += result.stats[k];
      expect(result.violations, `seed ${10_000 + seed}`).toEqual([]);
      expect(result.stats.flaggedVisits, `seed ${10_000 + seed}`).toBe(0);
      expect(result.stats.inferredTakeouts + result.stats.recoveredDarts).toBe(0);
    }
    // Pulls one at a time, called-off takeouts and 3 s visits are part of a clean session too.
    expect(total.pulledDarts).toBeGreaterThan(200);
    expect(total.calledOffTakeouts).toBeGreaterThan(50);
  }, 60_000);
});
