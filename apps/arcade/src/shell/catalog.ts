/**
 * Game manifests for the visual shell. In Phase 3 these come from each game module's
 * `manifest` and `options` schema (ARCHITECTURE §8.2); names are original placeholders.
 */
export type GameCategory = 'party' | 'classic' | 'practice';

export interface OptionSpec {
  key: string;
  label: string;
  values: string[];
  defaultIndex: number;
}

export interface GameManifest {
  id: string;
  name: string;
  tagline: string;
  category: GameCategory;
  players: { min: number; max: number };
  minutes: number;
  skill: 1 | 2 | 3;
  teams?: boolean;
  options: OptionSpec[];
}

export const CATEGORIES: { id: GameCategory; label: string }[] = [
  { id: 'party', label: 'Party' },
  { id: 'classic', label: 'Classic' },
  { id: 'practice', label: 'Practice' },
];

const ROUNDS: OptionSpec = { key: 'rounds', label: 'Rounds', values: ['3', '5', '10'], defaultIndex: 0 };
const DIFFICULTY: OptionSpec = { key: 'difficulty', label: 'Difficulty', values: ['Easy', 'Normal', 'Hard'], defaultIndex: 1 };

export const GAMES: GameManifest[] = [
  {
    id: 'siege',
    name: 'Siege',
    tagline: 'Hit the numbers the invaders carry before they reach your wall.',
    category: 'party',
    players: { min: 2, max: 8 },
    minutes: 12,
    skill: 2,
    teams: true,
    options: [ROUNDS, DIFFICULTY],
  },
  {
    id: 'territory',
    name: 'Territory',
    tagline: "Claim segments of the board, then steal your rivals' ground.",
    category: 'party',
    players: { min: 2, max: 6 },
    minutes: 15,
    skill: 2,
    options: [ROUNDS],
  },
  {
    id: 'balloon',
    name: 'Balloon Pop',
    tagline: 'Pop the balloons on your number before they float away.',
    category: 'party',
    players: { min: 1, max: 8 },
    minutes: 8,
    skill: 1,
    options: [ROUNDS, DIFFICULTY],
  },
  {
    id: 'countdown',
    name: 'Countdown',
    tagline: 'Classic x01: race from 501 to zero and finish on a double.',
    category: 'classic',
    players: { min: 1, max: 8 },
    minutes: 15,
    skill: 3,
    options: [
      { key: 'start', label: 'Start score', values: ['301', '501', '701'], defaultIndex: 1 },
      { key: 'out', label: 'Finish', values: ['Double out', 'Single out'], defaultIndex: 0 },
      ROUNDS,
    ],
  },
  {
    id: 'cricket',
    name: 'Cricket',
    tagline: 'Close 15 to 20 and the bull, and score on whatever is still open.',
    category: 'classic',
    players: { min: 2, max: 4 },
    minutes: 20,
    skill: 3,
    options: [ROUNDS],
  },
  {
    id: 'around-the-clock',
    name: 'Around the Clock',
    tagline: 'Hit 1 through 20 in order, then finish on the bull.',
    category: 'practice',
    players: { min: 1, max: 8 },
    minutes: 10,
    skill: 1,
    options: [ROUNDS],
  },
];

export function gameById(id: string | undefined): GameManifest {
  return GAMES.find((g) => g.id === id) ?? GAMES[0]!;
}

/** Profiles shown under "recent" in player setup until profiles exist (Phase 4). */
export const DEMO_PROFILES = ['Alex', 'Jo', 'Sam', 'Kim', 'Riley', 'Morgan'];
