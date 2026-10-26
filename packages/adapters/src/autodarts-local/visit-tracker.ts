import { sameSegment, type Coords, type EventOf, type Segment } from '@arcade/event-schema';
import type { NormalizedThrow, SegmentAnomaly } from '../normalize';
import type { IdSource } from '../ports';
import { MAX_DARTS_PER_VISIT, isLifecycle, relate, takeoutBegins, type Snapshot } from './snapshot';

/**
 * Turns ID-less board snapshots into a reliable dart stream (ARCHITECTURE §6.2, §6.4,
 * owner decision R). Pure: no timers or I/O; the adapter feeds it snapshots and wraps
 * the facts it returns.
 *
 * - `known` holds the current visit's darts in board order, each with its own `throwId` and
 *   `indexInVisit`. Each listed dart is matched to a known dart by identity, not position:
 *   with coordinates (real 2.0.2 frames carry them) by where it sits, so when the board
 *   withdraws a dart that is not the last one, that dart is withdrawn and every other keeps
 *   its id. Without coordinates the match goes by order and segment; when the board
 *   removes a dart that is not the last one, or the match is otherwise a guess, the darts left
 *   are flagged `pendingReview` (decision R). A re-delivered snapshot matches every dart and
 *   adds nothing (idempotency). A new dart takes the lowest `indexInVisit` free in its visit.
 * - `live` snapshots (frames and polls while online) follow §6.2.
 * - `resync` snapshots (the first observation after a (re)connect) follow §6.4 and
 *   decision R: darts first seen there are `recovered`, and whenever a takeout may have
 *   happened offline the tracker emits `TakeoutFinished{inferred:true}`. It never invents
 *   misses. A takeout may have happened when known darts are missing from the snapshot
 *   (always), or, with no darts known, when the board was out of sight long enough for a
 *   whole visit to come and go (`MIN_UNSEEN_VISIT_MS`): a short Wi-Fi blip on an empty
 *   visit infers nothing, and darts thrown during it continue the visit.
 * - `classifyFrame` tells the adapter which WebSocket frames are plain progress and
 *   which would retract, change or replace known darts; those are confirmed with a
 *   `GET /api/state` first, so a late or duplicated frame can never withdraw or
 *   re-add a dart.
 * - A dart whose segment cannot be read is reported as a miss with `pendingReview: true`
 *   (§7.3), and the fact carries the anomaly so the adapter can log a correlated
 *   `SourceAnomaly` for diagnostics.
 * - A new visit whose first darts sit exactly where the last visit's darts were (same
 *   segment, within `SAME_DART_TOLERANCE`) may be that visit reappearing or new darts in the
 *   same holes. The tracker cannot tell, so it counts them with `pendingReview: true` and a
 *   `SourceAnomaly` (decision R): never dropped as a ghost, never counted silently.
 */

export interface KnownDart {
  throwId: string;
  segment: Segment;
  coords?: Coords;
  indexInVisit: number;
  /**
   * Counted where a dart of the last ended visit was: it may be that dart reappearing. Its
   * identity is in doubt, not its reading, so every later fact about it stays `pendingReview`.
   */
  suspectedGhost?: true;
  /**
   * The tracker could not be sure of this dart or of its visit: it was gone when a takeout was
   * first seen, or when a resync found one going on (pulled, or withdrawn by the board while we
   * were not looking); its visit, first seen in a takeout after an outage, had room for a dart
   * thrown and pulled unseen; it survived a call-off that dropped other darts; or it was matched
   * without coordinates when the board removed a dart that was not the last one. It was flagged
   * with a `DartUpdated{pendingReview}` (its segment unchanged when only the flag is news), and
   * every later fact about it stays `pendingReview`.
   */
  inDoubt?: true;
}

export interface VisitState {
  visitKey: string;
  known: KnownDart[];
  inTakeout: boolean;
  /** Darts of the last ended visits, newest first, to recognise them if they reappear. */
  recentVisits: KnownDart[][];
  /**
   * The last visit ended when its last dart came out, and the board still shows that takeout on
   * the empty board: that is not a new, empty takeout.
   */
  takeoutTail?: true;
  /**
   * The current visit had darts and the board withdrew them all: nothing of it is known, but its
   * reset or takeout still ends it.
   */
  allWithdrawn?: true;
  /**
   * The board's `event` when it was last read: after an outage, a different one says what
   * happened meanwhile. `rebuildVisitState` can only guess it from the last board fact.
   */
  boardEvent?: string;
}

