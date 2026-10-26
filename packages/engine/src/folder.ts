import {
  isBoardFact,
  points,
  sameSegment,
  type ArcadeEvent,
  type EventOf,
  type EventSource,
  type HouseRules,
  type PauseReason,
  type PlayerId,
  type PlayerRef,
  type Segment,
  type Standing,
} from '@arcade/event-schema';
import { EngineError } from './errors';
import type { GameEffect, GameModule } from './game-module';
import { GamePass, type TurnResult } from './game-pass';
import type { GameRegistry } from './registry';
import type {
  BoardStatus,
  ConnectionState,
  DartOrigin,
  DartView,
  HeldDartView,
  SessionPhase,
  SessionState,
  TurnEndReason,
  TurnView,
  VoidReason,
  VoidedDartView,
} from './state';

export interface FoldOptions {
  /**
   * Keep a game-state checkpoint every N turns, so a live dart or a correction replays only from
   * the nearest checkpoint instead of from SessionStarted. 0 turns the cache off. Default 8.
   */
  snapshotEvery?: number;
  /** Deep-freeze every state a game returns, so a module that mutates its input throws. Default false. */
  freezeGameStates?: boolean;
}

/** A dart attributed to a turn (layer 2: DartThrown or DartAdded). */
export interface DartRecord {
  readonly throwId: string;
  readonly turnIndex: number;
  segment: Segment;
  readonly origin: DartOrigin;
  /** Added by the host at an observed takeout (missingDartsAreMisses). */
  readonly padded: boolean;
  readonly createdSeq: number;
  /** Its scoring effects are emitted: a DartThrown, or a manual-mode dart appended to the live turn. */
  readonly live: boolean;
  voided: VoidReason | null;
  adjusted: boolean;
  userCorrected: boolean;
}

export interface TurnRecord {
  readonly turnIndex: number;
  readonly playerId: PlayerId;
  readonly roundIndex: number;
  readonly startSeq: number;
  /** Throw order, voided darts kept in place. */
  readonly entries: DartRecord[];
  end: {
    seq: number;
    reason: TurnEndReason;
    needsReview: boolean;
    /**
     * Ended by an observed takeout, or a manual visit by "Next player", with missingDartsAreMisses
     * on, so the visit is kept at 3 darts.
     */
    paddingApplies: boolean;
  } | null;
  reviewed: boolean;
  /**
   * Started when a review pause ended (by ConfirmTurn, or as its held visits ended). The outage
   * behind the pause may have hidden any number of visits, so whether this player is really up
   * is the game's guess: the turn is flagged.
   */
  readonly afterReview: boolean;
  rev: number;
}

/** A dart the board reported (layer 1), whether or not it was attributed to a turn. */
export interface BoardDart {
  readonly throwId: string;
  readonly visitKey: string;
  segment: Segment;
  readonly recovered: boolean;
  /** The adapter could not read its latest segment (`pendingReview`): its turn is flagged. */
  pendingReview: boolean;
  withdrawn: boolean;
  /**
   * The board said something about this dart that a person's earlier word overrides: it
   * updated a dart the person voided, re-read one they corrected as something else, or
   * withdrew one they corrected. The person wins (Decider), but the board's ids follow its own
   * positions, so the fact may really be about another dart: its turn is flagged.
   */
  disputed: boolean;
  /** What was going on when the board reported it. */
  readonly phase: 'baseline' | 'turn' | 'review' | 'idle';
  readonly eventId: string;
  /** Seq of the DartDetected fact. */
  readonly seq: number;
  readonly source: EventSource;
  readonly occurredAt: string;
  attributedTo: number | null;
}

export interface VisitRecord {
  readonly visitKey: string;
  readonly throwIds: string[];
  /** First turn a dart of this visit was attributed to. */
  owner: number | null;
  hasBaseline: boolean;
  ended: { kind: 'takeout' | 'reset'; inferred: boolean; eventId: string; seq: number } | null;
}

interface StartedInfo {
  sessionId: string;
  startedAt: string;
  payload: EventOf<'SessionStarted'>['payload'];
  game: GameModule;
  players: readonly PlayerRef[];
}

