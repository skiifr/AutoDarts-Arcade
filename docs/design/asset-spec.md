# Art asset spec

What final art the restyled screens need, written so each row can be handed to ChatGPT's
image tool as a brief. The app renders every title, score, target number, label and focus
ring itself, so **no art contains text or numbers**. Placeholders in use today are logged in
[ASSETS.md](../../ASSETS.md); every final file gets a row there too (tool, exact prompt, date).

## Visual system (what the art has to sit in)

| Token | Value | Use |
|---|---|---|
| Navy background | `#060D1D` (deep `#030711`) | Screen backgrounds, panels `#0A1630` |
| Frame cyan | `#2CD5F2` (dim `#1B7E96`) | Thin frame lines, chips, avatar rings |
| Focus gold | `#FFC53D` | **The remote's focus ring only.** Never use gold or yellow outlines, rings or glows in art |
| Ink | `#F4F7FF` | Text |
| Game accents | Siege `#FF9A1F` amber, Territory `#A8E83A` lime, Balloon Pop `#FF4FA8` pink, Countdown `#2FE3FF` cyan, Cricket `#A66CFF` violet, Around the Clock `#22D07A` green | Poster title strips, plaque titles, highlights |

- **Type:** Barlow Condensed (SemiBold, Bold, ExtraBold), rendered by the app.
- **Style:** original, energetic, illustrated arcade art: chunky cartoon shapes, bright clean colour, restrained dimensional shading, light from the top left. Not photographic. Nothing that resembles another product's characters, games, logos or screens.
- **Screens:** the UI is laid out at 1920×1080 logical pixels on TV, also on 4K sticks (ARCHITECTURE §9.2). Controls and essential text keep inside the 5 % title-safe area (96 px left and right, 54 px top and bottom); art may bleed to the edges.
- **Phones** show the same files: posters at about 111×315 px, and stage backgrounds cropped to the centre (a 390×844 portrait screen shows roughly the middle 500 px of a 1920 px wide background).

## Slots

Sizes are what the app displays at 1080p; deliver at the **delivery size** (about 2×, so
they stay crisp on tablets). Formats: **PNG** with alpha for anything that is layered over
something else; **WebP** (lossy, quality about 85) or PNG for opaque backgrounds.