export type TrackerFact =
  | { type: 'DartDetected'; payload: EventOf<'DartDetected'>['payload']; anomaly?: SegmentAnomaly }
  | { type: 'DartUpdated'; payload: EventOf<'DartUpdated'>['payload']; anomaly?: SegmentAnomaly }
  | { type: 'DartWithdrawn'; payload: EventOf<'DartWithdrawn'>['payload'] }
  | { type: 'TakeoutStarted'; payload: EventOf<'TakeoutStarted'>['payload'] }
  | { type: 'TakeoutFinished'; payload: EventOf<'TakeoutFinished'>['payload'] }
  | { type: 'VisitReset'; payload: EventOf<'VisitReset'>['payload'] }
  | { type: 'SourceAnomaly'; payload: EventOf<'SourceAnomaly'>['payload'] };

export type ApplyMode = 'live' | 'resync';

/**
 * The shortest time in which a whole visit can come and go unseen: someone throws one dart, the
 * board detects it, and the dart is pulled out. No visit is shorter than 3 s, first dart to last
 * dart out (owner decision; the simulations' visits are no shorter either). A resync with no
 * known darts infers a takeout only if the board was out of sight at least this long; shorter
 * outages cannot hide one. The adapter measures every outage from at least `LINK_LOSS_MS` before
 * the connection ended (a crash included), so it never comes out shorter than the time the board
 * was out of sight, and a hidden visit measures at least this plus that second.
 *
 * It was 5 s, then 2 s. At 2 s a quick crash-relaunch on an idle board measured as a hidden
 * visit: its stored contact is up to `LINK_LOSS_MS` plus the runtime's heartbeat old. At 3 s a
 * relaunch within 1.5 s with a fresh contact measures at most about 2.8 s.
 */
export const MIN_UNSEEN_VISIT_MS = 3000;

const RECENT_VISITS = 2;

function copyDart(d: KnownDart): KnownDart {
  return d.coords ? { ...d, coords: { ...d.coords } } : { ...d };
}

export class VisitTracker {
  private readonly ids: IdSource;
  private s: VisitState;
  /** False until the first snapshot, unless a state was restored. */
  private observed: boolean;
  private changes = 0;
  /** The board `event` of the last applied snapshot, to tell a new event from a repeat. */
  private lastEvent: string | undefined;
  /** The current takeout was first seen with the darts already gone: its final list is unverified. */
  private blindTakeout = false;
  /**
   * The last dart came out and ended the visit, but the board still shows its takeout on the
   * empty board (darts pulled one at a time, before "Takeout finished"). That is the end of the
   * same takeout, not a new, empty one.
   */
  private takeoutTail: boolean;
  /** The current visit has had darts, even if the board withdrew them all since. */
  private hadDarts: boolean;

  constructor(ids: IdSource, restored?: VisitState) {
    this.ids = ids;
    this.observed = restored !== undefined;
    this.s = restored
      ? {
          visitKey: restored.visitKey,
          known: restored.known.map(copyDart),
          inTakeout: restored.inTakeout,
          recentVisits: restored.recentVisits.map((v) => v.map(copyDart)),
        }
      : { visitKey: ids(), known: [], inTakeout: false, recentVisits: [] };
    this.takeoutTail = restored?.takeoutTail === true;
    this.hadDarts = restored !== undefined && (restored.known.length > 0 || restored.allWithdrawn === true);
    this.lastEvent = restored?.boardEvent;
  }

  /** A copy of the current visit state (for diagnostics and tests). */
  state(): VisitState {
    const s: VisitState = {
      visitKey: this.s.visitKey,
      known: this.s.known.map(copyDart),
      inTakeout: this.s.inTakeout,
      recentVisits: this.s.recentVisits.map((v) => v.map(copyDart)),
    };
    if (this.takeoutTail) s.takeoutTail = true;
    if (this.hadDarts && this.s.known.length === 0) s.allWithdrawn = true;
    if (this.lastEvent !== undefined) s.boardEvent = this.lastEvent;
    return s;
  }

  /** Increments whenever an applied snapshot changed the state. */
  get changeCount(): number {
    return this.changes;
  }

