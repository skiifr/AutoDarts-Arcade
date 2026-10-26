# fake-board

A simulated Autodarts 2.x board for developing Arcade without a board or a Pi. It serves
the read endpoints Arcade uses on its own port (default 3180), driven by the board model
in `packages/adapters/src/simulator/board-model.ts`, so the frames have the community-
documented shapes (ARCHITECTURE §4.3, 🟡):

| Route | Answer |
|---|---|
| `GET /api/state` | current state; `throws` omitted on an empty board, as on 2.x |
| `GET /api/version` | plain text, `2.0.2` by default |
| `GET /api/state/stats`, `GET /api/cams/stats` | `{"fps": …}`, `{"fps": [ … ]}` |
| `WS /api/events` (also `?type=state`) | `state` frames; `motion_state` too unless `?type=state` |
| `OPTIONS` on the four GET routes | 204, a CORS preflight answer that allows GET only |
| anything else | 404 (405 for non-GET), and logged |

It never implements `/api/reset`, `/api/config` or `/api/system`; a request for one shows
up in the log.

The four GET routes send permissive CORS headers (`Access-Control-Allow-Origin: *`), so the
browser preview of the app (`yarn web`, http://localhost:8081) can read the fake board from
another origin. A real board probably sends none, so the browser preview can't reach a real
board. Use a native build for that (see `apps/arcade/README.md`).

## Run

Node 22 or newer, on Windows, macOS or Linux, from the repository root:

```sh
yarn fake-board --port 3180 --scenario random-play
yarn fake-board --list            # scenarios
```

Options: `--port`, `--host` (default `0.0.0.0`, so a phone or Fire TV on the LAN can reach
it), `--scenario`, `--seed`, `--version`. Point the app at this computer's LAN address.

Scenarios: `idle`, `random-play`, `two-visits`, `bulls-and-misses`, `stuck-takeout`,
`corrections`, `bounce-outs`.

## Keys

| Key | Action |
|---|---|
| `t` | throw a random dart |
| `b` | bounce-out (not detected) |
| `p` / `w` / `c` | phantom dart / withdraw the last detection / board re-reads a dart |
| `o` | takeout (finishes after 1 s) |
| `h` | hand in front of the cameras (empty takeout) |
| `s` | stuck takeout (2.0.2 bug; ends with `r`) |
| `r` | manual reset |
| `d` | drop every event socket |
| `x` | take the board off / back on the network |
| `?` / `q` | help / quit |

The tool runs the workspace TypeScript directly with Node's `--experimental-strip-types`;
`register.mjs` adds the module hooks that resolve extensionless imports.
