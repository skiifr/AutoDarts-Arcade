import type { GameModule } from '@arcade/engine';

/** Every playable game. Adding a game is one folder plus one line here (ARCHITECTURE §8.2). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each module has its own option and state types
export const GAMES: readonly GameModule<any, any, any>[] = [];