  get hasObserved(): boolean {
    return this.observed;
  }

  /** Whether a WebSocket frame is plain progress (`apply`) or must be confirmed by a poll. */
  classifyFrame(snap: Snapshot): 'apply' | 'confirm' {
    const K = this.s.known;
    const T = snap.throws;
    if (!this.observed) return 'confirm';
    if (snap.event === 'Manual reset' && (K.length > 0 || this.s.inTakeout || this.hadDarts)) return 'confirm';
    if (T.length === 0) {
      if (this.s.inTakeout) return 'apply';
      if (K.length === 0) return this.missedTakeout(snap) ? 'confirm' : 'apply';
      return 'confirm';
    }
    if (K.length === 0) return this.s.inTakeout || this.ghostCount(T) > 0 ? 'confirm' : 'apply';
    if (this.s.inTakeout) {
      // Calling the takeout off on a late frame from before it began would re-arm withdrawals.
      if (!takeoutBegins(snap)) return 'confirm';
      return T.length <= K.length && this.allKnown(T) ? 'apply' : 'confirm';
    }
    const extendsKnown = T.length >= K.length && K.every((k, i) => relate(k, T[i] as NormalizedThrow) === 'same');
    return extendsKnown ? 'apply' : 'confirm';
  }

  /**
   * `awayMs` (resync only): how long the board was out of sight before this snapshot, from the
   * last good contact. Unknown (undefined) counts as long enough to hide a whole visit.
   */
  apply(snap: Snapshot, mode: ApplyMode, awayMs?: number): TrackerFact[] {
    const out: TrackerFact[] = [];
    if (snap.throws.length > 0) this.takeoutTail = false;
    if (mode === 'resync' || !this.observed) this.applyResync(snap, out, awayMs);
    else this.applyLive(snap, out);
    if (!takeoutBegins(snap)) this.takeoutTail = false; // the board has left that takeout
    this.observed = true;
    this.lastEvent = snap.event;
    if (out.length > 0) this.changes++;
    return out;
  }

  // ── live (§6.2) ─────────────────────────────────────────────────────────

  private applyLive(snap: Snapshot, out: TrackerFact[]): void {
    const T = snap.throws;
    if (snap.event === 'Manual reset' && (this.s.known.length > 0 || this.s.inTakeout || this.hadDarts)) {
      out.push({ type: 'VisitReset', payload: { visitKey: this.s.visitKey, reason: 'manual-reset' } });
      this.withdrawFrom(out, 0);
      this.newVisit();
    }
    const K = this.s.known;
    if (T.length === 0) {
      if (K.length === 0) {
        if (this.s.inTakeout && !takeoutBegins(snap)) this.finishTakeout(out, false);
        else if (this.missedTakeout(snap)) this.finishTakeout(out, true);
      } else if (this.s.inTakeout) {
        // The last dart is out: the visit is over, even if the board still shows the takeout.
        this.finishTakeout(out, this.blindTakeout);
        if (takeoutBegins(snap)) this.takeoutTail = true;
      } else if (snap.event === 'Takeout finished') {
        // A takeout we never saw start: darts thrown before it may be missing too.
        this.finishTakeout(out, true);
      } else if (isLifecycle(snap)) {
        // The board restarted or recalibrated and dropped its list: not an observed takeout.
        this.finishTakeout(out, true);
      } else if (takeoutBegins(snap)) {
        // A takeout we first see with the darts already gone: we never saw its final list.
        this.blindTakeout = true;
      } else {
        // The board retracted every dart outside a takeout.
        this.withdrawFrom(out, 0);
      }
    } else if (K.length === 0) {
      if (this.s.inTakeout) {
        // The takeout we saw start ended unseen, and new darts are already in.
        this.finishTakeout(out, true);
        this.detectFrom(out, T, 0, true);
      } else {
        this.detectFrom(out, T, 0, false, this.flagGhosts(out, T));
      }
    } else if (this.s.inTakeout) {
      this.diffDuringTakeout(snap, out, 'live');
    } else if (takeoutBegins(snap)) {
      // Status first: darts missing from a takeout are being removed, not withdrawn.
      this.takeoutSeen(snap, out, 'live');
    } else {
      this.diffOrInfer(out, T, 'live');
    }
    this.beginTakeoutIfNeeded(snap, out);
  }

