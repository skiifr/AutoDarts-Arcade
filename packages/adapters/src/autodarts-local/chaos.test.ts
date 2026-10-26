import { describe, expect, it } from 'vitest';
import { chaosRun } from '../testing/chaos';
import type { ChaosStats } from '../testing/oracle';

/**
 * Adapter chaos suite (ROADMAP P2): 1,000 seeded runs of
 * board model → fault injection → fake transport → autodarts-local adapter.
 * Each run plays random visits with bounce-outs, phantom and re-read detections,
 * withdrawals, empty and stuck takeouts and manual resets, while the network drops,
 * duplicates, delays and reorders frames, cuts the socket and goes away for anything
 * from a blink to several visits. The oracle then demands: no invented darts, no dart
 * emitted twice, every dart seen online present, and every board visit either exactly
 * right or flagged for review.
 */

const RUNS = 1000;

describe('adapter chaos suite', () => {
  it(`${RUNS} seeded runs: zero invented, duplicated, lost or silently wrong darts`, async () => {
    const failures: string[] = [];
    const total: ChaosStats = { boardVisits: 0, detections: 0, flaggedVisits: 0, inferredTakeouts: 0, recoveredDarts: 0 };
    for (let seed = 0; seed < RUNS; seed++) {
      const { result, plan } = await chaosRun(seed);
      const { violations, stats } = result;
      for (const k of Object.keys(total) as (keyof ChaosStats)[]) total[k] += stats[k];
      if (violations.length > 0) failures.push(`seed ${seed} ${JSON.stringify(plan)}: ${violations.slice(0, 3).join(' | ')}`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // The suite must actually exercise recovery, not just quiet networks.
    expect(total.inferredTakeouts).toBeGreaterThan(100);
    expect(total.recoveredDarts).toBeGreaterThan(100);
    expect(total.detections).toBeGreaterThan(10000);
  }, 120_000);

  it("seed 7489: a new dart 0.34 mm from the last visit's first dart is counted pending review, not dropped as a ghost", async () => {
    const { rig, result } = await chaosRun(7489);
    expect(result.violations).toEqual([]);
    const flagged = rig.facts.filter((f) => f.type === 'DartDetected' && f.payload.pendingReview);
    expect(flagged.map((f) => f.type === 'DartDetected' && f.payload.segment.label)).toEqual(['S4']);
    expect(rig.facts.some((f) => f.type === 'SourceAnomaly' && /where the previous visit's darts were/.test(f.payload.note))).toBe(true);
  });

  it('flags nothing on a clean network: 200 runs, every visit exact', async () => {
    for (let seed = 0; seed < 200; seed++) {
      const { result } = await chaosRun(10_000 + seed, { clean: true });
      expect(result.violations, `seed ${10_000 + seed}`).toEqual([]);
      expect(result.stats.flaggedVisits, `seed ${10_000 + seed}`).toBe(0);
      expect(result.stats.inferredTakeouts + result.stats.recoveredDarts).toBe(0);
    }
  }, 60_000);
});
