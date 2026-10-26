# Contributing

AutoDarts Arcade is a private home project. These are the working rules for anyone changing it, people and coding agents alike.

## Run it

Node 22.12+ and Yarn 1, from the repo root:

```sh
yarn install --frozen-lockfile
yarn verify   # lint + typecheck + unit tests, the same steps CI runs
yarn web      # browser preview; add ?input=remote to the URL for the TV layout
```

- The script is `verify`, not `check`. Yarn 1 has a built-in `yarn check` that runs instead of any script with that name.
- The browser preview runs on `react-native-web`. It never exercises `react-native-tvos`, the TV manifest or native modules. The **Native builds** workflow (`.github/workflows/native.yml`) does, on GitHub.
- Remote-only navigation can only be checked in the Android TV emulator or on the Fire TV stick (see [apps/arcade/README.md](apps/arcade/README.md)).
- Keep `yarn.lock` in step with `package.json`: CI installs with `--frozen-lockfile`. Say why in the commit body when you add a dependency.

## Package dependency rule

From [ARCHITECTURE §5.3](ARCHITECTURE.md#53-monorepo-layout). `packages/event-schema`, `engine`, `games` and `adapters` are pure TypeScript, so they run the same in the app, in Node tests and in the dev tools.

- They import nothing from React, React Native, Expo, `@arcade/platform` or `@arcade/ui-kit`.
- They don't use `Date` or `Math.random`. Time comes in through the injected `Clock`, IDs through `IdSource`, and randomness from the seeded `Rng`.
- ESLint enforces both (`eslint.config.mjs`). Test files may use `Date` and `Math.random`.

## Reusing code

From [ARCHITECTURE §4.5](ARCHITECTURE.md#45-community-projects):

- **Learn freely** from protocols and ideas in other projects.
- **Copy code only from MIT, BSD or Apache-2.0 sources**, and keep their licence and copyright notices with the copied code.
- **Never copy code from NC (non-commercial), AGPL or unlicensed repos.** Read them for ideas only.
- **Never copy code, disassembly or decompiled output from closed-source binaries, including Autodarts.** Record only facts, such as endpoint paths and field names, with where you saw them.

## Commits

- Subject line in the imperative mood, short, no trailing full stop: "Add stuck-takeout banner action", not "Added…" or "Adds…".
- In the body, explain **why** the change is needed. The diff already shows what changed.
- One logical change per commit. Keep docs that the change affects (ARCHITECTURE, ROADMAP, RISK-REGISTER) in the same commit.
- Run `yarn verify` before you commit.
