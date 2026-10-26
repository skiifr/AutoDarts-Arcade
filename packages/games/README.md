# @arcade/games

Game modules for AutoDarts Arcade: pure rules that the engine folds the event log through
(ARCHITECTURE §8). A game is **one folder plus one line in the registry**.

| Game | Folder | Players | Category |
|---|---|---|---|
| Siege | `src/siege/` | 2–8 | party (prototype: rules only) |
| Countdown | `src/countdown/` | 1–8 | classic (x01) |
| Cricket | `src/cricket/` | 2–4 | classic |
| Around the Clock | `src/around-the-clock/` | 1–8 | practice |

## Adding a game

1. **Make a folder** `src/<id>/`, where `<id>` is the game's kebab-case id:
   - `module.ts`: the rules, exporting a `GameModule` (contract in
     `packages/engine/src/game-module.ts`);
   - `rules.md`: player-facing rules, short and clear;
   - `fixtures/*.json`: scripted games with their expected standings;
   - `module.test.ts`: a rules suite that follows `rules.md` section by section;
   - later, `stage/`: the React Native renderer for W3 (Phase 5, lives outside this package's
     pure code).
2. **Add one line** to `GAMES` in `src/index.ts` (and its import). The registry test then
   checks the id is unique, the defaults parse, the folder has its rules and fixtures, and
   that seeded random games run to a full ranking without mutating state.
3. Run `yarn run check` and `yarn workspace @arcade/games coverage`. Every `module.ts` must
   have **100 % branch coverage** from its own tests.

### A tiny example

A practice game: highest total after a few rounds.

```ts
// src/high-score/module.ts
import type { GameModule } from '@arcade/engine';
import { z } from 'zod';
import { replaceAt, seatOf, seatsFrom, type Seat } from '../shared/seats';
import { rankStandings, winEffects } from '../shared/standings';
import type { BaseView } from '../shared/view';

const highScoreOptions = z.object({ rounds: z.literal([3, 5, 10]).default(5) });
type Options = z.infer<typeof highScoreOptions>;

interface State {
  options: Options;
  players: (Seat & { score: number })[];
  current: number;
  round: number;
  finished: boolean;
}

const result = (state: State) =>
  state.finished ? rankStandings(state.players, (a, b) => b.score - a.score, (p) => p.score) : null;

export const highScore: GameModule<Options, State, BaseView> = {
  manifest: {
    id: 'high-score', version: '1.0.0', name: 'High Score',
    players: { min: 1, max: 8 }, category: 'practice', dartsPerTurn: 3,
  },
  options: highScoreOptions,
  init: ({ players, options }) => ({
    options,
    players: seatsFrom(players).map((seat) => ({ ...seat, score: 0 })),
    current: 0,
    round: 1,
    finished: false,
  }),
  onDart: (state, dart) => {
    const seat = seatOf(state.players, dart.playerId);
    const player = state.players[seat]!;
    return { state: { ...state, players: replaceAt(state.players, seat, { ...player, score: player.score + dart.points }) } };
  },
  onTurnEnd: (state, ctx) => {
    const next = (seatOf(state.players, ctx.playerId) + 1) % state.players.length;
    if (next !== 0) return { state: { ...state, current: next } };
    if (state.round < state.options.rounds) return { state: { ...state, current: 0, round: state.round + 1 } };
    const finished = { ...state, finished: true };
    return { state: finished, effects: winEffects(result(finished)!) };
  },
  nextPlayer: (state) => (state.finished ? null : state.players[state.current]!.playerId),
  result,
  view: (state) => ({
    gameId: 'high-score',
    headline: state.finished ? 'Game over' : `${state.players[state.current]!.name} to throw`,
    round: state.round,
    maxRounds: state.options.rounds,
    finished: state.finished,
    current: state.finished ? null : state.players[state.current]!.playerId,
    targets: [20],
    scoreboard: state.players.map((p, seat) => ({
      playerId: p.playerId, name: p.name, colorIndex: p.colorIndex, score: p.score,
      detail: '', active: !state.finished && seat === state.current, out: false,
    })),
  }),
};
```

