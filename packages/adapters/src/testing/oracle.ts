import type { BoardFactDraft, Coords, Segment } from '@arcade/event-schema';
import type { ApplyMode } from '../autodarts-local/visit-tracker';
import type { Snapshot } from '../autodarts-local/snapshot';
import type { BoardModel } from '../simulator/board-model';

/**
 * Ground truth vs adapter output for the chaos suite (ROADMAP P2: "final dart set equals
 * the ground truth, or the affected turn is flagged; zero silent mismatches").
 *
 * Adapter darts are matched to board detections by their coordinates, which the board
 * model draws at random, so every reading is unique. A board visit is *clean* when the
 * adapter holds exactly its darts, with their final segments, in one unflagged adapter
 * visit that ended the same way. It is *flagged* when an adapter visit holding any of its
 * darts has a recovered dart or ended with an inferred takeout, or when an inferred
 * takeout was emitted across it. Every visit must be clean or flagged.
 */

export interface AppliedRecord {
  boardVisit: number;
  mode: ApplyMode;
  /** Index into the fact list where this snapshot's facts start. */
  factFrom: number;
  detections: number[];
}

export interface ChaosStats {
  boardVisits: number;
  detections: number;
  flaggedVisits: number;
  inferredTakeouts: number;
  recoveredDarts: number;
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

const key = (c: Coords | undefined): string => (c ? `${c.x}|${c.y}` : 'none');

export class ChaosRecorder {
  readonly applied: AppliedRecord[] = [];
  private readonly coordsToDet = new Map<string, number>();
  private readonly board: BoardModel;
  private readonly facts: readonly BoardFactDraft[];

  constructor(board: BoardModel, facts: readonly BoardFactDraft[]) {
    this.board = board;
    this.facts = facts;
  }

  /** Pass as the adapter's `observer.beforeApply`. */
  readonly beforeApply = (snap: Snapshot, mode: ApplyMode): void => {
    const raw = snap.raw as { _simVisit?: unknown };
    const detections: number[] = [];
    for (const t of snap.throws) {
      const id = this.detOf(t.coords);
      if (id !== undefined) detections.push(id);
    }
    this.applied.push({
      boardVisit: typeof raw._simVisit === 'number' ? raw._simVisit : -1,
      mode,
      factFrom: this.facts.length,
      detections,
    });
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
    const darts = new Map<string, AdapterDart>();
    const visits = new Map<string, AdapterVisit>();
    const emissions = new Map<number, { recovered: boolean }[]>();
    const visitOf = (k: string): AdapterVisit => {
      let a = visits.get(k);
      if (!a) {
        a = { key: k, flagged: false, darts: [] };
        visits.set(k, a);
      }
      return a;
    };

    let inferredTakeouts = 0;
    let recoveredDarts = 0;
    for (const f of this.facts) {
      switch (f.type) {
        case 'DartDetected': {
          const p = f.payload;
          if (darts.has(p.throwId)) v.push(`duplicate throwId ${p.throwId}`);
          const detId = this.detOf(p.coords);
          if (detId === undefined) v.push(`invented dart ${p.segment.label} at ${key(p.coords)}`);
          darts.set(p.throwId, { throwId: p.throwId, visitKey: p.visitKey, recovered: !!p.recovered, live: true, segment: p.segment, detId });
          const a = visitOf(p.visitKey);
          a.darts.push(p.throwId);
          if (p.recovered) {
            a.flagged = true;
            recoveredDarts++;
          }
          if (detId !== undefined) {
            const list = emissions.get(detId) ?? [];
            list.push({ recovered: !!p.recovered });
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
          if (f.payload.coords) {
            const detId = this.detOf(f.payload.coords);
            if (detId === undefined) v.push(`update to invented coordinates ${key(f.payload.coords)}`);
            d.detId = detId;
          }
          break;
        }
        case 'DartWithdrawn': {
          const d = darts.get(f.payload.throwId);
          if (!d) v.push(`withdrawal of unknown throwId ${f.payload.throwId}`);
          else d.live = false;
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
    }

    // A physical detection is never emitted twice unless the later emission is flagged.
    for (const [detId, list] of emissions) {
      if (list.slice(1).some((e) => !e.recovered)) v.push(`detection ${detId} emitted ${list.length}× without a recovered flag`);
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

    const detById = new Map(board.detections.map((d) => [d.id, d]));
    const boardVisitOfDet = (id: number): number => detById.get(id)?.visit ?? -1;

    // Every dart the adapter saw, still listed by the board when its visit ended, is live.
    const seen = new Set(this.applied.flatMap((r) => r.detections));
    for (const id of seen) {
      const det = detById.get(id);
      if (!det || det.withdrawn) continue;
      if (board.visits[det.visit]?.endedBy === 'reset') continue;
      if (!liveByDet.has(id)) v.push(`detection ${id} (${det.segment.label}, visit ${det.visit}) was seen online but is missing`);
    }

    // Inferred takeouts and the board visits they span.
    const spanned = new Set<number>();
    this.applied.forEach((r, i) => {
      const end = this.applied[i + 1]?.factFrom ?? this.facts.length;
      const inferred = this.facts
        .slice(r.factFrom, end)
        .some((f) => f.type === 'TakeoutFinished' && f.payload.inferred === true);
      if (!inferred) return;
      const prev = i > 0 ? (this.applied[i - 1] as AppliedRecord).boardVisit : -1;
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
      stats: { boardVisits: board.visits.length, detections: board.detections.length, flaggedVisits, inferredTakeouts, recoveredDarts },
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
