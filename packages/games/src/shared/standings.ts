import type { GameEffect } from '@arcade/engine';
import type { PlayerId, Standing } from '@arcade/event-schema';

/**
 * Sorts players best first and gives equal players the same rank ("1, 1, 3"), so a
 * tie that the rules cannot break is shared rather than decided by seat order.
 */
export function rankStandings<T extends { playerId: PlayerId }>(
  items: readonly T[],
  compare: (a: T, b: T) => number,
  score: (item: T) => number,
): Standing[] {
  const sorted = [...items].sort(compare);
  const standings: Standing[] = [];
  sorted.forEach((item, i) => {
    const previous = sorted[i - 1];
    const tied = previous !== undefined && compare(previous, item) === 0;
    standings.push({ playerId: item.playerId, rank: tied ? standings[i - 1]!.rank : i + 1, score: score(item) });
  });
  return standings;
}

/** One `win` effect per first-placed player. */
export function winEffects(standings: readonly Standing[]): GameEffect[] {
  return standings.filter((s) => s.rank === 1).map((s) => ({ kind: 'win', playerId: s.playerId, intensity: 3 }));
}

/** "Alex wins", or "Alex and Jo share the win" when first place is tied. */
export function winnerHeadline(standings: readonly Standing[], nameOf: (playerId: PlayerId) => string): string {
  const names = standings.filter((s) => s.rank === 1).map((s) => nameOf(s.playerId));
  return names.length === 1 ? `${names[0]} wins` : `${names.join(' and ')} share the win`;
}
