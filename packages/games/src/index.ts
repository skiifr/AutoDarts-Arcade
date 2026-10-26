import type { GameModule } from '@arcade/engine';
import { aroundTheClock } from './around-the-clock/module';
import { countdown } from './countdown/module';
import { cricket } from './cricket/module';
import { siege } from './siege/module';

export type { BaseView, ScoreRow } from './shared/view';

/** Every playable game. Adding a game is one folder plus one line here (ARCHITECTURE §8.2). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each module has its own option and state types
export const GAMES: readonly GameModule<any, any, any>[] = [
  siege,
  countdown,
  cricket,
  aroundTheClock,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see GAMES
export function gameById(id: string): GameModule<any, any, any> | undefined {
  return GAMES.find((game) => game.manifest.id === id);
}