  /**
   * A "Takeout finished" we did not see start, on an empty visit: an empty takeout or a
   * whole visit whose frames were lost. Repeats of the same state (idle polls) are not.
   */
  private missedTakeout(snap: Snapshot): boolean {
    return (
      !this.s.inTakeout &&
      !this.takeoutTail &&
      snap.event === 'Takeout finished' &&
      this.lastEvent !== undefined &&
      this.lastEvent !== 'Takeout finished'
    );
  }

  private allKnown(T: readonly NormalizedThrow[]): boolean {
    return T.every((t) => this.s.known.some((k) => relate(k, t) === 'same'));
  }

  // ── resync (§6.4, decision R) ─────────────────────────────────────────────

  private applyResync(snap: Snapshot, out: TrackerFact[], awayMs: number | undefined): void {
    const T = snap.throws;
    const K = this.s.known;
    const wholeVisitFits = awayMs === undefined || awayMs >= MIN_UNSEEN_VISIT_MS;
    if (!this.observed) {
      // First contact with no history: whatever is on the board is a baseline.
      this.detectFrom(out, T, 0, true);
    } else if (T.length === 0 && K.length > 0) {
      // Known darts are gone: a takeout may have happened while we were away.
      this.finishTakeout(out, true);
    } else if (T.length === 0) {
      // Nothing was on the board and nothing is: a whole visit may have come and gone, if we were
      // away long enough for one, or if the board's own event says one ended meanwhile.
      if (wholeVisitFits || this.boardMovedOn(snap)) this.finishTakeout(out, true);
      else this.endEmptyTakeout(snap);
    } else if (K.length === 0) {
      // Nothing known proves the visit went on: a whole visit may have come and gone, unless we
      // were not away long enough for one. Darts where the last visit's darts were prove nothing
      // either way: they are counted, flagged.
      const ghosts = this.s.inTakeout ? 0 : this.ghostCount(T);
      if (wholeVisitFits) this.finishTakeout(out, true);
      else this.endEmptyTakeout(snap);
      this.detectFrom(out, T, 0, true, this.flagGhosts(out, T, ghosts));
    } else if (this.s.inTakeout) {
      this.diffDuringTakeout(snap, out, 'resync');
    } else if (takeoutBegins(snap)) {
      // Status first: darts missing from a takeout are being removed, not withdrawn.
      this.takeoutSeen(snap, out, 'resync');
    } else {
      this.diffOrInfer(out, T, 'resync');
    }
    this.beginTakeoutIfNeeded(snap, out);
  }

  // ── identity: which listed dart is which known dart ─────────────────────────

  /**
   * Matches a snapshot of the current visit to the known darts, or returns null when it is not
   * this visit's darts (a visit ended unseen). With coordinates on every dart the match is by
   * place, and certain. Without them it is by order and segment, and a guess whenever the board
   * removed a dart that was not the last one, or re-read more than one dart at once.
   *
   * `resync`: after an outage the visit goes on only if the first listed dart is exactly a known
   * dart (with coordinates), or every known dart is still listed first, unchanged (§6.4's literal
   * rule, without them).
   */
  private align(T: readonly NormalizedThrow[], mode: ApplyMode): Alignment | null {
    const K = this.s.known;
    if (K.every((k) => k.coords) && T.every((t) => t.coords)) return this.alignByPlace(T, mode);
    if (mode === 'resync') {
      const prefix = K.length <= T.length && K.every((k, i) => relate(k, T[i] as NormalizedThrow) === 'same');
      return prefix ? { toKnown: positions(T.length, K.length), doubtful: false } : null;
    }
    if (T.length >= K.length) {
      let unknown = 0;
      let mismatched = false;
      for (let i = 0; i < K.length; i++) {
        const k = K[i] as KnownDart;
        const t = T[i] as NormalizedThrow;
        const r = relate(k, t);
        if (r === 'other') return null;
        if (r === 'unknown') unknown++;
        if (!k.coords !== !t.coords) mismatched = true;
      }
      // One re-read is the board changing its mind; several at once may as well be darts
      // withdrawn and others thrown; a dart that lost or gained its coordinates is not one we know.
      return { toKnown: positions(T.length, K.length), doubtful: unknown > 1 || mismatched };
    }
    // Fewer darts: which ones went? Unchanged darts can be matched by segment in order; only the
    // last darts gone, and no other way to match, is plain.
    const ways = embeddings(K, T, 2);
    const first = ways[0];
    if (first) {
      const lastGone = first.every((j, i) => j === i);
      return { toKnown: first, doubtful: ways.length > 1 || !lastGone };
    }
    // A removal and a re-read at once: by position, as long as the first dart is still there.
    if (relate(K[0] as KnownDart, T[0] as NormalizedThrow) !== 'same') return null;
    if (T.some((t, i) => relate(K[i] as KnownDart, t) === 'other')) return null;
    return { toKnown: positions(T.length, T.length), doubtful: true };
  }

