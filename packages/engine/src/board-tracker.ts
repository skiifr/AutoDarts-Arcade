import type { BoardFactDraft, Coords, EventSource, Segment } from '@arcade/event-schema';

export interface DartOnBoard {
  throwId: string;
  visitKey: string;
  indexInVisit: number;
  segment: Segment;
  coords?: Coords;
  recovered?: true;
  pendingReview?: true;
  source: EventSource;
  occurredAt: string;
}

/**
 * The darts physically on the board right now, from the board facts alone. The host feeds it
 * every fact, with or without an open session, so that StartSession can record the darts that
 * are already in the board as baseline (ARCHITECTURE §6.3) and the adapter can rebuild its
 * `known[]` from the new session's log after a crash.
 */
export class BoardVisitTracker {
  private visitKey: string | null = null;
  private readonly darts = new Map<string, DartOnBoard>();
  private connection: Extract<BoardFactDraft, { type: 'SourceConnectionChanged' }> | null = null;
  private status: Extract<BoardFactDraft, { type: 'BoardStatusChanged' }> | null = null;

  observe(fact: BoardFactDraft): void {
    switch (fact.type) {
      case 'SourceConnectionChanged':
        this.connection = fact;
        return;
      case 'BoardStatusChanged':
        this.status = fact;
        return;
      case 'DartDetected': {
        const p = fact.payload;
        if (p.visitKey !== this.visitKey) {
          this.visitKey = p.visitKey;
          this.darts.clear();
        }
        if (this.darts.has(p.throwId)) return;
        const dart: DartOnBoard = {
          throwId: p.throwId,
          visitKey: p.visitKey,
          indexInVisit: p.indexInVisit,
          segment: p.segment,
          source: fact.source,
          occurredAt: fact.occurredAt,
        };
        if (p.coords) dart.coords = p.coords;
        if (p.recovered) dart.recovered = true;
        if (p.pendingReview) dart.pendingReview = true;
        this.darts.set(p.throwId, dart);
        return;
      }
      case 'DartUpdated': {
        const dart = this.darts.get(fact.payload.throwId);
        if (dart) {
          dart.segment = fact.payload.segment;
          if (fact.payload.coords) dart.coords = fact.payload.coords;
          if (fact.payload.pendingReview) dart.pendingReview = true;
          else delete dart.pendingReview;
        }
        return;
      }
      case 'DartWithdrawn':
        this.darts.delete(fact.payload.throwId);
        return;
      case 'TakeoutFinished':
      case 'VisitReset':
        this.visitKey = null;
        this.darts.clear();
        return;
      default:
        return;
    }
  }

  /** Darts on the board, in the order the board reported them. */
  onBoard(): DartOnBoard[] {
    return [...this.darts.values()].map((d) => ({ ...d }));
  }

  /**
   * The last connection and board status reported, so a new session's log starts from the
   * board as it is (the W3 status, manual-mode detection, and the crash-resume contact time).
   */
  boardState(): BoardFactDraft[] {
    const out: BoardFactDraft[] = [];
    if (this.connection) out.push(this.connection);
    if (this.status) out.push(this.status);
    return out;
  }
}
