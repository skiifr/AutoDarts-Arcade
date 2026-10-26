# AutoDarts Arcade

An arcade-style party-game frontend for an existing camera-scored steel-tip dartboard. It ships as a native app for **iPhone, iPad, Android and Amazon Fire TV**, and reads darts from the board over your home network without modifying the detection software.

> **Status: Phase 1 in progress.** The app shell runs on demo darts; the live board connection is next.
> **Scope:** private home use. Target devices: iPhone, iPad, Android and a Fire TV Stick 4K Max, all installed directly with no store listings.
> This is an independent community project. It is not affiliated with or endorsed by Autodarts GmbH, Winmau or BattleUp. "AutoDarts Arcade" is the name for private home use, and would be revisited only if the app were ever published.

| Document | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Research findings (Autodarts 2.x, licensing, community projects, Pi 4, Fire TV / Vega), system design, event schema, game engine, wireframes, and the verified-vs-assumed ledger |
| [ROADMAP.md](ROADMAP.md) | Owner decisions Q1–Q6, six implementation phases with gates, acceptance criteria, and the testing strategy |
| [RISK-REGISTER.md](RISK-REGISTER.md) | 27 scored technical, legal and platform risks with mitigations |

## Getting started

```sh
yarn install
yarn web      # browser preview; add ?input=remote to the URL for the TV layout
yarn check    # lint + typecheck + unit tests
```

Device builds (TestFlight, Android APK, Fire TV APK) are described in [apps/arcade/README.md](apps/arcade/README.md).

| Path | What |
|---|---|
| `apps/arcade` | The app: Expo SDK 56 + `react-native-tvos`, screens W0–W5 (visual shell on demo darts) |
| `packages/event-schema` | `arcade.event/v1` schema (zod), pure TypeScript |
| `packages/ui-kit` | Theme, focus handling, dartboard and correction picker |
| `docs/adr` | Architecture decision records |

## Licence

GPL-3.0 (see [LICENSE](LICENSE)). This doesn't matter for private installs. Before any outside contributions or store release, see ROADMAP **Q4** and risk **R07**.
