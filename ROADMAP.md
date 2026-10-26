# AutoDarts Arcade — Roadmap

> **Companion documents:** [ARCHITECTURE.md](ARCHITECTURE.md) (design and evidence) · [RISK-REGISTER.md](RISK-REGISTER.md) (risks R01–R27).
> Phase 0 is complete when these three documents are accepted. Phases 1–6 below are the implementation roadmap. **No code or deployment happens until Phase 1 is approved.**

---

## Phase 0: Research and architecture (this deliverable) ✅

| Deliverable | Where |
|---|---|
| AutoDarts architecture, versions, licensing, integration methods | ARCHITECTURE §4.1–4.4 |
| ludarts / IO-Darts-Agent review (+ the projects that actually matter) | ARCHITECTURE §4.5 |
| Live dart, miss, correction, takeout and reconnection handling | ARCHITECTURE §6 |
| React (Native) / TypeScript architecture with a modular engine | ARCHITECTURE §5, §8 |
| Normalized event schema | ARCHITECTURE §7 |
| Raspberry Pi 4 assessment and rendering placement | ARCHITECTURE §4.6, ADR-001 |
| Six-phase roadmap | this file |
| Wireframes W0–W5 | ARCHITECTURE §10 |
| Technical risk register | RISK-REGISTER.md |

### Owner decisions (answered 2026-10-26)

| # | Question | Answer → consequence |
|---|---|---|
| **Q1** | Which Fire TV Stick? | **Fire TV Stick 4K Max.** Both generations run **Fire OS** (1st gen 2021: Fire OS 7; 2nd gen 2023: Fire OS 8; 2 GB RAM each) ✅[P1]. The stick runs the **same Android build** as phones. The Vega track drops to an optional backlog item (R04, R05) |
| **Q2** | Private use or public store listing? | **Private home use.** No store listings. Fire TV Stick 4K Max and Android: APK sideloaded via ADB ✅[P26]. iPhone and iPad: **TestFlight internal testing** on the owner's paid Apple Developer account |
| **Q3** | Commercial or venue use? | **No.** Owner reports that Autodarts staff permitted private home use via their Discord. *Owner-attested; not independently verified.* Keep a screenshot or link of that permission (R03) |
| **Q4** | GPL app-store exception? | **Not needed for private use.** You are the sole copyright holder, so the GPL doesn't restrict your own installs. Revisit only before accepting outside contributions or publishing (R07) |
| **Q5** | Product name | **Keep "AutoDarts Arcade"** for home use. Revisit only if it's ever published (R08) |
| **Q6** | Upgrade the detection host if the Pi 4 proves unreliable? | **Only after Phase 5, and only if proven.** P1–P5 must work on the current Pi 4. Evidence is collected throughout, and the **H1 hardware review** after P5 decides (see below) |

---

## Dependency overview

```mermaid
flowchart LR
  P0["P0 Research ✅"] --> P1["P1 Hardware truth & foundations"]
  P1 -->|"GATE G1: board streams throws locally"| P2["P2 Event pipeline & reliability"]
  P1 -->|"schema frozen"| P3["P3 Game engine & reference games"]
  P2 --> P4["P4 Arcade shell UI"]
  P3 --> P4
  P4 --> P5["P5 Arcade games, effects & art"]
  P5 --> P6["P6 Companion & home-release hardening"]
  P5 -.->|"H1: hardware review"| HW["Optional detection-host upgrade"]
```

- **P2 and P3 run in parallel** once the event schema (P1) is frozen. P3 develops against the simulator adapter and recorded fixtures, so it doesn't need P2's live adapter.
- **Vega:** not on the critical path, because your 4K Max runs Fire OS. It becomes relevant only if the stick is replaced, since newer sticks run Vega. See the *Backlog* at the end of this file.

| Phase | Depends on | Unblocks | Gate to exit |
|---|---|---|---|
| P1 | P0 accepted (Q1–Q6 answered) | P2, P3 | **G1** go/no-go on the local throw stream |
| P2 | P1 (G1 = go) | P4 | Chaos suite green |
| P3 | P1 (schema) | P4 | Replay-equivalence suite green |
| P4 | P2, P3 | P5 | Full game playable on every device class |
| P5 | P4 | P6, H1 | Performance budgets met on the weakest target |
| H1 | P5 + health data from P2–P5 | optional hardware upgrade | Written upgrade / no-upgrade decision |
| P6 | P5 | home release | Soak test, installed on all your devices |

