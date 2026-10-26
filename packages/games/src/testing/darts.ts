import { createRng, type ScoredDart, type TurnCtx } from '@arcade/engine';
import { INNER_BULL, MISS, OUTER_BULL, makeSegment, points, type PlayerId, type Segment } from '@arcade/event-schema';
import { testId } from './players';

/**
 * Parses the dart labels used in scripts and fixtures: "T20", "D16", "S5", "25" (outer
 * bull), "BULL" (inner bull) and "MISS". Case does not matter.
 */
export function parseDart(label: string): Segment {
  const text = label.trim().toUpperCase();
  if (text === 'MISS') return MISS;
  if (text === 'BULL') return INNER_BULL;
  if (text === '25') return OUTER_BULL;
  const match = /^([SDT])([1-9]|1\d|20)$/.exec(text);
  if (!match) throw new RangeError(`Not a dart label: "${label}" (use T20, D16, S5, 25, BULL or MISS)`);
  const multiplier = match[1] === 'T' ? 3 : match[1] === 'D' ? 2 : 1;
  return makeSegment(Number(match[2]), multiplier);
}

export function parseVisits(visits: readonly (readonly string[])[]): Segment[][] {
  return visits.map((visit) => visit.map(parseDart));
}

/** A dart as the host hands it to `onDart`, for tests that call a module directly. */
export function scoredDart(playerId: PlayerId, label: string, dartIndex: 0 | 1 | 2 = 0, turnIndex = 0): ScoredDart {
  const segment = parseDart(label);
  return { throwId: testId(900 + dartIndex), playerId, turnIndex, dartIndex, segment, points: points(segment) };
}

/** A turn context for tests that call a module directly. */
export function turnCtx(playerId: PlayerId, seed = 'test'): TurnCtx {
  return { playerId, turnIndex: 0, roundIndex: 0, dartsThisTurn: [], rng: createRng(seed) };
}