function corrupt(message: string): never {
  throw new EngineError('corrupt-log', message);
}

/**
 * Folds one session's log into state. Event by event it maintains the turn structure (layer 2),
 * the board-visit model (layer 1, which the host derives new layer-2 events from) and a
 * `GamePass` that replays the turns through the game module. `foldSession` is a fold over a
 * fresh folder; the host keeps one alive and applies each new event, which ends in exactly the
 * same state because every piece of it is a function of the events alone.
 */
export class SessionFolder {
  private readonly registry: GameRegistry;
  private readonly opts: Required<FoldOptions>;

  private info: StartedInfo | null = null;
  private pass: GamePass | null = null;
  lastSeq = 0;

  readonly turns: TurnRecord[] = [];
  active: TurnRecord | null = null;
  private readonly darts = new Map<string, DartRecord>();

  private readonly boardDarts = new Map<string, BoardDart>();
  private readonly visits = new Map<string, VisitRecord>();
  private readonly held = new Set<string>();
  /**
   * Visits that turned up during a review pause, in the order they did: a held dart, or a
   * visit end for a visit no turn owns (an inferred takeout of a visit with no darts).
   */
  private readonly heldOrder: string[] = [];
  /** eventIds of visit ends that have already ended a turn. */
  private readonly consumedEnds = new Set<string>();
  private readonly takeoutFacts = new Map<string, { kind: 'takeout' | 'reset'; inferred: boolean }>();
  connection: ConnectionState = 'unknown';
  boardStatus: BoardStatus | 'unknown' = 'unknown';

  readonly paused: PauseReason[] = [];
  awaitingReviewTurn: number | null = null;
  private readonly unreviewed = new Set<number>();
  /**
   * A review pause has just ended and its release is running: the engine events that follow
   * GameResumed{review} (held darts thrown, their visits ended, turns started) until the next
   * board fact or person's input. Every turn started meanwhile is `afterReview`.
   */
  private releasing = false;
  lastGameFinished: { seq: number; standings: readonly Standing[] } | null = null;
  lastTurnStartedSeq = 0;
  closed: { outcome: 'completed' | 'abandoned'; finalStandings: readonly Standing[] } | null = null;
  /** Every causationId in the log: commands already applied, board facts already derived. */
  readonly causationIds = new Set<string>();

  private readonly viewCache = new Map<number, { rev: number; result: TurnResult | undefined; view: TurnView }>();

  constructor(registry: GameRegistry, options: FoldOptions = {}) {
    this.registry = registry;
    this.opts = { snapshotEvery: options.snapshotEvery ?? 8, freezeGameStates: options.freezeGameStates ?? false };
  }

  static fromLog(events: readonly ArcadeEvent[], registry: GameRegistry, options?: FoldOptions): SessionFolder {
    const folder = new SessionFolder(registry, options);
    for (const e of events) folder.apply(e);
    folder.pass?.ensure(folder.turns);
    folder.pass?.resetDrain();
    return folder;
  }

  /**
   * An independent copy, for a dry run (W4 preview). The mutable records are copied; game
   * checkpoints, turn results and turn views are immutable and shared, so a previewed change
   * replays only from the checkpoint before the turn it touches.
   */
  clone(): SessionFolder {
    const c = new SessionFolder(this.registry, this.opts);
    c.info = this.info;
    c.pass = this.pass?.clone() ?? null;
    c.lastSeq = this.lastSeq;
    for (const t of this.turns) {
      const entries = t.entries.map((d) => ({ ...d }));
      c.turns.push({ ...t, entries, end: t.end && { ...t.end } });
      for (const d of entries) c.darts.set(d.throwId, d);
    }
    c.active = this.active ? c.turns[this.active.turnIndex]! : null;
    for (const [id, bd] of this.boardDarts) c.boardDarts.set(id, { ...bd });
    for (const [key, v] of this.visits) c.visits.set(key, { ...v, throwIds: [...v.throwIds], ended: v.ended && { ...v.ended } });
    for (const id of this.held) c.held.add(id);
    c.heldOrder.push(...this.heldOrder);
    for (const id of this.consumedEnds) c.consumedEnds.add(id);
    for (const [id, fact] of this.takeoutFacts) c.takeoutFacts.set(id, fact);
    c.connection = this.connection;
    c.boardStatus = this.boardStatus;
    c.paused.push(...this.paused);
    c.awaitingReviewTurn = this.awaitingReviewTurn;
    for (const t of this.unreviewed) c.unreviewed.add(t);
    c.lastGameFinished = this.lastGameFinished;
    c.lastTurnStartedSeq = this.lastTurnStartedSeq;
    c.releasing = this.releasing;
    c.closed = this.closed;
    for (const id of this.causationIds) c.causationIds.add(id);
    for (const [turn, cached] of this.viewCache) c.viewCache.set(turn, cached);
    return c;
  }