| Slot id | Purpose | Shown at 1080p | Delivery size / aspect | Format | Must NOT contain | Layering | Safe zones | Palette and style | File name and folder |
|---|---|---|---|---|---|---|---|---|---|
| `poster-siege` | W1 poster art area for Siege (right of the title strip) | 201×569 (213×603 when focused) | **420×1190**, aspect 0.353 (≈ 2 : 5.67) | PNG, opaque | Any text, title, logo or number; numbers on shields; a frame or border (the card draws it); the title strip | Single opaque image; the app adds strip, frame, focus ring | Key subject in the middle 80 % of the width and between 10 % and 90 % of the height; top-right 70×40 px may be covered by a badge | A bright storybook castle wall under attack: shield-carrying invaders (blank shields), a dart in flight; amber `#FF9A1F` banners, teal sky | `apps/arcade/assets/art/posters/poster-siege.png` |
| `poster-territory` | W1 poster, Territory | 201×569 | 420×1190 | PNG, opaque | Text, numbers, logos, frames | As above | As above; top right is covered by the "Preview" badge until its rules ship | Colourful patchwork farmland seen from above, rivers and bridges, plots in player colours; lime `#A8E83A` highlights | `.../posters/poster-territory.png` |
| `poster-balloon` | W1 poster, Balloon Pop | 201×569 | 420×1190 | PNG, opaque | Text, numbers, logos, frames | As above | As above; top right covered by "Preview" | Glossy balloons popping under darts, confetti; pink `#FF4FA8` lead colour | `.../posters/poster-balloon.png` |
| `poster-countdown` | W1 poster, Countdown | 201×569 | 420×1190 | PNG, opaque | Text, **"501" or any numerals**, logos, frames | As above | As above | Dramatic dartboard close-up with a dart in the treble 20, electric cyan `#2FE3FF` light on dark navy | `.../posters/poster-countdown.png` |
| `poster-cricket` | W1 poster, Cricket | 201×569 | 420×1190 | PNG, opaque | Text, numerals, logos, frames | As above | As above | Graphic dartboard with darts clustered in 15–20 and the bull, violet `#A66CFF` energy | `.../posters/poster-cricket.png` |
| `poster-around-the-clock` | W1 poster, Around the Clock (today a vector placeholder) | 201×569 | 420×1190 | PNG, opaque | Text, numerals (draw positions as marks, not numbers), logos, frames | As above | As above | A clock-like ring of 20 glowing marks with a trail sweeping round to the bull, green `#22D07A` | `.../posters/poster-around-the-clock.png` |
| `stage-siege-bg` | W3 full-screen Siege backdrop behind the panels | 1920×1080, full bleed | **1920×1080**, 16:9 | WebP or PNG, opaque | Text, numbers, invaders or characters (sprites are separate), a wall with merlons along the stage top (the app draws the live wall there), UI frames | Bottom layer. On top the app draws: the live wall (x 620–1300, y 290–380), invaders (x 620–1300, y 380–740), panels and plaques | Calm, mid-contrast centre (x 600–1320, y 290–740) so live numbers read; castle and gate centred behind the wall line (gate around x 900–1020, y 450–560); a road from the gate to the bottom centre; panels cover x 228–560 and 1360–1692 (y 132–880); rail covers y 897–988 | Storybook green valley, warm stone fortress, bright teal sky, amber banners; the same cartoon style as the posters | `apps/arcade/assets/art/stages/stage-siege-bg.webp` |
| `stage-countdown-bg` | W3 backdrop for Countdown: electric arena | 1920×1080 | 1920×1080 | WebP or PNG, opaque | Text, numbers, scoreboards, a dartboard (the app draws the live board), crowds' faces in detail | Bottom layer; the app draws a dartboard and a very large score in the centre | Darkest and calmest in the centre (x 600–1320, y 280–740); light rigs and stands at the sides and top | Deep navy to electric blue, cyan `#2FE3FF` beams, light strips, floor glow | `.../stages/stage-countdown-bg.webp` |
| `stage-cricket-bg` | W3 backdrop for Cricket | 1920×1080 | 1920×1080 | WebP or PNG, opaque | As Countdown | The app draws the marks grid in the centre | As Countdown | The same arena lit violet `#A66CFF` | `.../stages/stage-cricket-bg.webp` |
| `stage-around-the-clock-bg` | W3 backdrop for Around the Clock | 1920×1080 | 1920×1080 | WebP or PNG, opaque | As Countdown | The app draws the target ring in the centre | As Countdown | The same arena lit green `#22D07A` | `.../stages/stage-around-the-clock-bg.webp` |
| `siege-invader-a`, `-b`, `-c` | Three invader types marching on the wall, each carrying a round shield | up to 214×246 (nearer bands are drawn smaller, down to about 62 %) | **440×506** each (100 : 115) | PNG with alpha | **Any number, letter or emblem on the shield** (the app writes the live number there); text; ground or scenery | Above the background; the app adds the number and strength pips over the shield | Shield is a plain round disc centred at x 220, y 290 with a diameter of 246 px, facing the viewer, uncovered by arms or weapons; the shield's top rim stays visible (pips sit on it); a soft ground shadow inside the bottom 20 px; transparent elsewhere | Chunky cartoon soldiers (for example horned helmet, plumed helmet, simple cap), different tunic colours per type; shields in distinct mid-tone colours (red, blue, gold-free yellow ochre, green) that keep white numerals readable | `apps/arcade/assets/art/siege/invader-a.png` (and `-b`, `-c`) |
| `siege-invader-a-damaged`, `-b-`, `-c-` | The same invaders after a hit that did not destroy them | as above | 440×506 | PNG with alpha | As above | Shown instead of the intact sprite while strength is below maximum | Same pose and shield position as the intact sprite (pixel-aligned), shield cracked and dented, still blank | As above | `.../siege/invader-a-damaged.png` (etc.) |
| `siege-brick-intact` | One merlon of the defender's wall (one per remaining brick, ten in a row) | about 49×33 | **100×68** | PNG with alpha | Text, numbers | Drawn in a row above `siege-wall-base` | Brick fills the canvas width; flat bottom edge | Warm sandstone `#D7C6A6`, darker mortar `#9F8D70`, light top edge | `.../siege/brick-intact.png` |
| `siege-brick-rubble` | A lost merlon | about 49×33 | 100×68 | PNG with alpha | Text, numbers | Replaces an intact brick | Rubble pile sitting on the bottom edge, lower than an intact brick | As above, darker and broken | `.../siege/brick-rubble.png` |
| `siege-wall-base` | The wall under the merlons | about 680×55 | **1360×110**, tileable left to right | PNG with alpha | Text, gates, flags | Under the bricks; the app overlays the "<name>'s wall 7 / 10" label in its middle | Plain masonry; seamless at the left and right edges | As above | `.../siege/wall-base.png` |
| `plaque-title`, `plaque-instruction` | Optional painted frames behind the stage plaques (today drawn in code as navy plates with a cyan line) | stretches with its text | 9-slice PNG, **600×160** with 40 px corners | PNG with alpha | Text; gold or yellow edges | Behind the app's text | Middle area flat and dark enough for white text | Brushed steel or carved wood per game, accent-coloured details | `apps/arcade/assets/art/plaques/plaque-<kind>-<game>.png` |
| `avatar-01` … `avatar-16` | Optional illustrated avatars, only if the owner chooses them over initials | 184 px (Up now), 92 px (Up next), 52 px (phones) | **512×512** | PNG with alpha (or opaque square) | Text, names, rings or frames (the app draws the ring), gold or yellow outlines, real people or celebrities | Clipped to a circle by the app | Head and shoulders inside the central circle of diameter 460 px; nothing important in the corners | 16 distinct, friendly, original cartoon characters of varied ages, skin tones and hairstyles, plain soft backgrounds in different colours, the same style as the posters | `apps/arcade/assets/art/avatars/avatar-01.png` … `avatar-16.png` |

## Wiring a delivered file

1. Put the file in the folder above and log it in [ASSETS.md](../../ASSETS.md) (tool, exact prompt, date, references).
2. Point the slot at it in `apps/arcade/src/shell/art.ts` (`POSTER_IMAGES`, `STAGE_BACKGROUNDS`, `INVADER_SPRITES`, `AVATAR_IMAGES`). Brick and plaque images are specified ahead of the code that will use them.
3. Delete the matching placeholder from `apps/arcade/assets/art/placeholder/` and its ASSETS.md row.
4. Check W1 and W3 at 1920×1080 and 390×844 (`?input=remote` and `?input=touch` in the web preview).

## Prompt template for the image tool

> Original illustration for a home darts game, **no text, no letters, no numbers, no logos,
> no frame**. [Subject from the table.] Style: energetic illustrated arcade art, chunky
> cartoon shapes, bright clean colour, restrained dimensional shading, light from the top
> left. Palette: [palette from the table]. Exactly [delivery size] px, [format]. Keep the main
> subject inside [safe zone]. Do not imitate any existing darts product, character or brand.

Record the prompt you actually used, word for word, in ASSETS.md.
