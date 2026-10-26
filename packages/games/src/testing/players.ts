import type { PlayerRef } from '@arcade/event-schema';

/** A deterministic, ULID-shaped id ("000…0001"). Crockford base32 allows plain digits. */
export function testId(n: number): string {
  return String(n).padStart(26, '0');
}

/** Guest players in turn order, with ids 1…n and palette colours 0…n-1. */
export function makePlayers(names: readonly string[]): PlayerRef[] {
  return names.map((displayName, i) => ({
    playerId: testId(i + 1),
    displayName,
    colorIndex: i % 8,
    kind: 'guest',
  }));
}

/** "Player 1" … "Player n". */
export function defaultNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Player ${i + 1}`);
}