  // ── Reads used by the host ────────────────────────────────────────────────

  get started(): StartedInfo {
    if (this.info === null) throw new EngineError('host', 'no SessionStarted folded yet');
    return this.info;
  }

  get sessionId(): string | null {
    return this.info?.sessionId ?? null;
  }

  get houseRules(): HouseRules {
    return this.started.payload.houseRules;
  }

  dart(throwId: string): DartRecord | undefined {
    return this.darts.get(throwId);
  }

  boardDart(throwId: string): BoardDart | undefined {
    return this.boardDarts.get(throwId);
  }

  visit(visitKey: string): VisitRecord | undefined {
    return this.visits.get(visitKey);
  }

  liveDarts(turn: TurnRecord): DartRecord[] {
    return turn.entries.filter((d) => d.voided === null);
  }

  liveCount(turn: TurnRecord): number {
    let n = 0;
    for (const d of turn.entries) if (d.voided === null) n++;
    return n;
  }

  /**
   * A visit entered by hand (manual mode): every dart in it, padding aside, came from
   * `AddDart{reason:'manual-mode'}`. A visit with no darts counts only while no board has
   * reported in this session, so "Next player" on a board-mode turn the board saw nothing
   * of stays a plain skip.
   */
  manualVisit(turn: TurnRecord): boolean {
    let darts = 0;
    for (const d of turn.entries) {
      if (d.padded) continue;
      if (d.origin !== 'manual-mode') return false;
      darts++;
    }
    return darts > 0 || this.connection === 'unknown';
  }

  /** Before the first turn: live board darts that were on the board when the game started. */
  baselineLive(): number {
    if (this.turns.length > 0) return 0;
    let n = 0;
    for (const bd of this.boardDarts.values()) {
      if (bd.phase === 'baseline' && !bd.withdrawn && this.visits.get(bd.visitKey)?.ended == null) n++;
    }
    return n;
  }

  /**
   * What a review pause is holding for the turns after it, in the order it happened: each
   * visit with held board darts (in board order), each visit with no darts that the board
   * may have ended offline (`TakeoutFinished{inferred}` with nothing held: a whole visit may
   * have come and gone), and each visit that ended after the board withdrew every dart it
   * held (`withdrawn`: it still was a visit). `lastSeq`: the latest of those darts, so only a
   * visit end after it closes the visit. Empty while the game is over: there is no next turn
   * to hold for.
   */
  heldVisits(): { visit: VisitRecord; darts: BoardDart[]; withdrawn: number; lastSeq: number }[] {
    if (this.heldOrder.length === 0 || this.isFinished()) return [];
    const out: { visit: VisitRecord; darts: BoardDart[]; withdrawn: number; lastSeq: number }[] = [];
    for (const key of this.heldOrder) {
      const visit = this.visits.get(key)!;
      const darts: BoardDart[] = [];
      let withdrawn = 0;
      let lastSeq = 0;
      for (const id of visit.throwIds) {
        const bd = this.boardDarts.get(id)!;
        if (this.held.has(id)) darts.push(bd);
        else if (bd.phase === 'review' && bd.withdrawn && bd.attributedTo === null) withdrawn++;
        else continue;
        lastSeq = Math.max(lastSeq, bd.seq);
      }
      const end = visit.ended;
      const pendingEnd =
        visit.owner === null &&
        end !== null &&
        !this.consumedEnds.has(end.eventId) &&
        ((end.kind === 'takeout' && end.inferred) || (withdrawn > 0 && darts.length === 0));
      if (darts.length > 0 || pendingEnd) out.push({ visit, darts, withdrawn, lastSeq });
    }
    return out;
  }

