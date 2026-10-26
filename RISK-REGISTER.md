# AutoDarts Arcade — Technical Risk Register (initial, Phase 0)

> **Last reviewed:** 2026-10-26. Review at every phase gate in [ROADMAP.md](ROADMAP.md).
> **Evidence:** ✅ verified · 🟡 community-reported · ⚪ assumption. Source IDs ([S#], [C#], [P#]) refer to [ARCHITECTURE.md §12](ARCHITECTURE.md#12-sources).
> **Scoring:** Likelihood (L) and Impact (I) are each rated 1–5. Score = L × I. **High ≥ 15**, Medium 8–14, Low ≤ 7.
> **Roles:** *Owner* = project owner (decisions, purchases, contacting Autodarts); *Lead* = development lead.

## Summary (sorted by score)

| ID | Risk | Category | Evidence | L | I | Score | Phase | Status |
|---|---|---|---|---|---|---|---|---|
| R01 | Undocumented local API changes, closes or adds auth (auto-updates) | Integration | ✅ | 4 | 5 | **20 High** | P1→ongoing | Open |
| R04 | Fire TV fragmentation: Vega sticks can't run the Android build | Platform | ✅ | 4 | 4 | **16 High** | P1 / P6 | Open: needs Q1 |
| R07 | GPL-3.0 blocks or complicates App Store / Amazon distribution | Legal | ✅ | 4 | 4 | **16 High** | P1 | Open: needs Q4 |
| R09 | Misdetected darts decide game outcomes | Product | 🟡 | 4 | 4 | **16 High** | P2–P4 | Open |
| R10 | ID-less snapshot stream leads to lost or duplicated darts on reconnect | Integration | 🟡 | 4 | 4 | **16 High** | P2 | Open |
| R11 | Pi 4 undersized for detection (dropped FPS, missed darts) | Hardware | ✅ | 4 | 4 | **16 High** | P1 | Open |
| R02 | Autodarts 2.x local stream may not carry throws at all | Integration | 🟡 | 3 | 5 | **15 High** | P1 (G1) | Open |
| R03 | Autodarts ToS: third-party / commercial use | Legal | ✅ | 3 | 5 | **15 High** | P0 / P6 | Open: needs Q2, Q3 |
| R05 | Vega can't open LAN sockets / no mDNS / can't host companion | Platform | ⚪ | 3 | 4 | 12 Med | P1 (G2) | Open |
| R06 | Effects too heavy for 1 GB TV sticks | Performance | ✅/⚪ | 4 | 3 | 12 Med | P5 | Open |
| R08 | Trademark: "AutoDarts" in app name / store rejection | Legal | ✅ | 4 | 3 | 12 Med | P1 | Open: needs Q5 |
| R18 | React Native version skew and library gaps (Expo / tvOS fork vs Vega) | Tech stack | ✅ | 4 | 3 | 12 Med | P1→P6 | Open |
| R21 | Scope vs capacity: five targets and a device lab | Delivery | ⚪ | 4 | 3 | 12 Med | all | Open |
| R12 | Board needs the internet / Autodarts cloud to start | Dependency | ✅ | 3 | 3 | 9 Med | P1 | Accept + mitigate |
| R13 | 2.0.2 stuck-takeout bug | Integration | 🟡 | 3 | 3 | 9 Med | P2 | Open |
| R14 | iOS Local Network permission / ATS blocks the board | Platform | ✅ | 3 | 3 | 9 Med | P1 | Open |
| R16 | App suspension drops the socket, so darts are missed | Platform | 🟡 | 3 | 3 | 9 Med | P2 | Open |
| R19 | App Review rejects a hardware-dependent app | Release | ✅ | 3 | 3 | 9 Med | P4 / P6 | Open |
| R23 | Asset / game-design IP (BattleUp look-alike, AI-asset provenance) | Legal | ⚪ | 3 | 3 | 9 Med | P5 | Open |
| R26 | An Autodarts match or other tool consumes the same darts concurrently | Integration | ⚪ | 3 | 3 | 9 Med | P2 / P4 | Open |
| R17 | Board API key / TLS key exposed via `/api/config` and `/api/system` | Security | 🟡 | 2 | 4 | 8 Med | P2 | Open |
| R15 | Android cleartext rules / Android 17 local-network permission | Platform | ✅ | 2 | 3 | 6 Low | P1 | Open |
| R25 | Companion pairing friction / unsupported on Vega | Product | ⚪ | 3 | 2 | 6 Low | P6 | Open |
| R20 | Clock skew corrupts ordering | Data | ⚪ | 2 | 2 | 4 Low | P2 | Mitigated by design |
| R22 | Inaccurate brief (hallucinated projects) propagates | Process | ✅ | 2 | 2 | 4 Low | P0 | **Mitigated** |
| R24 | Player personal data (names, stats, avatars) | Privacy | ⚪ | 2 | 2 | 4 Low | P4 | Mitigated by design |

---

## Details

### R01 · Undocumented local API changes, closes or adds auth — 20 High
- **Cause:** Arcade depends on the `:3180` local API, which Autodarts calls "not supported from version 2 on" ✅[S1]. Board software auto-updates (Velopack) ✅[S7], so a change can arrive overnight.
- **Impact:** Arcade stops scoring until the adapter is fixed.
- **Mitigation:**
  - Isolate everything behind `autodarts-local` with version-specific profiles.
  - Golden fixtures and a 30-minute re-check runbook (ROADMAP P6).
  - Board-version watch in the app.
  - Manual mode is always available.
  - Find out in P1 whether auto-update can be paused 🔬.
  - Ask Autodarts for a supported local API.
- **Early warning:** `/api/version` changes; `SourceAnomaly` events; fixture replay drift.
- **Owner:** Lead (Owner for vendor contact).

### R02 · Autodarts 2.x local stream may not carry throws — 15 High
- **Cause:** The sources disagree. HomeDarts and DartLab report throws on 2.0.2 🟡[C2][C3]. ioBroker says 2.x "no longer provides throw data" 🟡[C4].
- **Impact:** The core integration path is gone.
- **Mitigation:** Gate **G1** at the start of P1. Contingencies: pin the version → ask Autodarts → manual-entry arcade (ROADMAP P1). Cloud use only with written permission.
- **Early warning:** The P1 probe shows `state` frames without `throws` after a throw.
- **Owner:** Lead.

### R03 · Autodarts ToS: third-party and commercial use — 15 High
- **Cause:**
  - §3.2: "private, non-commercial", no "automated or indirect use through third-party software", no "unauthorized … third-party software to … access".
  - §6.1: no commercial third-party use without written authorization ✅[S3].
- **Impact:** Account suspension; a demand to stop distribution. This is a fatal blocker for any venue or "BattleUp-style" commercial use.
- **Mitigation:**
  - Private, non-commercial scope by default.
  - Local, read-only access only. No cloud, never handle Autodarts credentials.
  - **Written authorization from Autodarts GmbH before** any public store listing, commercial or venue use (Q2, Q3).
  - Get proper legal advice if commercial use is wanted.
- **Early warning:** A plan to monetise or list publicly; any contact from Autodarts.
- **Owner:** Owner.

### R04 · Fire TV fragmentation (Fire OS vs Vega) — 16 High
- **Cause:**
  - 4K Select 2025, HD 2026 and 4K 3rd gen 2026 run **Vega OS** ✅[P1].
  - Vega can't run APKs and blocks consumer sideloading 🟡[P11].
  - Amazon says all future sticks will be Vega 🟡[P11].
- **Impact:** The Fire OS build won't install on newer sticks, and Vega needs a separate app shell.
- **Mitigation:**
  - All logic sits in pure-TS packages shared with a React Native for Vega shell ✅[P10].
  - Vega spike in P1 (G2). The Vega track moves to P4 if your stick is Vega (Q1).
  - Interim option: develop on a Fire OS stick (4K Max 2nd gen is the last Fire OS stick, 🟡[P11]), or use the iPad as the host display.
- **Early warning:** The Q1 answer; Amazon announcements.
- **Owner:** Owner (Q1), Lead.

### R07 · GPL-3.0 vs app-store distribution — 16 High
- **Cause:** FSF and Apple terms conflict; VLC was removed in 2011 ✅[P24]. Amazon's agreement restricts certain copyleft combinations ✅[P22].
- **Impact:** A store listing could be taken down on any contributor's complaint.
- **Mitigation:**
  - **Now, while you're the sole copyright holder:** add a GPLv3 §7 app-store exception (as Signal did ✅[P25]), or dual-license, or relicense (Q4).
  - `CONTRIBUTING.md` with DCO/CLA.
  - Licence scanning in CI.
  - **Never copy code from NC, AGPL or unlicensed community repos.** IO-Darts-Agent, dartcade, Tools for Autodarts and darts-caller are learn-only (ARCHITECTURE §4.5).
- **Early warning:** The first outside contribution; any GPL dependency appearing in the tree.
- **Owner:** Owner.

### R09 · Misdetections decide outcomes — 16 High
- **Cause:** Camera detection isn't perfect. The Pi 4 field report saw only 2 of 3 darts detected at low FPS 🟡[C14]. Party games amplify single errors.
- **Impact:** Players lose trust in the product.
- **Mitigation:**
  - Correction-first design: W4 in ≤ 5 presses, preview, any dart correctable.
  - Results stay **provisional** until the next action.
  - "Needs review" flags.
  - `missingDartsAreMisses` house rule.
  - Replay makes corrections exact.
- **Early warning:** Correction rate per session (logged locally).
- **Owner:** Lead.

### R10 · Lost or duplicated darts from an ID-less snapshot stream — 16 High
- **Cause:** No throw IDs or sequence numbers, a silent socket, takeouts that may happen while offline 🟡[C3].
- **Impact:** Wrong scores, or double-counted darts.
- **Mitigation:** Snapshot-diff with `(visitKey, index)` idempotency, liveness polling, resync with inferred takeouts, `recovered` darts flagged for review (ARCHITECTURE §6). P2 chaos suite: 1,000 runs, zero silent mismatches.
- **Early warning:** Chaos-suite failures; `needsReview` frequency in the field.
- **Owner:** Lead.

### R11 · Pi 4 undersized for detection — 16 High
- **Cause:** Autodarts' own FAQ calls the Pi 4 "bleeding edge" ✅[S4]. A field report describes 3 cameras freezing at 0 FPS 🟡[C14].
- **Impact:** Missed darts and latency, which Arcade can't fix in software.
- **Mitigation:**
  - Zero added Pi load (ADR-001).
  - P1 health baseline (CPU, temperature, per-camera FPS).
  - Headless, active cooling, 800×600 ✅[S4].
  - Health shown in W1.
  - If needed, upgrade to a Pi 5 or mini PC with no app changes (Q6).
- **Early warning:** Camera FPS < 10, throttling flags, a rising correction rate.
- **Owner:** Owner (hardware), Lead (measurement).

### R05 · Vega LAN capabilities unknown — 12 Medium
- **Cause:** No documentation for native `ws://` to a LAN IP on Vega, no mDNS library ✅[P4], listening sockets unknown ⚪.
- **Impact:** No Vega support, or no companion on Vega.
- **Mitigation:** P1 time-boxed spike (G2). Fallbacks: manual IP / QR; iPad or Fire OS as the host; no companion on Vega. A bridge on the detection host only if the "no services" rule is relaxed.
- **Owner:** Lead.

### R06 · Effects too heavy for 1 GB sticks — 12 Medium
- **Cause:** 1 GB RAM, G310 / GE8300 GPUs ✅[P1]. Amazon memory and startup KPIs ✅[P6][P7]. Skia v3 not on Android TV, and no Skia on Vega ✅[P15][P4].
- **Impact:** Stutter or out-of-memory kills (Vega kills at 420 MB 🟡).
- **Mitigation:** Quality tiers. Baseline of Reanimated + SVG + Lottie. ≤ 100 animated views ✅[P16]. On-device performance runs at P1 (spike) and P5. Static fallbacks.
- **Owner:** Lead.

### R08 · Trademark and naming — 12 Medium
- **Cause:** Apple 4.1(c) and 5.2.1 ✅[P21]. Autodarts is a brand owned by the Nodor group 🟡.
- **Impact:** Store rejection or takedown.
- **Mitigation:** Own product name (Q5). Repo name stays internal. No Autodarts logos. "Works with Autodarts" only with permission.
- **Owner:** Owner.

### R18 · React Native version skew and library gaps — 12 Medium
- **Cause:**
  - The Expo TV path follows the `react-native-tvos` fork ✅[P12][P13].
  - Vega runs RN 0.72, with 0.83 in early access ✅[P3].
  - Amazon advises staying within 4–6 RN minors ✅[P10].
  - Library sets differ (no Skia or mDNS on Vega) ✅[P4].
- **Impact:** Shared UI code breaks on one target; upgrades stall.
- **Mitigation:**
  - Pure-TS core is unaffected.
  - `ui-kit` limited to libraries available on all targets.
  - Version ADR in P1 (candidate: Expo SDK 56 + `react-native-tvos@0.85-stable`).
  - Pinned dependencies and a scheduled upgrade window.
- **Owner:** Lead.

### R21 · Scope vs capacity — 12 Medium
- **Cause:** Five device classes, two TV OSes, original art and sound.
- **Impact:** Slipping phases; untested targets.
- **Mitigation:**
  - Phase gates.
  - Vega and the companion deferred to P6 unless Q1 says otherwise.
  - Minimum device lab: iPhone, iPad, Android phone, Fire OS stick (+ Vega stick).
  - Simulator-driven automation.
- **Owner:** Owner + Lead.

### R12 · Board depends on the internet / Autodarts cloud — 9 Medium
- **Cause:** "Necessary because of the structure Autodarts is built on" ✅[S4]. Auth uptime was 98.89 % for Jul–Oct 2026 ✅[S8].
- **Mitigation:**
  - Clear board-status messaging.
  - Manual mode.
  - P1 tests board behaviour with the internet unplugged 🔬.
  - Accept the residual risk.
- **Owner:** Lead.

### R13 · Stuck-takeout bug — 9 Medium
- **Cause:** 2.0.2 can stick at "Takeout in progress" with no darts 🟡[C12].
- **Mitigation:** Detect after 8 s and show a banner. Reset only via opt-in `POST /api/reset`. Re-check on each board version.
- **Owner:** Lead.

### R14 · iOS Local Network permission / ATS — 9 Medium
- **Cause:** The prompt appears on the first LAN connect, and the first attempt may fail. Silent denial in the background. ATS blocks IP addresses by default ✅[P17][P18].
- **Mitigation:**
  - An explainer before the prompt.
  - Retry.
  - A Settings deep link.
  - `NSLocalNetworkUsageDescription`, `NSAllowsLocalNetworking` and `NSBonjourServices`.
  - Tested on device in P1.
- **Owner:** Lead.

### R16 · App suspension drops the socket — 9 Medium
- **Cause:** iOS defuncts sockets when suspended 🟡. Doze on Android phones ✅.
- **Mitigation:** Keep-awake during games, pause on background, resync on foreground (§6.4). Darts thrown while suspended come back as `recovered`.
- **Owner:** Lead.

### R19 · App Review rejection — 9 Medium
- **Cause:** Rule 2.1 needs a demo mode or the hardware. Rule 4.2 rejects repackaged websites ✅[P21].
- **Mitigation:** Native React Native UI, a simulator demo mode, a review video and notes.
- **Owner:** Lead.

### R23 · Asset and game-design IP — 9 Medium
- **Cause:** The brief is "inspired by BattleUp". Generated or found assets have unclear provenance.
- **Mitigation:**
  - Original names and mechanics, checked against BattleUp's public catalogue.
  - A style guide.
  - An `ASSETS.md` provenance log (author, tool, licence).
  - Review the terms of any AI generation tool.
- **Owner:** Owner.

### R26 · Concurrent consumers of the same darts — 9 Medium
- **Cause:** The board doesn't know about Arcade. An Autodarts match, Lens or another integration may run at the same time ⚪.
- **Mitigation:** Guidance in W0/W2. The board must be clear at start. A warning if unexpected darts appear between turns.
- **Owner:** Lead.

### R17 · Board secrets exposure — 8 Medium
- **Cause:** `/api/config` and `/api/system` return the board API key and TLS key 🟡[C2].
- **Mitigation:** A transport endpoint allowlist with a build-failing test. Diagnostics contain only allowlisted data. No Autodarts credentials are ever handled.
- **Owner:** Lead.

### R15 · Android cleartext / local-network permission — 6 Low
- **Cause:** Cleartext is blocked by default on API 28+. Android 17 adds `ACCESS_LOCAL_NETWORK` for apps targeting API 37 ✅[P19][P20].
- **Mitigation:** `usesCleartextTraffic`. Plan the permission flow before raising the target SDK. The `NsdManager` picker for discovery.
- **Owner:** Lead.

### R25 · Companion pairing friction / Vega — 6 Low
- **Mitigation:** The companion is optional. QR plus a one-time token. The TV remote covers every flow on its own.
- **Owner:** Lead.

### R20 · Clock skew — 4 Low
- **Mitigation:** Ordering by host `seq` only. Timestamps are kept for diagnostics and stats (by design, ARCHITECTURE §7.1).
- **Owner:** Lead.

### R22 · Inaccurate brief propagates — 4 Low · Mitigated
- **What happened:** "ludarts" did not exist. The brief predated Autodarts 2.x and conflicted with the native-app requirement.
- **Mitigation:** Phase 0 verification, the evidence legend, and re-checking 🟡/⚪ items at each gate.
- **Owner:** Lead.

### R24 · Player personal data — 4 Low
- **Mitigation:** Data stays on-device. No accounts or analytics in v1. Delete-profile controls. Privacy label "Data Not Collected".
- **Owner:** Lead.
