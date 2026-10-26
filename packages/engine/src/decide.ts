import {
  EVENT_SCHEMA_VERSION,
  MISS,
  sameSegment,
  type ArcadeCommand,
  type ArcadeEvent,
  type ArcadeEventType,
  type CommandOf,
  type EventDraft,
  type EventOf,
  type EventSource,
  type Standing,
} from '@arcade/event-schema';
import type { BoardDart, DartRecord, SessionFolder, TurnRecord } from './folder';

export const ENGINE_VERSION = 'engine@0.1.0';

export type RejectReason =
  | 'invalid'
  | 'no-session'
  | 'session-open'
  | 'session-closed'
  | 'unknown-game'
  | 'invalid-options'
  | 'player-count'
  | 'invalid-turn-order'
  | 'unknown-dart'
  | 'dart-voided'
  | 'unknown-turn'
  | 'wrong-player'
  | 'turn-full'
  | 'no-active-turn'
  | 'not-flagged'
  | 'already-reviewed'
  | 'not-finished'
  | 'needs-review'
  | 'not-previewable';

/** Thrown inside a decision to refuse the input; the host turns it into a `rejected` result. */
export class Rejection extends Error {
  readonly reason: RejectReason;

  constructor(reason: RejectReason, message: string) {
    super(message);
    this.name = 'Rejection';
    this.reason = reason;
  }
}

export function reject(reason: RejectReason, message: string): never {
  throw new Rejection(reason, message);
}

/**
 * Collects the events one input produces. Each is applied to the folder as soon as it is
 * emitted, so later decisions in the same input see it; the host appends them all at once.
 */
export class Batch {
  readonly events: ArcadeEvent[] = [];

  constructor(
    readonly folder: SessionFolder,
    private readonly sessionId: string,
    private readonly mintId: () => string,
    readonly now: string,
  ) {}

  emit<T extends ArcadeEventType>(draft: EventDraft<T>): EventOf<T> {
    const event: Record<string, unknown> = {
      schema: EVENT_SCHEMA_VERSION,
      eventId: this.mintId(),
      sessionId: this.sessionId,
      seq: this.folder.lastSeq + 1,
      type: draft.type,
      payload: draft.payload,
      source: draft.source,
      occurredAt: draft.occurredAt,
      receivedAt: this.now,
    };
    if (draft.causationId !== undefined) event.causationId = draft.causationId;
    if (draft.correlationId !== undefined) event.correlationId = draft.correlationId;
    const e = event as unknown as EventOf<T>;
    this.folder.apply(e);
    this.events.push(e);
    return e;
  }

  mint(): string {
    return this.mintId();
  }
}

function sameStandings(a: readonly Standing[], b: readonly Standing[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.playerId === b[i]!.playerId && s.rank === b[i]!.rank && s.score === b[i]!.score)
  );
}

interface EndTurnOptions {
  reason: 'takeout' | 'manual-skip';
  /** Pad to 3 darts with misses (observed takeouts only, and only with missingDartsAreMisses). */
  pad: boolean;
  /** Flag the turn needsReview regardless of its darts. */
  flag: boolean;
  /** Pause for review instead of starting the next turn (inferred takeouts). */
  reviewPause: boolean;
  source: EventSource;
  occurredAt: string;
  causationId: string;
}

/** The host's turn policy (ARCHITECTURE §6.3, §8.3 and owner decision R) over one batch. */
export class Decider {
  readonly engine: EventSource = { kind: 'engine', adapterVersion: ENGINE_VERSION };

  constructor(
    private readonly batch: Batch,
    private readonly uiVersion: string,
  ) {}

  private get f(): SessionFolder {
    return this.batch.folder;
  }

  manual(actor: ArcadeCommand['actor']): EventSource {
    return { kind: 'manual', adapterVersion: this.uiVersion, actor };
  }

  // ── Board facts ───────────────────────────────────────────────────────────