  unreviewedTurns(): number[] {
    return [...this.unreviewed].sort((a, b) => a - b);
  }

  /**
   * The turn will be flagged when it ends, whatever ends it (§7.5): a recovered or pendingReview
   * dart, more than three darts in one visit, a dart the board and a person disagree about
   * (`BoardDart.disputed`, voided ones too), or a review pause behind it. A review pause holds
   * the game after a takeout that may have happened offline, and the outage may have hidden any
   * number of visits (or none). So whoever the game names next when it ends (`afterReview`),
   * and whoever gets the darts that arrived meanwhile (held darts, also in the turns after that),
   * is a guess.
   */
  flaggedAtEnd(turn: TurnRecord): boolean {
    const live = this.liveDarts(turn);
    return (
      turn.afterReview ||
      live.length > 3 ||
      turn.entries.some((d) => this.boardDarts.get(d.throwId)?.disputed === true) ||
      live.some((d) => {
        const bd = this.boardDarts.get(d.throwId);
        return d.origin === 'recovered' || bd?.pendingReview === true || bd?.phase === 'review';
      })
    );
  }

  /**
   * The live turn counts as unreviewed before it ends: it holds darts that will flag it, or
   * board darts are held for the turns after it. The winning turn stays live until its takeout,
   * so without this a session could close as completed on an unchecked dart. (Nothing is held
   * once the game is over, so for a finished game only the live turn's darts count.)
   */
  liveTurnUnreviewed(): boolean {
    return (this.active !== null && this.flaggedAtEnd(this.active)) || this.heldVisits().length > 0;
  }

  private gamePass(): GamePass {
    if (this.pass === null) throw new EngineError('host', 'no SessionStarted folded yet');
    this.pass.ensure(this.turns);
    return this.pass;
  }

  isFinished(): boolean {
    return this.gamePass().finished !== null;
  }

  standings(): readonly Standing[] | null {
    const pass = this.gamePass();
    return pass.finished?.standings ?? this.started.game.result(pass.state);
  }

  /** Who the game named after the last ended turn (null if the game is over or a turn is live). */
  expectedNext(): PlayerId | null {
    return this.gamePass().next;
  }

  turnResult(turnIndex: number): TurnResult | undefined {
    return this.gamePass().result(turnIndex);
  }

  drainEffects(fromSeq: number): { seq: number; effect: GameEffect }[] {
    return this.gamePass().drainEffects(fromSeq);
  }

  phase(): SessionPhase {
    if (this.closed) return 'closed';
    if (this.paused.includes('review')) return 'awaiting-review';
    if (this.isFinished()) return 'finished';
    if (this.turns.length === 0) return 'awaiting-clear-board';
    return 'playing';
  }

  // ── Apply ──────────────────────────────────────────────────────────────────

