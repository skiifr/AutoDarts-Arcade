/**
 * Test support: the end-to-end acceptance run. A seeded script plays the people in the room:
 * players taking turns at the `BoardModel` (the physical board), a referee who confirms every
 * review pause as it is, and, in some runs, a player correcting recent darts in W4 (the user
 * bot). Meanwhile the network misbehaves (`FakeBoardTransport` faults, outages, cuts), the
 * storage refuses appends, and the app crashes and is launched again. The real
 * `AutodartsLocalAdapter` feeds `createArcadeRuntime` and its `SessionHost` playing a real game.
 * `judge` then compares the session's log and final state with the ground truth: what the board
 * reported, who threw each visit, and what the person changed.
 */
import { createUlidSource, randomSegment, seededRandom, type FaultPlan, type RandomSource, type TimerHandle, type VirtualScheduler } from '@arcade/adapters';
import {
  COMMAND_SCHEMA_VERSION,
  parseArcadeEvent,
  type ArcadeCommand,
  type ArcadeEvent,
  type Coords,
  type EventOf,
  type PlayerId,
  type Segment,
} from '@arcade/event-schema';
import type { HostResult, SessionState } from '@arcade/engine';
import type { ArcadeRuntime } from '../arcade-runtime';
import { EPOCH, REGISTRY, Referee, SIM_MIN_VISIT_MS, incarnate, makePlayers, makeWorld, type Incarnation, type World } from './pipeline';

export type GameChoice = 'countdown' | 'siege' | 'cricket' | 'around-the-clock';

export interface E2EOptions {
  /** No faults, no outages, no board resets, no failing store: nothing may be flagged but a visit the board withdrew. */
  clean?: boolean;
  game?: GameChoice;
  /** Drop the app at this quiet step and resume it from the store at once (crash-resume). */
  crashAtStep?: number;
  /**
   * Switch the hard parts on by the seed, each in a share of the runs: the user bot (30 %), a
   * failing store (20 %), crashes at any moment (20 %), long idle stretches (25 %).
   */
  mix?: boolean;
  /** A player corrects recent darts now and then: VoidDart, CorrectDart, AddDart. */
  userBot?: boolean;
  /** The store refuses appends at random (2–10 %, and now and then for a few seconds). */
  storeFaults?: boolean;
  /** The app crashes at random moments (mid-visit, mid-takeout, idle) and is launched again. */
  crashes?: boolean;
  /** Now and then the players chat for 8–40 s between visits. */
  idle?: boolean;
  /** Relaunch delay after a crash, ms of virtual time. Default 0–10 s. */
  resumeMs?: readonly [number, number];
  /** Crash only once, inside the first idle stretch (with time to relaunch before it ends). */
  idleCrashOnly?: boolean;
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
  /** Turns flagged because the board withdrew every dart of their visit. */
  withdrawnVisits: number;
  /**
   * Board visits that ended with no dart listed and whose end the app could not see (it saw
   * none of their darts, or the adapter never reported the end): an adapter gap, left out.
   */
  unseenVisits: number;
  finished: number;
  /** Commands the user bot had applied. */
  userCommands: number;
  /** Appends the store refused, and the times the runtime rebuilt the source after one. */
  refusedAppends: number;
  sourceRebuilds: number;
  crashes: number;
}

export interface Features {
  userBot: boolean;
  storeFaults: boolean;
  crashes: boolean;
  idle: boolean;
}

