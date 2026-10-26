# Assets

Every non-code file the app ships (art, fonts, sounds) is logged here: where it came from,
how it was made, its licence and whether it is final. The specs for the art still to be made
are in [docs/design/asset-spec.md](docs/design/asset-spec.md).

## Provenance rules

Before an asset is committed, add a row here with:

- **File** path, and the **slot** id from the asset spec.
- **Source**: who or what made it, and from what. For generated art name the **tool** (and
  model or version if shown), paste the **exact prompt** (or link the prompt file), list every
  **reference image** given to the tool, and record the **date**.
- **Licence**: our own work, or the third-party licence with its notice file.
- **Status**: `final`, or `TEMPORARY placeholder, replace with final art`.

Rules for generated art:

- No third-party artwork, logos, product names or screenshots as references unless their
  licence allows it, and none of them may appear in the output. Our own concept images are fine.
- Check the output for accidental lettering, numbers or signatures; titles, scores and target
  numbers are always rendered by the app.
- Keep the untouched tool output in the PR description or an archive outside the app, and
  commit only the cropped or resized file the app uses.

## Fonts

| File | Source | Licence | Status |
|---|---|---|---|
| `apps/arcade/assets/fonts/BarlowCondensed-SemiBold.ttf` | Barlow Condensed SemiBold (600), Jeremy Tribby / The Barlow Project, from the [google/fonts repository](https://github.com/google/fonts/tree/main/ofl/barlowcondensed) `ofl/barlowcondensed/`, downloaded 2026-10-26. SHA-256 `7b619d14bc2327509a9ef32b0890f709626f7ecc9ff61191c2a4314c5499d2d9` | SIL Open Font License 1.1, `apps/arcade/assets/fonts/OFL.txt` (Copyright 2017 The Barlow Project Authors) | final |
| `apps/arcade/assets/fonts/BarlowCondensed-Bold.ttf` | As above, Bold (700). SHA-256 `e476562ec9c1e16cf16475895b511f08c804f438cc9a9f80a44ea50a0eeb5b65` | SIL OFL 1.1, `OFL.txt` | final |
| `apps/arcade/assets/fonts/BarlowCondensed-ExtraBold.ttf` | As above, ExtraBold (800). SHA-256 `724c9c25952d5f4a2d87185d9767aa006144c5f0d944dc05bf7d5d603551c260` | SIL OFL 1.1, `OFL.txt` | final |
| `apps/arcade/assets/fonts/OFL.txt` | The licence file from the same folder. SHA-256 `186d750eb496a4c17a76385f82be6aea2ac1cf2de074a811d63786cf374ea73f` | n/a | final |

The fonts are unmodified and keep their reserved name. Native builds embed them with the
expo-font config plugin (`apps/arcade/app.json`); the web and Expo Go load them at runtime
(`apps/arcade/src/shell/fonts.ts`).

## Art

| File | Slot | Source | Tool | Date | Status |
|---|---|---|---|---|---|
| `apps/arcade/assets/art/placeholder/poster-siege.png` (194×564) | `poster-siege` | Art area of the Siege card in the concept mockup `docs/research/ui-smarts-mockups/w1-game-selection.png` (branch `research/ui-smarts-mockups`; mockup SHA-256 `2eceb09e157bdd1b8dab24e2ceac4fe6ec9c60906189d80d00d557232098ea74`), crop box x 157–351, y 133–697, title strip excluded | ChatGPT image generation, concept mockup ("MENU PROMPT" and "MENU REVISION PROMPT" in `docs/research/ui-smarts-mockups/generation-prompts.txt`); cropped with Python Pillow, no other edits | 2026-10-26 | **TEMPORARY placeholder, replace with final art** |
| `apps/arcade/assets/art/placeholder/poster-territory.png` (186×558) | `poster-territory` | Same mockup, Territory card, x 481–667, y 137–695 | As above | 2026-10-26 | **TEMPORARY placeholder, replace with final art** |
| `apps/arcade/assets/art/placeholder/poster-balloon.png` (195×558) | `poster-balloon` | Same mockup, Balloon Pop card, x 791–986, y 137–695 | As above | 2026-10-26 | **TEMPORARY placeholder, replace with final art** |
| `apps/arcade/assets/art/placeholder/poster-countdown.png` (192×558) | `poster-countdown` | Same mockup, Countdown card, x 1114–1306, y 137–695 | As above | 2026-10-26 | **TEMPORARY placeholder, replace with final art** |
| `apps/arcade/assets/art/placeholder/poster-cricket.png` (184×558) | `poster-cricket` | Same mockup, Cricket card, x 1435–1619, y 137–695 | As above | 2026-10-26 | **TEMPORARY placeholder, replace with final art** |

Notes on the placeholders:

- The concept mockup was generated with public photographs of a commercial darts product as
  composition references (see the research README). The crops are fine for private testing
  but are **not cleared for release**; replace them before the app or its screenshots are
  published anywhere.
- They contain baked-in numbers (the "501" and the numbered shields) that final poster art
  must not have.
- At 1080p they are shown at about 201×569 px, so they are slightly upscaled and soft.

## Vector art drawn in code (no files)

Original SVG placeholders, drawn for this app, each with an image slot that painted art can
fill later (see the asset spec):

| Where | What | Replaced by slot |
|---|---|---|
| `packages/ui-kit/src/PosterArt.tsx` | Around the Clock poster (clock ring, progress arc, dart) and a generic fallback | `poster-around-the-clock` |
| `apps/arcade/src/shell/stages/Backdrops.tsx` | Siege valley with castle and road; electric arena for the classic games | `stage-siege-bg`, `stage-countdown-bg`, `stage-cricket-bg`, `stage-around-the-clock-bg` |
| `apps/arcade/src/shell/stages/SiegeStage.tsx` | Invaders with blank shields (live numbers are text), wall merlons and rubble | `siege-invader-*`, `siege-brick-*` |
| `apps/arcade/src/shell/stages/StageBoard.tsx` | Low-key dartboard behind stage numbers | (stays vector: it shows live targets) |
