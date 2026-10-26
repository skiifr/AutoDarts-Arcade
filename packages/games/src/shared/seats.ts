import type { PlayerId, PlayerRef } from '@arcade/event-schema';

/** The part of a player every game keeps in its state, in turn order. */
export interface Seat {
  playerId: PlayerId;
  name: string;
  colorIndex: number;
}

export function seatsFrom(players: readonly PlayerRef[]): Seat[] {
  return players.map((p) => ({ playerId: p.playerId, name: p.displayName, colorIndex: p.colorIndex }));
}

/** Index of a player in turn order. An unknown id is a host bug, so it throws. */
export function seatOf(players: readonly Seat[], playerId: PlayerId): number {
  const seat = players.findIndex((p) => p.playerId === playerId);
  if (seat < 0) throw new RangeError(`Player ${playerId} is not in this game`);
  return seat;
}

/** A copy of `items` with one element replaced. States are never mutated. */
export function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return items.map((item, i) => (i === index ? value : item));
}
