import { SegmentSchema } from '@arcade/event-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeSegment, normalizeThrow } from './normalize';
import { MAX_EXCERPT_CHARS, excerpt } from './raw';
import { badToJson, cyclic, deep, hostileArb, hostileThrowArb, revokedProxy, throwingGetters, trappedProxy, unprintable } from './testing/hostile';

/**
 * Normalization and excerpts are total: whatever a throw holds, they return, never throw. A
 * throw that made them throw wedged the adapter in `resyncing` (review finding 6).
 */

describe('normalization never throws, whatever the input', () => {
  it('the reviewer’s case: a miss hint with a multiplier that cannot become a string', () => {
    const raw = { name: 'M', multiplier: unprintable() };
    const r = normalizeSegment(raw);
    expect(r.segment.bed).toBe('miss');
    expect(r.fatal?.note).toMatch(/miss hint with multiplier/);
    expect(normalizeThrow({ segment: raw }).fatal).toBeDefined();
  });

  it.each([
    ['throwing getters', () => throwingGetters()],
    ['a proxy whose traps throw', trappedProxy],
    ['a revoked proxy', revokedProxy],
    ['a cycle', cyclic],
    ['nesting deeper than the stack', () => deep()],
    ['a toJSON that throws', badToJson],
  ])('%s: a miss pending review', (_label, make) => {
    for (const raw of [make(), { segment: make() }, { segment: { number: 20, multiplier: 1, bed: make() } }]) {
      const r = normalizeThrow(raw);
      expect(SegmentSchema.safeParse(r.segment).success).toBe(true);
      if (r.fatal) expect(r.fatal.rawExcerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    }
    const s = normalizeSegment(make());
    expect(s.fatal).toBeDefined();
  });

  it('fuzz: hostile values anywhere in a throw', () => {
    fc.assert(
      fc.property(hostileThrowArb, (make) => {
        const raw = make();
        const t = normalizeThrow(raw);
        const s = normalizeSegment(raw);
        for (const r of [t, s]) {
          expect(SegmentSchema.safeParse(r.segment).success).toBe(true);
          expect(r.notes.every((n) => typeof n === 'string' && n.length <= 200)).toBe(true);
          if (r.fatal) {
            expect(typeof r.fatal.note).toBe('string');
            expect(r.fatal.rawExcerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
          }
        }
        if (t.coords) expect(Number.isFinite(t.coords.x) && Number.isFinite(t.coords.y)).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });
});

describe('excerpts never throw and stay capped', () => {
  it('fuzz: any value', () => {
    fc.assert(
      fc.property(fc.oneof(hostileArb, hostileThrowArb), (make) => {
        const e = excerpt(make());
        expect(typeof e).toBe('string');
        expect(e.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
      }),
      { numRuns: 1500 },
    );
  });

  it('plain JSON data reads as JSON.stringify would write it', () => {
    fc.assert(
      fc.property(fc.jsonValue().filter((v) => typeof v !== 'string'), (v) => {
        const json = JSON.stringify(v);
        if (json.length < MAX_EXCERPT_CHARS && !/key|token|secret|password|cert/i.test(json)) expect(excerpt(v)).toBe(json);
      }),
      { numRuns: 500 },
    );
  });

  it('a cycle, deep nesting and a huge string', () => {
    expect(excerpt(cyclic())).toContain('[cycle]');
    expect(excerpt(deep()).length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(excerpt('y'.repeat(5_000_000)).length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(excerpt({ s: 'y'.repeat(5_000_000) }).length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
  });
});