  /** `fact` has just been appended; derive the layer-2 events it implies. */
  deriveFromFact(fact: ArcadeEvent): void {
    const f = this.f;
    switch (fact.type) {
      case 'DartDetected': {
        const bd = f.boardDart(fact.payload.throwId)!;
        if (bd.eventId === fact.eventId && bd.phase === 'turn' && f.active) this.throwDart(bd, f.active);
        break;
      }
      case 'DartUpdated': {
        const rec = f.dart(fact.payload.throwId);
        // A person's correction wins over a later change of mind by the board.
        if (!rec || rec.voided !== null || rec.userCorrected || sameSegment(rec.segment, fact.payload.segment)) break;
        this.batch.emit({
          type: 'DartCorrected',
          payload: { throwId: rec.throwId, previous: rec.segment, segment: fact.payload.segment, reason: 'source-update' },
          source: fact.source,
          occurredAt: fact.occurredAt,
          causationId: fact.eventId,
        });
        this.afterChange(fact.eventId);
        break;
      }
      case 'DartWithdrawn': {
        const rec = f.dart(fact.payload.throwId);
        if (!rec || rec.voided !== null || rec.userCorrected) break;
        // A board reset drops its darts; that ends the visit (below), it does not unthrow them.
        const bd = f.boardDart(rec.throwId);
        if (bd && f.visit(bd.visitKey)?.ended?.kind === 'reset') break;
        this.batch.emit({
          type: 'DartVoided',
          payload: { throwId: rec.throwId, reason: 'source-withdrawn' },
          source: fact.source,
          occurredAt: fact.occurredAt,
          causationId: fact.eventId,
        });
        this.repad(rec, fact.eventId);
        this.afterChange(fact.eventId);
        break;
      }
      case 'TakeoutFinished': {
        if (f.turns.length === 0) {
          this.startNextTurn(fact.eventId);
          break;
        }
        const turn = f.active;
        if (!turn) break; // review pause (the visit model holds it) or after the game
        const base = { source: this.engine, occurredAt: this.batch.now, causationId: fact.eventId };
        if (fact.payload.inferred) {
          // Owner decision R: a takeout may have happened offline. Flag, don't pad, wait for a person.
          this.endTurn({ ...base, reason: 'takeout', pad: false, flag: true, reviewPause: true });
          break;
        }
        if (!this.visitBelongsTo(fact.payload.visitKey, turn)) break;
        if (f.liveCount(turn) === 0) {
          if (f.houseRules.emptyTakeoutSkipsTurn) {
            this.endTurn({ ...base, reason: 'manual-skip', pad: false, flag: false, reviewPause: false });
          }
          break;
        }
        this.endTurn({ ...base, reason: 'takeout', pad: true, flag: false, reviewPause: false });
        break;
      }
      case 'VisitReset': {
        if (f.turns.length === 0) {
          this.startNextTurn(fact.eventId);
          break;
        }
        const turn = f.active;
        if (!turn || !this.visitBelongsTo(fact.payload.visitKey, turn) || f.liveCount(turn) === 0) break;
        // A reset ends the board visit, but nobody saw whether the visit was complete: flag it.
        this.endTurn({
          reason: 'takeout',
          pad: false,
          flag: true,
          reviewPause: false,
          source: this.engine,
          occurredAt: this.batch.now,
          causationId: fact.eventId,
        });
        break;
      }
      case 'SourceConnectionChanged': {
        const offline = f.paused.includes('board-offline');
        if (fact.payload.state === 'offline' && !offline && !f.isFinished()) {
          this.emitPause('GamePaused', 'board-offline', this.engine, this.batch.now, fact.eventId);
        } else if (fact.payload.state === 'online' && offline) {
          this.emitPause('GameResumed', 'board-offline', this.engine, this.batch.now, fact.eventId);
        }
        break;
      }
      default:
        break;
    }
    // Before the first turn, any fact can leave the board clear (a takeout, withdrawn darts).
    if (f.turns.length === 0 && f.baselineLive() === 0) this.startNextTurn(fact.eventId);
  }