  apply(e: ArcadeEvent): void {
    if (this.info === null) {
      if (e.type !== 'SessionStarted') corrupt(`a session log must begin with SessionStarted, got ${e.type}`);
    } else if (e.sessionId !== this.info.sessionId) {
      corrupt(`event ${e.seq} belongs to session ${e.sessionId}`);
    }
    if (e.seq !== this.lastSeq + 1) corrupt(`expected seq ${this.lastSeq + 1}, got ${e.seq}`);
    if (this.closed) corrupt(`event ${e.seq} follows SessionClosed`);
    this.lastSeq = e.seq;
    if (e.type === 'GameResumed' && e.payload.reason === 'review') this.releasing = true;
    else if (isBoardFact(e) || e.source.kind === 'manual') this.releasing = false;
    const afterReview = this.releasing;
    if (e.causationId !== undefined) this.causationIds.add(e.causationId);

    switch (e.type) {
      case 'SessionStarted':
        return this.onSessionStarted(e);
      case 'TurnStarted':
        return this.onTurnStarted(e, afterReview);
      case 'DartThrown':
        return this.onDartThrown(e);
      case 'DartAdded':
        return this.onDartAdded(e);
      case 'DartCorrected': {
        const rec = this.requireDart(e.payload.throwId, e.seq);
        rec.segment = e.payload.segment;
        rec.adjusted = true;
        if (e.payload.reason === 'user') rec.userCorrected = true;
        return this.touch(rec.turnIndex);
      }
      case 'DartVoided': {
        const rec = this.requireDart(e.payload.throwId, e.seq);
        rec.voided = e.payload.reason;
        return this.touch(rec.turnIndex);
      }
      case 'TurnEnded':
        return this.onTurnEnded(e);
      case 'TurnReviewed': {
        const turn = this.requireTurn(e.payload.turnIndex, e.seq);
        turn.reviewed = true;
        this.unreviewed.delete(turn.turnIndex);
        turn.rev++;
        return;
      }
      case 'GamePaused':
        if (!this.paused.includes(e.payload.reason)) this.paused.push(e.payload.reason);
        if (e.payload.reason === 'review') this.awaitingReviewTurn = this.turns.at(-1)?.turnIndex ?? null;
        return;
      case 'GameResumed': {
        const i = this.paused.indexOf(e.payload.reason);
        if (i >= 0) this.paused.splice(i, 1);
        if (e.payload.reason === 'review') this.awaitingReviewTurn = null;
        return;
      }
      case 'GameFinished':
        this.lastGameFinished = { seq: e.seq, standings: e.payload.standings };
        return;
      case 'SessionClosed':
        this.closed = { outcome: e.payload.outcome, finalStandings: e.payload.finalStandings };
        return;
      case 'DartDetected':
        return this.onDartDetected(e);
      case 'DartUpdated': {
        const bd = this.boardDarts.get(e.payload.throwId);
        const rec = this.darts.get(e.payload.throwId);
        if (bd && rec && this.overrules(rec, bd) && (rec.voided !== null || !sameSegment(rec.segment, e.payload.segment))) this.dispute(bd);
        if (bd) {
          bd.segment = e.payload.segment;
          const pending = e.payload.pendingReview === true;
          if (bd.pendingReview !== pending) {
            bd.pendingReview = pending;
            if (bd.attributedTo !== null) this.touch(bd.attributedTo);
          }
        }
        return;
      }
      case 'DartWithdrawn': {
        const bd = this.boardDarts.get(e.payload.throwId);
        const rec = this.darts.get(e.payload.throwId);
        if (bd && rec && rec.voided === null && this.overrules(rec, bd)) this.dispute(bd);
        if (bd) {
          bd.withdrawn = true;
          this.held.delete(bd.throwId);
        }
        return;
      }
      case 'TakeoutStarted':
        this.visitFor(e.payload.visitKey);
        return;
      case 'TakeoutFinished':
      case 'VisitReset': {
        const visit = this.visitFor(e.payload.visitKey);
        const kind = e.type === 'TakeoutFinished' ? 'takeout' : 'reset';
        const inferred = e.type === 'TakeoutFinished' && e.payload.inferred === true;
        visit.ended ??= { kind, inferred, eventId: e.eventId, seq: e.seq };
        this.takeoutFacts.set(e.eventId, { kind, inferred });
        if (this.inReviewHold() && visit.owner === null) this.holdVisit(visit.visitKey);
        return;
      }
      case 'SourceConnectionChanged':
        this.connection = e.payload.state;
        return;
      case 'BoardStatusChanged':
        this.boardStatus = e.payload.status;
        return;
      case 'SourceAnomaly':
        return;
    }
  }

