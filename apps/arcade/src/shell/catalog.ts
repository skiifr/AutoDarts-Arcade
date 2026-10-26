import { GAMES as MODULES } from '@arcade/games';

/**
 * Game cards for W1 and setup for W2. Names, player counts and categories come from the
 * game modules' manifests (`@arcade/games`) wherever a module exists; this file adds the
 * presentation (pitch, art, timings) and the two party games whose rules are not written
 * yet, which run on demo scoring and carry a "Preview" badge. Names are original placeholders.
 */
export type GameCategory = 'party' | 'classic' | 'practice';
/** W1's tabs: every game, or one category. */
export type GameFilter = 'all' | GameCategory;

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
  /** One line under the posters: "Defend the wall. Hit the invaders' numbers." */
  pitch: string;
  category: GameCategory;
  players: { min: number; max: number };
  minutes: number;
  skill: 1 | 2 | 3;
  teams?: boolean;
  options: OptionSpec[];
  /** No rules module yet: playable on demo scoring only. */
  preview: boolean;
}

export const CATEGORIES: { id: GameCategory; label: string }[] = [
  { id: 'party', label: 'Party' },
  { id: 'classic', label: 'Classic' },
  { id: 'practice', label: 'Practice' },
];

export const FILTERS: { id: GameFilter; label: string }[] = [{ id: 'all', label: 'All games' }, ...CATEGORIES];

/** Round counts each module accepts (its zod literals), shortest first for quick demos. */
const rounds = (values: number[]): OptionSpec => ({ key: 'rounds', label: 'Rounds', values: values.map(String), defaultIndex: 0 });
const DIFFICULTY: OptionSpec = { key: 'difficulty', label: 'Difficulty', values: ['Easy', 'Normal', 'Hard'], defaultIndex: 1 };

type Presentation = Omit<GameManifest, 'name' | 'category' | 'players' | 'preview'> &
  Partial<Pick<GameManifest, 'name' | 'category' | 'players'>>;

/** Display order on W1. Entries without a module must give name, category and players. */
const PRESENTATION: Presentation[] = [
  {
    id: 'siege',
    tagline: 'Hit the numbers the invaders carry before they reach your wall.',
    pitch: "Defend the wall. Hit the invaders' numbers.",
    minutes: 12,
    skill: 2,
    options: [rounds([5, 10, 15, 20]), DIFFICULTY],
  },
  {
    id: 'territory',
    name: 'Territory',
    category: 'party',
    players: { min: 2, max: 6 },
    tagline: "Claim segments of the board, then steal your rivals' ground.",
    pitch: "Claim the board. Steal your rivals' ground.",
    minutes: 15,
    skill: 2,
    options: [rounds([3, 5, 10])],
  },
  {
    id: 'balloon',
    name: 'Balloon Pop',
    category: 'party',
    players: { min: 1, max: 8 },
    tagline: 'Pop the balloons on your number before they float away.',
    pitch: 'Pop your balloons before they float away.',
    minutes: 8,
    skill: 1,
    options: [rounds([3, 5, 10]), DIFFICULTY],
  },
  {
    id: 'countdown',
    tagline: 'Classic x01: race from 501 to zero and finish on a double.',
    pitch: 'Race from 501 to zero. Finish on a double.',
    minutes: 15,
    skill: 3,
    options: [
      { key: 'start', label: 'Start score', values: ['301', '501', '701'], defaultIndex: 1 },
      { key: 'out', label: 'Finish', values: ['Double out', 'Single out'], defaultIndex: 0 },
      rounds([10, 15, 20, 30, 50]),
    ],
  },
  {
    id: 'cricket',
    tagline: 'Close 15 to 20 and the bull, and score on whatever is still open.',
    pitch: 'Close 15 to 20 and the bull. Score on the rest.',
    minutes: 20,
    skill: 3,
    options: [rounds([10, 15, 20, 30])],
  },
  {
    id: 'around-the-clock',
    tagline: 'Hit 1 through 20 in order, then finish on the bull.',
    pitch: 'Hit 1 to 20 in order, then the bull.',
    minutes: 10,
    skill: 1,
    options: [rounds([10, 15, 20, 30])],
  },
];

function categoryOf(category: string): GameCategory {
  return category === 'classic' || category === 'practice' ? category : 'party';
}

/** A module registered without presentation still gets a card (with plain defaults). */
const UNPRESENTED: Presentation[] = MODULES.filter((m) => !PRESENTATION.some((p) => p.id === m.manifest.id)).map((m) => ({
  id: m.manifest.id,
  tagline: '',
  pitch: '',
  minutes: 10,
  skill: 2,
  options: [],
}));

export const GAMES: GameManifest[] = [...PRESENTATION, ...UNPRESENTED].map((p) => {
  const module = MODULES.find((m) => m.manifest.id === p.id);
  const manifest = module?.manifest;
  return {
    ...p,
    name: manifest?.name ?? p.name ?? p.id,
    category: manifest ? categoryOf(manifest.category) : (p.category ?? 'party'),
    players: manifest ? { ...manifest.players } : (p.players ?? { min: 1, max: 8 }),
    teams: manifest?.teams ?? p.teams,
    preview: !module,
  };
});

export function gamesIn(filter: GameFilter): GameManifest[] {
  return filter === 'all' ? GAMES : GAMES.filter((g) => g.category === filter);
}

export function gameById(id: string | undefined): GameManifest {
  return GAMES.find((g) => g.id === id) ?? GAMES[0]!;
}

/** Profiles shown under "recent" in player setup until profiles exist (Phase 4). */
export const DEMO_PROFILES = ['Alex', 'Jo', 'Sam', 'Kim', 'Riley', 'Morgan'];
