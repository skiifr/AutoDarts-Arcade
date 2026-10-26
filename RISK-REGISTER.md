# AutoDarts Arcade — Technical Risk Register (initial, Phase 0)

> **Last reviewed:** 2026-10-26. Re-scored after the owner confirmed:
> - **private home use**, with permission from Autodarts staff (owner-attested);
> - a **Fire TV Stick 4K Max** as the TV;
> - **TestFlight** on a paid Apple Developer account for iOS;
> - the **Pi 4 is kept through Phase 5**, with an upgrade only if the H1 review proves the need.
> Review at every phase gate in [ROADMAP.md](ROADMAP.md).
> **Evidence:** ✅ verified · 🟡 community-reported · ⚪ assumption. Source IDs ([S#], [C#], [P#]) refer to [ARCHITECTURE.md §12](ARCHITECTURE.md#12-sources).
> **Scoring:** Likelihood (L) and Impact (I) are each rated 1–5. Score = L × I. **High ≥ 15**, Medium 8–14, Low ≤ 7.
> **Roles:** *Owner* = project owner (decisions, purchases, contact with Autodarts); *Lead* = development lead.

## Summary (sorted by score)

| ID | Risk | Category | Evidence | L | I | Score | Phase | Status |
|---|---|---|---|---|---|---|---|---|
| R01 | Undocumented local API changes, closes or adds auth (auto-updates) | Integration | ✅ | 4 | 5 | **20 High** | P1→ongoing | Open |
| R09 | Misdetected darts decide game outcomes | Product | 🟡 | 4 | 4 | **16 High** | P2–P4 | Open |
| R10 | ID-less snapshot stream leads to lost or duplicated darts on reconnect | Integration | 🟡 | 4 | 4 | **16 High** | P2 | Open |
| R11 | Pi 4 undersized for detection (dropped FPS, missed darts) | Hardware | ✅ | 4 | 4 | **16 High** | P1–P5 → H1 | **Accepted through P5**; decided at H1 |
| R02 | Autodarts 2.x local stream may not carry throws at all | Integration | 🟡 | 3 | 5 | **15 High** | P1 (G1) | Open |
| R06 | Effects too heavy for the 4K Max (2 GB, GE9215) | Performance | ✅/⚪ | 3 | 3 | 9 Med | P5 | Open |
| R12 | Board needs the internet / Autodarts cloud to start | Dependency | ✅ | 3 | 3 | 9 Med | P1 | Accept + mitigate |
| R13 | 2.0.2 stuck-takeout bug | Integration | 🟡 | 3 | 3 | 9 Med | P2 | Open |
| R14 | iOS Local Network permission / ATS blocks the board | Platform | ✅ | 3 | 3 | 9 Med | P1 | Open |
| R16 | App suspension drops the socket, so darts are missed | Platform | 🟡 | 3 | 3 | 9 Med | P2 | Open |
| R18 | React Native / `react-native-tvos` fork lag and library gaps | Tech stack | ✅ | 3 | 3 | 9 Med | P1→P6 | Open |
| R21 | Scope vs capacity: four device classes, original art and sound | Delivery | ⚪ | 3 | 3 | 9 Med | all | Open |
| R26 | An Autodarts match or other tool consumes the same darts concurrently | Integration | ⚪ | 3 | 3 | 9 Med | P2 / P4 | Open |
| R17 | Board API key / TLS key exposed via `/api/config` and `/api/system` | Security | 🟡 | 2 | 4 | 8 Med | P2 | Open |
| R15 | Android cleartext rules / Android 17 local-network permission | Platform | ✅ | 2 | 3 | 6 Low | P1 | Open |
| R27 | Fire OS sideload friction (iOS resolved: TestFlight on a paid account) | Distribution | ✅/🟡 | 2 | 3 | 6 Low | P1 / P6 | Open |
| R03 | Autodarts ToS: third-party / commercial use | Legal | ✅ + owner-attested | 1 | 5 | 5 Low | P0 | **Mitigated:** private use, staff permission |
| R04 | Fire TV fragmentation (Vega sticks can't run the Android build) | Platform | ✅ | 1 | 4 | 4 Low | — | **Resolved for current hardware** |
| R20 | Clock skew corrupts ordering | Data | ⚪ | 2 | 2 | 4 Low | P2 | Mitigated by design |
| R22 | Inaccurate brief (hallucinated projects) propagates | Process | ✅ | 2 | 2 | 4 Low | P0 | **Mitigated** |
| R23 | Asset / game-design originality | IP | ⚪ | 2 | 2 | 4 Low | P5 | Open (project principle) |
| R24 | Player personal data (names, stats, avatars) | Privacy | ⚪ | 2 | 2 | 4 Low | P4 | Mitigated by design |
| R25 | Companion pairing friction | Product | ⚪ | 2 | 2 | 4 Low | P6 | Open |
| R05 | Vega LAN capabilities unknown | Platform | ⚪ | 3 | 1 | 3 Low | backlog | Deferred |
| R07 | GPL-3.0 vs app-store distribution | Legal | ✅ | 1 | 2 | 2 Low | backlog | N/A for private installs |
| R08 | Trademark: "AutoDarts" in app name | Legal | ✅ | 1 | 2 | 2 Low | backlog | N/A for private installs |
| R19 | App Review rejects a hardware-dependent app | Release | ✅ | 1 | 1 | 1 Low | backlog | N/A for private installs |

---

## Details

### R01 · Undocumented local API changes, closes or adds auth — 20 High
- **Cause:** Arcade depends on the `:3180` local API, which Autodarts calls "not supported from version 2 on" ✅[S1]. Board software auto-updates (Velopack) ✅[S7], so a change can arrive overnight.
- **Impact:** Arcade stops scoring until the adapter is fixed.
- **Mitigation:**
  - Everything goes through `autodarts-local`, with version-specific profiles.
  - Golden fixtures and a 30-minute re-check runbook (ROADMAP P6).
  - Board-version watch in the app.
  - Manual mode is always available.
  - Find out in P1 whether auto-update can be paused 🔬.
  - Use your Discord contact with Autodarts staff to ask about upcoming local-API changes.
- **Early warning:** `/api/version` changes; `SourceAnomaly` events; fixture replay drift.
- **Owner:** Lead (Owner for staff contact).

### R09 · Misdetections decide outcomes — 16 High
- **Cause:** Camera detection isn't perfect. A Pi 4 field report saw only 2 of 3 darts detected at low FPS 🟡[C14]. Party games amplify single errors.
- **Impact:** Players stop trusting the scores.
- **Mitigation:**
  - Correction-first design: W4 reached in ≤ 5 presses, with preview, and any dart correctable.
  - Results stay **provisional** until the next action.
  - "Needs review" flags.
  - `missingDartsAreMisses` house rule.
  - Replay makes corrections exact.
- **Early warning:** Correction rate per session (logged locally).
- **Owner:** Lead.

### R10 · Lost or duplicated darts from an ID-less snapshot stream — 16 High
- **Cause:** No throw IDs or sequence numbers, a silent socket, and takeouts that may happen while offline 🟡[C3].
- **Impact:** Wrong scores, or double-counted darts.
- **Mitigation:**
  - Snapshot diff with `(visitKey, index)` idempotency.
  - Liveness polling.
  - Resync with inferred takeouts (ARCHITECTURE §6.4).
  - Reconciliation (owner decision R):
    - darts recovered within the same visit are scored as `recovered`, and the turn is flagged `needsReview` without a pause;
    - an inferred takeout ends the turn `needsReview`, pads no misses, and pauses the game until a person confirms the turn (`ConfirmTurn` → `TurnReviewed`);
    - a session can't close as completed while a flagged turn is unconfirmed.
  - P2 chaos suite: 1,000 runs, zero silent mismatches, and a review pause after every inferred takeout.
- **Early warning:** Chaos-suite failures; `needsReview` frequency at home.
- **Owner:** Lead.

### R11 · Pi 4 undersized for detection — 16 High
- **Cause:** Autodarts' own FAQ calls the Pi 4 "bleeding edge" ✅[S4]. A field report describes 3 cameras freezing at 0 FPS 🟡[C14].
- **Impact:** Missed darts and latency, which Arcade can't fix in software.
- **Owner decision (Q6):** Keep the Pi 4 through Phase 5. Upgrade only if the **H1 review** proves the need. Until then the risk is *accepted*, and the software absorbs it.
- **Mitigation through P5:**
  - Zero added Pi load (ADR-001).
  - Free tuning: headless operation, active cooling, 800×600 ✅[S4], and checks on calibration and lighting.
  - Correction-first UX and missed-dart recovery (R09, R10).
  - Board health shown in W1.
- **Evidence for H1:**
  - P1 baseline.
  - Board-health log on every session (ARCHITECTURE §9.7).
  - Repeat measurement after P5.
  - Thresholds in ROADMAP H1: > 5 % missed on-board or misread darts, cameras < 10 fps for > 10 % of game time, any throttling, or median latency > 1 s.
- **Exit:** H1 decides upgrade or no upgrade. A Pi 5 or mini PC needs no app change and is verified by re-running the golden fixtures.
- **Early warning:** Rising correction rate in the health log; camera FPS dips; throttling flags.
- **Owner:** Owner (hardware decision at H1), Lead (measurement).

### R02 · Autodarts 2.x local stream may not carry throws — 15 High
- **Cause:** Sources disagree. HomeDarts and DartLab report throws on 2.0.2 🟡[C2][C3]. ioBroker says 2.x "no longer provides throw data" 🟡[C4].
- **Impact:** The core integration path is gone.
- **Mitigation:** Gate **G1** at the start of P1. The contingencies are, in order:
  1. Pin the board version.
  2. Ask Autodarts staff how to read throws locally on 2.x.
  3. Fall back to a manual-entry arcade (ROADMAP P1).
- **Early warning:** The P1 probe shows `state` frames without `throws` after a throw.
- **Owner:** Lead.

### R06 · Effects too heavy for the 4K Max — 9 Medium
- **Cause:** 2 GB RAM, GE9215 GPU ✅[P1]. Amazon's memory and startup KPIs ✅[P7]. Skia v3 doesn't support Android TV, leaving only v2 ✅[P15]. No Fire-TV-specific animation benchmarks exist ⚪.
- **Impact:** Stutter during celebrations; a slow app launch.
- **Mitigation:**
  - Standard quality tier.
  - Reanimated + SVG + Lottie baseline.
  - ≤ 100 animated views ✅[P16].
  - On-device performance runs in P1 (skeleton) and P5.
  - Static fallbacks.
- **Owner:** Lead.

### R12 · Board depends on the internet / Autodarts cloud — 9 Medium
- **Cause:** "Necessary because of the structure Autodarts is built on" ✅[S4]. Auth uptime was 98.89 % for Jul–Oct 2026 ✅[S8].
- **Mitigation:** Clear board-status messaging and manual mode. P1 tests the board with the internet unplugged 🔬. Accept the residual risk.
- **Owner:** Lead.

### R13 · Stuck-takeout bug — 9 Medium
- **Cause:** 2.0.2 can stick at "Takeout in progress" with no darts on the board 🟡[C12].
- **Mitigation:**
  - Detect after 8 s and show a banner telling the player to reset the board from Autodarts' own app.
  - The banner offers *Enter manually*, so the game can go on meanwhile.
  - Arcade never sends a reset, because it never writes to the board (owner decision S).
  - Re-check on each board version.
- **Owner:** Lead.

### R14 · iOS Local Network permission / ATS — 9 Medium
- **Cause:**
  - The prompt appears on the first LAN connect, and the first attempt may fail.
  - Silent denial in the background.
  - ATS blocks IP addresses by default ✅[P17][P18].
- **Mitigation:**
  - Explainer screen before the prompt.
  - Retry.
  - Deep link to Settings.
  - `NSLocalNetworkUsageDescription`, `NSAllowsLocalNetworking` and `NSBonjourServices`.
  - Tested on device in P1.
- **Owner:** Lead.

### R16 · App suspension drops the socket — 9 Medium
- **Cause:** iOS defuncts sockets when the app is suspended 🟡. Doze applies on Android phones ✅.
- **Mitigation:** Keep the screen awake during games, pause on background, resync on foreground (§6.4). Darts thrown while suspended come back as `recovered`.
- **Owner:** Lead.

### R18 · React Native / TV-fork lag and library gaps — 9 Medium
- **Cause:** The Expo TV path follows the `react-native-tvos` fork ✅[P12][P13], which can lag upstream React Native. Not every library supports TV.
- **Mitigation:**
  - The pure-TS core is unaffected.
  - `ui-kit` only uses libraries Expo lists for TV ✅[P13].
  - Version ADR in P1 (candidate: Expo SDK 56 + `react-native-tvos@0.85-stable`).
  - Pinned dependencies and a scheduled upgrade window.
- **Owner:** Lead.

### R21 · Scope vs capacity — 9 Medium
- **Cause:** iPhone, iPad, Android and Fire TV, plus original art and sound. Vega is no longer in scope.
- **Mitigation:**
  - Phase gates.
  - The companion is optional (P6).
  - Device lab is your own devices plus an Android emulator.
  - Simulator-driven automation.
- **Owner:** Owner + Lead.

### R26 · Concurrent consumers of the same darts — 9 Medium
- **Cause:** The board doesn't know about Arcade. An Autodarts match, Lens or another integration could run at the same time ⚪.
- **Mitigation:** Guidance in W0 and W2. The board must be clear at game start. A warning if unexpected darts appear between turns.
- **Owner:** Lead.

### R27 · Fire OS sideload friction — 6 Low
- **iOS: resolved.** The owner has a paid Apple Developer account, and TestFlight internal testing is the route. The only routine task is uploading a fresh build at least every 90 days 🟡[P27]. That is an operational step, not a risk, and EAS Build + Submit can automate it ⚪.
- **Cause (Fire OS):**
  - Sideloading needs Developer Options, ADB debugging and Apps from Unknown Sources ✅[P26].
  - Developer Options is hidden on recent Fire OS versions and reappears after 7 presses on *About* ✅[P26].
  - Amazon could tighten sideloading on Fire OS ⚪. Newer Vega sticks already block it 🟡[P11].
- **Impact:** A Fire OS update makes reinstalling or updating the TV app harder.
- **Mitigation:**
  - `docs/install.md` with exact `adb` steps.
  - Keep the last good APK archived.
  - Re-check Developer Options after Fire OS updates.
  - Fallback: the iPad becomes the display, mirrored to the TV if wanted ⚪.
- **Early warning:** Developer Options missing after a Fire OS update.
- **Owner:** Owner (devices), Lead (docs).

### R17 · Board secrets exposure — 8 Medium
- **Cause:** `/api/config` and `/api/system` return the board API key and TLS key 🟡[C2].
- **Mitigation:** A transport endpoint allowlist enforced by a build-failing test. Diagnostics contain only allowlisted data. No Autodarts credentials are ever handled.
- **Owner:** Lead.

### R15 · Android cleartext / local-network permission — 6 Low
- **Cause:** Cleartext traffic is blocked by default on API 28+. Android 17 adds `ACCESS_LOCAL_NETWORK` for apps targeting API 37 ✅[P19][P20]. This doesn't affect the 4K Max (Fire OS 7/8).
- **Mitigation:** `usesCleartextTraffic`. Plan the permission flow before raising the target SDK.
- **Owner:** Lead.

### R03 · Autodarts ToS: third-party and commercial use — 5 Low (mitigated)
- **Cause:** §3.2 restricts use to "private, non-commercial" purposes and bars "unauthorized … third-party software". §6.1 requires written authorization for commercial third-party use ✅[S3].
- **Why low now:**
  - Scope is **private home use** only.
  - The owner reports that Autodarts staff permitted it via their Discord *(owner-attested, not independently verified)*.
  - The design is local, read-only and cloud-free.
- **Remaining actions:**
  - Keep a screenshot or link of the staff permission with the project's private notes.
  - Re-check before any change of scope (sharing the app, venue use, cloud features).
- **Owner:** Owner.

### R04 · Fire TV fragmentation — 4 Low (resolved for current hardware)
- **Cause:** 4K Select 2025, HD 2026 and 4K 3rd gen 2026 run **Vega OS**, which can't run the Android build ✅[P1] 🟡[P11].
- **Why low now:** Your **4K Max runs Fire OS** ✅[P1].
- **Residual:** Any *replacement* stick bought later will likely be Vega 🟡[P11]. The pure-TS core keeps a Vega shell possible (ROADMAP backlog). Replacing with another Fire OS device, or using the iPad as the display, avoids it.
- **Owner:** Owner.

### R20 · Clock skew — 4 Low
- **Mitigation:** Order by host `seq` only. Timestamps are kept for diagnostics and stats (by design, ARCHITECTURE §7.1).
- **Owner:** Lead.

### R22 · Inaccurate brief propagates — 4 Low (mitigated)
- **What happened:** "ludarts" did not exist. The brief predated Autodarts 2.x and conflicted with the native-app requirement.
- **Mitigation:** Phase 0 verification, the evidence legend, and re-checking 🟡/⚪ items at each gate.
- **Owner:** Lead.

### R23 · Asset and game-design originality — 4 Low
- **Cause:** The brief is "inspired by BattleUp". Private use lowers the exposure, but originality is a stated project goal.
- **Mitigation:**
  - Original names and mechanics.
  - A style guide.
  - An `ASSETS.md` provenance log (author, tool, licence), which also keeps a future public release possible.
- **Owner:** Owner.

### R24 · Player personal data — 4 Low
- **Mitigation:** Data stays on the device. No accounts or analytics. Profiles can be deleted.
- **Owner:** Lead.

### R25 · Companion pairing friction — 4 Low
- **Mitigation:** The companion is optional. Pairing is a QR code with a one-time token. The TV remote covers every flow on its own.
- **Owner:** Lead.

### R05 · Vega LAN capabilities unknown — 3 Low (deferred)
- **Cause:** No documentation for native `ws://` to a LAN IP on Vega, and no mDNS library ✅[P4].
- **Why low now:** Vega is a backlog item (R04). If it is ever picked up, spike this first.
- **Owner:** Lead.

### R07 · GPL-3.0 vs app-store distribution — 2 Low (N/A for private installs)
- **Cause:** FSF and Apple terms conflict ✅[P24]. Amazon's agreement restricts certain copyleft combinations ✅[P22].
- **Why low now:** You are the sole copyright holder installing on your own devices, so your own licence doesn't restrict you.
- **Remaining rule:** Never copy code from NC, AGPL or unlicensed community repos (ARCHITECTURE §4.5). Before accepting outside contributions or publishing, add a GPLv3 §7 app-store exception ✅[P25].
- **Owner:** Owner.

### R08 · Trademark and naming — 2 Low (N/A for private installs)
- **Why low now:** Store naming rules (Apple 4.1(c), 5.2.1 ✅[P21]) apply only to listings. Revisit before any publication.
- **Owner:** Owner.

### R19 · App Review rejection — 1 Low (N/A for private installs)
- **Why low now:** There is no store submission. TestFlight builds for internal testers reportedly skip review 🟡[P27]. Demo mode stays useful for development.
- **Owner:** Lead.
