# AutoDarts Arcade — Architecture (Phase 0)

> **Status:** Phase 0 deliverable. This is research and architecture only, and no application code exists yet.
> **Research date:** 2026-10-26. Autodarts changed substantially in 2026, so re-check anything marked 🟡 or ⚪ before relying on it.
> **Confirmed scope (owner, 2026-10-26):**
> - **Private home use**, non-commercial. The owner reports that Autodarts staff permitted this via their Discord.
> - TV target: **Fire TV Stick 4K Max (Fire OS)**.
> - Distribution with no public store listings: **TestFlight** for iPhone and iPad (paid Apple Developer account); ADB sideload for Fire TV and Android.
> - Detection host: the current **Raspberry Pi 4 through Phase 5**. An upgrade is considered only if the post-P5 **H1 hardware review** proves it's needed.
> - See [ROADMAP Q1–Q6](ROADMAP.md#owner-decisions-answered-2026-10-26).
> **Companion documents:** [ROADMAP.md](ROADMAP.md) · [RISK-REGISTER.md](RISK-REGISTER.md)

### Evidence legend

Every factual claim carries one of these marks. Bracketed IDs refer to [§12 Sources](#12-sources).

| Mark | Meaning |
|---|---|
| ✅ **Verified** | Read in an official or primary source, or in source code. |
| 🟡 **Community** | Reported by a third-party project, forum or fixture. Autodarts has not confirmed it. |
| ⚪ **Assumption** | Our own inference or design target, not yet proven. |
| 🔬 **Probe** | Can only be confirmed on *your* board or devices. Phase 1 checks these. |

---

## Contents

1. [Summary and key decisions](#1-summary-and-key-decisions)
2. [Review of the Phase 0 brief](#2-review-of-the-phase-0-brief)
3. [Requirements and target devices](#3-requirements-and-target-devices)
4. [Research findings](#4-research-findings)
5. [System architecture](#5-system-architecture)
6. [Source adapters and event reliability](#6-source-adapters-and-event-reliability)
7. [Normalized event schema](#7-normalized-event-schema-arcadeeventv1)
8. [Game engine](#8-game-engine)
9. [Presentation, performance and platform integration](#9-presentation-performance-and-platform-integration)
10. [Wireframes](#10-wireframes)
11. [Verified vs assumed: ledger](#11-verified-vs-assumed-ledger)
12. [Sources](#12-sources)

---

## 1. Summary and key decisions

**The approach in one sentence:** a React Native + TypeScript app runs on the display device (iPad, iPhone, Android or Fire TV). It reads darts straight from the Autodarts board's local network API, runs every game in a pure-TypeScript, event-sourced engine, and leaves the Raspberry Pi 4 doing nothing but detection.

| # | Decision | Why |
|---|---|---|
| D1 | **The client is React Native + TypeScript.** Expo + `react-native-tvos` builds one app for iOS, iPadOS, Android and Fire OS, which includes **your Fire TV Stick 4K Max**. | It meets the "native app on iPhone, iPad, Android and Fire Stick" requirement and keeps the brief's React/TS direction. It also leaves the door open to Vega-OS sticks: React Native is the only mainstream stack that reaches Vega ✅[P5][P10]. That is a backlog item, not needed for the 4K Max. |
| D2 | **Rendering runs on the display device, never on the Pi 4.** | Autodarts' own FAQ says a Pi 4 with a monitor is "not recommended" and "could function on the bleeding edge" ✅[S4]. |
| D3 | **We integrate through the local board API only, read-only, with no new services.** The app talks to `ws://<board>:3180/api/events` and `GET /api/state` directly. | The cloud API is off-limits: the ToS bans unauthorised third-party software ✅[S3], and Autodarts reportedly issues no third-party client IDs 🟡[C13]. Nothing gets deployed on the Pi, which matches the brief's "do not deploy services". |
| D4 | **The engine is event-sourced.** Game state is a pure fold over an append-only log, and corrections are new events that trigger a replay. | It makes corrections, crash recovery, reconnection and testing one mechanism instead of four. |
| D5 | **The host device is the single writer.** | The device showing the game owns the log. Phones send *commands*, which removes multi-device conflicts. |
| D6 | **Phase 1 opens with a go/no-go hardware probe.** | Whether Autodarts **2.x** still streams throws locally is *disputed* (🟡[C3][C2] say yes, 🟡[C4] says no). Everything else depends on it. |
| D7 | **Private home use, installed directly.** APK sideload onto the 4K Max and Android; TestFlight on iOS. No store listings. | Owner decision. The GPL, app-name and App Review concerns only apply to public store releases ✅[P21][P24]. Commercial use stays out of scope ✅[S3]. |

---

## 2. Review of the Phase 0 brief

The ChatGPT brief is a sound starting structure: research first, a modular engine, an event schema, risk-first planning. However, it was written without current information and it conflicts with your native-app requirement.

| Brief says | Finding | What we changed |
|---|---|---|
| "Inspect **ludarts** and **IO-Darts-Agent**" | **"ludarts" does not exist.** We searched GitHub, npm, PyPI, Docker Hub and GitLab. It probably means *lidarts*, an unrelated AGPL web scorer ✅[C7]. **IO-Darts-Agent exists** ✅[C6]. It is cloud-based, ~0 stars, and *PolyForm Noncommercial* licensed (its `module-sdk/` is MIT). | We reviewed both, plus the projects that actually matter: HomeDarts, dartcade, DartLab, ioBroker, Chade's client and darts-caller (§4.5). |
| "Preserve existing AutoDarts detection" (assumes a stable API) | **Autodarts 2.x shipped in Sept 2026.** It removed the port-3180 Board Manager UI ("not supported from version 2 on") ✅[S1], moved to `autodarts.com`, retired the Keycloak login, and auto-updates ✅[S7]. | The adapter layer is isolated, version-detected and contract-tested. The Phase 1 probe is a gate. |
| "Prioritize … performance on Raspberry Pi 4" | The Pi 4 is already at the edge just running detection ✅[S4]. A community report describes a Pi 4 with 3 cameras freezing at 0 FPS 🟡[C14]. | The Pi 4 does **detection only**. Rendering moves to the display device. |
| "React/TypeScript frontend" | A web frontend can't be a native app on iPhone, iPad or Fire TV without a wrapper. App Store rule 4.2 rejects repackaged websites ✅[P21]. | **React Native** + TypeScript, which is still React. |
| "Fire Stick" (implicit) | There are now **two Fire TV operating systems**. Fire OS (Android-based) runs on the 4K Max (both generations), 4K 2nd gen, 4K Plus, HD 2024 and Lite. **Vega OS** (Linux-based, *cannot run Android apps*) runs on the 4K Select 2025, HD 2026 and 4K 3rd gen 2026 ✅[P1]. Amazon says all future sticks will run Vega 🟡[P11]. | **Resolved:** your 4K Max runs Fire OS, so it runs the shared Android build. Vega is a backlog item (§3.3). |
| "Inspired by BattleUp's commercial entertainment" / "premium" | Autodarts' ToS restricts the Play Services to *private, non-commercial* use. It bans commercial use by third parties through external software "not … expressly authorized in writing by Autodarts" ✅[S3 §3.2, §6.1]. | **Resolved:** private home use, with staff permission reported by the owner (§4.4). Original names and art remain a project principle (R23). |
| Not mentioned | Our own repo is **GPL-3.0**, which conflicts with App Store distribution. "AutoDarts" in an app name breaks Apple 4.1(c)/5.2.1. App Review needs a demo mode for hardware apps ✅[P21]. TV apps need D-pad-only UX ✅[P8]. Two local endpoints return the board's API key and TLS key 🟡[C2]. | Store-related items are **not applicable to private installs** (R07, R08, R19 lowered). D-pad UX and secret handling still apply. |

---

## 3. Requirements and target devices

### 3.1 Functional requirements (from the brief, kept)

- Animated multiplayer games, player selection, scoring, game effects and sound.
- Reliable handling of live darts, misses, manual corrections, takeouts and reconnections.
- A modular game engine, so new games plug in without touching the core.
- Original visual assets and game designs.
- No modification of Autodarts, and no service deployment.

### 3.2 Non-functional requirements (added)

| ID | Requirement | Target ⚪ (Phase 1 refines these) |
|---|---|---|
| NF1 | **Native installable app** on iPhone, iPad, Android and Fire TV | the hard requirement |
| NF2 | Dart on screen after the board reports it | ≤ 150 ms from WebSocket frame to first visual |
| NF3 | Never lose or duplicate a dart without telling the user | 0 silent losses or duplicates in the chaos suite |
| NF4 | Recover after app crash or kill mid-game | exact state restored, resume ≤ 3 s |
| NF5 | Re-attach after board or Wi-Fi drop | resync ≤ 2 s after the board is reachable |
| NF6 | TV performance | meet Amazon KPIs: Fire OS foreground memory < 300 MB, cold start TTFF < 2 s ✅[P7]; Vega < 400 MiB, TTFF < 1.5 s, fluidity > 99 % ✅[P6] |
| NF7 | TV usability | D-pad only, Back always works, readable at 10 ft, 90 % screen fill, Home → "Game paused" ✅[P8] |
| NF8 | Zero added load on the Pi | read-only API calls; ≤ 1 idle poll / 5 s |

### 3.3 Target device matrix

| Target | OS | Build | Input | Typical role | Phase |
|---|---|---|---|---|---|
| iPhone | iOS | Expo app (universal) | touch | companion remote / small display | P1 |
| iPad | iPadOS | same binary | touch | **primary display** | P1 |
| Android phone or tablet | Android 7+ (API 24) ✅[P12] | Expo app, mobile profile | touch | display / companion | P1 |
| **Fire TV Stick 4K Max (your TV target)**: 1st gen 2021 = Fire OS 7, 2nd gen 2023 = Fire OS 8; 2 GB RAM, GE9215 GPU | API 28 / 30 ✅[P1][P2] | same code, **TV build profile** (`EXPO_TV=1`), sideloaded via ADB ✅[P26] | D-pad remote | **primary display** | P1 |
| Other Fire OS sticks (4K 2nd gen, 4K Plus 2025, HD 2024, Lite 2020, 3rd gen 2020) | API 28 / 30 ✅[P1] | same build | D-pad remote | display | supported, not tested |
| Fire TV, **Vega OS** (4K Select 2025, HD 2026, 4K 3rd gen 2026) | Vega OS 1.1 / 2.0 ✅[P1] | separate **React Native for Vega** shell over the shared packages | D-pad remote | display | **backlog**: only if the stick is replaced |
| Apple TV (optional) | tvOS | `react-native-tvos` makes it nearly free ✅[P12] | Siri remote | display | backlog |

**Performance target:** the **4K Max (2 GB)** is the weakest device in your household, so the TV visual budgets are set against it (the *Standard* tier, §9.2). The *Lite* tier for 1 GB sticks stays in the design, but is only tuned if such a device is added ✅[P1].

---

## 4. Research findings

### 4.1 Autodarts today

```
 Cameras (2–4, USB) ──▶ Detection host (your Pi 4)                    Autodarts cloud (autodarts.com)
                        ├─ v1: "Board Manager" + web UI :3180   ◀──▶  play / API / auth / AI-ref
                        └─ v2: headless board core (+ CLI),           (internet required to start) ✅[S4]
                               local API still on :3180 🟡
                               mDNS _autodarts-board._tcp 🟡[C15]
```

**Platform**
- Closed source. Binaries come only from `releases.autodarts.com` ✅[S6].
- Autodarts is now owned by Nodor (Winmau and Red Dragon) 🟡. It relaunched in Sept 2026 alongside the Winmau "Autodarts X" hardware and phone-camera "Lens" scoring ✅[S10][S11].

**Versions**

| Line | What changed | Evidence |
|---|---|---|
| 0.x / 1.x (legacy) | Browser **Board Manager at `:3180`**. Root systemd unit. Board ID + API key. Keycloak login | ✅[S1] 🟡[C2] |
| **2.0.0 → 2.0.2 stable**, 2.1.0-beta.5 | Board Manager UI removed. Autodarts Desktop or headless + `autodarts` CLI. **User** systemd unit. QR/short-code pairing. Velopack auto-update | ✅[S1][S6][S7] |
| June 2026 | Keycloak retired. OAuth 2.0 (PKCE / device flow). `grant_type=password` ended | 🟡[C9] |
| 2.0.2 bug | A takeout can stick at "Takeout in progress" with `numThrows: 0`. Darts are not counted until the board is reset | 🟡[C12] |

**Builds**
- Headless 2.0.2 is published for linux-arm64 and **linux-armv7l**, so the Pi 4 is still a published target ✅[S6].

**Tiers**
- Free and Plus (£5.99 / €6.99 per month) ✅[S9]. **No tier offers an API.**

**Reliability facts**
- Internet is required even for local play ✅[S4].
- v2 reportedly starts detection only after reaching the server 🟡.
- The auth service showed 98.89 % uptime for Jul–Oct 2026 ✅[S8].

### 4.2 Integration methods

| Method | Status | Verdict |
|---|---|---|
| **Local board API** (`ws://:3180/api/events`, `GET /api/state`) | Undocumented. "Board Manager … not supported from version 2" ✅[S1]. Still used on 2.0.2 by HomeDarts and DartLab 🟡[C2][C3]. ioBroker says 2.x **no longer returns throws** 🟡[C4] | **Chosen.** Gated by the 🔬 Phase 1 probe |
| Cloud WebSocket (`play.ws.autodarts.com`) | Reverse-engineered. Works only by impersonating the first-party `autodarts-play` client with a password login 🟡[C6][C4] | **Rejected:** violates the spirit of ToS §3.2(5) ✅[S3], needs internet, and no third-party client IDs exist 🟡[C13] |
| Browser extensions / DOM hooks | Hooks the web app's socket in a desktop browser 🟡[C9] | Not applicable to native apps |
| darts-caller relay (`:8079`) | Depends on darts-caller's cloud login 🟡[C8] | Rejected, same reasons as cloud |
| **Manual entry + simulator** | Ours | **Required:** fallback, development, and App Review demo mode |

### 4.3 Local API reference (as far as known)

**Endpoints**

| Endpoint | Use in Arcade | Evidence |
|---|---|---|
| `WS /api/events` | **Yes.** Primary stream. An optional `?type=state` query asks for `state` frames only 🔬 | 🟡[C1][C2][C10] |
| `GET /api/state` | **Yes.** Snapshot on connect, idle liveness poll | 🟡[C2][C4] |
| `GET /api/version` | Yes, to pick the adapter profile | 🟡[C2] |
| `GET /api/state/stats`, `/api/cams/stats` | Optional, for health (FPS, CPU) | 🟡[C2] |
| `GET /api/config`, `GET /api/system` | **Forbidden.** They return the board **API key** and **TLS key** | 🟡[C2] |
| `WS /api/events/system` | **Forbidden.** Not needed, and what it carries is unchecked | ⚪ |
| Anything that writes: reset, start/stop, calibration, restart, upstream connect, `PATCH /api/config` | **Forbidden.** **The app never writes to the board** (owner decision S). A stuck takeout is reset from Autodarts' own app (§6.3) | 🟡[C2] |

**Frame envelope:** `{"type": "state" | "cam_state" | "motion_state" | "stats" | "cam_stats", "data": {…}}` 🟡[C1][C2].

**`state` frames during one visit.** These are reconstructed from a fixture and cross-checked with a real 2.0.2 capture 🟡[C2][C3]:

```json
{"type":"state","data":{"connected":true,"running":true,"status":"Throw","event":"Throw detected","numThrows":1,
  "throws":[{"segment":{"name":"T20","number":20,"bed":"Triple","multiplier":3},"coords":{"x":0.0021,"y":0.6138}}]}}
{"type":"state","data":{"connected":true,"running":true,"status":"Takeout","event":"Throw detected","numThrows":3,"throws":[…3…]}}
{"type":"state","data":{"connected":true,"running":true,"status":"Takeout in progress","event":"Takeout started","numThrows":3,"throws":[…]}}
{"type":"state","data":{"connected":true,"running":true,"status":"Throw","event":"Takeout finished","numThrows":0}}
```

**Enumerations** 🟡[C1]
- `status`: `Stopped`, `Starting`, `Throw`, `Takeout`, `Takeout in progress`. Some integrations also report `calibrating` and `error`.
- `event`: `Stopped`, `Stopping`, `Starting`, `Started`, `Throw detected`, `Takeout started`, `Takeout finished`, `Manual reset`. Also `Calibration started` and `Calibration finished`.

**Quirks** (all 🟡 until 🔬)

| Quirk | Source |
|---|---|
| **No throw IDs and no sequence numbers.** `throws` is a snapshot of the current visit | [C3] |
| `throws` is **omitted entirely** on an empty board (v2) | [C3] |
| `numThrows` caps at 3. Status flips to `Takeout` on the 3rd dart | [C3] |
| **Misses come in two shapes:** `{"name":"M12","bed":"Outside","multiplier":0,"number":12}` (real 2.0.2 capture), and `{"name":"M","number":0,"multiplier":0}` | [C3][C2] |
| **Inner bull:** `{"name":"Bull","number":25,"bed":"Double","multiplier":2}`. Cloud types also use `DoubleBull` | [C2][C6] |
| `coords` are bull-centred, with r = 1.0 at the outer double wire. Values up to ~3.0 occur off-board. Bounce-outs may carry no coords | [C3][C5] |
| A `bouncer` field exists, but `true` has never been observed | [C3] |
| The socket is **silent when nothing changes**. There is no heartbeat | [C3] |
| The board can **withdraw** a detection outside a takeout | [C2] |
| `connected` is unreliable | [C5] |
| Corrections made in the Autodarts web UI go to the *cloud* match API. **No evidence they appear locally** | ⚪ |

### 4.4 Licensing and terms

**Autodarts ToS** ✅[S3]

| Clause | What it says |
|---|---|
| §3.2 | Play Services are for "private, non-commercial purposes". Bans "automated or indirect use through third-party software", "extracting data … through … automated methods", and "unauthorized connections, servers, emulators, or third-party software to operate, access, modify, or interfere". |
| §3.6 | Bans reverse engineering beyond what German law allows. |
| §6.1 | Bans commercial third-party use "not … expressly authorized in writing by Autodarts". |

⚪ *Interpretation, not legal advice:*
- Reading your own board's LAN API for private play is the least exposed use. Every community integration above relies on it.
- Using the cloud, any commercial or venue use, or a public store listing increases exposure.
- Get written authorization before any of those.

**Owner-attested permission (2026-10-26).** The owner reports that Autodarts staff, via the Autodarts Discord, permitted private home use of a third-party frontend.
- We have not seen this statement, so it is recorded as **owner-attested**.
- Keep a screenshot or message link with the project's private notes, because Discord messages aren't durable.
- The architecture already fits that permission: local network, read-only, non-commercial, no cloud and no Autodarts credentials.

**Our repo is GPL-3.0.** FSF and Apple terms conflict. VLC was pulled from the App Store in 2011 ✅[P24].
- **For private installs this doesn't matter.** As the sole copyright holder you aren't bound by your own licence.
- If the project ever takes outside contributions or goes to a store, add a GPLv3 §7 "app-store exception" first, as Signal did ✅[P25], or dual-license. Amazon's agreement has related clauses ✅[P22].

**Name.** Apple 4.1(c) and 5.2.1 ban third-party brand names in app names ✅[P21]. This is irrelevant for private installs; it only matters if the app is ever published.

### 4.5 Community projects

| Project | Licence | Data source | Relevance |
|---|---|---|---|
| **IO-Darts-Agent** [C6] | PolyForm **Noncommercial** (`module-sdk/` MIT) ✅ | Cloud v2 (password login) | Protocol reference only. **Code not reusable** |
| "ludarts" | **Not found** | — | Probably lidarts [C7]: AGPL, standalone web scorer, no Autodarts link |
| **HomeDarts** [C2] (Home Assistant) | **MIT** ✅ | Local `:3180`, mDNS, BM 2.0.2 | **Best protocol reference.** Nine local party games, up to 8 players |
| **dartcade** [C5] | AGPL-3.0 | Local `:3180` via a Go bridge | **Closest design** (web, X01 / Around-the-Clock, snapshot-diff events). Ideas only, no code (AGPL + App Store) |
| **DartLab** [C3] | not checked | Local, real 2.0.2 capture | Best real-capture protocol notes (Flutter app) |
| ioBroker.autodarts [C4] | MIT ✅ | Local polling (v1), cloud (v2) | Source of the "2.x has no local throws" claim |
| Chade/AutodartsClient [C1] | GPL-3.0 | Local WS | Status/event enumerations |
| darts-caller [C8] | **No licence** (all rights reserved) | Cloud | v1 protocol reference. Successor is closed source |
| Tools for Autodarts [C9] | CC BY-NC 4.0 | Hooks the web app's socket | v2 match schema reference |
| autodarts-board (npm) [C10] | MIT | Local WS | Small reusable TS client (MIT) |
| Autodarts-TV [C11] | MIT | WebView around play.autodarts.com | Android TV precedent |

**Rule for this repo:** learn freely from protocols and ideas. **Copy code only from MIT/BSD/Apache sources, with notices.** Never copy code from NC, AGPL or unlicensed repos.

### 4.6 Raspberry Pi 4 assessment

| Evidence | Mark |
|---|---|
| Pi 4 "not recommended … with a monitor". Even overclocked with active cooling it "could function on the bleeding edge". Pi 5 is "tested and working" | ✅[S4] |
| The basic tier is the Board Manager **only**: "no Monitor, no Extensions" | ✅[S5] |
| Pi 4 with 3 cameras: a camera dropped to 0 FPS and froze. At 10 FPS it sometimes saw only 2 of 3 darts | 🟡[C14] |
| No published latency or CPU figures for v2 on a Pi 4 | gap → 🔬 |

**Conclusion.** Rendering **must** run on a separate device. Running even a "light" bridge service on the Pi 4 competes with detection, so we don't.

Practical Pi hygiene, all outside our scope:
- Run headless with active cooling.
- Use 800×600 camera resolution, which is "absolutely fine" ✅[S4].
- Watch temperature and per-camera FPS.

**Owner decision: the Pi 4 stays through Phase 5.** The software must therefore cope with it:
- zero added load;
- correction-first UX;
- recovery from missed darts.

A per-session **board-health log** (§9.7) feeds the **H1 hardware review** after P5 (ROADMAP). Only if H1 proves the need is the Pi replaced with a Pi 5 or mini PC. That is a drop-in change, because the app only needs `IP:3180`.

### 4.7 Native platform landscape

**Framework reach** ✅ unless marked

| Framework | iOS / iPadOS | Android | Fire OS | Vega | Notes |
|---|---|---|---|---|---|
| **React Native** (Expo + react-native-tvos) | ✅ | ✅ | ✅ | via **RN for Vega** | Amazon recommends Expo for new Fire TV apps [P14]. Amazon documents shared-code workspaces across TV OSes [P10] |
| Flutter | ✅ | ✅ | ✅ | ❌ | Vega supports only RN and web [P5] |
| Capacitor / WebView | ✅ (rule 4.2 risk) | ✅ | ✅ | WebView-in-RN only | Weak on 1 GB sticks 🟡 |
| Unity / Godot | ✅ | ✅ | ✅ | ❌ | Not TypeScript. Unity + GPL is awkward ⚪ |

**React Native toolchain**
- **react-native-tvos 0.88.0-0** (2026-10-17): New Architecture, Hermes, iOS 15.1+, Android API 24+ ✅[P12].
- **Expo's TV guide** documents **SDK 56 ↔ `react-native-tvos@0.85-stable`**. It lists Reanimated, Audio, Skia, SQLite, SVG and React Navigation as working on TV ✅[P13].

**React Native for Vega**
- The **SDK 0.24** runtime is supplied by the OS. RN 0.72 is stable and **RN 0.83 is early access** ✅[P3].
- System libraries: **Reanimated 4.1.3, react-native-svg 15.11.1, lottie-react-native 6.0.0-rc.1, AsyncStorage** ✅[P4].
- **Not available on Vega:** Skia, Rive, mDNS ✅[P4].

**Rendering libraries across targets**

| Library | iOS / Android | Fire OS | Vega | Use |
|---|---|---|---|---|
| Reanimated 4 | ✅ | ✅[P13] | ✅[P4] | **Baseline** |
| react-native-svg | ✅ | ✅[P13] | ✅[P4] | **Baseline** (board picker, vector art) |
| Lottie | ✅ | ⚪ | ✅[P4] | **Baseline** (celebrations) |
| Skia | v3 ✅ | **v2 only** (v3: "Android TV is not supported") ✅[P15] | ❌ | Optional enhancement tier |
| Rive | ✅ | ⚪ | ❌ | Not used |

Reanimated's own guidance is no more than ~100 animated components on low-end Android ✅[P16].

---

## 5. System architecture

### 5.1 Topology (ADR-001: direct LAN, no services on the Pi)

```
┌───────────────── Your LAN ──────────────────────────────────────────────────────────────┐
│                                                                                         │
│  ┌──────────────────────┐    ws://pi:3180/api/events (read-only)                         │
│  │ Raspberry Pi 4       │◀────────────────────────────────┐                              │
│  │ Autodarts 2.x board  │    GET /api/state, /api/version  │                              │
│  │ (UNMODIFIED)         │                                  │                              │
│  └──────────┬───────────┘                                  │                              │
│             │ internet (Autodarts' own needs)  ┌───────────┴────────────────────────────┐ │
│             ▼                                  │ HOST APP (TV or iPad)                  │ │
│        Autodarts cloud                         │  adapter → session host → engine → UI  │ │
│        (we never call it)                      │  event log (on-device storage)         │ │
│                                                └───────────▲────────────────────────────┘ │
│                                                            │ LAN WS, commands only (P6)   │
│                                                ┌───────────┴───────────┐                 │
│                                                │ Phone companion app   │                 │
│                                                │ (corrections, names)  │                 │
│                                                └───────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

| Option | Verdict |
|---|---|
| **A. App → board directly** | **Chosen.** Zero deployment and zero added Pi load. Works offline from *our* side |
| B. Sidecar bridge on the Pi (like dartcade's Go bridge) | Rejected for now: Pi 4 headroom (§4.6) and the "no services" rule. **Revisit** only if Vega can't open LAN sockets (R05) |
| C. Autodarts cloud | Rejected (§4.2) |
| D. Rendering on the Pi 4 (kiosk browser) | Rejected (§4.6). The browser build remains a *developer* tool |

### 5.2 Client stack (ADR-002)

| Concern | Choice | Status |
|---|---|---|
| Language | TypeScript (strict) everywhere | — |
| Mobile + Fire OS app | Expo (prebuild / dev client, no Expo Go on TV ✅[P13]) + `react-native-tvos`. **Chosen: Expo SDK 56 + `react-native-tvos@0.85.3-3`** ([ADR-003](docs/adr/0003-client-stack-versions.md)), documented for TV and within 2 minors of Vega's RN 0.83 ✅[P13][P3] | decided |
| Vega app (backlog) | React Native for Vega (RN 0.83 track), Yarn workspace `apps/vega`, platform files `*.kepler.tsx` ✅[P10]. Not needed for the 4K Max. Shared packages stay Vega-compatible so this remains cheap | ⚪ |
| Private distribution | Fire TV / Android: APK sideload via `adb` ✅[P26]. iOS / iPadOS: **TestFlight internal testing** (owner has a paid Apple Developer account). Builds expire after 90 days 🟡[P27], so a fresh build is uploaded at least every 90 days | decided |
| Animation | Reanimated 4 + react-native-svg + Lottie (all targets). Skia v2 as an optional "high" tier on non-Vega | ✅ availability / ⚪ performance |
| Navigation and focus | React Navigation (Expo TV ✅[P13]). TV focus via `TVFocusGuideView` / `nextFocus*`. Vega `FocusManager` ✅[P5] | Vega navigation library ⚪ |
| Audio | `AudioPort` interface: `expo-audio` on Expo; W3C media API on Vega 🟡 | ⚪ |
| Storage | `LogStore` interface: `expo-sqlite` on Expo ✅[P13]; AsyncStorage on Vega ✅[P4] | — |
| Validation | `zod` (pure JS) | — |
| State → UI | `useSyncExternalStore` over the session host. No global store library needed | — |
| Unit tests | Vitest + fast-check (property-based) | — |

### 5.3 Monorepo layout

```
autodarts-arcade/
├─ apps/
│  ├─ arcade/            Expo app → iOS, iPadOS, Android, Fire OS (EXPO_TV build profile)
│  ├─ vega/              React Native for Vega shell (backlog; only if a Vega stick is added)
│  └─ devtools/          Node CLIs: board-probe, frame-recorder, fault-proxy, headless game runner
├─ packages/
│  ├─ event-schema/      zod types + generated JSON Schema, versioned (arcade.event/v1)
│  ├─ engine/            session host, event log, fold/replay, turn policy (pure TS, no React)
│  ├─ games/             one folder per game: module.ts, rules.md, stage/, fixtures/
│  ├─ adapters/          autodarts-local, simulator, manual (pure TS + injected transport)
│  ├─ platform/          ports: Transport, LogStore, AudioPort, Discovery, KeepAwake (+ impls)
│  ├─ ui-kit/            focus-aware RN components, theme, dartboard picker, quality tiers
│  └─ effects/           GameEffect → animation/sound mapping, effect queue
└─ fixtures/             recorded board sessions from YOUR board (Phase 1), golden logs
```

**Dependency rule** (enforced by lint): `engine`, `games`, `adapters` and `event-schema` import nothing from React, React Native or `platform`. They run identically in the app, in Node tests and in the CLI.

### 5.4 Runtime layers

```
 Board WS ─▶ Transport ─▶ autodarts-local adapter ─▶ Layer-1 "board facts" ─┐
 Simulator adapter ─────────────────────────────────▶ (same facts) ─────────┤
 Manual / UI commands ────────────────────────────────────────────────────── ▼
                                                    ┌──────────────────────────────┐
                                                    │ Session Host (single writer) │
                                                    │  • turn policy               │──▶ LogStore (persist first)
                                                    │  • command validation        │
                                                    │  • seq assignment            │
                                                    └──────────────┬───────────────┘
                                                                   │ fold(GameModule)
                                                     GameState ────┴──▶ view(state) ──▶ React screens
                                                     effects (new events only) ──▶ Effects runtime ──▶ anim + audio
```

---

## 6. Source adapters and event reliability

This section answers brief item 3: live darts, misses, corrections, takeouts and reconnections.

### 6.1 The core problem

The board emits **snapshots without IDs** 🟡[C3]. We reconstruct a reliable dart stream ourselves.

**Adapter state:**
- `visitKey`: a ULID minted at each new visit.
- `known[]`: the darts seen in this visit, each with its own `throwId`.
- `inTakeout`.

### 6.2 Snapshot diff (every `state` frame, and every `GET /api/state`)

```
throws := data.throws ?? []                 // v2 omits the key on an empty board
if data.event == "Manual reset":            emit VisitReset; withdraw all known; new visitKey
elif takeout begins (event "Takeout started" | status "Takeout in progress") and !inTakeout:
                                            emit TakeoutStarted; inTakeout = true
elif (event "Takeout finished") or (inTakeout and throws empty):
                                            emit TakeoutFinished; known = []; new visitKey; inTakeout = false
for i in 0..max(len(throws), len(known))-1:
  i <  len(known) and i <  len(throws) and seg differs → emit DartUpdated(known[i].throwId)
  i >= len(known)                                      → emit DartDetected(new ULID, indexInVisit=i)
  i >= len(throws) and !inTakeout                      → emit DartWithdrawn(known[i].throwId)   // board retracted it
```

- **Idempotency:** `(visitKey, indexInVisit)` is the dedupe key. Re-delivered or duplicate snapshots produce no new events.
- **Segment normalization** (§7.3) runs before comparison, so `M` and `M12` style misses compare consistently.

### 6.3 Per-situation handling

| Situation | Handling |
|---|---|
| **Normal dart** | `DartDetected` → host emits `DartThrown` for the current player, with `dartIndex = indexInVisit`. |
| **Miss** (on-board outside the doubles, or off-board) | Normalized to `bed: "miss"`, `points: 0`. Keeps `missSector` when given (`M12`), which is useful for "near-miss" effects and stats. |
| **Bounce-out or fallen dart** (usually *not* detected) | At an **observed** `TakeoutFinished` with fewer than 3 darts, the house rule `missingDartsAreMisses` (default **on**) appends `DartAdded{reason:'undetected'}` as misses. Players can relabel one as "bounce-out" in W4. An inferred takeout is never padded (§6.4). |
| **Board changes its mind** (`DartUpdated` / `DartWithdrawn`) | Host appends `DartCorrected{reason:'source-update'}` / `DartVoided{reason:'source-withdrawn'}`, then replays. The UI shows a subtle "adjusted" chip. |
| **User correction** | W4 sends commands: `CorrectDart` / `VoidDart` / `AddDart`. Host appends the event and replays. Any dart in the session is correctable, including after "game over" (results stay *provisional* until the next action). |
| **Takeout** | `TakeoutFinished` ends the turn. On the 3rd dart (board status `Takeout`) the UI already shows "Remove darts". |
| **Uncertain history after a reconnect** (owner decision R) | Same-visit darts are scored as `recovered` and the turn is flagged `needsReview`, with no pause. A takeout that may have happened offline (`TakeoutFinished{inferred:true}`) ends the turn `needsReview`, pads nothing and pauses the game until a person confirms the turn. Details in §6.4. |
| **Takeout with 0 darts** (hand in front of the cameras) | Ignored by default. A setting can make it count as "skip turn". |
| **Stuck takeout** (2.0.2 bug 🟡[C12]) | `Takeout in progress` with no darts for > 8 s → `BoardStatusChanged{status:'stuck-takeout'}` and a banner telling the player to reset the board from Autodarts' own app, with *Enter manually* as the way to keep playing. Arcade never sends a reset itself: it never writes to the board (owner decision S). |
| **Darts already on the board at game start** | They are treated as baseline, not scored. The UI says "Clear the board to start". |
| **Autodarts corrections in its own web UI** | Not applicable: Arcade sessions are not Autodarts matches. Don't run an Autodarts match at the same time (R26). |

### 6.4 Connection lifecycle and resync

```
 CONNECTING ──open──▶ RESYNCING ──snapshot diffed──▶ ONLINE ──socket error / liveness fail──▶ OFFLINE
     ▲                                                                                          │
     └────────────── backoff: 0.5 s, 1, 2, 4, then 5 s cap, ±20 % jitter ───────────────────────┘
```

**Liveness.** The socket is silent when idle 🟡, so the adapter polls `GET /api/state` every 5 s with no frames. Two failed polls → `OFFLINE`. Each poll result is also diffed, which makes the stream **self-healing** if a frame was ever missed.

**Resync** compares the snapshot to `known[]`:

| Snapshot vs `known[]` | Interpretation | Adapter emits | Host does |
|---|---|---|---|
| Same prefix, maybe more darts | Same visit | Only the new darts, flagged `recovered: true` | Scores them as `DartThrown{origin:'recovered'}`. The turn goes on, and its `TurnEnded` carries `needsReview: true`. **No pause** |
| Empty (while `known[]` had darts) | A takeout may have happened offline | `TakeoutFinished{inferred:true}` | **Review pause** (below) |
| Different prefix | A visit boundary may have happened offline | `TakeoutFinished{inferred:true}`, then the new darts as `recovered` | **Review pause**. The new darts are held for the next turn |

**Reconciliation (owner decision R).** The system never guesses silently: every uncertain turn is flagged ⚠ "Needs review" (W3 banner, one press to W4).

**Review pause.** Whenever a takeout was inferred:
1. The host ends the current turn with `TurnEnded{reason:'takeout', needsReview:true}`. It does **not** pad missing darts as misses: `missingDartsAreMisses` applies only to observed takeouts.
2. It appends `GamePaused{reason:'review'}` and does not start the next turn.
3. A person checks the turn in W4, corrects it if needed, and confirms with the command `ConfirmTurn{turnIndex}`. The host appends `TurnReviewed{playerId, turnIndex}`, then `GameResumed{reason:'review'}`, then the next `TurnStarted`.
4. Board darts that arrive during the pause are **held**, not dropped, and are attributed to the next turn when it starts.

A `needsReview` turn without a pause (same-visit recovery) is confirmed the same way. `ConfirmTurn` then only appends `TurnReviewed`.

**Finishing with unconfirmed turns.** While any `needsReview` turn has no matching `TurnReviewed`:
- `GameFinished` stays provisional;
- the host refuses `CloseSession{outcome:'completed'}`.

`CloseSession{outcome:'abandoned'}` is always allowed.

**App lifecycle.**
- iOS drops sockets when the app is suspended 🟡. Arcade keeps the screen awake during games and runs **resync on foreground**.
- Fire TV keeps the screen on (`FLAG_KEEP_SCREEN_ON` 🟡) and pauses on Home ✅[P8].

### 6.5 Crash recovery

1. The host **persists each event before** emitting effects (write-ahead).
2. On launch, an open session (no `SessionClosed`) offers **Resume**: load log → fold → connect → resync.

The adapter's `known[]` is rebuilt from the last visit's events. This works because layer-1 board facts are persisted too (§7.1).

---

## 7. Normalized event schema (`arcade.event/v1`)

### 7.1 Principles

1. **Append-only log with a single writer.** Only the host appends and assigns `seq`. Other devices send commands.
2. **Order by `seq`, never by timestamp.** Pi, TV and phone clocks aren't synchronized. Timestamps are kept for diagnostics and stats.
3. **Never mutate, always compensate.** Corrections are new events, and state is re-derived by replay.
4. **Two layers.**
   - *Board facts* (layer 1) describe the physical board and know nothing about players.
   - *Game facts* (layer 2) say who threw what, in which turn.

   The host derives layer 2 from layer 1 **at append time and records it**. A later change to the turn policy can therefore never silently rewrite an old game.
5. **Versioned and validated.** zod at every boundary (adapter output, command input, log load). JSON Schema is generated for non-TS tools.

### 7.2 Envelope

```ts
export interface ArcadeEvent<TType extends string = string, TPayload = unknown> {
  schema: 'arcade.event/v1';
  eventId: string;          // ULID: unique, lexically time-sortable
  sessionId: string;        // ULID of the arcade session
  seq: number;              // 1..n, gap-free, assigned by the host on append
  type: TType;
  payload: TPayload;
  source: {
    kind: 'autodarts-local' | 'simulator' | 'manual' | 'engine';
    adapterVersion: string;           // "autodarts-local@0.1.0"
    upstreamVersion?: string;         // board version from /api/version
    boardId?: string;                 // stable board identity if derivable (never the API key)
    actor?: PlayerId | 'operator';    // who issued a manual action
  };
  occurredAt: string;       // ISO-8601 at origin (else = receivedAt)
  receivedAt: string;       // ISO-8601 host clock at append
  causationId?: string;     // commandId / eventId that caused this event
  correlationId?: string;   // groups events from one physical action (e.g. one resync)
}
```

### 7.3 Value types and Autodarts mapping

```ts
export type PlayerId = string;   // ULID (stable for profiles, per-session for guests)
export type ThrowId  = string;   // ULID minted on first sighting (or for a manual dart)

export type Bed = 'single-inner' | 'single-outer' | 'single' | 'double' | 'triple'
                | 'outer-bull' | 'inner-bull' | 'miss';

export interface Segment {
  number: 0 | 1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20 | 25;  // 0 = miss
  multiplier: 0 | 1 | 2 | 3;
  bed: Bed;
  label: string;          // canonical: "T20" "D16" "S5" "25" "BULL" "MISS"
  missSector?: number;    // sector a miss landed beside, when the source says (e.g. "M12")
}
// points are derived, never stored: number * multiplier  (inner bull = 25 × 2 = 50)
```

| Autodarts input 🟡 | Normalized |
|---|---|
| `bed: SingleInner` / `SingleOuter` / `Single` | `single-inner` / `single-outer` / `single` |
| `bed: Double`, `Triple` (number 1–20) | `double`, `triple` |
| `number 25, multiplier 1` (`Bull`/`25`, bed `Single*`/`Bull`) | `outer-bull` (25) |
| `number 25, multiplier 2` (bed `Double` or `DoubleBull`) | `inner-bull` (50) |
| `bed: Outside` **or** `multiplier 0` **or** name `M`, `M<n>`, `Miss` | `miss`, `missSector = n` when 1–20 |
| anything else | adapter emits `SourceAnomaly` and treats the dart as a miss **pending review** |

**Rule:** derive the result from `number` and `multiplier` first, and use `bed` and `name` only as hints. This tolerates the naming differences between versions.

### 7.4 Layer 1: board facts (from adapters)

| `type` | `payload` |
|---|---|
| `DartDetected` | `{ throwId, segment, coords?, visitKey, indexInVisit, recovered?: true }` |
| `DartUpdated` | `{ throwId, previous: Segment, segment, coords? }` |
| `DartWithdrawn` | `{ throwId }` |
| `TakeoutStarted` | `{ visitKey }` |
| `TakeoutFinished` | `{ visitKey, inferred?: true }` |
| `VisitReset` | `{ visitKey, reason: 'manual-reset' }` |
| `BoardStatusChanged` | `{ status: 'ready'\|'throwing'\|'takeout'\|'stuck-takeout'\|'calibrating'\|'stopped'\|'error', health?: { fps?: number, camFps?: number[] } }` |
| `SourceConnectionChanged` | `{ state: 'connecting'\|'resyncing'\|'online'\|'offline', attempt?: number, error?: string }` |
| `SourceAnomaly` | `{ rawExcerpt: string, note: string }` (unknown enum or shape; raw excerpt is size-capped) |

`recovered: true` marks a dart first seen in a resync snapshot. `inferred: true` marks a takeout the adapter did not see happen. The host treats both as uncertain (§6.4).

### 7.5 Layer 2: game facts (from the host)

| `type` | `payload` |
|---|---|
| `SessionStarted` | `{ gameId, gameVersion, options, players: PlayerRef[], turnOrder: PlayerId[], rngSeed: string, houseRules }` |
| `TurnStarted` | `{ playerId, turnIndex, roundIndex }` |
| `DartThrown` | `{ throwId, playerId, turnIndex, dartIndex: 0\|1\|2, segment, origin: 'detected'\|'recovered' }` |
| `DartCorrected` | `{ throwId, previous: Segment, segment, reason: 'user'\|'source-update' }` |
| `DartVoided` | `{ throwId, reason: 'false-detection'\|'duplicate'\|'source-withdrawn'\|'user' }` |
| `DartAdded` | `{ throwId, playerId, turnIndex, dartIndex, segment, reason: 'undetected'\|'bounce-out'\|'manual-mode' }` |
| `TurnEnded` | `{ playerId, turnIndex, reason: 'takeout'\|'bust'\|'game-rule'\|'manual-skip', needsReview?: true }`. `needsReview` is set when the turn has a `recovered` dart or ended on an inferred takeout (§6.4) |
| `TurnReviewed` | `{ playerId, turnIndex }`. A person confirmed a `needsReview` turn (`ConfirmTurn`) |
| `GamePaused` / `GameResumed` | `{ reason: 'menu'\|'correction'\|'board-offline'\|'app-background'\|'review' }`. `review` holds the next turn until `TurnReviewed` (§6.4) |
| `GameFinished` | `{ standings: { playerId, rank, score }[], provisional: true }`. Stays provisional while any `needsReview` turn has no `TurnReviewed` |
| `SessionClosed` | `{ outcome: 'completed'\|'abandoned', finalStandings }`. `completed` is refused while any `needsReview` turn has no `TurnReviewed`; `abandoned` is always allowed |

**Commands** (UI or companion → host): `StartSession`, `CorrectDart`, `VoidDart`, `AddDart`, `SkipTurn`, `ConfirmTurn{turnIndex}`, `Pause`, `Resume`, `Rematch`, `CloseSession`. Each carries a `commandId`, which becomes the resulting events' `causationId`. A retried command is therefore applied at most once.

### 7.6 Example: a detected S5 corrected to S1

```jsonc
{ "schema":"arcade.event/v1", "eventId":"01JBX…A1", "sessionId":"01JBX…00", "seq":41, "type":"DartThrown",
  "payload":{ "throwId":"01JBX…T7", "playerId":"01JBW…P1", "turnIndex":12, "dartIndex":1, "origin":"detected",
              "segment":{ "number":5, "multiplier":1, "bed":"single-outer", "label":"S5" } },
  "source":{ "kind":"autodarts-local", "adapterVersion":"autodarts-local@0.1.0", "upstreamVersion":"2.0.2" },
  "occurredAt":"2026-11-02T20:14:03.120Z", "receivedAt":"2026-11-02T20:14:03.161Z" }

{ "schema":"arcade.event/v1", "eventId":"01JBX…A4", "sessionId":"01JBX…00", "seq":44, "type":"DartCorrected",
  "causationId":"cmd_01JBX…C9",
  "payload":{ "throwId":"01JBX…T7", "reason":"user",
              "previous":{ "number":5, "multiplier":1, "bed":"single-outer", "label":"S5" },
              "segment": { "number":1, "multiplier":1, "bed":"single-outer", "label":"S1" } },
  "source":{ "kind":"manual", "adapterVersion":"ui@0.1.0", "actor":"operator" },
  "occurredAt":"2026-11-02T20:14:20.004Z", "receivedAt":"2026-11-02T20:14:20.004Z" }
```

---

## 8. Game engine

### 8.1 Principles

- **`packages/engine` is pure TypeScript.** No React, timers, I/O, `Date` or `Math.random`. Randomness comes from a seeded RNG (`rngSeed` in `SessionStarted`), so every game replays deterministically.
- **Replay is the correction mechanism.** Any `DartCorrected`, `DartVoided` or `DartAdded` refolds from `SessionStarted`. Games never implement undo. ⚪ A session holds a few hundred darts, so a refold should cost ≲ 5 ms on a Fire TV-class CPU. Phase 3 measures this, and the fallback is snapshot every N turns.
- **Effects fire only for newly appended events.** A replay is silent apart from a single "score adjusted" effect.
- **The host owns turn boundaries.** A game may only *request* an early end (bust or rule). This keeps physical-board behaviour identical across all games.

### 8.2 Game module contract

```ts
export interface GameModule<Opts, State, View> {
  manifest: {
    id: string; version: string; name: string;
    players: { min: number; max: number }; teams?: boolean;
    category: 'party' | 'classic' | 'practice' | 'team';
    dartsPerTurn: 3;              // physical board visit = max 3 darts 🟡[C3]
  };
  options: ZodType<Opts>;        // drives the W2 option controls and validation
  init(ctx: { players: PlayerRef[]; options: Opts; rng: Rng }): State;
  onDart(state: State, dart: ScoredDart, ctx: TurnCtx): Step<State>;
  onTurnEnd(state: State, ctx: TurnCtx): Step<State>;
  nextPlayer(state: State, ctx: TurnCtx): PlayerId | null;   // null → finished
  result(state: State): Standings | null;
  view(state: State): View;                                   // serialisable, UI-agnostic
}
export interface Step<S> { state: S; effects?: GameEffect[]; endTurn?: 'bust' | 'game-rule' }
export type GameEffect =
  | { kind: 'hit' | 'big-hit' | 'miss' | 'bust' | 'checkout' | 'eliminated' | 'lead-change' | 'win';
      playerId?: PlayerId; intensity?: 1 | 2 | 3; data?: Record<string, unknown> };
```

Each game folder holds four parts:
- `module.ts`: pure rules.
- `rules.md`: player-facing rules.
- `stage/`: React Native renderer for W3's centre stage.
- `fixtures/`: scripted dart sequences with expected standings.

Adding a game means **one folder plus one registry line**.

### 8.3 Turn policy (host)

| Situation | Behaviour |
|---|---|
| Darts 1–3 detected | `DartThrown` for the current player, `dartIndex` 0–2 |
| `TakeoutFinished` (observed) | `TurnEnded{reason:'takeout'}`; pad missing darts per `missingDartsAreMisses` |
| `TakeoutFinished{inferred:true}` | `TurnEnded{reason:'takeout', needsReview:true}` with no padding, then the review pause (§6.4) |
| Game returns `endTurn:'bust'` | Later darts in the visit are shown greyed and not scored. The turn ends at takeout |
| Board offline mid-turn | `GamePaused{board-offline}`. After 5 s the UI offers *Enter manually*. On reconnect, resync (§6.4) |
| Manual mode (no board) | Darts arrive as `DartAdded{reason:'manual-mode'}` from the W4 picker. Turn ends on "Next player" |

### 8.4 Initial game slate (original designs, placeholder names)

| Game | Type | Purpose |
|---|---|---|
| Countdown (x01 variant) | classic | Reference implementation and rules test bed |
| Cricket | classic | Exercises marks, closing and points rules |
| Around the Clock | practice | Simplest module, used for the engine tutorial |
| **Siege** | party | Targets carry numbers. Exercises stage animation and spawn RNG |
| **Territory** | party | Claim segments. Exercises board-map rendering and steals |
| **Balloon Pop** | party | Exercises fast effects and the effect-queue collapse |

Before release, names and mechanics are checked against BattleUp's catalogue so nothing is a clone (R23).

---

## 9. Presentation, performance and platform integration

### 9.1 Effects runtime

- **Game effects are data:** `GameEffect[]` produced by the engine.
- The `effects` package maps them to:
  - **animation presets**: Reanimated + SVG, plus Lottie for celebrations.
  - **sounds**: through `AudioPort`.
  - optionally **Skia particles** on the high tier.
- **Queue rule:** recording a dart is never delayed by an animation. Pending effects collapse when darts arrive faster than they play (e.g. three quick "hit"s → one "triple combo").

### 9.2 Quality tiers ⚪

| Tier | Devices | Budget |
|---|---|---|
| **High** | iPad, recent iPhones / Android | 60 fps, full particles, Skia allowed (non-Vega) |
| **Standard** | **Fire TV Stick 4K Max** and other 2 GB Fire OS sticks | ≤ 100 concurrently animated views ✅[P16]; Lottie celebrations; Skia v2 particles only if P5 measurements allow; foreground memory < 300 MB ✅[P7] |
| **Lite** | 1 GB sticks (not in your household; kept for later) | Reduced particles, shorter transitions, static backgrounds; memory < 300 MB (Fire OS) / < 400 MiB (Vega) ✅[P6][P7] |

- The tier is auto-selected from model and RAM, and the user can override it in Settings.
- UI renders at 1080p logical resolution even on 4K sticks.

### 9.3 Platform integration checklist

| Platform | Needed | Evidence |
|---|---|---|
| iOS / iPadOS | `NSLocalNetworkUsageDescription`. The first LAN connect triggers the **Local Network prompt** and may fail before the answer, so retry. `NSAllowsLocalNetworking = YES` (ATS blocks IP addresses by default on iOS 17+). `NSBonjourServices: ["_autodarts-board._tcp"]` for discovery. Keep-awake during games | ✅[P17][P18] |
| Android / Fire OS | `usesCleartextTraffic` (arbitrary LAN IPs can't be listed in `domain-config`). Plan for Android 17's `ACCESS_LOCAL_NETWORK` when targeting API 37. TV profile: leanback launcher, no touch requirement, `FLAG_KEEP_SCREEN_ON` | ✅[P19][P20] |
| Vega (backlog) | Cleartext policy in the manifest (WebView blocks HTTP by default ✅[P9]). **Native `ws://` to a LAN IP is undocumented**, so spike first if Vega is ever needed. No mDNS library, so discovery is manual or QR | ⚪ |

### 9.4 Discovery (W0 screen)

1. **mDNS** `_autodarts-board._tcp` 🟡[C15] on iOS, Android and Fire OS.
2. **Last-known address**.
3. **Manual IP** entry, with a QR code shown on a phone for TV.
4. **Subnet probe** of `:3180/api/version`, opt-in.
5. **Demo mode**: the simulator adapter, for development and for playing without the board. It would also satisfy App Review ✅[P21] if the app is ever published.

### 9.5 Security and privacy

- **Endpoint allowlist in the transport.** The app never writes to the board (owner decision S). Only these are allowed:
  - `GET /api/state`, `/api/version`, `/api/state/stats` and `/api/cams/stats`;
  - `WS /api/events`, optionally with `?type=state`.
  - A unit test fails the build if any other path, or any method other than GET, appears.
  - This blocks `/api/events/system`, and `/api/config` and `/api/system`, which return the board **API key and TLS key** 🟡[C2].
- **No Autodarts credentials** are ever requested or stored.
- **Player data** (names, avatars, stats) stays on-device. No accounts and no analytics in v1, so the App Store privacy label is "Data Not Collected".
- **Diagnostic exports** (raw-frame ring buffer) are user-initiated through the share sheet and secret-free, because those endpoints are never fetched.

### 9.6 Companion phone (Phase 6, optional)

- The host (iPad or Fire OS) runs a small LAN WebSocket server (`react-native-tcp-socket` ✅[P23]). Accepting incoming connections needs no permission on iOS ✅[P17].
- The phone pairs by scanning a QR code with a one-time token, then sends **commands only**.
- Uses: name entry, quick corrections, and acting as the "operator".
- On Vega, listening sockets are unknown ⚪, so the companion is unavailable there unless the spike proves otherwise.

### 9.7 Board-health log (evidence for the H1 hardware review)

The Pi 4 stays until after Phase 5 (§4.6), so the app quietly collects the evidence needed to decide whether it should be replaced.

**Board telemetry**
- Per-camera FPS and overall detection FPS, sampled **every 30 s during games only**, from the allowlisted `/api/state/stats` and `/api/cams/stats` 🟡[C2].
- Adds ≤ 2 small requests per 30 s, well within NF8.

**Detection quality, derived from the event log at no extra cost**
- Missed on-board darts.
- Misread darts.
- `needsReview` turns.
- Stuck takeouts.
- Reconnects.

Bounce-outs are kept separate, because no hardware can detect them.

**Not readable through the API:** thermal throttling. The owner runs `vcgencmd get_throttled` on the Pi at the P1 baseline and again at H1. This is read-only.

**Storage and privacy:** all data stays on-device. W1's Settings shows a per-session summary, and a share-sheet export provides the H1 report input.

---

## 10. Wireframes

Low-fidelity layouts are drawn for the **TV / iPad landscape** canvas (16:9, 1920×1080 logical). Each screen notes how it adapts to a phone and how a TV remote (D-pad, OK, Back, Menu / Play-Pause) drives it.

Legend:
- `[ ]` = focusable control
- `▶` = current focus
- `●` = status light

Game names are original placeholders.

### W0 · Connect board (first run / offline)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ CONNECT YOUR BOARD                                                           │
│  Found on this network:  [▶ Board @ 192.168.1.40:3180   v2.0.2   ● online ]   │
│                          [   Scan again ]                                     │
│  Or enter address:       [ 192.168.1.__ ]:[3180]        (QR → type it on phone)│
│  Or:                     [ Demo mode — simulated darts ]                      │
│  ⓘ iOS asks for "Local Network" access — it is needed to reach the board.    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### W1 · Game selection

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ARCADE                          ● Board online · 3 cams · 12 fps  [⚙ Settings] │
├──────────────────────────────────────────────────────────────────────────────┤
│  [ Party ]   Classic    Practice    Team                 ◀ category ▶          │
│                                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │▶ ░░░░░░ ◀│ │  ░░░░░░  │ │  ░░░░░░  │ │  ░░░░░░  │ │  ░░░░░░  │  ›         │
│  │ SIEGE    │ │ TERRITORY│ │ BALLOON  │ │ COUNTDOWN│ │ CRICKET  │            │
│  │ 2–8 ply  │ │ 2–6 ply  │ │ 1–8 ply  │ │ 1–8 ply  │ │ 2–4 ply  │            │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘            │
│   focused tile: scale 1.08, glow ring, looping 3 s preview (static on Lite)   │
│                                                                              │
│  SIEGE: Hit the numbers carried by the invaders before they reach the wall.  │
│  ~12 min · 3 darts/turn · Skill ★★☆ · Teams supported                        │
│  [ How to play ]                                          [ OK  Choose ▸ ]   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Data:** game manifests from the registry. The status light comes from `SourceConnectionChanged` and `BoardStatusChanged`.
- **TV:** a horizontal carousel. Focus starts on the last-played game.
- **Phone:** a 2-column grid with a details sheet.
- **Board offline:** "Choose" offers *Play with manual entry?*.

### W2 · Player setup

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [◀ Back]   SIEGE · Players & options                              Step 2 / 2  │
├──────────────────────────────────────────────────────────────────────────────┤
│  TURN ORDER                               ADD                                │
│  1 ▌■ ALEX     [avatar ▸]  [↑↓]  [✕]       [ + SAM   (recent) ]               │
│  2 ▌■ JO       [avatar ▸]  [↑↓]  [✕]       [ + KIM   (recent) ]               │
│  3 ▌■ GUEST 3  [avatar ▸]  [↑↓]  [✕]       [ + Guest          ]               │
│  4 ▌   — empty —                           [ + New profile…   ]  ← QR / phone │
│                                                                              │
│  OPTIONS (generated from the game's options schema)                          │
│  Rounds      [◀ 10 ▶]      Turn order   [◀ Random ▶]                          │
│  Difficulty  [◀ Normal ▶]  Missing darts count as miss  [◀ On ▶]              │
│                                                                              │
│  ⓘ 2–8 players · board online · board clear      [ ▶ START GAME ]             │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **TV:** prefers recent profiles and *Guest N*, because typing with a remote is slow. "New profile…" uses the phone companion via QR (P6) or the system keyboard.
- **Phone:** single column with a sticky START button.
- **START** is disabled with the reason shown until the player count is valid and the board is clear.

### W3 · Live gameplay

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ROUND 4 / 10              SIEGE                      ● Board   [⏸ Menu]      │
├────────────────┬────────────────────────────────────────────┬────────────────┤
│ ▶ ALEX    240  │                                            │  ALEX · TURN   │
│   JO      180  │                                            │  ① T20    60   │
│   GUEST3  155  │          GAME STAGE (game module)          │  ② S5      5   │
│                │      animated targets / effects layer      │  ③ ·  ·  ·     │
│                │                                            │  ───────────   │
│                │                                            │  Turn     65   │
├────────────────┴────────────────────────────────────────────┴────────────────┤
│ Dart 3 of 3 — throw now                    Remove darts to end turn   [✎ Fix] │
└──────────────────────────────────────────────────────────────────────────────┘
 Takeout:   ┌───────────────────── REMOVE DARTS ─────── Next up: JO ─────────────┐
 Offline:   ┌──── ⚠ Board connection lost — reconnecting (try 3) [Enter manually]┐
 Review:    ┌──── ⚠ Turn 11 needs review — darts recovered after reconnect [Fix] ┐
 Paused:    ┌──── ⏸ Board may have been cleared while offline — check turn 11 [Review]┐
 Stuck:     ┌──── ⛔ Board stuck in takeout — reset it in the Autodarts app [Enter manually]┐
```

- `DartThrown` updates the dart list, plays the stage effect and sound. `TakeoutStarted` shows the banner. `TurnEnded` plays the next-player transition (≤ 600 ms).
- **Needs review** (§6.4, owner decision R):
  - *Review*: darts recovered within the same visit. Play goes on, and the banner stays until the turn is confirmed in W4.
  - *Paused*: a takeout may have happened offline. Play stops, and the next player's turn starts only after someone confirms the turn in W4. Darts thrown meanwhile are held for that next turn.
- **TV:** OK or Menu opens pause. "Fix" is one D-pad press away. Home → "Game paused" ✅[P8].
- **Phone:** stage on top, standings as a chip row, dart list below.

### W4 · Correction

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ FIX THROWS — ALEX · Round 4                                   game paused ⏸  │
├──────────────────────────────────────────────────────────────────────────────┤
│  This turn:  [① T20]  [▶② S5]  [③ + add missed dart]     [◀ Earlier turns]    │
│                                                                              │
│        ┌──────────── board picker ────────────┐    QUICK                     │
│        │   ◀▶ walk round the numbers           │    [ MISS ]                  │
│        │   ▲▼ cycle S-in / T / S-out / D       │    [ BOUNCE-OUT ]            │
│        │   (touch: tap the segment)            │    [ 25 ]   [ BULL ]         │
│        │          · dartboard graphic ·        │                              │
│        └──────────────────────────────────────┘                              │
│                                                                              │
│  Dart ②   was  S5   →   now  [ S1 ]          Preview: ALEX 240 → 236          │
│  [ ✓ Apply ]    [ 🗑 Not a dart ]    [ Cancel ]                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Preview** dry-runs the replay with the proposed change, so consequences such as eliminations or a different winner are visible before applying.
- **Apply** appends `DartCorrected`, `DartVoided` or `DartAdded`. Earlier turns are reachable for the whole session.
- **Review mode** (opened from a needs-review banner): `recovered` darts are marked, and after an inferred takeout missing darts show as empty slots, not misses. **Confirm turn** sends `ConfirmTurn{turnIndex}` once the corrections are done, which also ends a review pause.
- **Target:** the common fixes (wrong bed, miss ↔ hit, add a bounce-out) take **≤ 5 remote presses** from W3.

### W5 · Victory

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         ✦   J O   W I N S !   ✦                               │
│                    [ celebration animation (tiered) ]                        │
│      1  ■ JO       412 pts   best turn 140   hit-rate 61%   ★ MVP             │
│      2  ■ ALEX     380 pts   best turn 100   hit-rate 55%                     │
│      3  ■ GUEST 3  301 pts   best turn  85   hit-rate 42%                     │
│  [▶ Rematch ]   [ New game, same players ]   [ Main menu ]                    │
│  [ ✎ Fix last turn ]  ← result is provisional until you pick an action        │
└──────────────────────────────────────────────────────────────────────────────┘
```

- `GameFinished` is **provisional**. A correction can withdraw the victory and resume play.
- `SessionClosed` is written, and stats committed, only when the players pick Rematch, New game or Menu.
- While a turn still needs review, those actions open W4 for it first, because the host refuses to close the session as completed (§6.4). Quitting (abandon) always works.
- The celebration can be skipped with OK after 1.5 s.

---

## 11. Verified vs assumed: ledger

| Capability or fact | Status |
|---|---|
| Autodarts 2.x removed the `:3180` Board Manager UI; local API undocumented | ✅[S1] |
| Local `ws://:3180/api/events` still streams throws on 2.x | 🟡 disputed ([C2][C3] yes, [C4] no) → **🔬 Phase 1 gate** |
| Local API needs no auth | 🟡[C2][C3] → 🔬 |
| Frame field names, enums, miss shapes, coords convention | 🟡[C1][C2][C3] → 🔬 recorded fixtures |
| Board withdraws or updates darts in place | 🟡[C2] → 🔬 |
| `/api/config` and `/api/system` expose secrets | 🟡[C2] (never called) |
| mDNS `_autodarts-board._tcp` on 2.x | 🟡[C15] → 🔬 |
| Board needs the internet at start | ✅[S4] (v1 FAQ) / 🟡 for v2 → 🔬 |
| Pi 4 marginal for detection; don't render on it | ✅[S4] |
| Your Pi 4's actual CPU, thermal and FPS headroom | 🔬 P1 baseline → H1 review after P5 |
| ToS bans unauthorised third-party / commercial use | ✅[S3] |
| Autodarts staff permit this project for private home use | **Owner-attested** (Autodarts Discord); not independently verified |
| Your TV stick (4K Max) runs Fire OS and accepts ADB sideloading | ✅[P1][P26] → 🔬 install dry run in P1 |
| iOS private install via TestFlight on the owner's paid Apple Developer account | decided (owner); 90-day build lifetime 🟡[P27] |
| No official third-party API or client IDs | ✅ (none published) / 🟡[C13] (Autodarts' reply) |
| Fire TV models and their OS (Fire OS vs Vega) | ✅[P1] |
| Vega can't run APKs; all future sticks Vega (affects only a future replacement stick) | 🟡[P11] |
| Expo + react-native-tvos builds for Fire OS with Reanimated, Skia, SVG, Audio | ✅[P13] (TV generally) / ⚪ Fire OS specifics → 🔬 |
| Vega ships Reanimated 4.1.3, SVG, Lottie, AsyncStorage; no Skia or mDNS | ✅[P4] |
| Vega app can open `ws://` to a LAN IP | ⚪ (backlog; not needed for the 4K Max) |
| Effects hit Amazon KPIs on the 4K Max | ⚪ → 🔬 Phase 5 |
| Full-log refold ≲ 5 ms on TV-class CPU | ⚪ → Phase 3 benchmark |
| Board→screen ≤ 150 ms | ⚪ target → 🔬 |

---

## 12. Sources

All sources accessed 2026-10-26. The decision-critical ones (S1, S3, S4, P1, P4, P13, C2, C3, C4) were re-checked independently of the first research pass.

**Autodarts (official)**
- [S1] Headless installation: https://docs.autodarts.com/getting-started/detection/headless-installation/
- [S2] Autodarts Desktop: https://docs.autodarts.com/getting-started/detection/autodarts-desktop/
- [S3] Terms (app): https://autodarts.com/legal/terms-app
- [S4] FAQ (hardware, internet): https://autodarts.diy/FAQ/
- [S5] Hardware requirements: https://autodarts.diy/getting-started/hardware-requirements/
- [S6] Release manifests: https://releases.autodarts.com/headless/downloads/latest.stable.json
- [S7] Install script: https://autodarts.sh/sh/install.sh
- [S8] Status: https://status.autodarts.com/
- [S9] Autodarts Plus: https://docs.autodarts.com/getting-started/autodarts-plus/
- [S10] Winmau launch: https://winmau.com/blogs/news/winmau-redefines-the-future-of-darts-with-launch-of-autodarts-ecosystem
- [S11] Autodarts X FAQ: https://winmau.com/pages/autodarts-x-faqs

**Community**
- [C1] Chade/AutodartsClient: https://github.com/Chade/AutodartsClient/blob/main/AutodartsDefines.h
- [C2] HomeDarts (MIT): https://github.com/Dennis-Otto/homedarts-for-autodarts
- [C3] DartLab protocol notes (2.0.2 capture): https://github.com/MrTeaMusic/DartsApp/blob/main/docs/autodarts-protokoll.md
- [C4] ioBroker.autodarts: https://github.com/inventwo/ioBroker.autodarts
- [C5] dartcade: https://github.com/W3D3/dartcade
- [C6] IO-Darts-Agent: https://github.com/Castorio/io-darts-agent
- [C7] lidarts: https://github.com/mischkadb/lidarts
- [C8] darts-caller: https://github.com/lbormann/darts-caller → https://github.com/Peschi90/darts-caller
- [C9] Tools for Autodarts (incl. AUTH_CHANGES.md): https://github.com/creazy231/tools-for-autodarts
- [C10] autodarts-board (npm, MIT): https://github.com/LunyaaDev/autodarts-board
- [C11] Autodarts-TV: https://github.com/TheJim03/Autodarts-TV
- [C12] Stuck-takeout on 2.0.2: https://github.com/Dennis-Otto/ha-autodarts/pull/172
- [C13] "No OAuth client IDs to third parties": https://github.com/Dennis-Otto/ha-autodarts/pull/440
- [C14] Pi 4 field report (German): https://www.dartn-forum.de/thread/31106-autodarts-technische-fragen-zur-installation/
- [C15] mDNS on BM 2: https://github.com/Dennis-Otto/HACSAutodarts/pull/10

**Platforms**
- [P1] Fire TV stick specs: https://developer.amazon.com/docs/device-specs/device-specifications-fire-tv-streaming-media-player.html
- [P2] Fire OS overview: https://developer.amazon.com/docs/fire-tv/fire-os-overview.html
- [P3] Vega SDK 0.24 release notes: https://developer.amazon.com/docs/vega/0.24/vega-release-notes.html
- [P4] Vega supported libraries: https://developer.amazon.com/docs/vega-api/0.24/supported-libraries.html
- [P5] React Native for Vega: https://developer.amazon.com/docs/vega/0.24/vega-rn-overview.html
- [P6] Vega app KPIs: https://developer.amazon.com/docs/vega/0.24/measure-app-kpis.html
- [P7] Fire OS app KPIs: https://developer.amazon.com/docs/app-testing/measure-kpis-fire-tv-apps.html
- [P8] Amazon Appstore test criteria: https://developer.amazon.com/docs/app-testing/test-criteria.html
- [P9] Vega WebView: https://developer.amazon.com/docs/vega/0.24/develop-your-app-with-webview.html
- [P10] Reusing RN code across TV OSes: https://community.amazondeveloper.com/t/reuse-your-react-native-vega-code-across-tv-operating-systems/27616
- [P11] "All future Fire TV Sticks will run Vega": https://www.aftvnews.com/amazon-confirms-all-future-fire-tv-sticks-will-run-vega-os-no-more-android-or-sideloading-on-new-models/
- [P12] react-native-tvos: https://github.com/react-native-tvos/react-native-tvos
- [P13] Expo, building for TV: https://docs.expo.dev/guides/building-for-tv/
- [P14] Amazon, React Native for Fire TV: https://developer.amazon.com/docs/fire-tv/get-started-with-react-native.html
- [P15] React Native Skia installation: https://github.com/Shopify/react-native-skia/blob/main/apps/docs/docs/getting-started/installation.md
- [P16] Reanimated performance: https://docs.swmansion.com/react-native-reanimated/docs/guides/performance
- [P17] Apple TN3179, local network privacy: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
- [P18] NSAllowsLocalNetworking: https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking
- [P19] Android network security config: https://developer.android.com/privacy-and-security/security-config
- [P20] Android local network permission: https://developer.android.com/privacy-and-security/local-network-permission
- [P21] App Store Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- [P22] Amazon Developer Services Agreement: https://developer.amazon.com/support/legal/da
- [P23] react-native-tcp-socket: https://github.com/Rapsssito/react-native-tcp-socket
- [P24] VLC removed from the App Store (2011): https://9to5mac.com/2011/01/07/vlc-for-ios-removed-from-the-app-store/
- [P25] Signal's GPLv3 app-store exception: https://scancode-licensedb.aboutcode.org/signal-gpl-3.0-exception.LICENSE
- [P26] Amazon, connect to Fire TV through ADB (Developer Options, ADB debugging, Apps from Unknown Sources): https://developer.amazon.com/docs/fire-tv/connecting-adb-to-device.html
- [P27] Apple TestFlight (up to 100 internal testers): https://developer.apple.com/testflight/. The 90-day build lifetime and "no review for internal testers" come from third-party guides such as https://instabug.com/blog/testflight-guide 🟡
