# AutoDarts Arcade

An arcade-style party-game frontend for an existing camera-scored steel-tip dartboard. It ships as a native app for **iPhone, iPad, Android and Amazon Fire TV**, and reads darts from the board over your home network without modifying the detection software.

> **Status: Phases 2 and 3 built and proven in simulation.** The live board connection (Phase 2) and the game engine with four games (Phase 3) pass their test suites against the simulator and the fake board. The engine, boundary and board fixes are merged and reconciled: 5,000 extra seeds of each chaos suite find no silent mismatch, and uncertain turns are flagged for review. W0 connects to a board and the dart ticker shows its darts; the game screens still run on demo darts. Hardware checkpoint HC1 (board probe, fixtures, Pi baseline, device installs) waits for access to the board and the Pi. The visual redesign (owner decision V) is in progress.
> **Scope:** private home use. Target devices: iPhone, iPad, Android and a Fire TV Stick 4K Max, all installed directly with no store listings.
> This is an independent community project. It is not affiliated with or endorsed by Autodarts GmbH, Winmau or BattleUp. "AutoDarts Arcade" is the name for private home use, and would be revisited only if the app were ever published.

| Document | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Research findings (Autodarts 2.x, licensing, community projects, Pi 4, Fire TV / Vega), system design, event schema, game engine, wireframes, and the verified-vs-assumed ledger |
| [ROADMAP.md](ROADMAP.md) | Owner decisions (Q1–Q6, R, S, V), six implementation phases and hardware checkpoint HC1 with their gates, acceptance criteria, and the testing strategy |
| [RISK-REGISTER.md](RISK-REGISTER.md) | 30 scored technical, legal and platform risks with mitigations |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to run the checks, the package dependency rule, the code-reuse rule and commit conventions |

## Getting started

```sh
yarn install
yarn web      # browser preview; add ?input=remote to the URL for the TV layout
yarn verify   # lint + typecheck + unit tests
```

Device builds (TestFlight, Android APK, Fire TV APK) are described in [apps/arcade/README.md](apps/arcade/README.md).

| Path | What |
|---|---|
| `apps/arcade` | The app: Expo SDK 56 + `react-native-tvos`, screens W0–W5 (games on demo darts), the live board check and the dart ticker |
| `apps/devtools` | Fake board, fault proxy and headless runner (below) |
| `packages/event-schema` | `arcade.event/v1` schema (zod), pure TypeScript |
| `packages/adapters` | Board sources: `autodarts-local`, the simulator and manual entry, pure TypeScript |
| `packages/engine` | Session host, event log, replay and turn policy, pure TypeScript |
| `packages/games` | Countdown, Cricket, Around the Clock and Siege, with the authoring guide |
| `packages/platform` | Board transport with the endpoint allowlist, log storage, discovery and `createArcadeRuntime` |
| `packages/ui-kit` | Theme, focus handling, dartboard and correction picker |
| `docs/adr` | Architecture decision records |

## Try it without a board

Node 22 or newer, from the repository root:

```sh
yarn fake-board --port 3180 --scenario random-play
yarn fault-proxy --target 127.0.0.1:3180 --listen 3181 --drop 0.1 --cut-every 30
yarn play-headless --game countdown --players 2
```

- **`fake-board`** serves a simulated board's read API on port 3180. Point the app at this computer ([README](apps/devtools/fake-board/README.md)).
- **The dart ticker:** with `yarn fake-board` running, start `yarn web` in a second terminal and open http://localhost:8081. On the connect screen, enter `127.0.0.1` and press **Connect**. The ticker shows the simulated darts as they land. The browser preview can read only the fake board; a real board needs a native build ([app README](apps/arcade/README.md#against-the-fake-board)).
- **`fault-proxy`** sits between the app and the board and drops, duplicates, delays or cuts frames. Point the app at port 3181 ([README](apps/devtools/fault-proxy/README.md)).
- **`play-headless`** plays a whole game through the engine with a seeded thrower, no board or app needed. `--help` lists the options ([games README](packages/games/README.md#headless-runner)).

## Licence

GPL-3.0 (see [LICENSE](LICENSE)). This doesn't matter for private installs. Before any outside contributions or store release, see ROADMAP **Q4** and risk **R07**.
