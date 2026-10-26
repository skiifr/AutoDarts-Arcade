import type { BoardFactDraft, Coords, Segment } from '@arcade/event-schema';
import type { ApplyMode, KnownDart, VisitState } from '../autodarts-local/visit-tracker';
import type { Snapshot } from '../autodarts-local/snapshot';
import type { BoardModel, Detection } from '../simulator/board-model';

/**
 * Ground truth vs adapter output for the chaos suite (ROADMAP P2: "final dart set equals
 * the ground truth, or the affected turn is flagged; zero silent mismatches").
 *
 * Which board detection an adapter dart is: the board model tags every listed dart with its
 * detection id (`annotate`), and after each snapshot the recorder reads the tracker's visit
 * state. A known dart with coordinates is the detection that had them (the model draws them at
 * random, so every reading is unique); the known darts without coordinates are the remaining
 * listed darts, in board order, when their counts agree. A board visit is *clean* when the
 * adapter holds exactly its darts, with their final segments, in one unflagged adapter visit
 * that ended the same way. It is *flagged* when an adapter visit holding any of its darts has a
 * recovered dart or a dart pending review, or ended with an inferred takeout, or when an
 * inferred takeout was emitted across it. Every visit must be clean or flagged.
 *
 * Each physical dart keeps one identity (review finding 2). In an unflagged adapter visit:
 * - a throwId is always the same detection;
 * - a withdrawal hits a detection the board withdrew, and no longer lists;
 * - an update gives a detection a segment the board read for it.
 */

export interface AppliedRecord {
  boardVisit: number;
  mode: ApplyMode;
  /** Index into the fact list where this snapshot's facts start… */
  factFrom: number;
  /** …and end (-1 until the snapshot has been applied). */
  factTo: number;
  /** Detection ids the snapshot listed, in board order. */
  detections: number[];
  /** throwId → detection id of the tracker's known darts once the snapshot was applied. */
  identity: Map<string, number>;
}

export interface ChaosStats {
  boardVisits: number;
  detections: number;
  flaggedVisits: number;
  inferredTakeouts: number;
  recoveredDarts: number;
  /** Detections pulled out one at a time during a takeout. */
  pulledDarts: number;
  /** Takeouts the board called off with the darts still in. */
  calledOffTakeouts: number;
  /** Detections the board reported without coordinates. */
  noCoordsDetections: number;
  /** Times a throwId's detection was checked against what it was before. */
  identityChecks: number;
}

interface AdapterDart {
  throwId: string;
  visitKey: string;
  recovered: boolean;
  live: boolean;
  segment: Segment;
  detId: number | undefined;
}

interface AdapterVisit {
  key: string;
  flagged: boolean;
  endedBy?: 'takeout' | 'inferred' | 'reset';
  darts: string[];
}

/** An identity breach, reported unless the adapter visit it happened in is flagged. */
interface Suspect {
  visitKey: string;
  what: string;
}

const key = (c: Coords | undefined): string => (c ? `${c.x}|${c.y}` : 'none');
const isNumber = (v: unknown): v is number => typeof v === 'number';

export class ChaosRecorder {
  readonly applied: AppliedRecord[] = [];
  private readonly coordsToDet = new Map<string, number>();
  private readonly board: BoardModel;
  private readonly facts: readonly BoardFactDraft[];
  private readonly visitState: (() => VisitState) | undefined;

  /** `visitState`: the adapter's, read after each snapshot (without it, identity goes by coordinates only). */
  constructor(board: BoardModel, facts: readonly BoardFactDraft[], visitState?: () => VisitState) {
    this.board = board;
    this.facts = facts;
    this.visitState = visitState;
  }