  // ── Commands (all but StartSession and Rematch, which the host handles) ──

  decideCommand(cmd: ArcadeCommand): void {
    const f = this.f;
    const src = this.manual(cmd.actor);
    const base = { source: src, occurredAt: cmd.issuedAt, causationId: cmd.commandId };
    switch (cmd.type) {
      case 'CorrectDart': {
        const rec = this.liveDart(cmd.payload.throwId);
        if (sameSegment(rec.segment, cmd.payload.segment)) return;
        this.batch.emit({
          ...base,
          type: 'DartCorrected',
          payload: { throwId: rec.throwId, previous: rec.segment, segment: cmd.payload.segment, reason: 'user' },
        });
        this.afterChange(cmd.commandId);
        return;
      }
      case 'VoidDart': {
        const rec = this.liveDart(cmd.payload.throwId);
        this.batch.emit({ ...base, type: 'DartVoided', payload: { throwId: rec.throwId, reason: cmd.payload.reason } });
        this.repad(rec, cmd.commandId);
        this.afterChange(cmd.commandId);
        return;
      }
      case 'AddDart':
        return this.addDart(cmd, base);
      case 'SkipTurn': {
        if (f.turns.length === 0) {
          // "Start anyway": the baseline darts stay unscored.
          if (f.isFinished()) reject('no-active-turn', 'the game is over');
          this.startNextTurn(cmd.commandId);
          return;
        }
        if (!f.active) reject('no-active-turn', 'no turn is in progress');
        this.endTurn({ ...base, reason: 'manual-skip', pad: false, flag: false, reviewPause: false });
        return;
      }
      case 'Pause':
        if (!f.paused.includes(cmd.payload.reason)) {
          this.emitPause('GamePaused', cmd.payload.reason, src, cmd.issuedAt, cmd.commandId);
        }
        return;
      case 'Resume': {
        const lift = cmd.payload.reason ? [cmd.payload.reason] : (['menu', 'correction', 'app-background'] as const);
        for (const reason of [...f.paused]) {
          if ((lift as readonly string[]).includes(reason)) {
            this.emitPause('GameResumed', reason, src, cmd.issuedAt, cmd.commandId);
          }
        }
        return;
      }
      case 'ConfirmTurn':
        return this.confirmTurn(cmd, base);
      case 'CloseSession': {
        if (cmd.payload.outcome === 'completed') this.assertCanComplete();
        this.batch.emit({
          ...base,
          type: 'SessionClosed',
          payload: { outcome: cmd.payload.outcome, finalStandings: [...(f.standings() ?? [])] },
        });
        return;
      }
      case 'StartSession':
      case 'Rematch':
        reject('invalid', `${cmd.type} is handled by the host`);
    }
  }

  assertCanComplete(): void {
    const f = this.f;
    if (!f.isFinished()) reject('not-finished', 'the game is not over');
    const open = f.unreviewedTurns();
    if (open.length > 0) reject('needs-review', `turns ${open.join(', ')} still need review`);
  }

  private liveDart(throwId: string): DartRecord {
    const rec = this.f.dart(throwId) ?? reject('unknown-dart', `no dart ${throwId} in this session`);
    if (rec.voided !== null) reject('dart-voided', `dart ${throwId} is already voided`);
    return rec;
  }