  /** Every dart has coordinates: a listed dart is the known dart in the same place, or nearly (re-read). */
  private alignByPlace(T: readonly NormalizedThrow[], mode: ApplyMode): Alignment | null {
    const K = this.s.known;
    const toKnown = T.map(() => -1);
    const used = new Set<number>();
    T.forEach((t, i) => {
      const j = K.findIndex((k, jj) => !used.has(jj) && relate(k, t) === 'same');
      if (j < 0) return;
      toKnown[i] = j;
      used.add(j);
    });
    T.forEach((t, i) => {
      if (toKnown[i] !== -1) return;
      let best = -1;
      let bestDistance = Infinity;
      K.forEach((k, j) => {
        if (used.has(j) || relate(k, t) !== 'updated') return;
        const d = distance(k.coords as Coords, t.coords as Coords);
        if (d < bestDistance) {
          best = j;
          bestDistance = d;
        }
      });
      if (best < 0) return;
      toKnown[i] = best;
      used.add(best);
    });
    if (used.size === 0 || !inBoardOrder(toKnown)) return null;
    const exact = (i: number): boolean => {
      const j = toKnown[i] as number;
      return j >= 0 && relate(K[j] as KnownDart, T[i] as NormalizedThrow) === 'same';
    };
    // Only re-reads, and darts gone: more likely a new visit whose darts landed near the old ones.
    if (used.size < K.length && !T.some((_, i) => exact(i))) return null;
    if (mode === 'resync' && !exact(0)) return null;
    return { toKnown, doubtful: false };
  }

  /** A same-visit snapshot, or, if it is not this visit's darts, an inferred takeout and the darts recovered. */
  private diffOrInfer(out: TrackerFact[], T: readonly NormalizedThrow[], mode: ApplyMode, flagLeft = false): void {
    const a = this.align(T, mode);
    if (!a) {
      this.finishTakeout(out, true);
      this.detectFrom(out, T, 0, true);
      return;
    }
    this.diffVisit(out, T, a, mode === 'resync', flagLeft);
  }

  /**
   * Applies an alignment outside a takeout: known darts the board no longer lists are withdrawn
   * (it retracted them), matched darts are updated when re-read, and new darts are detected.
   * When the match was a guess, or `flagLeft`, the darts left are flagged pending review.
   */
  private diffVisit(out: TrackerFact[], T: readonly NormalizedThrow[], a: Alignment, recovered: boolean, flagLeft: boolean): void {
    const K = this.s.known;
    const kept = new Set(a.toKnown.filter((j) => j >= 0));
    K.forEach((k, j) => {
      if (!kept.has(j)) out.push({ type: 'DartWithdrawn', payload: { throwId: k.throwId } });
    });
    const doubt = a.doubtful || (flagLeft && kept.size < K.length);
    const next: KnownDart[] = [];
    T.forEach((t, i) => {
      const j = a.toKnown[i] as number;
      if (j >= 0) next.push(this.updated(out, K[j] as KnownDart, t, doubt));
    });
    this.s.known = next;
    T.forEach((t, i) => {
      if (a.toKnown[i] === -1) this.detect(out, t, recovered);
    });
  }

