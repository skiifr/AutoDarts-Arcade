/**
 * Test support: the whole board-to-game pipeline on virtual time. A `World` is the physical
 * side that survives an app crash (the board, the network, the device's storage and the person
 * refereeing); an `Incarnation` is one run of the app on it (adapter, runtime, host).
 */
import {
  AutodartsLocalAdapter,
  BoardModel,
  FakeBoardTransport,
  SIM_EPOCH_MS,
  VirtualScheduler,
  createUlidSource,
  epochMsFromIso,
  isoFromEpochMs,
  seededRandom,
  type AutodartsLocalOptions,
  type BoardModelOptions,
  type FaultPlan,
  type RandomSource,
  type TimerHandle,
} from '@arcade/adapters';
import { MemoryLogStore, gameRegistry, ulidFromNumber, type GameRegistry, type HostResult, type LogStore } from '@arcade/engine';
import type { ArcadeEvent, BoardFactDraft, PlayerRef } from '@arcade/event-schema';
import { GAMES } from '@arcade/games';
import { createArcadeRuntime, type ArcadeRuntime, type RuntimeProblem } from '../arcade-runtime';
import { MemoryContactStore, type ContactStore } from '../contact-store';

export const EPOCH = SIM_EPOCH_MS;
export const REGISTRY: GameRegistry = gameRegistry(GAMES);

/**
 * The shortest visit a simulation plays, first throw to last dart out: 3 s, the shortest a real
 * one can be, as in the adapter's chaos suite. The adapter's MIN_UNSEEN_VISIT_MS must not exceed
 * it; the simulated network's frame delays are covered by LINK_LOSS_MS.
 */
export const SIM_MIN_VISIT_MS = 3000;

/**
 * A `LogStore` over another that refuses chosen appends, as a full disk or a busy database
 * would. A refused append stores nothing (the `LogStore` contract).
 */
export class FlakyLogStore implements LogStore {
  /** Refuse the next n appends. */
  failNext = 0;
  /** Refuse every append this returns true for. */
  failIf: ((events: readonly ArcadeEvent[]) => boolean) | null = null;
  /** Refuse each append with this probability. */
  failRate = 0;
  /** Appends refused so far. */
  refused = 0;
  readonly inner: LogStore;
  private readonly random: RandomSource;

  constructor(inner: LogStore, random: RandomSource) {
    this.inner = inner;
    this.random = random;
  }

  async append(sessionId: string, events: readonly ArcadeEvent[]): Promise<void> {
    const fail = this.failNext > 0 || (this.failIf?.(events) ?? false) || (this.failRate > 0 && this.random() < this.failRate);
    if (fail) {
      if (this.failNext > 0) this.failNext--;
      this.refused++;
      throw new Error('SQLITE_FULL: database or disk is full');
    }
    await this.inner.append(sessionId, events);
  }

  load(sessionId: string): Promise<ArcadeEvent[]> {
    return this.inner.load(sessionId);
  }

  listSessions(): Promise<{ sessionId: string; lastSeq: number; closed: boolean }[]> {
    return this.inner.listSessions();
  }
}

export interface World {
  seed: string;
  sched: VirtualScheduler;
  board: BoardModel;
  transport: FakeBoardTransport;
  /** The device's log storage: survives a crash, and can be made to refuse appends. */
  store: FlakyLogStore;
  /** The device's key-value storage for the last board contact (survives a crash too). */
  contacts: MemoryContactStore;
  clock: () => string;
  /** Simulated ms of an ISO time from `clock`. */
  simMs(iso: string): number;
  /**
   * The oracle's record, not the app's: which board detection each adapter dart (throwId) was
   * when an adapter first held it, read from the board's `_simDet` tags (`annotate`). A dart with
   * coordinates is found by them; this places the darts reported without (`noCoordsRate`).
   */
  tags: Map<string, number>;
}

export function makeWorld(seed: string, options: { faults?: FaultPlan; board?: Partial<Omit<BoardModelOptions, 'random' | 'now'>> } = {}): World {
  const sched = new VirtualScheduler();
  const board = new BoardModel({ random: seededRandom(`board:${seed}`), now: () => sched.now(), ...options.board });
  const transport = new FakeBoardTransport({ board, scheduler: sched, random: seededRandom(`net:${seed}`), faults: options.faults });
  return {
    seed,
    sched,
    board,
    transport,
    store: new FlakyLogStore(new MemoryLogStore(), seededRandom(`store:${seed}`)),
    contacts: new MemoryContactStore(),
    clock: () => isoFromEpochMs(EPOCH + sched.now()),
    simMs: (iso) => (epochMsFromIso(iso) ?? NaN) - EPOCH,
    tags: new Map(),
  };
}

const isNumber = (v: unknown): v is number => typeof v === 'number';

/**
 * Fills `world.tags` (an adapter's `observer`): after each snapshot, the adapter's known darts
 * with coordinates are the detections that had them, and those without are the remaining listed
 * detections, in board order, when their counts agree (as the adapter chaos suite's oracle).
 */
function tagger(world: World, adapter: () => AutodartsLocalAdapter): NonNullable<AutodartsLocalOptions['observer']> {
  let listed: number[] = [];
  return {
    beforeApply: (snap) => {
      const raw = snap.raw as { throws?: unknown };
      listed = Array.isArray(raw.throws) ? raw.throws.slice(0, 3).map((t) => (t as { _simDet?: unknown } | null)?._simDet).filter(isNumber) : [];
    },
    afterApply: () => {
      if (listed.length === 0) return;
      const byCoords = new Map<string, number>();
      for (const id of listed) for (const h of world.board.detections[id - 1]?.history ?? []) byCoords.set(`${h.coords.x}|${h.coords.y}`, id);
      const claimed = new Set<number>();
      const unplaced: string[] = [];
      for (const k of adapter().visitState().known) {
        const det = k.coords ? byCoords.get(`${k.coords.x}|${k.coords.y}`) : undefined;
        if (det === undefined) unplaced.push(k.throwId);
        else claimed.add(det);
      }
      const rest = listed.filter((id) => !claimed.has(id));
      if (unplaced.length !== rest.length) return;
      unplaced.forEach((throwId, i) => {
        if (!world.tags.has(throwId)) world.tags.set(throwId, rest[i]!);
      });
    },
  };
}