---

## Phase 1: Hardware truth and foundations

**Goal:** replace every 🔬 in the architecture with facts from *your* board and devices, and stand up the skeleton everything else builds on.

**Status (2026-10-26):**
- **Done:** items 4–6. That covers the monorepo with CI, `event-schema` v1 with tests, and the app skeleton on Expo SDK 56 + `react-native-tvos` ([ADR-003](docs/adr/0003-client-stack-versions.md)).
- **Done early:** the app skeleton also carries the **visual shell** for all of W0–W5, driven by demo darts. This pulls P4's layout work forward; P4 still owns wiring the shell to the engine, profiles and the acceptance criteria.
- **Open:** items 1–3 (board probe, fixtures, Pi baseline: these need your network), item 7 (installing on your devices), and item 8.

**Scope**
1. **Board probe** (`apps/devtools/board-probe`, runs on a laptop, read-only, nothing installed on the Pi):
   - version detection;
   - `GET /api/state` and `WS /api/events` capture;
   - an mDNS browse.
2. **Scripted capture sessions** → `fixtures/`. Each one is a scripted sequence of physical actions with a written expectation. They cover:
   - normal visits and all beds (T, D, S-in, S-out, 25, 50);
   - off-board misses and bounce-outs;
   - a dart that falls out mid-visit;
   - takeout with 0, 1, 2 and 3 darts;
   - a hand in front of the cameras;
   - manual reset;
   - Wi-Fi drop on the display side;
   - board-host reboot;
   - internet unplugged at the board.