  private onSessionStarted(e: EventOf<'SessionStarted'>): void {
    const p = e.payload;
    const game = this.registry(p.gameId);
    if (!game) throw new EngineError('unknown-game', `no game "${p.gameId}" in the registry`);
    const parsed = game.options.safeParse(p.options);
    if (!parsed.success) throw new EngineError('invalid-options', `options for "${p.gameId}" no longer validate`);
    const players = p.turnOrder.map((id) => p.players.find((pl) => pl.playerId === id) ?? corrupt(`unknown player ${id}`));
    this.info = { sessionId: e.sessionId, startedAt: e.occurredAt, payload: p, game, players };
    this.pass = GamePass.start(
      game,
      { players, options: parsed.data, seed: p.rngSeed },
      { snapshotEvery: this.opts.snapshotEvery, freezeStates: this.opts.freezeGameStates },
    );
  }

  private onTurnStarted(e: EventOf<'TurnStarted'>, afterReview: boolean): void {
    const p = e.payload;
    if (this.active) corrupt(`turn ${p.turnIndex} started while turn ${this.active.turnIndex} is live`);
    if (p.turnIndex !== this.turns.length) corrupt(`expected turn ${this.turns.length}, got ${p.turnIndex}`);
    if (!this.started.players.some((pl) => pl.playerId === p.playerId)) corrupt(`unknown player ${p.playerId}`);
    const turn: TurnRecord = {
      turnIndex: p.turnIndex,
      playerId: p.playerId,
      roundIndex: p.roundIndex,
      startSeq: e.seq,
      entries: [],
      end: null,
      reviewed: false,
      afterReview,
      rev: 0,
    };
    this.turns.push(turn);
    this.active = turn;
    this.lastTurnStartedSeq = e.seq;
    this.pass!.markDirty(turn.turnIndex);
  }

  private onDartThrown(e: EventOf<'DartThrown'>): void {
    const p = e.payload;
    const turn = this.requireTurn(p.turnIndex, e.seq);
    if (turn.playerId !== p.playerId) corrupt(`dart ${p.throwId} names the wrong player for turn ${p.turnIndex}`);
    if (this.darts.has(p.throwId)) corrupt(`dart ${p.throwId} attributed twice`);
    const rec: DartRecord = {
      throwId: p.throwId,
      turnIndex: p.turnIndex,
      segment: p.segment,
      origin: p.origin,
      padded: false,
      createdSeq: e.seq,
      live: turn === this.active,
      voided: null,
      adjusted: false,
      userCorrected: false,
    };
    turn.entries.push(rec);
    this.darts.set(rec.throwId, rec);
    const bd = this.boardDarts.get(p.throwId);
    if (bd) {
      bd.attributedTo = p.turnIndex;
      this.held.delete(bd.throwId);
      const visit = this.visits.get(bd.visitKey);
      if (visit && visit.owner === null) visit.owner = p.turnIndex;
    }
    this.touch(turn.turnIndex);
  }

  private onDartAdded(e: EventOf<'DartAdded'>): void {
    const p = e.payload;
    const turn = this.requireTurn(p.turnIndex, e.seq);
    if (turn.playerId !== p.playerId) corrupt(`dart ${p.throwId} names the wrong player for turn ${p.turnIndex}`);
    if (this.darts.has(p.throwId)) corrupt(`dart ${p.throwId} attributed twice`);
    const liveBefore = this.liveCount(turn);
    const rec: DartRecord = {
      throwId: p.throwId,
      turnIndex: p.turnIndex,
      segment: p.segment,
      origin: p.reason,
      padded: e.source.kind === 'engine' && p.reason === 'undetected',
      createdSeq: e.seq,
      live: p.reason === 'manual-mode' && turn === this.active && p.dartIndex >= liveBefore,
      voided: null,
      adjusted: false,
      userCorrected: false,
    };
    // `dartIndex` is the slot among live darts the dart goes into; later darts move up one.
    let insertAt = turn.entries.length;
    if (p.dartIndex < liveBefore) {
      let seen = 0;
      insertAt = turn.entries.findIndex((d) => d.voided === null && seen++ === p.dartIndex);
    }
    turn.entries.splice(insertAt, 0, rec);
    this.darts.set(rec.throwId, rec);
    this.touch(turn.turnIndex);
  }

