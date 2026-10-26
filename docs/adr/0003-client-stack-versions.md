# ADR-003: Client stack versions

- **Status:** Accepted (Phase 1, 2026-10-26)
- **Context:** ARCHITECTURE §5.2 named a candidate stack. Phase 1 has to pin exact versions before device builds.

## Decision

| Piece | Version | Why |
|---|---|---|
| Expo SDK | **56** (`expo ~56.0.24`) | Expo's TV guide documents this exact pairing |
| React Native | **`react-native-tvos@0.85.3-3`**, aliased as `react-native` | Same React Native version as SDK 56 (0.85.3). Third stable patch of the TV fork. One fork serves iOS, iPadOS, Android and Fire OS |
| React | 19.2.3 | Bundled with SDK 56 |
| Navigation | Expo Router 56.2 | File routes. Expo lists React Navigation, which Router builds on, as TV-compatible |
| Animation | Reanimated 4.3.1 + Worklets 0.8.3 | SDK 56 bundle. Also on the Vega library list (ARCHITECTURE §4.7) |
| Vector graphics | react-native-svg 15.15.4 | Dartboard, game art |
| TypeScript | 6.0 | SDK 56 template default |
| Package manager | Yarn 1 workspaces | Hoisting keeps a single React Native copy across the monorepo |
| Tests / lint | Vitest 5 (+ Vite 8), ESLint 10, typescript-eslint 8 | |

**TV build:** the same code, with `EXPO_TV=1` at prebuild (the `firetv-apk` EAS profile). `@react-native-tvos/config-tv` applies the leanback/TV manifest.

**React Compiler** is on (`experiments.reactCompiler`), matching the SDK 56 template.

## Alternatives considered

- **Expo SDK 58 + `react-native-tvos` 0.88.0-0:** rejected for now. That TV build was released on 2026-10-17 and is the first build of its line.
- **Expo SDK 57 + `react-native-tvos` 0.86.3-0:** also an exact pairing. Rejected because SDK 56 is the version Expo's TV guide documents.

## Consequences

- Upgrade both together: bumping the Expo SDK means switching to the matching `react-native-tvos` line, per Expo's TV guide.
- The bundle ID and package `io.github.skiifr.autodartsarcade` are placeholders. Change them before the first TestFlight upload if you want a different ID. They cannot change afterwards without creating a new app record.
- Native builds are compiled in CI by `.github/workflows/native.yml`: Android phone, Android TV (`EXPO_TV=1`) and the iOS simulator, unsigned. That proves they compile only once the workflow is green on GitHub.
- Not yet proven on hardware: installing on the devices, the Fire TV focus engine, and Reanimated performance on the 4K Max. These are part of the Phase 1 install dry run (ROADMAP P1, item 7).