3. **Pi 4 health baseline:** CPU, temperature, throttling and per-camera FPS (from `/api/cams/stats` and the Pi's own tools, e.g. `vcgencmd get_throttled`) across a 30-minute session. Also impact → frame latency, filmed at 240 fps against the frame timestamps. This baseline is the reference point for the **H1 review** after P5.
4. **Monorepo:** Yarn workspaces, TS strict, ESLint dependency rules (§5.3), Vitest, and CI (lint, typecheck, unit tests).
5. **`packages/event-schema` v1:** zod types, JSON Schema generation, validation of all fixtures through a *throwaway* normalizer.
6. **App skeleton** (`apps/arcade`, Expo + `react-native-tvos`):
   - builds for iPhone, iPad, Android and the **Fire TV Stick 4K Max** (TV profile);
   - W0 connect screen;
   - a raw "dart ticker" that shows live darts from the board.
7. **Private-install dry run.**
   - *Fire TV:* enable Developer Options → ADB debugging and Apps from Unknown Sources on the 4K Max ✅[P26], then install the APK over the network with `adb`.
   - *iPhone / iPad:* **TestFlight internal testing** on the owner's paid Apple Developer account. Build with EAS or Xcode, upload, and install from the TestFlight app.
   - Write both routes into `docs/install.md`.
8. **Repo housekeeping:** add a `CONTRIBUTING.md` with the code-reuse rule (ARCHITECTURE §4.5), so the private-use licence position stays clean.

**Acceptance criteria**
- [ ] **G1:** a written verdict on whether *your* board's version streams throws on `/api/events`, with the fixture that proves it. **No-go** triggers the contingency below.
- [ ] Every 🟡/🔬 row in ARCHITECTURE §11 is updated to ✅ or ❌ with evidence.
- [ ] ≥ 10 scripted fixtures are committed, each with an expectation file.
- [ ] The app installs (TestFlight on iOS, ADB on Fire TV) and shows live darts on **iPhone, iPad and the Fire TV Stick 4K Max** (plus an Android phone or emulator), with the iOS Local Network prompt handled.
- [ ] Pi 4 baseline report committed (`docs/hardware/pi4-baseline.md`).
- [ ] `docs/install.md` lets you reinstall or update every device without help.
- [ ] The Expo SDK / `react-native-tvos` version is chosen and recorded as an ADR.
- [ ] CI is green on `main`.

**G1 no-go contingency** (the board doesn't stream throws locally), in order of preference:
1. Pin the detection host to the last version that does stream, and turn off auto-update. Feasibility to be confirmed in P1.
2. Ask Autodarts staff, through the same Discord channel that granted private use, how a home integration should read throws on 2.x.
3. **Manual-entry arcade**: everything else in this roadmap still works.

The cloud API stays out unless Autodarts staff explicitly confirm a supported way to use it (R03).

**Tests:** schema validation of fixtures; CI smoke builds for each target; a manual device checklist.

---

## Phase 2: Event pipeline and reliability

**Goal:** a dart stream that never silently loses, duplicates or invents a dart. This answers brief item 3 in code.

**Scope**
- `packages/adapters`:
  - `autodarts-local`: snapshot diff, idempotency, normalization, resync, liveness, stuck-takeout detection;
  - `simulator`: scripted and random, including fault modes;
  - `manual`.
- `packages/platform`:
  - `Transport` with the **endpoint allowlist**;
  - `LogStore` (SQLite on Expo);
  - `Discovery`: mDNS, last-known, manual, probe.
- Session host core: seq assignment, write-ahead persistence, crash-resume, raw-frame ring buffer, diagnostics export.
- **Board-health log** (ARCHITECTURE §9.7), feeding the H1 review. It records per-camera FPS, sampled every 30 s during games, and detection-quality metrics derived from the event log.
- `apps/devtools/fault-proxy`: a laptop-side WebSocket proxy that drops, delays, duplicates and cuts frames between the board and the app.

**Acceptance criteria**
- [ ] **Golden replay:** each P1 fixture produces a byte-identical normalized log, committed as a golden file.
- [ ] **Chaos suite:** 1,000 seeded runs with random disconnects, duplicate frames, missed frames and reconnects at every point in a visit.
  - Final dart set equals the ground truth, **or** the affected turn is flagged `needsReview`.
  - **Zero** silent mismatches.
- [ ] Resync completes ≤ 2 s after the board becomes reachable, measured with the fault proxy.
- [ ] Killing the app mid-turn and relaunching restores the exact state. Resume ≤ 3 s on a Fire OS stick.
- [ ] Allowlist test: any request outside the allowed endpoints fails the build.
- [ ] Idle load on the board ≤ 1 HTTP request per 5 s.

**Tests:**
- Unit tests for the diff and normalization tables, including both miss shapes, both bull shapes and the missing `throws` key.
- Property tests: idempotency, and no duplicate `throwId`.
- Golden fixture tests and the chaos suite.
- On-device reconnect tests (airplane mode, board reboot, iOS background → foreground).

---

## Phase 3: Game engine and reference games

**Goal:** a pure, deterministic engine with a plugin game API, proven on well-known rules before inventing new ones.

**Scope**
- `packages/engine`: fold/replay, turn policy, commands, provisional finish, effect emission for new events only, and an optional snapshot cache.
- `packages/games`:
  - **Countdown** (x01 with in/out options);
  - **Cricket**;
  - **Around the Clock**;
  - one **party prototype** (Siege rules only, no art).
- Headless runner (`devtools`): plays any game from a fixture or script and prints standings.
- A game-authoring guide (`packages/games/README.md`).

**Acceptance criteria**
- [ ] Each game has a rules test suite derived from its `rules.md`, with 100 % branch coverage of `module.ts`.
- [ ] **Replay equivalence** (property test): for any generated session and any dart *k*, throwing a wrong value and then correcting it to *v* ends in the same state as throwing *v* in the first place. The same holds for void and add.
- [ ] **Determinism:** the same log and seed produce identical state, on Node and on device.
- [ ] Refolding a 1,000-dart log takes ≤ 5 ms on a Fire OS stick (release build). If not, the snapshot cache is enabled and re-measured.
- [ ] A new trivial game can be added with one folder and one registry line (checked by a sample PR).

**Tests:** Vitest unit tests, fast-check properties, and fixture-driven game tests using P1 recordings. Engine micro-benchmarks run on device.

---

## Phase 4: Arcade shell UI

**Goal:** the full player journey from W0 to W5, on every device class, with both touch and D-pad.

**Scope**
- Screens W0–W5 (ARCHITECTURE §10). `ui-kit` includes:
  - focus-aware components (`TVFocusGuideView`);
  - the dartboard picker (SVG);
  - theme and player colours (colour-blind-safe palette).
- Correction flow with **dry-run preview**; provisional results; "needs review" badges.
- Player profiles (local), guests, settings (quality tier, house rules, board control opt-in).
- Basic audio through `AudioPort`; keep-awake; Home → pause on TV.
- **Demo mode** (simulator), for development and for trying games without the board.

**Acceptance criteria**
- [ ] A complete Countdown and Cricket session can be played end-to-end:
  - **with D-pad only** on the Fire TV Stick 4K Max;
  - **with touch only** on iPad and on an Android phone;
  - on iPhone.
- [ ] The common corrections (wrong bed, miss ↔ hit, add a bounce-out, void a false dart) take **≤ 5 remote presses** from W3.
- [ ] A correction that changes the winner withdraws the victory screen and resumes play correctly.
- [ ] Amazon's TV test criteria, used as a UX checklist rather than for store submission, pass a self-audit:
  - D-pad navigation everywhere;
  - Back always works;
  - 90 % screen fill;
  - readable from 10 ft;
  - Home shows "Game paused".
- [ ] iOS: denying and then re-granting Local Network permission is handled with clear guidance.
- [ ] Accessibility: player identity is never conveyed by colour alone; text remains legible at the largest phone font scale.

**Tests:**
- Component tests (React Native Testing Library).
- E2E flows driven by the simulator adapter on the iOS simulator, Android emulator and Android TV emulator. The tool is Maestro or Detox, chosen in P1 ⚪.
- A manual acceptance script on the four real devices.

---

## Phase 5: Arcade games, effects and art

**Goal:** the "premium arcade" feel: original party games, celebration effects and sound, within budget on the weakest TV.

**Scope**
- `packages/effects`:
  - effect queue with collapse rules;
  - animation presets (Reanimated, SVG, Lottie);
  - Skia v2 particles on the High tier (not on Vega);
  - quality-tier auto-selection.
- Games: **Siege**, **Territory**, **Balloon Pop** (all original), with stage renderers and their own rules tests.
- **Original asset pipeline:**
  - style guide;
  - an `ASSETS.md` provenance log (author, tool, licence for every file);
  - an originality check against BattleUp's public catalogue;
  - sound design with a licence on file.

**Acceptance criteria**
- [ ] **Fire TV Stick 4K Max, Standard tier:**
  - foreground memory < 300 MB;
  - cold-start TTFF < 2 s;
  - no visible stutter through the victory celebration;
  - no dropped dart events during a 3-dart celebration storm.
- [ ] **iPad:** 60 fps sustained through the victory celebration (Instruments).
- [ ] The Lite tier exists and is selectable, but is only tuned if a 1 GB device is added later.
- [ ] A dart is shown on screen ≤ 150 ms after its frame arrives, on all tiers, even during effects.
- [ ] Every shipped asset has a provenance entry. There are no third-party marks or look-alike game names.

**Tests:** on-device performance runs (release builds) with recorded traces; visual snapshot tests for stage components; rules tests per game.

---

## H1: Hardware review (after Phase 5)

**Purpose:** decide, from evidence, whether the Raspberry Pi 4 detection host should be upgraded. Until this point the Pi 4 is the supported hardware, and nothing in P1–P5 may depend on an upgrade.

**Inputs**
- The P1 baseline.
- The board-health logs from every real session played during P2–P5 (aim for ≥ 10 sessions).
- A repeat of the P1 measurement on the Pi.

**"Proven" means any one of these thresholds is met.** The thresholds are ⚪ proposals, to be calibrated against the P1 baseline and agreed at the end of P1.

| Signal | Threshold | Source |
|---|---|---|
| **Missed on-board darts**: auto-padded misses the user corrected to a scoring segment, plus darts the user added by hand (`DartAdded` from `source.kind: 'manual'`), ÷ all darts. Bounce-outs are excluded because no hardware detects them | > 5 % across ≥ 10 sessions | event log |
| **Misread darts**: `DartCorrected{reason:'user'}` on detected darts ÷ detected darts | > 5 % across ≥ 10 sessions | event log |
| Camera FPS | any camera below 10 fps for > 10 % of game time | board-health log |
| Thermal throttling during play | any throttling flag in the repeat measurement | `vcgencmd get_throttled` |
| Detection latency (impact → frame) | median > 1 s | P1 method, repeated |

The causes of a breach matter:
- **If only the correction thresholds are breached**, first rule out calibration, lighting and camera placement. These are free fixes and not a Pi problem.
- **If the hardware thresholds are breached**, recommend a Pi 5 or mini PC. The app needs no change, because it only needs `IP:3180`.

**Output:** `docs/hardware/h1-review.md`, with the numbers, the decision and, if upgrading, a re-run of the P1 golden fixtures on the new host.

---

## Phase 6: Companion and home-release hardening

**Goal:** add the phone companion and make the app robust enough for a 4-hour party at home.

**Scope**
- **Phone companion** (optional): a LAN server in the host app (4K Max or iPad), QR pairing with a one-time token, and commands for name entry, corrections and operator actions.
- **Soak and resilience:** 4-hour simulated sessions with periodic board and Wi-Fi drops.
- **Home release:** final private builds on every household device. TestFlight builds expire after 90 days 🟡[P27], so a fresh build is uploaded at least every 90 days. EAS Build + Submit can automate this ⚪.
- User documentation: setup, troubleshooting, and the "your board updated and something broke" playbook.

**Acceptance criteria**
- [ ] 4-hour soak on the 4K Max: no crash, memory growth < 10 %, and no unflagged dart discrepancy against the simulator's ground truth.
- [ ] Companion: pairing in under 30 s, and a correction from the phone shows on the TV in under 500 ms on the same LAN.
- [ ] Every household device has the release build installed and updatable from `docs/install.md`.
- [ ] Runbook: re-running the P1 probe and the golden fixtures against a new Autodarts version takes under 30 minutes.

---

## Backlog (not scheduled)

| Item | Trigger |
|---|---|
| **Vega OS shell** (`apps/vega`): React Native for Vega reusing the pure-TS packages (ARCHITECTURE §5.2). Note that Vega blocks consumer sideloading 🟡[P11], so even private installs would go through Amazon's Appstore tooling ⚪ | The 4K Max is replaced by a Vega-based stick |
| Public store release (GPL exception, product name, App Review demo mode, store listings) | A decision to publish, with Autodarts' agreement |
| Apple TV (tvOS) build | Wanted; `react-native-tvos` makes it cheap |

---

## Testing strategy (all phases)

| Layer | What | Tooling | Runs |
|---|---|---|---|
| Schema | Every event and fixture validates; schema changes are versioned | zod, JSON Schema | CI |
| Unit | Normalizer tables, diff algorithm, turn policy, game rules | Vitest | CI |
| Property | Replay equivalence, determinism, adapter idempotency, no duplicate IDs | fast-check | CI |
| Golden / contract | Recorded **real-board** fixtures → normalized logs; re-run per Autodarts version | Vitest + `fixtures/` | CI + on board update |
| Chaos | Disconnect, duplicate, drop and delay at every visit point | simulator + fault-proxy | CI (simulated), weekly (real board) |
| Component | Screens and focus order | RN Testing Library | CI |
| E2E | Scripted journeys W0→W5 on simulator / emulators incl. Android TV | Maestro or Detox (P1 pick) ⚪ | CI nightly |
| Device | Manual acceptance on iPhone, iPad, Fire TV Stick 4K Max (+ an Android phone or emulator) | checklists in `docs/qa/` | each phase exit |
| Performance | TTFF, memory, fluidity, frame→pixel latency | Xcode Instruments, Android profiler / Perfetto, Amazon KPI tooling | P4–P6 exits |
| Soak | 4-hour sessions | simulator on device | P6 |

**Board-version watch:** Autodarts auto-updates (R01). Whenever the board's `/api/version` changes, the app shows a one-time "Board updated: run the check?" prompt. The `devtools` probe re-runs the golden fixtures in under 30 minutes.