  private onTurnEnded(e: EventOf<'TurnEnded'>): void {
    const p = e.payload;
    const turn = this.requireTurn(p.turnIndex, e.seq);
    if (turn !== this.active) corrupt(`turn ${p.turnIndex} ended but is not the live turn`);
    const cause = e.causationId === undefined ? undefined : this.takeoutFacts.get(e.causationId);
    turn.end = {
      seq: e.seq,
      reason: p.reason,
      needsReview: p.needsReview === true,
      paddingApplies:
        this.started.payload.houseRules.missingDartsAreMisses &&
        ((p.reason === 'takeout' && cause?.kind === 'takeout' && !cause.inferred) ||
          (p.reason === 'manual-skip' && cause === undefined && this.manualVisit(turn))),
    };
    if (p.needsReview) this.unreviewed.add(turn.turnIndex);
    if (e.causationId !== undefined && cause !== undefined) this.consumedEnds.add(e.causationId);
    this.active = null;
    this.touch(turn.turnIndex);
  }

  private onDartDetected(e: EventOf<'DartDetected'>): void {
    const p = e.payload;
    if (this.boardDarts.has(p.throwId)) return; // a re-delivered fact; the first sighting stands
    const visit = this.visitFor(p.visitKey);
    const phase = this.turns.length === 0 ? 'baseline' : this.active ? 'turn' : this.inReviewHold() ? 'review' : 'idle';
    const bd: BoardDart = {
      throwId: p.throwId,
      visitKey: p.visitKey,
      segment: p.segment,
      recovered: p.recovered === true,
      pendingReview: p.pendingReview === true,
      withdrawn: false,
      disputed: false,
      phase,
      eventId: e.eventId,
      seq: e.seq,
      source: e.source,
      occurredAt: e.occurredAt,
      attributedTo: null,
    };
    this.boardDarts.set(bd.throwId, bd);
    visit.throwIds.push(bd.throwId);
    if (phase === 'baseline') visit.hasBaseline = true;
    if (phase === 'review') {
      this.held.add(bd.throwId);
      this.holdVisit(bd.visitKey);
    }
  }

  /**
   * A person's word about `rec` stands over the board's (a correction, or a void other than the
   * board's own withdrawal), and the board is not just clearing a visit it reset.
   */
  private overrules(rec: DartRecord, bd: BoardDart): boolean {
    const byPerson = rec.userCorrected || (rec.voided !== null && rec.voided !== 'source-withdrawn');
    return byPerson && this.visits.get(bd.visitKey)?.ended?.kind !== 'reset';
  }

  private dispute(bd: BoardDart): void {
    if (bd.disputed) return;
    bd.disputed = true;
    if (bd.attributedTo !== null) this.touch(bd.attributedTo);
  }

  /** Between turns, waiting for a person to confirm a turn that ended on an inferred takeout. */
  private inReviewHold(): boolean {
    return this.turns.length > 0 && this.active === null && this.paused.includes('review');
  }

  private holdVisit(visitKey: string): void {
    if (!this.heldOrder.includes(visitKey)) this.heldOrder.push(visitKey);
  }

  private visitFor(visitKey: string): VisitRecord {
    let visit = this.visits.get(visitKey);
    if (!visit) {
      visit = { visitKey, throwIds: [], owner: null, hasBaseline: false, ended: null };
      this.visits.set(visitKey, visit);
    }
    return visit;
  }

  private requireTurn(turnIndex: number, seq: number): TurnRecord {
    return this.turns[turnIndex] ?? corrupt(`event ${seq} refers to unknown turn ${turnIndex}`);
  }

  private requireDart(throwId: string, seq: number): DartRecord {
    return this.darts.get(throwId) ?? corrupt(`event ${seq} refers to unknown dart ${throwId}`);
  }

