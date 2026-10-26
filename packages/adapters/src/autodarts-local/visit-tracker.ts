import { sameSegment, type Coords, type EventOf, type Segment } from '@arcade/event-schema';
import type { NormalizedThrow, SegmentAnomaly } from '../normalize';
import type { IdSource } from '../ports';
import { isLifecycle, relate, takeoutBegins, type Snapshot } from './snapshot';

/**
 * Turns ID-less board snapshots into a reliable dart stream (ARCHITECTURE §6.2, §6.4,
 * owner decision R). Pure: no timers or I/O; the adapter feeds it snapshots and wraps
 * the facts it returns.
 *
 * - `known[i]` is the dart at board position i of the current visit, so
 *   `(visitKey, indexInVisit)` is the idempotency key: a re-delivered snapshot finds
 *   every position already occupied and adds nothing.
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
   * The tracker could not be sure of this dart: it was gone when a takeout was first seen
   * (pulled, or withdrawn by the board before the takeout began). It was flagged with a
   * `DartUpdated{pendingReview}`, and every later fact about it stays `pendingReview`.
   */
  inDoubt?: true;
}

export interface VisitState {
  visitKey: string;
  known: KnownDart[];
  inTakeout: boolean;
  /** Darts of the last ended visits, newest first, to recognise them if they reappear. */
  recentVisits: KnownDart[][];
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
 * The shortest time in which a whole visit can come and go unseen: someone throws, the board
 * detects the dart, and the darts are pulled out (owner decision, Phase 2/3 integration). A
 * resync with no known darts infers a takeout only if the board was out of sight at least
 * this long; shorter outages cannot hide one.
 */
export const MIN_UNSEEN_VISIT_MS = 5000;

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
  private takeoutTail = false;

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
  }

  /** A copy of the current visit state (for diagnostics and tests). */
  state(): VisitState {
    return {
      visitKey: this.s.visitKey,
      known: this.s.known.map(copyDart),
      inTakeout: this.s.inTakeout,
      recentVisits: this.s.recentVisits.map((v) => v.map(copyDart)),
    };
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
    if (snap.event === 'Manual reset' && (K.length > 0 || this.s.inTakeout)) return 'confirm';
    if (T.length === 0) {
      if (this.s.inTakeout) return 'apply';
      if (K.length === 0) return this.missedTakeout(snap) ? 'confirm' : 'apply';
      return 'confirm';
    }
    if (K.length === 0) return this.s.inTakeout || this.ghostCount(T) > 0 ? 'confirm' : 'apply';
    if (this.s.inTakeout) return T.length <= K.length && this.allKnown(T) ? 'apply' : 'confirm';
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
    if (snap.event === 'Manual reset' && (this.s.known.length > 0 || this.s.inTakeout)) {
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
      this.diffDuringTakeout(snap, out, false);
    } else if (takeoutBegins(snap)) {
      // Status first: darts missing from a takeout are being removed, not withdrawn.
      this.takeoutSeen(snap, out, false);
    } else if (this.anchoredLive(T)) {
      this.diffSameVisit(out, T, false);
    } else {
      this.finishTakeout(out, true);
      this.detectFrom(out, T, 0, true);
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

  /** Whether a live snapshot continues the current visit (§6.2 index rule, guarded by coords). */
  private anchoredLive(T: readonly NormalizedThrow[]): boolean {
    const K = this.s.known;
    const first = T[0] as NormalizedThrow;
    const r0 = relate(K[0] as KnownDart, first);
    if (r0 === 'same') return true;
    // The board re-read its first dart; an update that also drops darts looks like a new visit.
    if ((r0 === 'updated' || r0 === 'unknown') && T.length >= K.length) return true;
    return this.shifted(first);
  }

  /** The first dart of the snapshot is a later known dart: earlier ones were withdrawn. */
  private shifted(first: NormalizedThrow): boolean {
    if (!first.coords) return false;
    return this.s.known.slice(1).some((k) => k.coords !== undefined && relate(k, first) === 'same');
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
      // Nothing was on the board and nothing is: a whole visit may have come and gone, but
      // only if we were away long enough for one.
      if (wholeVisitFits) this.finishTakeout(out, true);
      else this.endEmptyTakeout(snap);
    } else if (K.length === 0) {
      // Nothing known proves the visit went on: a whole visit may have come and gone, unless we
      // were not away long enough for one. Darts where the last visit's darts were prove nothing
      // either way: they are counted, flagged.
      const ghosts = this.s.inTakeout ? 0 : this.ghostCount(T);
      if (wholeVisitFits) this.finishTakeout(out, true);
      else this.endEmptyTakeout(snap);
      this.detectFrom(out, T, 0, true, this.flagGhosts(out, T, ghosts));
    } else if (!this.s.inTakeout && takeoutBegins(snap)) {
      // Status first: darts missing from a takeout are being removed, not withdrawn.
      this.takeoutSeen(snap, out, true);
    } else if (!this.anchoredResync(T)) {
      this.finishTakeout(out, true);
      this.detectFrom(out, T, 0, true);
    } else if (this.s.inTakeout) {
      this.diffDuringTakeout(snap, out, true);
    } else {
      this.diffSameVisit(out, T, true);
    }
    this.beginTakeoutIfNeeded(snap, out);
  }

  /**
   * With coordinates, the visit continues only if the snapshot's first dart is exactly a
   * known dart. Without them, §6.4's literal rule: every known dart is a prefix of the
   * snapshot.
   */
  private anchoredResync(T: readonly NormalizedThrow[]): boolean {
    const K = this.s.known;
    const first = T[0] as NormalizedThrow;
    const k0 = K[0] as KnownDart;
    if (k0.coords && first.coords) return relate(k0, first) === 'same' || this.shifted(first);
    return K.every((k, i) => i < T.length && relate(k, T[i] as NormalizedThrow) === 'same');
  }

  // ── shared diff steps ──────────────────────────────────────────────────────

  private diffSameVisit(out: TrackerFact[], T: readonly NormalizedThrow[], recovered: boolean): void {
    const K = this.s.known;
    for (let i = 0; i < T.length; i++) {
      const t = T[i] as NormalizedThrow;
      if (i < K.length) this.update(out, i, t);
      else this.detect(out, t, i, recovered);
    }
    if (T.length < K.length) this.withdrawFrom(out, T.length);
  }

  /** Darts come off in any order during a takeout: never update or withdraw then. */
  private diffDuringTakeout(snap: Snapshot, out: TrackerFact[], recovered: boolean): void {
    const K = this.s.known;
    const T = snap.throws;
    if (T.length <= K.length) {
      if (this.allKnown(T)) return; // partial removal
      this.finishTakeout(out, true);
      this.detectFrom(out, T, 0, true);
      return;
    }
    if (K.every((k, i) => relate(k, T[i] as NormalizedThrow) === 'same')) {
      // More darts than before: the board called off the takeout.
      if (!takeoutBegins(snap)) this.s.inTakeout = false;
      this.detectFrom(out, T, K.length, recovered);
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
   * darts means a visit ended while we were not looking: an inferred takeout.
   */
  private takeoutSeen(snap: Snapshot, out: TrackerFact[], recovered: boolean): void {
    const K = this.s.known;
    const T = snap.throws;
    const kept = this.subsequence(T);
    if (kept) {
      K.forEach((k, j) => {
        if (!kept.includes(j)) this.flagInDoubt(out, j);
      });
      return;
    }
    if (T.length > K.length && K.every((k, i) => relate(k, T[i] as NormalizedThrow) === 'same')) {
      this.detectFrom(out, T, K.length, recovered);
      return;
    }
    this.finishTakeout(out, true);
    this.detectFrom(out, T, 0, true);
  }

  /**
   * The known darts (by index) that the snapshot lists, in order, if every listed dart is one
   * of them; null otherwise. With coordinates the match is exact; without them it goes by
   * segment and prefers the earliest darts.
   */
  private subsequence(T: readonly NormalizedThrow[]): number[] | null {
    const K = this.s.known;
    const picked: number[] = [];
    let j = 0;
    for (const t of T) {
      while (j < K.length && relate(K[j] as KnownDart, t) !== 'same') j++;
      if (j >= K.length) return null;
      picked.push(j++);
    }
    return picked;
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

  /** `ghosts`: how many leading darts to flag as possible ghosts (`flagGhosts`). */
  private detectFrom(out: TrackerFact[], T: readonly NormalizedThrow[], from: number, recovered: boolean, ghosts = 0): void {
    for (let i = from; i < T.length; i++) this.detect(out, T[i] as NormalizedThrow, i, recovered, i < ghosts);
  }

  private detect(out: TrackerFact[], t: NormalizedThrow, index: number, recovered: boolean, ghost = false): void {
    if (this.s.known[index]) return; // idempotency: this (visitKey, indexInVisit) is taken
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
    this.s.known[index] = known;
  }

  private update(out: TrackerFact[], i: number, t: NormalizedThrow): void {
    const k = this.s.known[i] as KnownDart;
    // Also log a move to a different physical dart with the same segment (positions shift
    // when the board withdraws an earlier dart), so the log's coordinates stay true.
    if (!sameSegment(k.segment, t.segment) || relate(k, t) === 'other') {
      const payload: EventOf<'DartUpdated'>['payload'] = { throwId: k.throwId, previous: k.segment, segment: t.segment };
      if (t.coords) payload.coords = t.coords;
      // A re-read settles an unreadable segment, but not whether the dart is a ghost or in doubt.
      if (t.fatal || k.suspectedGhost || k.inDoubt) payload.pendingReview = true;
      out.push(t.fatal ? { type: 'DartUpdated', payload, anomaly: t.fatal } : { type: 'DartUpdated', payload });
    }
    const next: KnownDart = { throwId: k.throwId, segment: t.segment, indexInVisit: k.indexInVisit };
    const coords = t.coords ?? k.coords;
    if (coords) next.coords = coords;
    if (k.suspectedGhost) next.suspectedGhost = true;
    if (k.inDoubt) next.inDoubt = true;
    this.s.known[i] = next;
  }

  private withdrawFrom(out: TrackerFact[], n: number): void {
    const K = this.s.known;
    for (let i = n; i < K.length; i++) {
      out.push({ type: 'DartWithdrawn', payload: { throwId: (K[i] as KnownDart).throwId } });
    }
    K.length = Math.min(K.length, n);
  }
}