  /**
   * Darts come off in any order during a takeout: never update or withdraw then. After an
   * outage, though, darts gone may not all have been pulled: the board may have called the
   * takeout off, withdrawn a dart and begun another while we were away. They are kept, flagged.
   */
  private diffDuringTakeout(snap: Snapshot, out: TrackerFact[], mode: ApplyMode): void {
    const K = this.s.known;
    const T = snap.throws;
    if (!takeoutBegins(snap)) {
      // The board is back to throwing with darts listed: the takeout was called off (a hand in
      // front of the cameras that left the darts in). The visit goes on, so later withdrawals
      // are withdrawals again. Darts the board no longer lists were dropped from its
      // visit: withdrawn, as outside a takeout. They may have been pulled before the call-off,
      // so the darts left are flagged pending review.
      this.s.inTakeout = false;
      this.blindTakeout = false;
      this.diffOrInfer(out, T, mode, true);
      return;
    }
    if (T.length <= K.length) {
      if (this.allKnown(T)) {
        // A partial removal.
        if (mode === 'resync') {
          K.forEach((k, j) => {
            if (!T.some((t) => relate(k, t) === 'same')) this.flagInDoubt(out, j);
          });
        }
        return;
      }
      this.finishTakeout(out, true);
      this.detectFrom(out, T, 0, true);
      return;
    }
    if (K.every((k, i) => relate(k, T[i] as NormalizedThrow) === 'same')) {
      this.detectFrom(out, T, K.length, mode === 'resync');
      return;
    }
    this.finishTakeout(out, true);
    this.detectFrom(out, T, 0, true);
  }

  /**
   * A takeout seen for the first time with darts still listed (we missed its start: an outage,
   * or a lost frame). Darts come off during a takeout, so a known dart missing from the list was
   * pulled out, or was withdrawn by the board before the takeout began: nothing tells the two
   * apart. It is kept, not withdrawn, and flagged pending review (decision R). Darts the list has
   * and we do not are darts we missed before the takeout. A list that is not this visit's
   * darts, or that both lacks known darts and has new ones, means we cannot tell what happened:
   * an inferred takeout.
   *
   * After an outage, a visit with room for another dart may also have had one we never saw,
   * thrown and already pulled: then every dart of the visit is flagged. One throw, the walk to the
   * board and one pull take far less than a whole visit (`MIN_UNSEEN_VISIT_MS`), and no outage
   * the adapter measures is short enough to rule them out, so this holds after any outage.
   */
  private takeoutSeen(snap: Snapshot, out: TrackerFact[], mode: ApplyMode): void {
    const K = this.s.known;
    const T = snap.throws;
    const a = this.alignTakeout(T, mode);
    const kept = new Set(a?.toKnown.filter((j) => j >= 0));
    const fresh = a ? a.toKnown.filter((j) => j === -1).length : 0;
    if (!a || (fresh > 0 && kept.size < K.length)) {
      this.finishTakeout(out, true);
      this.detectFrom(out, T, 0, true);
      return;
    }
    a.toKnown.forEach((j, i) => {
      if (j >= 0) K[j] = this.updated(out, K[j] as KnownDart, T[i] as NormalizedThrow, false);
    });
    const unseenDartFits = mode === 'resync' && K.length + fresh < MAX_DARTS_PER_VISIT;
    K.forEach((_, j) => {
      if (!kept.has(j) || unseenDartFits) this.flagInDoubt(out, j);
    });
    T.forEach((t, i) => {
      if (a.toKnown[i] === -1) this.detect(out, t, mode === 'resync');
    });
  }

  /** Like `align`, for a takeout: known darts may be missing anywhere, never withdrawn. */
  private alignTakeout(T: readonly NormalizedThrow[], mode: ApplyMode): Alignment | null {
    const K = this.s.known;
    if (K.every((k) => k.coords) && T.every((t) => t.coords)) return this.alignByPlace(T, mode);
    const [first] = embeddings(K, T, 1);
    if (first) return { toKnown: first, doubtful: false };
    const extended = T.length > K.length && K.every((k, i) => relate(k, T[i] as NormalizedThrow) === 'same');
    return extended ? { toKnown: positions(T.length, K.length), doubtful: false } : null;
  }

  /** Flags a known dart pending review, once; its later facts stay flagged (`inDoubt`). */
  private flagInDoubt(out: TrackerFact[], j: number): void {
    const k = this.s.known[j] as KnownDart;
    if (k.inDoubt || k.suspectedGhost) return;
    const payload: EventOf<'DartUpdated'>['payload'] = { throwId: k.throwId, previous: k.segment, segment: k.segment, pendingReview: true };
    if (k.coords) payload.coords = k.coords;
    out.push({ type: 'DartUpdated', payload });
    this.s.known[j] = { ...k, inDoubt: true };
  }