export interface Incarnation {
  adapter: AutodartsLocalAdapter;
  runtime: ArcadeRuntime;
  /** Every fact the adapter emitted, in order. */
  facts: BoardFactDraft[];
  /** Problems the runtime reported that it could not recover from: refused facts, lost facts. */
  errors: string[];
  /** Every problem the runtime reported, recovered or not. */
  problems: RuntimeProblem[];
  /** The app dies: what it had in flight never reaches the storage, and it does nothing more. */
  kill(): void;
}

function describeProblem(p: RuntimeProblem): string {
  return `${p.fact?.type ?? p.command?.type}: ${p.result?.status === 'rejected' ? p.result.message : String(p.error)}`;
}

/** One launch of the app on the world. `n` keeps each launch's ids apart. */
export function incarnate(world: World, n: number, options: { stateOnlySocket?: boolean; contacts?: ContactStore } = {}): Incarnation {
  const ids = createUlidSource({ now: () => EPOCH + world.sched.now(), random: seededRandom(`ids:${world.seed}:${n}`) });
  const adapter: AutodartsLocalAdapter = new AutodartsLocalAdapter({
    transport: world.transport,
    scheduler: world.sched,
    clock: world.clock,
    ids,
    random: seededRandom(`jitter:${world.seed}:${n}`),
    observer: tagger(world, () => adapter),
    ...(options.stateOnlySocket !== undefined ? { stateOnlySocket: options.stateOnlySocket } : {}),
  });
  const facts: BoardFactDraft[] = [];
  const errors: string[] = [];
  const problems: RuntimeProblem[] = [];
  adapter.subscribe((f) => facts.push(f));
  // This launch's view of the device storage: once it dies, its writes never land.
  let alive = true;
  const store: LogStore = {
    append: (sessionId, events) => (alive ? world.store.append(sessionId, events) : new Promise<void>(() => {})),
    load: (sessionId) => world.store.load(sessionId),
    listSessions: () => world.store.listSessions(),
  };
  const contacts = options.contacts;
  const contactStore: ContactStore | undefined = contacts && {
    get: (sessionId) => contacts.get(sessionId),
    set: (sessionId, at) => (alive ? contacts.set(sessionId, at) : Promise.resolve()),
  };
  const runtime = createArcadeRuntime({
    source: adapter,
    store,
    games: REGISTRY,
    clock: world.clock,
    ids,
    scheduler: world.sched,
    ...(contactStore ? { contactStore } : {}),
    onError: (p) => {
      problems.push(p);
      if (p.recovery === undefined || p.recovery === 'none') errors.push(describeProblem(p));
    },
  });
  const kill = (): void => {
    alive = false;
    runtime.stop();
  };
  return { adapter, runtime, facts, errors, problems, kill };
}

export function makePlayers(n: number): PlayerRef[] {
  return Array.from({ length: n }, (_, i) => ({
    playerId: ulidFromNumber(i + 1, '1P'),
    displayName: `Player ${i + 1}`,
    colorIndex: i,
    kind: 'guest' as const,
  }));
}

/**
 * The person at the board: whenever the game pauses for review, they look at the turn for a
 * moment and confirm it as it is (no corrections, so the comparison sees the raw outcome). They
 * survive an app crash: `detach` when it dies, `watch` the new runtime after the resume. A
 * confirm the app could not store is pressed again a moment later.
 */
export class Referee {
  confirms = 0;
  readonly results: HostResult[] = [];
  /** Virtual times of the confirms pressed: the people at the board looked at the app then. */
  readonly confirmTimes: number[] = [];
  private runtime: ArcadeRuntime | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending: number | null = null;
  private timer: TimerHandle | null = null;
  private readonly sched: VirtualScheduler;
  private readonly random: RandomSource;

  constructor(sched: VirtualScheduler, random: RandomSource) {
    this.sched = sched;
    this.random = random;
  }

  watch(runtime: ArcadeRuntime): void {
    this.detach();
    this.runtime = runtime;
    this.unsubscribe = runtime.subscribe(() => this.check());
    this.check();
  }

  /** The app died: forget what was about to be pressed. */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.runtime = null;
    this.pending = null;
    if (this.timer !== null) this.sched.clearTimeout(this.timer);
    this.timer = null;
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  private check(): void {
    const s = this.runtime?.getSnapshot();
    if (!s || s.phase !== 'awaiting-review' || s.awaitingReviewTurn === null) return;
    const turn = s.awaitingReviewTurn;
    if (this.pending === turn) return;
    this.pending = turn;
    this.press(turn, 500 + this.random() * 3500);
  }

  private press(turn: number, afterMs: number): void {
    const runtime = this.runtime!;
    this.timer = this.sched.setTimeout(() => {
      this.timer = null;
      this.confirmTimes.push(this.sched.now());
      runtime.command('ConfirmTurn', { turnIndex: turn }).then(
        (r) => {
          if (runtime !== this.runtime) return;
          this.results.push(r);
          this.confirms++;
          this.pending = null;
          this.check();
        },
        () => {
          // The storage refused it: press again.
          if (runtime === this.runtime) this.press(turn, 1000);
        },
      );
    }, afterMs);
  }

  stop(): void {
    this.detach();
  }
}
