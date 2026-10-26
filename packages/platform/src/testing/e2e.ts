/**
 * Test support: the Phase 2 acceptance run, end to end. A seeded player script drives the
 * `BoardModel` while the network misbehaves (`FakeBoardTransport` faults, outages, cuts); the
 * real `AutodartsLocalAdapter` feeds `createArcadeRuntime` and its `SessionHost` playing a real
 * game; a referee confirms every review pause as it is. `judge` then compares the session's
 * log and final state with the board model's ground truth.
 */
import { seededRandom, type FaultPlan, type TimerHandle } from '@arcade/adapters';
import { parseArcadeEvent, type ArcadeEvent, type Coords, type EventOf, type Segment } from '@arcade/event-schema';
import type { SessionState } from '@arcade/engine';
import { REGISTRY, Referee, SIM_MIN_VISIT_MS, incarnate, makePlayers, makeWorld, type Incarnation, type World } from './pipeline';

export type GameChoice = 'countdown' | 'siege' | 'cricket' | 'around-the-clock';

export interface E2EOptions {
  /** No faults, no outages, no board resets: nothing may be flagged. */
  clean?: boolean;
  game?: GameChoice;
  /** Drop the app at this quiet step and resume it from the store (crash-resume). */
  crashAtStep?: number;
}

export interface E2EStats {
  boardVisits: number;
  detections: number;
  turns: number;
  flaggedTurns: number;
  inferredTakeouts: number;
  reviewPauses: number;
  recoveredDarts: number;
  /** Board visits whose darts never reached a turn, each covered by a flagged turn. */
  coveredLostVisits: number;
  finished: number;
}

export interface E2ERun {
  seed: number;
  plan: FaultPlan;
  world: World;
  incarnations: Incarnation[];
  referee: Referee;
  sessionId: string;
  log: ArcadeEvent[];
  state: SessionState;
  /** Quiet steps the script passed (crash points). */
  steps: number;
  violations: string[];
  stats: E2EStats;
}

function faultPlan(r: () => number): FaultPlan {
  const plan: FaultPlan = {};
  if (r() < 0.15) return plan; // clean network, outages only
  plan.drop = [0, 0.02, 0.05, 0.1][Math.floor(r() * 4)];
  plan.dropBreaksSocket = true; // a lost frame comes with a broken connection (TCP)
  plan.duplicate = [0, 0.05, 0.15][Math.floor(r() * 3)];
  plan.delayMs = r() < 0.5 ? [0, 0] : [0, 40 + r() * 160];
  if (r() < 0.3) plan.reorder = 0.03;
  if (r() < 0.2) plan.cutEvery = 6 + Math.floor(r() * 30);
  return plan;
}

function gameOptions(game: GameChoice, r: () => number): Record<string, unknown> {
  switch (game) {
    case 'countdown':
      return { start: r() < 0.5 ? 301 : 501, doubleOut: r() < 0.6, maxRounds: 10 };
    case 'siege':
      return { rounds: 5, difficulty: (['easy', 'normal', 'hard'] as const)[Math.floor(r() * 3)] };
    case 'cricket':
      return { maxRounds: 10, cutThroat: r() < 0.3 };
    case 'around-the-clock':
      return { maxRounds: 10, skipAhead: r() < 0.5 };
  }
}