export interface E2ERun {
  seed: number;
  plan: FaultPlan;
  features: Features;
  world: World;
  incarnations: Incarnation[];
  referee: Referee;
  bot: UserBot | null;
  people: People;
  /** Board visit index → who threw it (`People.throwers`, as judged). */
  throwers: Map<number, PlayerId>;
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

function chooseFeatures(seed: number, o: E2EOptions): Features {
  const m = seededRandom(`mix:${seed}`);
  const draw = (share: number): boolean => o.mix === true && !o.clean && m() < share;
  const mixed = { userBot: draw(0.3), storeFaults: draw(0.2), crashes: draw(0.2), idle: draw(0.25) };
  return {
    userBot: o.userBot ?? mixed.userBot,
    storeFaults: o.storeFaults ?? mixed.storeFaults,
    crashes: o.crashes ?? (o.idleCrashOnly === true || mixed.crashes),
    idle: o.idle ?? (o.idleCrashOnly === true || mixed.idle),
  };
}

// ── the people ───────────────────────────────────────────────────────────────

/**
 * Who throws each visit: the players take turns in the game's order (the next seat still in the
 * game), whatever the app thinks. After a review pause, though, the person who confirmed it has
 * looked at the app and the group goes by it: the first visit to start after the confirm is
 * thrown by whoever the app has up, which is whoever the app gives it to, and the rotation goes
 * on from there. (An outage that hid a whole visit leaves the app a seat off; the review pause
 * is where the people learn of it.)
 *
 * A visit the app could see nothing of (the board withdrew every dart, or was reset, before any
 * reading reached the app) is no visit to it: its takeout looks like a hand in front of the
 * cameras, and the darts that follow continue the turn. `throwers` leaves such visits out of
 * the rotation, as the app must. Ground truth for `judge`.
 */
export class People {
  private readonly visits: { visit: number; startedAt: number; out: PlayerId[] }[] = [];
  readonly order: readonly PlayerId[];
  private readonly referee: Referee;

  constructor(order: readonly PlayerId[], referee: Referee) {
    this.order = order;
    this.referee = referee;
  }

  /** A player steps up and throws the first dart into board visit `visit`. `app`: what the screen shows, or showed last. */
  startVisit(visit: number, now: number, app: SessionState | null): void {
    this.visits.push({ visit, startedAt: now, out: this.order.filter((pl) => fallen(app, pl)) });
  }

  /**
   * Board visit index → the player who threw it, leaving out the visits in `unseen`.
   * `appGave(visit)`: the player of the turn the app put the visit's darts in, if any.
   */
  throwers(unseen: ReadonlySet<number>, appGave: (visit: number) => PlayerId | undefined): Map<number, PlayerId> {
    const out = new Map<number, PlayerId>();
    const confirms = this.referee.confirmTimes;
    let last: PlayerId | null = null;
    let lastStart = -Infinity;
    let resync = false;
    for (const v of this.visits) {
      if (confirms.some((t) => t > lastStart && t <= v.startedAt)) resync = true;
      lastStart = v.startedAt;
      if (unseen.has(v.visit)) continue;
      // The first seat throws first (every game's opening nextPlayer).
      const app = resync && last !== null ? appGave(v.visit) : undefined;
      const thrower: PlayerId = app ?? (last === null ? this.order[0]! : this.rotate(last, v.out));
      if (app !== undefined) resync = false;
      out.set(v.visit, thrower);
      last = thrower;
    }
    return out;
  }

  private rotate(after: PlayerId, out: readonly PlayerId[]): PlayerId {
    const i = this.order.indexOf(after);
    for (let k = 1; k <= this.order.length; k++) {
      const p = this.order[(i + k) % this.order.length]!;
      if (!out.includes(p)) return p;
    }
    return after;
  }
}

/** Siege: a player whose wall fell is out of the rotation (the app shows it). */
function fallen(app: SessionState | null, playerId: PlayerId): boolean {
  const lanes = (app?.view as { lanes?: { playerId: string; fallen: boolean }[] } | undefined)?.lanes;
  return lanes?.find((l) => l.playerId === playerId)?.fallen === true;
}

// ── the user bot ─────────────────────────────────────────────────────────────

export interface UserCommand {
  commandId: string;
  type: 'VoidDart' | 'CorrectDart' | 'AddDart';
  /** VoidDart, CorrectDart: the dart. AddDart: the dart the host minted for it. */
  throwId?: string;
  turnIndex: number;
  segment?: Segment;
  status: HostResult['status'] | 'failed';
}

/**
 * A player at W4 who, every few seconds, may change one of the recent darts (the current turn's
 * or the last ended turn's): voids it, corrects it to another segment, or adds a dart the board
 * missed. Not to fix anything: what a person says about a dart is the truth `judge` holds the
 * app to. Padded misses are left alone.
 */
export class UserBot {
  readonly commands: UserCommand[] = [];
  private runtime: ArcadeRuntime | null = null;
  private timer: TimerHandle | null = null;
  private readonly sched: VirtualScheduler;
  private readonly random: RandomSource;
  private readonly clock: () => string;
  private readonly ids: () => string;

  constructor(world: World, random: RandomSource) {
    this.sched = world.sched;
    this.random = random;
    this.clock = world.clock;
    this.ids = createUlidSource({ now: () => EPOCH + world.sched.now(), random: seededRandom(`bot-ids:${world.seed}`) });
  }

