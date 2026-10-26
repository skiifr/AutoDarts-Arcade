# Community-sourced board fixtures

**None of these files come from the owner's board.** They are built from community
material about the Autodarts local API (🟡 in ARCHITECTURE §4.3) and are a stand-in until
the Phase 1 probe records the owner's board into `fixtures/`. When the real recordings
arrive, they replace these as the golden reference.

Each `.jsonl` line is one `WS /api/events` frame, exactly as a client receives it. The
golden test (`packages/adapters/src/fixtures.test.ts`) replays every file through the
`autodarts-local` adapter against an empty board and compares the normalized
`BoardFactDraft` output with the `*.golden.json` file next to it. Run
`yarn vitest run -u packages/adapters/src/fixtures.test.ts` to accept a deliberate change.

| File | Source | What it covers |
|---|---|---|
| `architecture-4.3-visit.jsonl` | The four frames in ARCHITECTURE §4.3. Darts 2 and 3 are elided there (`[…3…]`) and are filled with S5 and D20 here. | One visit, takeout, `throws` key omitted on the empty board |
| `homedarts-2.0.2-ws-frames.jsonl` | Copied unchanged from HomeDarts (MIT), `tests/fixtures/board_manager/2.0.2/ws-frames.jsonl`, commit `2ff923f` (2026-10-26). HomeDarts built it from the shapes its integration was developed against; it is not a capture. | Inner bull `{"name":"Bull","bed":"Double"}`, `cam_state`/`motion_state`/`stats`/`cam_stats` frames, `throws: []`, 2.0.2's stuck takeout (`Takeout started` with 0 darts) and `Manual reset` |
| `dartlab-2.0.2-shapes.jsonl` | Re-authored by us from the facts DartLab's protocol notes report for a real 2.0.2 capture: two visits T20 T20 T5 and S12 M12 S20, a miss as `{"bed":"Outside","multiplier":0,"name":"M12","number":12}`, `SingleInner`/`SingleOuter`, alphabetical keys, `bouncer: false`, `throws` omitted after a takeout. DartLab has no licence, so no data was copied; coordinates are ours. | The real 2.0.2 frame shape |
| `community-misses-and-bulls.jsonl` | Synthesized from the shapes in §4.3 and §7.3 (HomeDarts' doubles: bare `{"name":"M","number":0,"multiplier":0}`, outer bull `{"name":"25","bed":"Single"}`; cloud types: `DoubleBull`). | Both miss shapes, `Miss`, both inner-bull beds, the outer bull, a dart without coordinates, both empty-board forms |
| `community-anomalies.jsonl` | Synthesized. | An unreadable segment (miss pending review), an unknown bed, `bouncer: true`, a board re-read, an unknown status, a malformed state and a non-state frame |

## Notice for the HomeDarts file

`homedarts-2.0.2-ws-frames.jsonl` (and the version pattern in
`packages/adapters/src/autodarts-local/status.ts`) come from HomeDarts for Autodarts,
https://github.com/Dennis-Otto/homedarts-for-autodarts, under this licence:

```
MIT License

Copyright (c) 2026 Trkal and HACSAutodarts contributors
Copyright (c) 2026 Dennis Otto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