export async function e2eRun(seed: number, options: E2EOptions = {}): Promise<E2ERun> {
  const r = seededRandom(`e2e:${seed}`);
  const plan: FaultPlan = options.clean ? {} : faultPlan(r);
  const world = makeWorld(`e2e:${seed}`, {
    faults: plan,
    board: { noiseFrames: r() < 0.3, missStyle: r() < 0.5 ? 'outside' : 'bare', emptyThrows: r() < 0.8 ? 'omit' : 'array' },
  });
  const socket = { stateOnlySocket: r() < 0.3 };
  const { sched, board, transport } = world;
  const between = (lo: number, hi: number): number => lo + r() * (hi - lo);
  const referee = new Referee(sched, seededRandom(`referee:${seed}`));
  const incarnations = [incarnate(world, 0, socket)];
  const app = () => incarnations.at(-1)!;
  referee.watch(app().runtime);
  app().runtime.start();
  await sched.advance(between(50, 400));

  const game = options.game ?? 'countdown';
  const { min, max } = REGISTRY(game)!.manifest.players;
  const players = makePlayers(min + Math.floor(r() * (Math.min(3, max) - min + 1)));
  const started = await app().runtime.command('StartSession', {
    gameId: game,
    options: gameOptions(game, r),
    players,
    rngSeed: `e2e-${seed}`,
  });
  if (started.status !== 'applied') throw new Error(`StartSession: ${JSON.stringify(started)}`);
  const sessionId = app().runtime.getSnapshot()!.sessionId;

  let steps = 0;
  /** A quiet moment (50 ms after a board action): where the app may crash. */
  const quiet = async (): Promise<void> => {
    await sched.advance(50);
    if (steps++ !== options.crashAtStep) return;
    const old = app();
    await old.runtime.whenIdle();
    old.runtime.stop();
    const next = incarnate(world, incarnations.length, socket);
    incarnations.push(next);
    await next.runtime.resumeSession(sessionId);
    referee.watch(next.runtime);
    next.runtime.start();
  };

  const outageTimers: TimerHandle[] = [];
  const visits = 4 + Math.floor(r() * 10);
  for (let v = 0; v < visits; v++) {
    const trouble = options.clean ? 1 : r();
    if (trouble < 0.3) {
      const at = between(0, 4000);
      const long = r() < 0.35;
      const dur = long ? between(4000, 30000) : between(100, 3000);
      outageTimers.push(sched.setTimeout(() => transport.setReachable(false), at));
      outageTimers.push(sched.setTimeout(() => transport.setReachable(true), at + dur));
    } else if (trouble < 0.4) {
      outageTimers.push(sched.setTimeout(() => transport.cutSockets(), between(0, 4000)));
    }

    const darts = r() < 0.15 ? 1 + Math.floor(r() * 2) : 3;
    let firstThrowAt = -1;
    for (let d = 0; d < darts; d++) {
      await sched.advance(between(250, 2500));
      if (firstThrowAt < 0) firstThrowAt = sched.now();
      const u = r();
      if (u < 0.05) board.bounceOut();
      else if (u < 0.09) board.phantom();
      else board.throwDart();
      await quiet();
      const w = r();
      if (w < 0.06) {
        await sched.advance(between(50, 800));
        board.changeDetection();
      } else if (w < 0.1) {
        await sched.advance(between(50, 800));
        board.withdraw(r() < 0.7 ? undefined : Math.floor(r() * Math.max(1, board.dartsOnBoard)));
      }
    }
    await sched.advance(between(400, 3000));
    // A clean run is a clean session: the board never needs a reset (a reset flags its turn).
    const end = options.clean ? 1 : r();
    if (end < 0.05) {
      board.manualReset();
    } else if (end < 0.08) {
      await sched.advance(Math.max(0, firstThrowAt + SIM_MIN_VISIT_MS - sched.now()));
      board.stickTakeout();
      await sched.advance(between(8500, 12000));
      board.manualReset();
    } else {
      board.startTakeout();
      const pulling = between(300, 2500);
      await sched.advance(Math.max(pulling, firstThrowAt + SIM_MIN_VISIT_MS - sched.now()));
      board.finishTakeout();
      await quiet();
    }
    if (r() < 0.05) {
      await sched.advance(between(300, 1500));
      board.handInFront();
    }
    await sched.advance(between(200, 1500));
  }

  for (const t of outageTimers) sched.clearTimeout(t);
  transport.faults = {};
  transport.setReachable(true);
  await sched.advance(20_000);
  for (let i = 0; i < 20 && (referee.busy || app().runtime.getSnapshot()?.phase === 'awaiting-review'); i++) {
    await sched.advance(5000);
  }
  await app().runtime.whenIdle();
  referee.stop();
  app().runtime.stop();

  const log = await world.store.load(sessionId);
  const state = app().runtime.getSnapshot()!;
  const { violations, stats } = judge(world, log, state, app().runtime.host.getLog(), options);
  for (const inc of incarnations) for (const e of inc.errors) violations.push(`runtime error: ${e}`);
  return { seed, plan, world, incarnations, referee, sessionId, log, state, steps, violations, stats };
}