  private addDart(
    cmd: CommandOf<'AddDart'>,
    base: { source: EventSource; occurredAt: string; causationId: string },
  ): void {
    const f = this.f;
    const p = cmd.payload;
    const turn = f.turns[p.turnIndex] ?? reject('unknown-turn', `no turn ${p.turnIndex}`);
    if (turn.playerId !== p.playerId) reject('wrong-player', `turn ${p.turnIndex} is not that player's`);
    const live = f.liveDarts(turn);
    if (live.length >= 3) {
      // A visit holds 3 darts. An automatic miss gives way to the dart the person adds.
      const pad = [...live].reverse().find((d) => d.padded && d.segment.bed === 'miss');
      if (!pad) reject('turn-full', `turn ${p.turnIndex} already has ${live.length} darts`);
      this.batch.emit({ ...base, type: 'DartVoided', payload: { throwId: pad.throwId, reason: 'user' } });
    }
    this.batch.emit({
      ...base,
      type: 'DartAdded',
      payload: {
        throwId: this.batch.mint(),
        playerId: p.playerId,
        turnIndex: p.turnIndex,
        dartIndex: Math.min(p.dartIndex, f.liveCount(turn)),
        segment: p.segment,
        reason: p.reason,
      },
    });
    this.afterChange(cmd.commandId);
  }

  private confirmTurn(
    cmd: CommandOf<'ConfirmTurn'>,
    base: { source: EventSource; occurredAt: string; causationId: string },
  ): void {
    const f = this.f;
    const turn = f.turns[cmd.payload.turnIndex] ?? reject('unknown-turn', `no turn ${cmd.payload.turnIndex}`);
    if (!turn.end?.needsReview) reject('not-flagged', `turn ${turn.turnIndex} does not need review`);
    if (turn.reviewed) reject('already-reviewed', `turn ${turn.turnIndex} was already reviewed`);
    this.batch.emit({ ...base, type: 'TurnReviewed', payload: { playerId: turn.playerId, turnIndex: turn.turnIndex } });
    if (f.paused.includes('review') && f.awaitingReviewTurn === turn.turnIndex) {
      this.emitPause('GameResumed', 'review', base.source, base.occurredAt, base.causationId);
      this.startNextTurn(cmd.commandId);
      this.releaseHeld();
    }
  }

  // ── Turn policy ───────────────────────────────────────────────────────────

  /** Board darts that arrived during the review pause go to the turn that has just started. */
  private releaseHeld(): void {
    const f = this.f;
    for (const { visit, darts } of f.heldVisits()) {
      for (const bd of darts) {
        if (!f.active) return;
        this.throwDart(bd, f.active);
      }
      if (!f.active) return;
      const end = visit.ended;
      // Only an end the board reported after these darts closes their visit.
      if (end === null || end.seq < darts.at(-1)!.seq) continue;
      const base = { source: this.engine, occurredAt: this.batch.now, causationId: end.eventId };
      if (end.kind === 'takeout' && end.inferred) {
        this.endTurn({ ...base, reason: 'takeout', pad: false, flag: true, reviewPause: true });
        return; // later held darts wait for this new review
      }
      if (f.liveCount(f.active) === 0) continue;
      if (end.kind === 'reset') this.endTurn({ ...base, reason: 'takeout', pad: false, flag: true, reviewPause: false });
      else this.endTurn({ ...base, reason: 'takeout', pad: true, flag: false, reviewPause: false });
    }
  }

  private throwDart(bd: BoardDart, turn: TurnRecord): void {
    this.batch.emit({
      type: 'DartThrown',
      payload: {
        throwId: bd.throwId,
        playerId: turn.playerId,
        turnIndex: turn.turnIndex,
        dartIndex: Math.min(this.f.liveCount(turn), 2),
        segment: bd.segment,
        origin: bd.recovered ? 'recovered' : 'detected',
      },
      source: bd.source,
      occurredAt: bd.occurredAt,
      causationId: bd.eventId,
    });
    this.checkFinished(bd.eventId);
  }

  /** Does a takeout of `visitKey` end `turn`? Not if the visit's darts belong to an earlier turn or the baseline. */
  private visitBelongsTo(visitKey: string, turn: TurnRecord): boolean {
    const f = this.f;
    const visit = f.visit(visitKey);
    if (!visit) return true;
    if (turn.entries.some((d) => f.boardDart(d.throwId)?.visitKey === visitKey)) return true;
    return visit.owner === null && !visit.hasBaseline;
  }

