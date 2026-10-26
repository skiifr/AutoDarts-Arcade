import type { GameModule } from './game-module';

/**
 * Looks a game up by `manifest.id`. Injected into the fold and the host, so the engine never
 * imports `packages/games`: the app passes `gameRegistry(GAMES)`.
 */
export type GameRegistry = (gameId: string) => GameModule | undefined;

/** Builds a registry from a list of modules. Throws on duplicate ids. */
export function gameRegistry(games: readonly GameModule[]): GameRegistry {
  const byId = new Map<string, GameModule>();
  for (const game of games) {
    if (byId.has(game.manifest.id)) throw new Error(`Duplicate game id "${game.manifest.id}"`);
    byId.set(game.manifest.id, game);
  }
  return (gameId) => byId.get(gameId);
}