// ── the oracle ───────────────────────────────────────────────────────────────

const coordKey = (c: Coords): string => `${c.x}|${c.y}`;
const sameSeg = (a: Segment, b: Segment): boolean => a.label === b.label && a.bed === b.bed;

/**
 * Ground truth is the board model's record of what the board reported (its detections and
 * visits): a phantom or a missed bounce-out is a board error only a person can catch, not a
 * pipeline error. A turn is right when its board darts, in order and with their final
 * segments, are exactly the darts the board listed when one visit ended, and it ended with that
 * visit. Every turn must be right or flagged needsReview; every board visit with darts must end
 * up in turns or be covered by a flagged turn; nothing invented or counted twice.
 */
export function judge(
  world: World,
  log: readonly ArcadeEvent[],
  state: SessionState,
  hostLog: readonly ArcadeEvent[],
  options: E2EOptions = {},
): { violations: string[]; stats: E2EStats } {
  const v: string[] = [];
  const { board } = world;

  // The log: gap-free, schema-valid, unique ids, and what the host thinks it wrote.
  const ids = new Set<string>();
  log.forEach((e, i) => {
    if (e.seq !== i + 1) v.push(`log gap: event ${i} has seq ${e.seq}`);
    if (ids.has(e.eventId)) v.push(`duplicate eventId ${e.eventId}`);
    ids.add(e.eventId);
    try {
      parseArcadeEvent(e);
    } catch (err) {
      v.push(`invalid event ${e.seq} ${e.type}: ${String(err).slice(0, 120)}`);
    }
  });
  if (JSON.stringify(log) !== JSON.stringify(hostLog)) v.push('stored log differs from the host’s');
  if (state.lastSeq !== log.length) v.push(`state at seq ${state.lastSeq}, log has ${log.length}`);

  // Board darts → detections, by coordinates (unique per reading in the board model).
  const detByCoords = new Map<string, number>();
  for (const d of board.detections) for (const h of d.history) detByCoords.set(coordKey(h.coords), d.id);
  const detById = new Map(board.detections.map((d) => [d.id, d]));
  const detOfThrow = new Map<string, number | undefined>();
  let recoveredDarts = 0;
  for (const e of log) {
    if (e.type === 'DartDetected') {
      const id = e.payload.coords ? detByCoords.get(coordKey(e.payload.coords)) : undefined;
      if (id === undefined) v.push(`invented dart ${e.payload.segment.label} (seq ${e.seq})`);
      if (!detOfThrow.has(e.payload.throwId)) detOfThrow.set(e.payload.throwId, id);
    } else if (e.type === 'DartUpdated' && e.payload.coords) {
      // Positions are the adapter's identity: an update may move a throw id to another dart.
      const id = detByCoords.get(coordKey(e.payload.coords));
      if (id === undefined) v.push(`update to invented coordinates (seq ${e.seq})`);
      detOfThrow.set(e.payload.throwId, id);
    } else if (e.type === 'DartThrown' && e.payload.origin === 'recovered') recoveredDarts++;
  }

  // Times (simulated ms) of turn starts, for which turn was in play when.
  const turnStartAt: number[] = [];
  for (const e of log) {
    if (e.type === 'TurnStarted') turnStartAt[e.payload.turnIndex] = world.simMs(e.receivedAt);
  }

  // Every live board dart, by detection.
  const holders = new Map<number, number[]>();
  for (const t of state.turns) {
    for (const d of t.darts) {
      if (d.padded || (d.origin !== 'detected' && d.origin !== 'recovered')) continue;
      const det = detOfThrow.get(d.throwId);
      if (det === undefined) continue;
      holders.set(det, [...(holders.get(det) ?? []), t.turnIndex]);
    }
  }
  for (const [det, turns] of holders) {
    if (turns.length > 1 && turns.some((ti) => !state.turns[ti]!.needsReview)) {
      v.push(`detection ${det} counted ${turns.length}× (turns ${turns.join(', ')}), not all flagged`);
    }
  }

  // Each unflagged turn is exactly one board visit.
  const listed = board.listedDetectionIds();
  const finalOf = (visit: number): number[] => {
    const bv = board.visits[visit]!;
    if (bv.endedBy === 'takeout') return bv.finalDetections;
    if (bv.endedBy === 'reset') return [];
    return listed;
  };
  for (const t of state.turns) {
    if (t.needsReview) continue;
    const label = `turn ${t.turnIndex} (${t.ended ? t.endReason : 'open'})`;
    const darts = t.darts.filter((d) => !d.padded);
    if (darts.some((d) => d.origin !== 'detected' && d.origin !== 'recovered')) {
      v.push(`${label}: holds a dart nobody threw on the board`);
      continue;
    }
    const dets = darts.map((d) => detOfThrow.get(d.throwId));
    if (dets.some((d) => d === undefined)) continue; // reported as invented above
    if (dets.length === 0) {
      if (t.ended) v.push(`${label}: ended with no board darts, unflagged`);
      continue;
    }
    const visits = new Set(dets.map((d) => detById.get(d!)!.visit));
    const describe = () =>
      `scored [${darts.map((d) => d.segment.label).join(' ')}] vs board [${[...visits].map((bv) => finalOf(bv).map((id) => detById.get(id)!.segment.label).join(' ')).join(' | ')}]`;
    if (visits.size !== 1) {
      v.push(`silent mismatch, ${label}: darts of ${visits.size} board visits, ${describe()}`);
      continue;
    }
    const bv = board.visits[[...visits][0]!]!;
    const truth = finalOf(bv.index);
    const exact =
      truth.length === dets.length &&
      truth.every((id, i) => id === dets[i] && sameSeg(detById.get(id)!.segment, darts[i]!.segment));
    if (!exact) v.push(`silent mismatch, ${label}: board visit ${bv.index}, ${describe()}`);
    else if (t.ended !== (bv.endedBy !== undefined) || (bv.endedBy !== undefined && bv.endedBy !== 'takeout')) {
      v.push(`silent mismatch, ${label}: board visit ${bv.index} ${bv.endedBy ?? 'still open'}`);
    }
  }

  // Every board visit with darts reached the turns, or a flagged turn covers it. Once the game
  // is over, the visits after the last one any turn scored are nobody's.
  const firstTurnAt = turnStartAt[0] ?? Infinity;
  let lastGameVisit = Infinity;
  if (state.finished) {
    lastGameVisit = -1;
    for (const det of holders.keys()) lastGameVisit = Math.max(lastGameVisit, detById.get(det)!.visit);
  }
  let coveredLostVisits = 0;
  for (const bv of board.visits) {
    const truth = finalOf(bv.index);
    if (truth.length === 0) continue;
    const endAt = bv.endedAt ?? Infinity;
    if (endAt <= firstTurnAt || bv.index > lastGameVisit) continue; // baseline, or after the game
    const missing = truth.filter((id) => !holders.has(id));
    if (missing.length === 0) continue;
    const covered = state.turns.some((t) => {
      if (!t.needsReview) return false;
      const from = turnStartAt[t.turnIndex] ?? Infinity;
      const to = turnStartAt[t.turnIndex + 1] ?? Infinity;
      return from < endAt && bv.startedAt < to;
    });
    if (covered) coveredLostVisits++;
    else {
      v.push(
        `silent mismatch, board visit ${bv.index} (${bv.endedBy ?? 'open'}): [${missing.map((id) => detById.get(id)!.segment.label).join(' ')}] never scored`,
      );
    }
  }

  // Every inferred takeout during play ended a turn flagged and paused for review before the next turn.
  const firstTurnSeq = log.find((e) => e.type === 'TurnStarted')?.seq ?? Infinity;
  const lastFinishedSeq = state.finished ? (log.filter((e) => e.type === 'GameFinished').at(-1)?.seq ?? Infinity) : Infinity;
  let inferredTakeouts = 0;
  for (const e of log) {
    if (e.type !== 'TakeoutFinished' || !e.payload.inferred) continue;
    inferredTakeouts++;
    if (e.seq < firstTurnSeq || e.seq > lastFinishedSeq) continue;
    const ended = log.findIndex((x) => x.type === 'TurnEnded' && x.causationId === e.eventId);
    if (ended < 0) {
      if (state.finished === null) v.push(`inferred takeout (seq ${e.seq}) ended no turn`);
      continue;
    }
    const te = log[ended] as EventOf<'TurnEnded'>;
    if (!te.payload.needsReview) v.push(`turn ${te.payload.turnIndex} ended on an inferred takeout, unflagged`);
    const next = log.slice(ended + 1).find((x) => x.type === 'TurnStarted' || (x.type === 'GamePaused' && x.payload.reason === 'review'));
    if (next?.type !== 'GamePaused') v.push(`turn ${te.payload.turnIndex} ended on an inferred takeout without a review pause before the next turn`);
  }
  if (state.phase === 'awaiting-review') v.push('still paused for review at the end');

  const reviewPauses = log.filter((e) => e.type === 'GamePaused' && e.payload.reason === 'review').length;
  const flaggedTurns = state.turns.filter((t) => t.needsReview).length;
  if (options.clean) {
    if (flaggedTurns > 0) v.push(`clean network: ${flaggedTurns} turn(s) flagged`);
    if (reviewPauses + inferredTakeouts + recoveredDarts > 0) {
      v.push(`clean network: ${reviewPauses} review pause(s), ${inferredTakeouts} inferred takeout(s), ${recoveredDarts} recovered dart(s)`);
    }
  }
  return {
    violations: v,
    stats: {
      boardVisits: board.visits.length,
      detections: board.detections.length,
      turns: state.turns.length,
      flaggedTurns,
      inferredTakeouts,
      reviewPauses,
      recoveredDarts,
      coveredLostVisits,
      finished: state.finished ? 1 : 0,
    },
  };
}