  /**
   * A resync of an empty board, nothing known: the board's `event` (the last thing that happened
   * to it) changed while we were away to one that ends a visit, or to "Throw detected" with no
   * darts listed (darts thrown and withdrawn). Darts do not only leave by a takeout, so this is
   * evidence that a visit boundary may have passed, however short the outage. The end of an
   * empty takeout we saw start is not. A visit that had darts, all withdrawn, is still open, so
   * a board showing a reset or a finished takeout ended it, whatever its event was before.
   */
  private boardMovedOn(snap: Snapshot): boolean {
    const e = snap.event;
    if (e === undefined) return false;
    const ends = e === 'Manual reset' || e === 'Takeout finished';
    if (this.hadDarts && ends) return true;
    if (this.lastEvent === undefined || e === this.lastEvent) return false;
    if (e === 'Takeout finished') return !this.s.inTakeout;
    return ends || e === 'Throw detected';
  }

  /**
   * After a short outage on an empty visit: a takeout of the empty board we saw start (a hand
   * in front of the cameras, a stuck takeout) is over if the board no longer shows one. It
   * removed no darts, so it ends nothing.
   */
  private endEmptyTakeout(snap: Snapshot): void {
    if (this.s.inTakeout && !takeoutBegins(snap)) {
      this.s.inTakeout = false;
      this.blindTakeout = false;
    }
  }

  private beginTakeoutIfNeeded(snap: Snapshot, out: TrackerFact[]): void {
    if (takeoutBegins(snap) && !this.s.inTakeout && !this.takeoutTail) {
      out.push({ type: 'TakeoutStarted', payload: { visitKey: this.s.visitKey } });
      this.s.inTakeout = true;
    }
  }

  private finishTakeout(out: TrackerFact[], inferred: boolean): void {
    out.push({
      type: 'TakeoutFinished',
      payload: inferred ? { visitKey: this.s.visitKey, inferred: true } : { visitKey: this.s.visitKey },
    });
    this.newVisit();
  }

  private newVisit(): void {
    if (this.s.known.length > 0) {
      this.s.recentVisits.unshift(this.s.known);
      this.s.recentVisits.length = Math.min(this.s.recentVisits.length, RECENT_VISITS);
    }
    this.s.visitKey = this.ids();
    this.s.known = [];
    this.s.inTakeout = false;
    this.blindTakeout = false;
    this.takeoutTail = false;
    this.hadDarts = false;
  }

  /** Leading darts that are exactly the darts of the last ended visit. */
  private ghostCount(T: readonly NormalizedThrow[]): number {
    const prev = this.s.recentVisits[0];
    if (!prev) return 0;
    let j = 0;
    while (j < T.length && j < prev.length) {
      const t = T[j] as NormalizedThrow;
      const p = prev[j] as KnownDart;
      if (!t.coords || !p.coords || relate(p, t) !== 'same') break;
      j++;
    }
    return j;
  }

  /**
   * The first `n` darts of a new visit sit where the last ended visit's darts were. Either the
   * board put that visit back (a takeout called off after we reported it, or a stale read) or
   * new darts landed in the same holes; coordinates cannot tell the two apart. Dropping them
   * would lose real darts silently, so they are counted with `pendingReview` (decision R) and
   * a person voids them if they were the old darts. Returns the number of darts to flag.
   */
  private flagGhosts(out: TrackerFact[], T: readonly NormalizedThrow[], n = this.ghostCount(T)): number {
    if (n === 0) return 0;
    const prev = this.s.recentVisits[0] as KnownDart[];
    out.push({
      type: 'SourceAnomaly',
      payload: {
        note: `${n} dart(s) where the previous visit's darts were: counted pending review, in case that visit reappeared after its takeout`,
        rawExcerpt: prev
          .slice(0, n)
          .map((d) => d.segment.label)
          .join(','),
      },
    });
    return n;
  }

  /** Detects `T[from..]` as new darts; `ghosts`: how many leading darts to flag as possible ghosts (`flagGhosts`). */
  private detectFrom(out: TrackerFact[], T: readonly NormalizedThrow[], from: number, recovered: boolean, ghosts = 0): void {
    for (let i = from; i < T.length; i++) this.detect(out, T[i] as NormalizedThrow, recovered, i < ghosts);
  }