  watch(runtime: ArcadeRuntime): void {
    this.detach();
    this.runtime = runtime;
    this.arm();
  }

  detach(): void {
    this.runtime = null;
    if (this.timer !== null) this.sched.clearTimeout(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.detach();
  }

  private arm(): void {
    this.timer = this.sched.setTimeout(() => {
      this.timer = null;
      const runtime = this.runtime;
      if (!runtime) return;
      this.act(runtime);
      this.arm();
    }, 2000 + this.random() * 8000);
  }

  private act(runtime: ArcadeRuntime): void {
    const s = runtime.getSnapshot();
    if (!s || s.closed || this.random() < 0.4) return;
    const ended = [...s.turns].reverse().find((t) => t.ended);
    const recent = [s.currentTurn, ended].filter((t): t is NonNullable<typeof t> => t !== null && t !== undefined);
    const darts = recent.flatMap((t) => t.darts.filter((d) => !d.padded).map((dart) => ({ turn: t, dart })));
    const u = this.random();
    let cmd: { type: UserCommand['type']; payload: Record<string, unknown> };
    let record: Omit<UserCommand, 'commandId' | 'status'>;
    if (u < 0.75 && darts.length > 0) {
      const { turn, dart } = darts[Math.floor(this.random() * darts.length)]!;
      if (u < 0.35) {
        const reason = this.random() < 0.5 ? 'false-detection' : 'user';
        cmd = { type: 'VoidDart', payload: { throwId: dart.throwId, reason } };
        record = { type: 'VoidDart', throwId: dart.throwId, turnIndex: turn.turnIndex };
      } else {
        const segment = randomSegment(this.random);
        cmd = { type: 'CorrectDart', payload: { throwId: dart.throwId, segment } };
        record = { type: 'CorrectDart', throwId: dart.throwId, turnIndex: turn.turnIndex, segment };
      }
    } else {
      // A dart the board missed, in a turn the board saw.
      const turn = recent.find((t) => t.darts.some((d) => !d.padded && isBoardOrigin(d.origin)) || t.voidedDarts.length > 0);
      if (!turn) return;
      const segment = randomSegment(this.random);
      const dartIndex = Math.min(2, Math.floor(this.random() * (turn.darts.length + 1)));
      cmd = { type: 'AddDart', payload: { playerId: turn.playerId, turnIndex: turn.turnIndex, dartIndex, segment, reason: 'bounce-out' } };
      record = { type: 'AddDart', turnIndex: turn.turnIndex, segment };
    }
    const command = { schema: COMMAND_SCHEMA_VERSION, commandId: this.ids(), ...cmd, actor: 'operator', issuedAt: this.clock() } as ArcadeCommand;
    const entry: UserCommand = { ...record, commandId: command.commandId, status: 'failed' };
    this.commands.push(entry);
    runtime.dispatch(command).then(
      (r) => {
        entry.status = r.status;
        if (r.status === 'applied' && entry.type === 'AddDart') {
          entry.throwId = r.events.find((e): e is EventOf<'DartAdded'> => e.type === 'DartAdded' && e.source.kind === 'manual')?.payload.throwId;
        }
      },
      () => undefined, // the storage refused it: as if never pressed
    );
  }
}

// ── the run ──────────────────────────────────────────────────────────────────

export async function e2eRun(seed: number, options: E2EOptions = {}): Promise<E2ERun> {
  const r = seededRandom(`e2e:${seed}`);
  const features = chooseFeatures(seed, options);
  const plan: FaultPlan = options.clean ? {} : faultPlan(r);
  const world = makeWorld(`e2e:${seed}`, {
    faults: plan,
    board: { noiseFrames: r() < 0.3, missStyle: r() < 0.5 ? 'outside' : 'bare', emptyThrows: r() < 0.8 ? 'omit' : 'array' },
  });
  const launch = { stateOnlySocket: r() < 0.3, contacts: world.contacts };
  const { sched, board, transport } = world;
  const between = (lo: number, hi: number): number => lo + r() * (hi - lo);
  const rc = seededRandom(`crash:${seed}`);
  const ri = seededRandom(`idle:${seed}`);
  const referee = new Referee(sched, seededRandom(`referee:${seed}`));
  const bot = features.userBot ? new UserBot(world, seededRandom(`bot:${seed}`)) : null;
  const incarnations = [incarnate(world, 0, launch)];
  const app = () => incarnations.at(-1)!;
  const attach = (inc: Incarnation): void => {
    referee.watch(inc.runtime);
    bot?.watch(inc.runtime);
  };
  attach(app());
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
  const people = new People(app().runtime.getSnapshot()!.turnOrder, referee);
  if (features.storeFaults) world.store.failRate = [0.02, 0.05, 0.1][Math.floor(seededRandom(`rate:${seed}`)() * 3)]!;

  // ── crashes: the app dies, and is launched again after a while ──
  let down = false;
  let crashes = 0;
  /** What the app showed last: the screen while it is up, the last picture while it is down. */
  let lastSeen: SessionState | null = app().runtime.getSnapshot();
  const screen = (): SessionState | null => (down ? lastSeen : (lastSeen = app().runtime.getSnapshot()));
  const crash = (resumeAfterMs: number): void => {
    if (down) return;
    screen();
    down = true;
    crashes++;
    app().kill();
    referee.detach();
    bot?.detach();
    sched.setTimeout(() => {
      const next = incarnate(world, incarnations.length, launch);
      incarnations.push(next);
      let done = false;
      // Keep virtual time ticking while the relaunch works through the storage.
      const pump = (): void => {
        if (!done) sched.setTimeout(pump, 1);
      };
      pump();
      void next.runtime.resumeSession(sessionId).then(() => {
        done = true;
        attach(next);
        next.runtime.start();
        down = false;
      });
    }, resumeAfterMs);
  };
  const [resumeLo, resumeHi] = options.resumeMs ?? [0, 10_000];
  const resumeDelay = (): number => resumeLo + rc() * (resumeHi - resumeLo);
  const crashTimers: TimerHandle[] = [];

  let steps = 0;
  /** A quiet moment (50 ms after a board action): where the app may crash (crashAtStep). */
  const quiet = async (): Promise<void> => {
    await sched.advance(50);
    if (steps++ !== options.crashAtStep) return;
    const old = app();
    await old.runtime.whenIdle();
    old.kill();
    const next = incarnate(world, incarnations.length, launch);
    incarnations.push(next);
    crashes++;
    await next.runtime.resumeSession(sessionId);
    attach(next);
    next.runtime.start();
  };

  const outageTimers: TimerHandle[] = [];
  const visits = 4 + Math.floor(r() * 10);
  if (features.crashes && !options.idleCrashOnly) {
    // Anywhere in the game: mid-visit, mid-takeout, between visits.
    const n = 1 + Math.floor(rc() * 2);
    for (let i = 0; i < n; i++) {
      const delay = resumeDelay();
      crashTimers.push(sched.setTimeout(() => crash(delay), 2000 + rc() * visits * 7000));
    }
  }
  let idleCrashes = options.idleCrashOnly ? 1 : Infinity;
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
    if (features.storeFaults && rc() < 0.1) {
      // The storage is gone for a few seconds.
      const rate = world.store.failRate;
      const at = rc() * 4000;
      const dur = 1000 + rc() * 4000;
      outageTimers.push(sched.setTimeout(() => (world.store.failRate = 1), at));
      outageTimers.push(sched.setTimeout(() => (world.store.failRate = rate), at + dur));
    }

    const darts = r() < 0.15 ? 1 + Math.floor(r() * 2) : 3;
    let firstThrowAt = -1;
    let detected = 0;
    for (let d = 0; d < darts; d++) {
      await sched.advance(between(250, 2500));
      if (firstThrowAt < 0) {
        firstThrowAt = sched.now();
        people.startVisit(board.currentVisit.index, firstThrowAt, screen());
      }
      const u = r();
      // A visit the board saw nothing of is no visit to it (its takeout looks like a hand in
      // front of the cameras), and nothing can tell whose it was: every visit gets a dart the
      // board lists.
      const mustList = d === darts - 1 && detected === 0;
      if (u < 0.05 && !mustList) board.bounceOut();
      else if (u >= 0.05 && u < 0.09 && board.phantom()) detected++;
      else if (board.throwDart().outcome === 'detected') detected++;
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
    if (features.idle && ri() < 0.25) {
      // The players chat. The app may die meanwhile; the board sits there, empty.
      const idleMs = 8000 + ri() * 32_000;
      // The crash draws come from their own stream, so a run with them idles as one without.
      if (features.crashes && idleCrashes > 0 && (options.idleCrashOnly === true || rc() < 0.5)) {
        idleCrashes--;
        const delay = resumeDelay();
        crashTimers.push(sched.setTimeout(() => crash(delay), 1000 + rc() * Math.max(0, idleMs - delay - 4000)));
      }
      await sched.advance(idleMs);
    }
  }

  for (const t of outageTimers) sched.clearTimeout(t);
  for (const t of crashTimers) sched.clearTimeout(t);
  transport.faults = {};
  transport.setReachable(true);
  world.store.failRate = 0;
  bot?.stop();
  for (let i = 0; i < 40 && down; i++) await sched.advance(500);
  await sched.advance(20_000);
  for (let i = 0; i < 20 && (referee.busy || app().runtime.getSnapshot()?.phase === 'awaiting-review'); i++) {
    await sched.advance(5000);
  }
  await app().runtime.whenIdle();
  referee.stop();
  app().runtime.stop();

  const log = await world.store.load(sessionId);
  const state = app().runtime.getSnapshot()!;
  const { violations, stats, throwers } = judge(world, log, state, app().runtime.host.getLog(), { options, people, bot });
  for (const inc of incarnations) for (const e of inc.errors) violations.push(`runtime error: ${e}`);
  if (down) violations.push('the app never came back after a crash');
  stats.refusedAppends = world.store.refused;
  stats.sourceRebuilds = incarnations.reduce((n, inc) => n + inc.problems.filter((p) => p.recovery === 'resync').length, 0);
  stats.crashes = crashes;
  return { seed, plan, features, world, incarnations, referee, bot, people, throwers, sessionId, log, state, steps, violations, stats };
}

// ── the oracle ───────────────────────────────────────────────────────────────

const coordKey = (c: Coords): string => `${c.x}|${c.y}`;
const sameSeg = (a: Segment, b: Segment): boolean => a.label === b.label && a.bed === b.bed;
function isBoardOrigin(origin: string): boolean {
  return origin === 'detected' || origin === 'recovered';
}

export interface JudgeContext {
  options?: E2EOptions;
  /** Who threw each board visit. Without it, identity is not checked. */
  people?: People;
  /** What a person changed: the truth for those darts. */
  bot?: UserBot | null;
}

/**
 * Ground truth is the board model's record of what the board reported (its detections and
 * visits), who threw each visit (`People`), and what a person said about a dart (`UserBot`):
 * a phantom or a missed bounce-out is a board error only a person can catch, not a pipeline
 * error. A turn is right when
 * - its board darts, in order and with their final segments, are exactly the darts the board
 *   listed when one visit ended, less those a person voided, with the segments a person gave;
 * - its voided darts are of that visit too (a turn must not run on into the next visit);
 * - the darts a person added to it are there, and no others;
 * - it is the turn of the player who threw that visit;
 * - and it ended with that visit.
 * Every turn must be right or flagged needsReview; every board visit with darts must end up in
 * turns or be covered by a flagged turn; nothing invented or counted twice; every inferred
 * takeout pauses for review; the session cannot complete with anything unreviewed.
 */
export function judge(
  world: World,
  log: readonly ArcadeEvent[],
  state: SessionState,
  hostLog: readonly ArcadeEvent[],
  ctx: JudgeContext = {},
): { violations: string[]; stats: E2EStats; throwers: Map<number, PlayerId> } {
  const options = ctx.options ?? {};
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

  // Board darts → detections, by coordinates (unique per reading in the board model), and which
  // detection a throw id stood for when a person acted on it.
  const detByCoords = new Map<string, number>();
  for (const d of board.detections) for (const h of d.history) detByCoords.set(coordKey(h.coords), d.id);
  const detById = new Map(board.detections.map((d) => [d.id, d]));
  const detOfThrow = new Map<string, number | undefined>();
  const userCommands = new Map((ctx.bot?.commands ?? []).filter((c) => c.status === 'applied').map((c) => [c.commandId, c]));
  const detAtCommand = new Map<string, number | undefined>();
  let recoveredDarts = 0;
  for (const e of log) {
    if (e.causationId !== undefined && userCommands.has(e.causationId) && !detAtCommand.has(e.causationId)) {
      const c = userCommands.get(e.causationId)!;
      detAtCommand.set(e.causationId, c.type === 'AddDart' || c.throwId === undefined ? undefined : detOfThrow.get(c.throwId));
    }
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

  // What a person said, in the order the host applied it.
  const userVoided = new Set<number>();
  const userSegment = new Map<number, Segment>();
  const addedVoided = new Set<string>();
  const addedSegment = new Map<string, Segment>();
  const addedTo = new Map<number, string[]>();
  for (const c of userCommands.values()) {
    const det = detAtCommand.get(c.commandId);
    if (c.type === 'AddDart') {
      if (c.throwId === undefined) continue;
      addedTo.set(c.turnIndex, [...(addedTo.get(c.turnIndex) ?? []), c.throwId]);
      addedSegment.set(c.throwId, c.segment!);
    } else if (c.type === 'VoidDart') {
      if (det !== undefined) userVoided.add(det);
      else if (c.throwId !== undefined) addedVoided.add(c.throwId);
    } else if (det !== undefined) userSegment.set(det, c.segment!);
    else if (c.throwId !== undefined) addedSegment.set(c.throwId, c.segment!);
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
      if (d.padded || !isBoardOrigin(d.origin)) continue;
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

  // A visit that ended with no dart listed (the board withdrew them all, or was reset), and
  // whose end the app could not see: it saw none of its darts (a short outage hid them and the
  // reset), or the adapter never reported the visit's end (a reset after every dart was
  // withdrawn, a takeout during an outage then), so the next visit's darts came under the same
  // visit key. To the app the visit never ended: its turn runs on into the next visit. That is
  // the adapter's to catch (visit tracker, §6.4); here such a visit is left out of the
  // rotation, as the app must leave it out, and counted.
  const keysOf = new Map<number, Set<string>>();
  for (const e of log) {
    if (e.type !== 'DartDetected' || !e.payload.coords) continue;
    const det = detByCoords.get(coordKey(e.payload.coords));
    if (det === undefined) continue;
    const visit = detById.get(det)!.visit;
    keysOf.set(visit, (keysOf.get(visit) ?? new Set()).add(e.payload.visitKey));
  }
  const endedKeys = new Set<string>();
  for (const e of log) if (e.type === 'TakeoutFinished' || e.type === 'VisitReset') endedKeys.add(e.payload.visitKey);
  const unseen = new Set<number>();
  for (const bv of board.visits) {
    if (bv.everDetections.length === 0 || bv.endedBy === undefined || (bv.endedBy === 'takeout' && bv.finalDetections.length > 0)) continue;
    const keys = [...(keysOf.get(bv.index) ?? [])];
    const merged = board.visits.some((later) => later.index > bv.index && [...(keysOf.get(later.index) ?? [])].some((k) => keys.includes(k)));
    if (keys.length === 0 || merged || !keys.some((k) => endedKeys.has(k))) unseen.add(bv.index);
  }
  // The player of the turn the app put each board visit's darts in (live or voided).
  const gaveTo = new Map<number, PlayerId>();
  for (const t of state.turns) {
    for (const d of [...t.darts, ...t.voidedDarts]) {
      if (!isBoardOrigin(d.origin)) continue;
      const det = detOfThrow.get(d.throwId);
      if (det !== undefined && !gaveTo.has(detById.get(det)!.visit)) gaveTo.set(detById.get(det)!.visit, t.playerId);
    }
  }
  const throwerOf = ctx.people?.throwers(unseen, (visit) => gaveTo.get(visit));

  // The darts of a board visit as the board listed them at its end, less what a person voided.
  const listed = board.listedDetectionIds();
  const finalOf = (visit: number): number[] => {
    const bv = board.visits[visit]!;
    const end = bv.endedBy === 'takeout' ? bv.finalDetections : bv.endedBy === 'reset' ? [] : listed;
    return end.filter((id) => !userVoided.has(id));
  };
  const truthSeg = (id: number): Segment => userSegment.get(id) ?? detById.get(id)!.segment;

  // Each unflagged turn is exactly one board visit, of the player who threw it.
  for (const t of state.turns) {
    if (t.needsReview) continue;
    const label = `turn ${t.turnIndex} (${t.ended ? t.endReason : 'open'})`;
    const live = t.darts.filter((d) => !d.padded);
    const darts = live.filter((d) => isBoardOrigin(d.origin));
    const added = live.filter((d) => !isBoardOrigin(d.origin));
    const expectAdded = (addedTo.get(t.turnIndex) ?? []).filter((id) => !addedVoided.has(id));
    for (const d of added) {
      const said = addedSegment.get(d.throwId);
      if (!expectAdded.includes(d.throwId) || said === undefined) v.push(`${label}: holds a dart nobody threw on the board or added (${d.segment.label} ${d.origin})`);
      else if (!sameSeg(d.segment, said)) v.push(`${label}: an added dart is ${d.segment.label}, the person said ${said.label}`);
    }
    for (const id of expectAdded) if (!added.some((d) => d.throwId === id)) v.push(`${label}: lost a dart a person added`);
    const dets = darts.map((d) => detOfThrow.get(d.throwId));
    if (dets.some((d) => d === undefined)) continue; // reported as invented above
    const voided = t.voidedDarts.filter((d) => isBoardOrigin(d.origin)).map((d) => detOfThrow.get(d.throwId));
    const visits = new Set([...dets, ...voided].filter((d) => d !== undefined).map((d) => detById.get(d)!.visit));
    for (const bv of unseen) if (visits.size > 1) visits.delete(bv);
    if (visits.size === 1 && unseen.has([...visits][0]!)) continue; // the darts of a visit whose end the app could not see
    if (visits.size === 0) {
      if (t.ended) v.push(`${label}: ended with no board darts, unflagged`);
      continue;
    }
    const describe = () =>
      `scored [${darts.map((d) => d.segment.label).join(' ')}] vs board [${[...visits].map((bv) => finalOf(bv).map((id) => truthSeg(id).label).join(' ')).join(' | ')}]`;
    if (visits.size !== 1) {
      v.push(`silent mismatch, ${label}: darts of ${visits.size} board visits, ${describe()}`);
      continue;
    }
    const bv = board.visits[[...visits][0]!]!;
    const thrower = throwerOf?.get(bv.index);
    if (throwerOf && thrower !== t.playerId) {
      v.push(`silent misattribution, ${label}: board visit ${bv.index} was thrown by player ${thrower?.slice(-1) ?? '(nobody)'}, scored to player ${t.playerId.slice(-1)}`);
      continue;
    }
    const truth = finalOf(bv.index);
    const exact = truth.length === dets.length && truth.every((id, i) => id === dets[i] && sameSeg(truthSeg(id), darts[i]!.segment));
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
      v.push(`silent mismatch, board visit ${bv.index} (${bv.endedBy ?? 'open'}): [${missing.map((id) => truthSeg(id).label).join(' ')}] never scored`);
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

  // A session cannot complete while anything is unreviewed, the live winning turn included.
  if (state.canComplete) {
    const live = state.currentTurn;
    if (state.needsReview.length > 0) v.push(`could complete with turns ${state.needsReview.join(', ')} unreviewed`);
    if (live && (live.darts.some((d) => d.origin === 'recovered' || d.pendingReview) || live.darts.length > 3)) {
      v.push(`could complete while the live turn ${live.turnIndex} holds uncertain darts`);
    }
  }

  const reviewPauses = log.filter((e) => e.type === 'GamePaused' && e.payload.reason === 'review').length;
  const flaggedTurns = state.turns.filter((t) => t.needsReview).length;
  // The board may withdraw every dart of a visit on a clean network too: that turn is flagged.
  const withdrawnVisits = state.turns.filter(
    (t) => t.needsReview && t.darts.every((d) => d.padded) && t.voidedDarts.some((d) => d.reason === 'source-withdrawn'),
  ).length;
  if (options.clean) {
    if (flaggedTurns > withdrawnVisits) v.push(`clean network: ${flaggedTurns - withdrawnVisits} turn(s) flagged`);
    if (reviewPauses + inferredTakeouts + recoveredDarts > 0) {
      v.push(`clean network: ${reviewPauses} review pause(s), ${inferredTakeouts} inferred takeout(s), ${recoveredDarts} recovered dart(s)`);
    }
  }
  return {
    violations: v,
    throwers: throwerOf ?? new Map(),
    stats: {
      boardVisits: board.visits.length,
      detections: board.detections.length,
      turns: state.turns.length,
      flaggedTurns,
      inferredTakeouts,
      reviewPauses,
      recoveredDarts,
      coveredLostVisits,
      withdrawnVisits,
      unseenVisits: unseen.size,
      finished: state.finished ? 1 : 0,
      userCommands: userCommands.size,
      refusedAppends: 0,
      sourceRebuilds: 0,
      crashes: 0,
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