```ts
// src/index.ts
import { highScore } from './high-score/module';
export const GAMES = [
  // …
  highScore,
];
```

## The rules for rules

- **Pure TypeScript.** No React, React Native, Expo or platform imports, no `Date`, no
  `Math.random`, no timers or I/O. Lint enforces it.
- **Randomness only from the `Rng`** passed to `init` and in every `TurnCtx`. Make the same
  number of draws whatever the players throw (Siege draws each wave the same way every
  round), so a correction does not reshuffle the future.
- **State is plain JSON** and is **never mutated**: return a new state (copy only what
  changes; `replaceAt` helps). The harness can deep-freeze and JSON round-trip every state
  to prove it.
- **The host owns turn boundaries.** A visit is up to three darts. A game may only ask to end
  a visit early with `endTurn: 'bust'` (score restored by the game) or `'game-rule'` (for
  example a finish). Later darts in that visit are shown but never reach `onDart`.
- **Identify the thrower from `dart.playerId` / `ctx.playerId`** (use `seatOf`), keep whose
  turn is next in the state, and return `null` from `nextPlayer` once the game is over.
- **`result` is `null` until the game is finished**, then ranks every player. Players the
  rules cannot separate share a rank (`rankStandings` does this: 1, 1, 3).
- **`view` is everything the UI needs** without knowing the rules. Every reference game's
  view extends `BaseView` (`src/shared/view.ts`): a headline, round, the current player,
  numbers worth aiming at (`targets`) and a ready-made scoreboard, plus its own stage data.
- **`options` is a zod schema with a default for every field** (`options.parse({})` must
  work). Prefer `z.boolean()`, `z.enum()` and `z.literal([…])` so the setup screen can
  render a control per option.

## Testing

`src/testing/` stands in for the engine until the session host lands:

- `runSession(game, { players, options, seed, darts })` plays init → `onDart` per dart →
  `onTurnEnd` → `nextPlayer`, three darts a visit, padding short visits with misses and
  honouring `endTurn`. `darts` is a list of visits or a function asked for each dart.
  `freeze` and `roundTrip` check purity.
- `playScript(game, fixture)` plays a fixture and returns named standings.
- `scoredDart`, `turnCtx` and `makePlayers` build inputs for calling a module directly.
- `aimingThrower(seed)` is a seeded pub-level player who aims at the view's `targets`.

### Fixtures

```json
{
  "description": "What this game shows.",
  "players": ["Alex", "Jo"],
  "options": { "start": 301 },
  "seed": "optional, for games that use the Rng",
  "visits": [["T20", "T20", "T20"], ["S5", "MISS"], ["T20", "T7", "D20"]],
  "expect": {
    "finished": true,
    "turns": 3,
    "standings": [{ "player": "Alex", "rank": 1, "score": 0 }, { "player": "Jo", "rank": 2, "score": 296 }]
  }
}
```

Visits are in throwing order and use labels `T20`, `D16`, `S5`, `25`, `BULL` and `MISS`. A
short visit is padded with misses. `src/fixtures.test.ts` plays every fixture of every
registered game.

Fixtures for games that use the `Rng` (Siege) are recorded with the engine's generator
(`createRng` from `@arcade/engine`), the one sessions run on. If it ever changes, re-record
them.

### Headless runner

```sh
yarn play-headless --game countdown --players 2 --seed abc      # random game, seeded
yarn play-headless --game cricket --script path/to/fixture.json  # replay a script, check "expect"
yarn play-headless --game siege --players 3 -o difficulty=hard --record my-fixture.json
yarn play-headless --help
```

`--record` saves any game as a fixture whose `expect` is the result it produced: check it by
hand before you commit it.