  /** Pass as the adapter's `observer.beforeApply`. */
  readonly beforeApply = (snap: Snapshot, mode: ApplyMode): void => {
    const raw = snap.raw as { _simVisit?: unknown; throws?: unknown };
    const listed = Array.isArray(raw.throws) ? raw.throws.slice(0, 3) : [];
    const detections = listed.map((t) => (t as { _simDet?: unknown } | null)?._simDet).filter(isNumber);
    // Boards that do not tag their darts: by coordinates.
    if (detections.length === 0) for (const t of snap.throws) if (this.detOf(t.coords) !== undefined) detections.push(this.detOf(t.coords) as number);
    this.applied.push({
      boardVisit: typeof raw._simVisit === 'number' ? raw._simVisit : -1,
      mode,
      factFrom: this.facts.length,
      factTo: -1,
      detections,
      identity: new Map(),
    });
  };

  /** Pass as the adapter's `observer.afterApply`. */
  readonly afterApply = (): void => {
    const rec = this.applied[this.applied.length - 1];
    if (!rec || rec.factTo !== -1) return;
    rec.factTo = this.facts.length;
    if (!this.visitState) return;
    const known: KnownDart[] = this.visitState().known;
    const claimed = new Set<number>();
    const unplaced: KnownDart[] = [];
    for (const k of known) {
      const det = this.detOf(k.coords);
      if (det === undefined) unplaced.push(k);
      else {
        rec.identity.set(k.throwId, det);
        claimed.add(det);
      }
    }
    const rest = rec.detections.filter((d) => !claimed.has(d));
    if (unplaced.length === rest.length) unplaced.forEach((k, i) => rec.identity.set(k.throwId, rest[i] as number));
  };

  detOf(c: Coords | undefined): number | undefined {
    if (!c) return undefined;
    const k = key(c);
    const hit = this.coordsToDet.get(k);
    if (hit !== undefined) return hit;
    for (const d of this.board.detections) for (const h of d.history) this.coordsToDet.set(key(h.coords), d.id);
    return this.coordsToDet.get(k);
  }