  private touch(turnIndex: number): void {
    const turn = this.turns[turnIndex]!;
    turn.rev++;
    this.pass!.markDirty(turnIndex);
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  /** An immutable view of the current state. Nothing in it aliases the folder's mutable records. */
  snapshot(): SessionState {
    const info = this.started;
    const pass = this.gamePass();
    const turns = this.turns.map((t) => this.turnView(t, pass.result(t.turnIndex)));
    const current = this.active ? turns[this.active.turnIndex]! : null;
    const last = turns.at(-1) ?? null;
    const finished = pass.finished;
    const standings = finished?.standings ?? info.game.result(pass.state);
    const unreviewed = this.unreviewedTurns();
    // Once the game is over nothing is held for a next turn; a correction that reopens the game
    // releases them again (Decider.afterChange).
    const heldDarts: HeldDartView[] =
      finished !== null
        ? []
        : this.heldVisits().flatMap(({ darts }) =>
            darts.map((bd) => ({ throwId: bd.throwId, segment: bd.segment, visitKey: bd.visitKey, recovered: bd.recovered })),
          );
    return {
      sessionId: info.sessionId,
      lastSeq: this.lastSeq,
      startedAt: info.startedAt,
      gameId: info.payload.gameId,
      gameVersion: info.payload.gameVersion,
      gameVersionMismatch: info.payload.gameVersion !== info.game.manifest.version,
      gameName: info.game.manifest.name,
      options: info.payload.options,
      houseRules: info.payload.houseRules,
      rngSeed: info.payload.rngSeed,
      players: info.players,
      turnOrder: info.payload.turnOrder,
      phase: this.phase(),
      currentTurn: current,
      currentPlayerId: current?.playerId ?? null,
      turnIndex: last?.turnIndex ?? null,
      roundIndex: last?.roundIndex ?? null,
      dartsThisTurn: current?.darts ?? [],
      nextPlayerId: this.active === null && finished === null ? pass.next : null,
      paused: [...this.paused],
      isPaused: this.paused.length > 0,
      turns,
      needsReview: unreviewed,
      reviewedTurns: this.turns.filter((t) => t.reviewed).map((t) => t.turnIndex),
      awaitingReviewTurn: this.awaitingReviewTurn,
      heldDarts,
      baselineDarts: this.baselineLive(),
      finished: finished
        ? { standings: finished.standings, provisional: this.closed?.outcome !== 'completed' }
        : null,
      standings,
      canComplete: this.closed === null && finished !== null && unreviewed.length === 0 && !this.liveTurnUnreviewed(),
      closed: this.closed,
      board: { connection: this.connection, status: this.boardStatus },
      gameState: pass.state,
      view: info.game.view(pass.state),
    };
  }

  private turnView(turn: TurnRecord, result: TurnResult | undefined): TurnView {
    const cached = this.viewCache.get(turn.turnIndex);
    if (cached && cached.rev === turn.rev && cached.result === result) return cached.view;
    const darts: DartView[] = [];
    const voidedDarts: VoidedDartView[] = [];
    for (const d of turn.entries) {
      if (d.voided !== null) {
        voidedDarts.push({ throwId: d.throwId, segment: d.segment, origin: d.origin, reason: d.voided });
        continue;
      }
      const status = result?.statuses.get(d.throwId);
      darts.push({
        throwId: d.throwId,
        position: darts.length,
        segment: d.segment,
        points: points(d.segment),
        origin: d.origin,
        padded: d.padded,
        pendingReview: this.boardDarts.get(d.throwId)?.pendingReview ?? false,
        scored: status?.scored ?? false,
        greyedBy: status?.greyedBy ?? null,
        adjusted: d.adjusted,
      });
    }
    const view: TurnView = {
      turnIndex: turn.turnIndex,
      playerId: turn.playerId,
      roundIndex: turn.roundIndex,
      darts,
      voidedDarts,
      ended: turn.end !== null,
      endReason: turn.end?.reason ?? null,
      needsReview: turn.end?.needsReview ?? false,
      reviewed: turn.reviewed,
      closedBy: result?.closedBy ?? null,
      afterFinish: result?.afterFinish ?? false,
      points: result?.points ?? 0,
    };
    this.viewCache.set(turn.turnIndex, { rev: turn.rev, result, view });
    return view;
  }
}