  private endTurn(o: EndTurnOptions): void {
    const f = this.f;
    const turn = f.active!;
    if (o.pad && f.houseRules.missingDartsAreMisses) {
      for (let i = f.liveCount(turn); i < 3; i++) this.pad(turn, i, o.causationId);
    }
    const live = f.liveDarts(turn);
    const needsReview = o.flag || live.length > 3 || live.some((d) => d.origin === 'recovered');
    this.batch.emit({
      type: 'TurnEnded',
      payload: {
        playerId: turn.playerId,
        turnIndex: turn.turnIndex,
        reason: o.reason,
        ...(needsReview ? { needsReview: true as const } : {}),
      },
      source: o.source,
      occurredAt: o.occurredAt,
      causationId: o.causationId,
    });
    this.checkFinished(o.causationId);
    if (o.reviewPause) this.emitPause('GamePaused', 'review', this.engine, this.batch.now, o.causationId);
    else this.startNextTurn(o.causationId);
  }

  private pad(turn: TurnRecord, dartIndex: number, causationId: string): void {
    this.batch.emit({
      type: 'DartAdded',
      payload: {
        throwId: this.batch.mint(),
        playerId: turn.playerId,
        turnIndex: turn.turnIndex,
        dartIndex,
        segment: MISS,
        reason: 'undetected',
      },
      source: this.engine,
      occurredAt: this.batch.now,
      causationId,
    });
  }

  /**
   * Voiding a dart of a turn that ended at an observed takeout re-applies missingDartsAreMisses,
   * so the visit still has 3 darts (unless the voided dart was itself an automatic miss).
   */
  private repad(rec: DartRecord, causationId: string): void {
    const f = this.f;
    const turn = f.turns[rec.turnIndex]!;
    if (!turn.end?.paddingApplies || rec.padded) return;
    for (let i = f.liveCount(turn); i < 3; i++) this.pad(turn, i, causationId);
  }

  /** After a correction: record a new or changed result, or restart play if the finish was withdrawn. */
  private afterChange(causationId: string): void {
    const f = this.f;
    this.checkFinished(causationId);
    if (!f.isFinished() && !f.active && f.turns.length > 0 && !f.paused.includes('review')) {
      this.startNextTurn(causationId);
    }
  }

  private checkFinished(causationId: string): void {
    const f = this.f;
    if (!f.isFinished()) return;
    const standings = f.standings() ?? [];
    if (standings.length === 0) return;
    const last = f.lastGameFinished;
    if (last && last.seq > f.lastTurnStartedSeq && sameStandings(last.standings, standings)) return;
    this.batch.emit({
      type: 'GameFinished',
      payload: { standings: [...standings], provisional: true },
      source: this.engine,
      occurredAt: this.batch.now,
      causationId,
    });
  }

  /**
   * Starts the turn of the player the game names (its opening `nextPlayer` answer for the first
   * turn). No-op if a turn is live or the game is over.
   */
  startNextTurn(causationId: string): void {
    const f = this.f;
    if (f.active || f.closed || f.isFinished()) return;
    const playerId = f.expectedNext();
    if (playerId === null) return;
    const order = f.started.payload.turnOrder;
    const prev = f.turns.at(-1);
    // Display only (games keep their own rounds): a new round starts whenever play wraps
    // round to the same or an earlier seat.
    const roundIndex = prev
      ? prev.roundIndex + (order.indexOf(playerId) <= order.indexOf(prev.playerId) ? 1 : 0)
      : 0;
    this.batch.emit({
      type: 'TurnStarted',
      payload: { playerId, turnIndex: f.turns.length, roundIndex },
      source: this.engine,
      occurredAt: this.batch.now,
      causationId,
    });
  }

  private emitPause(
    type: 'GamePaused' | 'GameResumed',
    reason: EventOf<'GamePaused'>['payload']['reason'],
    source: EventSource,
    occurredAt: string,
    causationId: string,
  ): void {
    this.batch.emit({ type, payload: { reason }, source, occurredAt, causationId });
  }
}