  check(): { violations: string[]; stats: ChaosStats } {
    const v: string[] = [];
    const board = this.board;
    const detById = new Map<number, Detection>(board.detections.map((d) => [d.id, d]));
    const darts = new Map<string, AdapterDart>();
    const visits = new Map<string, AdapterVisit>();
    const emissions = new Map<number, { flagged: boolean }[]>();
    const suspects: Suspect[] = [];
    let identityChecks = 0;
    const visitOf = (k: string): AdapterVisit => {
      let a = visits.get(k);
      if (!a) {
        a = { key: k, flagged: false, darts: [] };
        visits.set(k, a);
      }
      return a;
    };

    // Snapshots whose facts were cut short (an error inside the apply) end where the next begins.
    const records = this.applied.map((r, i) => ({ ...r, factTo: r.factTo >= 0 ? r.factTo : (this.applied[i + 1]?.factFrom ?? this.facts.length) }));
    const recordAt: (AppliedRecord | undefined)[] = [];
    for (const r of records) for (let i = r.factFrom; i < r.factTo; i++) recordAt[i] = r;

    // Once a snapshot's facts are through, its identity observations hold.
    let settled = 0;
    const settle = (upTo: number): void => {
      while (settled < records.length && (records[settled] as AppliedRecord).factTo <= upTo) {
        const r = records[settled++] as AppliedRecord;
        for (const [throwId, det] of r.identity) {
          const d = darts.get(throwId);
          if (!d) continue;
          identityChecks++;
          if (d.detId !== undefined && d.detId !== det) {
            suspects.push({ visitKey: d.visitKey, what: `throwId ${throwId} moved from detection ${d.detId} to ${det}` });
          }
          d.detId = det;
        }
      }
    };

    let inferredTakeouts = 0;
    let recoveredDarts = 0;
    this.facts.forEach((f, i) => {
      settle(i);
      const rec = recordAt[i];
      switch (f.type) {
        case 'DartDetected': {
          const p = f.payload;
          if (darts.has(p.throwId)) v.push(`duplicate throwId ${p.throwId}`);
          const detId = rec?.identity.get(p.throwId) ?? this.detOf(p.coords);
          if (detId === undefined) v.push(`invented dart ${p.segment.label} at ${key(p.coords)}`);
          darts.set(p.throwId, { throwId: p.throwId, visitKey: p.visitKey, recovered: !!p.recovered, live: true, segment: p.segment, detId });
          const a = visitOf(p.visitKey);
          a.darts.push(p.throwId);
          if (p.recovered) recoveredDarts++;
          // Recovered and pending-review darts both flag their turn in the host.
          const flagged = !!p.recovered || !!p.pendingReview;
          if (flagged) a.flagged = true;
          if (detId !== undefined) {
            const list = emissions.get(detId) ?? [];
            list.push({ flagged });
            emissions.set(detId, list);
          }
          break;
        }
        case 'DartUpdated': {
          const d = darts.get(f.payload.throwId);
          if (!d) {
            v.push(`update of unknown throwId ${f.payload.throwId}`);
            break;
          }
          d.segment = f.payload.segment;
          if (f.payload.pendingReview) visitOf(d.visitKey).flagged = true;
          if (f.payload.coords && this.detOf(f.payload.coords) === undefined) v.push(`update to invented coordinates ${key(f.payload.coords)}`);
          // The detection it is after this snapshot: the board must have read it so.
          const det = detById.get(rec?.identity.get(d.throwId) ?? d.detId ?? -1);
          if (f.payload.previous.label !== f.payload.segment.label && det && !det.history.some((h) => h.segment.label === f.payload.segment.label)) {
            suspects.push({ visitKey: d.visitKey, what: `update gave detection ${det.id} (${det.segment.label}) a reading it never had: ${f.payload.segment.label}` });
          }
          break;
        }
        case 'DartWithdrawn': {
          const d = darts.get(f.payload.throwId);
          if (!d) {
            v.push(`withdrawal of unknown throwId ${f.payload.throwId}`);
            break;
          }
          d.live = false;
          const det = d.detId === undefined ? undefined : detById.get(d.detId);
          const reset = rec !== undefined && this.facts.slice(rec.factFrom, rec.factTo).some((g) => g.type === 'VisitReset');
          if (det && !reset && (!det.withdrawn || rec?.detections.includes(det.id))) {
            suspects.push({ visitKey: d.visitKey, what: `withdrew detection ${det.id} (${det.segment.label}), which the board ${det.withdrawn ? 'still lists' : 'never withdrew'}` });
          }
          break;
        }
        case 'TakeoutFinished': {
          const a = visitOf(f.payload.visitKey);
          a.endedBy = f.payload.inferred ? 'inferred' : 'takeout';
          if (f.payload.inferred) {
            a.flagged = true;
            inferredTakeouts++;
          }
          break;
        }
        case 'VisitReset':
          visitOf(f.payload.visitKey).endedBy = 'reset';
          break;
        default:
          break;
      }
    });
    settle(Infinity);

    // Identity breaches count unless their adapter visit is up for review anyway.
    for (const s of suspects) if (!visitOf(s.visitKey).flagged) v.push(`silent identity breach: ${s.what}`);

    // A physical detection is never emitted twice unless the later emission is flagged.
    for (const [detId, list] of emissions) {
      if (list.slice(1).some((e) => !e.flagged)) v.push(`detection ${detId} emitted ${list.length}× without a recovered or pending-review flag`);
    }
    const live = [...darts.values()].filter((d) => d.live);
    const liveByDet = new Map<number, AdapterDart[]>();
    for (const d of live) {
      if (d.detId === undefined) continue;
      const l = liveByDet.get(d.detId) ?? [];
      l.push(d);
      liveByDet.set(d.detId, l);
    }
    for (const [detId, l] of liveByDet) {
      if (l.length > 1 && l.some((d) => !visitOf(d.visitKey).flagged)) v.push(`detection ${detId} is live ${l.length}× in an unflagged visit`);
    }

    const boardVisitOfDet = (id: number): number => detById.get(id)?.visit ?? -1;

    // Every dart the adapter saw, still in its visit when the visit ended, is live.
    const seen = new Set(records.flatMap((r) => r.detections));
    for (const id of seen) {
      const det = detById.get(id);
      if (!det || det.withdrawn) continue;
      if (board.visits[det.visit]?.endedBy === 'reset') continue;
      if (!liveByDet.has(id)) v.push(`detection ${id} (${det.segment.label}, visit ${det.visit}) was seen online but is missing`);
    }

    // Inferred takeouts and the board visits they span.
    const spanned = new Set<number>();
    records.forEach((r, i) => {
      const inferred = this.facts.slice(r.factFrom, r.factTo).some((f) => f.type === 'TakeoutFinished' && f.payload.inferred === true);
      if (!inferred) return;
      const prev = i > 0 ? (records[i - 1] as AppliedRecord).boardVisit : -1;
      for (let b = Math.max(0, prev); b <= r.boardVisit; b++) spanned.add(b);
    });

    let flaggedVisits = 0;
    const listed = board.listedDetectionIds();
    for (const bv of board.visits) {
      const open = bv.endedBy === undefined;
      const truth = bv.endedBy === 'reset' ? [] : open ? listed : bv.finalDetections;
      const mine = live.filter((d) => d.detId !== undefined && boardVisitOfDet(d.detId) === bv.index);
      const touched = [...darts.values()].filter((d) => d.detId !== undefined && boardVisitOfDet(d.detId) === bv.index);
      const flagged = touched.some((d) => visitOf(d.visitKey).flagged) || spanned.has(bv.index);
      if (flagged) flaggedVisits++;
      if (flagged || this.isClean(bv.endedBy, truth, mine, live, visitOf, boardVisitOfDet, detById)) continue;
      v.push(
        `silent mismatch in board visit ${bv.index} (${bv.endedBy ?? 'open'}): truth [${truth
          .map((id) => detById.get(id)?.segment.label)
          .join(' ')}], adapter [${mine.map((d) => d.segment.label).join(' ')}]`,
      );
    }
    return {
      violations: v,
      stats: {
        boardVisits: board.visits.length,
        detections: board.detections.length,
        flaggedVisits,
        inferredTakeouts,
        recoveredDarts,
        pulledDarts: board.detections.filter((d) => d.pulled).length,
        calledOffTakeouts: board.calledOffTakeouts,
        noCoordsDetections: board.detections.filter((d) => d.noCoords).length,
        identityChecks,
      },
    };
  }