function withoutThrowId<T extends { throwId: string }>(d: T): Omit<T, 'throwId'> {
  const copy: Partial<T> = { ...d };
  delete copy.throwId;
  return copy as Omit<T, 'throwId'>;
}

/** The game-visible part of a state, without ids or log positions: what crash-resume must keep. */
export function gameView(state: SessionState): unknown {
  return {
    phase: state.phase,
    gameId: state.gameId,
    options: state.options,
    rngSeed: state.rngSeed,
    players: state.players,
    turns: state.turns.map((t) => ({
      playerId: t.playerId,
      roundIndex: t.roundIndex,
      ended: t.ended,
      endReason: t.endReason,
      needsReview: t.needsReview,
      reviewed: t.reviewed,
      closedBy: t.closedBy,
      afterFinish: t.afterFinish,
      points: t.points,
      darts: t.darts.map(withoutThrowId),
      voided: t.voidedDarts.map(withoutThrowId),
    })),
    needsReview: state.needsReview,
    reviewedTurns: state.reviewedTurns,
    awaitingReviewTurn: state.awaitingReviewTurn,
    heldDarts: state.heldDarts.map((d) => [d.segment.label, d.recovered]),
    baselineDarts: state.baselineDarts,
    paused: state.paused,
    finished: state.finished,
    standings: state.standings,
    canComplete: state.canComplete,
    board: state.board,
    gameState: state.gameState,
    view: state.view,
  };
}
