# fault-proxy

An HTTP + WebSocket proxy between Arcade and a board (real, or `yarn fake-board`) that
injects faults into the board's event stream. It forwards **only** the allowlisted reads
(`GET /api/state`, `/api/version`, `/api/state/stats`, `/api/cams/stats` and
`WS /api/events[?type=state]`) and answers everything else with 403, logged as `BLOCKED`,
so it doubles as a check that a build never asks for a forbidden route.

## Run

Node 22 or newer, on Windows, macOS or Linux, from the repository root:

```sh
yarn fault-proxy --target 127.0.0.1:3180 --listen 3181 --drop 0.1 --dup 0.05 --delay 200 --cut-every 30
```

Then point the app at this computer's address and port 3181.

| Option | Effect on board → app frames |
|---|---|
| `--drop p` | lose a frame with probability p |
| `--dup p` | send a frame twice with probability p |
| `--delay ms` | add latency to every frame (order kept) |
| `--jitter ms` | add 0..ms random latency (order kept) |
| `--reorder p` | hold a frame back past later ones with probability p |
| `--cut-every n` | close the app's socket after every n frames |
| `--seed s` | make the faults reproducible |

Keys: `c` cut every socket now, `o` outage on/off (the board vanishes: requests and sockets
are refused), `s` stats, `?` help, `q` quit.

Use it for the Phase 2 acceptance checks on a device: resync ≤ 2 s after `o` is switched
off, and no dart lost or duplicated without a "needs review" flag.