  private isClean(
    endedBy: 'takeout' | 'reset' | undefined,
    truth: readonly number[],
    mine: readonly AdapterDart[],
    live: readonly AdapterDart[],
    visitOf: (k: string) => AdapterVisit,
    boardVisitOfDet: (id: number) => number,
    detById: Map<number, { segment: Segment; visit: number }>,
  ): boolean {
    if (truth.length === 0) return mine.length === 0;
    if (mine.length !== truth.length) return false;
    const ids = new Set(mine.map((d) => d.detId));
    if (ids.size !== truth.length || truth.some((id) => !ids.has(id))) return false;
    for (const d of mine) {
      const det = detById.get(d.detId as number);
      if (!det || det.segment.label !== d.segment.label || det.segment.bed !== d.segment.bed) return false;
    }
    const keys = new Set(mine.map((d) => d.visitKey));
    if (keys.size !== 1) return false;
    const a = visitOf([...keys][0] as string);
    if (a.flagged) return false;
    const bv = boardVisitOfDet(mine[0]?.detId as number);
    if (live.some((d) => d.visitKey === a.key && (d.detId === undefined || boardVisitOfDet(d.detId) !== bv))) return false;
    if (endedBy === 'takeout') return a.endedBy === 'takeout';
    return a.endedBy === undefined;
  }
}