  /** A new dart, appended in board order, with the lowest `indexInVisit` free in its visit. */
  private detect(out: TrackerFact[], t: NormalizedThrow, recovered: boolean, ghost = false): void {
    const used = new Set(this.s.known.map((k) => k.indexInVisit));
    let index = 0;
    while (used.has(index)) index++;
    const throwId = this.ids();
    const payload: EventOf<'DartDetected'>['payload'] = {
      throwId,
      segment: t.segment,
      visitKey: this.s.visitKey,
      indexInVisit: index,
    };
    if (t.coords) payload.coords = t.coords;
    if (recovered) payload.recovered = true;
    if (t.fatal || ghost) payload.pendingReview = true;
    out.push(t.fatal ? { type: 'DartDetected', payload, anomaly: t.fatal } : { type: 'DartDetected', payload });
    const known: KnownDart = { throwId, segment: t.segment, indexInVisit: index };
    if (t.coords) known.coords = t.coords;
    if (ghost) known.suspectedGhost = true;
    this.s.known.push(known);
    this.hadDarts = true;
  }

  /**
   * Known dart `k` as listed now: `DartUpdated` when the board re-read it, or, with `doubt`, a
   * `DartUpdated{pendingReview}` flag the first time its identity is in doubt.
   */
  private updated(out: TrackerFact[], k: KnownDart, t: NormalizedThrow, doubt: boolean): KnownDart {
    const flag = doubt && !k.inDoubt && !k.suspectedGhost;
    if (!sameSegment(k.segment, t.segment) || flag) {
      const payload: EventOf<'DartUpdated'>['payload'] = { throwId: k.throwId, previous: k.segment, segment: t.segment };
      if (t.coords) payload.coords = t.coords;
      // A re-read settles an unreadable segment, but not whether the dart is a ghost or in doubt.
      if (t.fatal || k.suspectedGhost || k.inDoubt || doubt) payload.pendingReview = true;
      out.push(t.fatal ? { type: 'DartUpdated', payload, anomaly: t.fatal } : { type: 'DartUpdated', payload });
    }
    const next: KnownDart = { throwId: k.throwId, segment: t.segment, indexInVisit: k.indexInVisit };
    const coords = t.coords ?? k.coords;
    if (coords) next.coords = coords;
    if (k.suspectedGhost) next.suspectedGhost = true;
    if (k.inDoubt || doubt) next.inDoubt = true;
    return next;
  }

  private withdrawFrom(out: TrackerFact[], n: number): void {
    const K = this.s.known;
    for (let i = n; i < K.length; i++) {
      out.push({ type: 'DartWithdrawn', payload: { throwId: (K[i] as KnownDart).throwId } });
    }
    K.length = Math.min(K.length, n);
  }
}

interface Alignment {
  /** For each listed dart, the index of the known dart it is, or -1 for a new dart. */
  toKnown: number[];
  /** The match is a guess (darts without coordinates): the darts left are flagged pending review. */
  doubtful: boolean;
}

/** [0, 1, …, matched - 1, -1, …]: the first `matched` listed darts are the known darts in order. */
function positions(listed: number, matched: number): number[] {
  return Array.from({ length: listed }, (_, i) => (i < matched ? i : -1));
}

function distance(a: Coords, b: Coords): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Matched known darts keep the board's order, and new darts come after them (the board appends). */
function inBoardOrder(toKnown: readonly number[]): boolean {
  let last = -1;
  let fresh = false;
  for (const j of toKnown) {
    if (j === -1) fresh = true;
    else if (fresh || j <= last) return false;
    else last = j;
  }
  return true;
}

/**
 * Up to `limit` ways to read the listed darts as known darts in order, each listed dart the same
 * as its known dart (`relate` = same), earliest known darts first.
 */
function embeddings(K: readonly KnownDart[], T: readonly NormalizedThrow[], limit: number): number[][] {
  const found: number[][] = [];
  const picked: number[] = [];
  const walk = (i: number, from: number): void => {
    if (found.length >= limit) return;
    if (i === T.length) {
      found.push([...picked]);
      return;
    }
    for (let j = from; j < K.length; j++) {
      if (relate(K[j] as KnownDart, T[i] as NormalizedThrow) !== 'same') continue;
      picked.push(j);
      walk(i + 1, j + 1);
      picked.pop();
    }
  };
  walk(0, 0);
  return found;
}
