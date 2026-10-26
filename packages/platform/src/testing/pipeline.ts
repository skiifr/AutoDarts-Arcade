/**
 * Test support: the whole board-to-game pipeline on virtual time. A `World` is the physical
 * side that survives an app crash (the board, the network, the device's storage and the person
 * refereeing); an `Incarnation` is one run of the app on it (adapter, runtime, host).
 */
import {
  AutodartsLocalAdapter,
  BoardModel,
  FakeBoardTransport,
  MIN_UNSEEN_VISIT_MS,
  SIM_EPOCH_MS,
  VirtualScheduler,
  createUlidSource,
  epochMsFromIso,
  isoFromEpochMs,
  seededRandom,
  type BoardModelOptions,
  type FaultPlan,
  type RandomSource,
  type TimerHandle,
} from '@arcade/adapters';
import { MemoryLogStore, gameRegistry, ulidFromNumber, type GameRegistry, type HostResult } from '@arcade/engine';
import type { BoardFactDraft, PlayerRef } from '@arcade/event-schema';
import { GAMES } from '@arcade/games';
import { createArcadeRuntime, type ArcadeRuntime } from '../arcade-runtime';

export const EPOCH = SIM_EPOCH_MS;
export const REGISTRY: GameRegistry = gameRegistry(GAMES);

/**
 * The shortest visit a simulation plays, first throw to takeout finished: the physical minimum
 * (MIN_UNSEEN_VISIT_MS) plus 1 s for the simulated network's frame delays (up to ~0.65 s with
 * delay and reorder faults), which a LAN does not have.
 */
export const SIM_MIN_VISIT_MS = MIN_UNSEEN_VISIT_MS + 1000;

export interface World {
  seed: string;
  sched: VirtualScheduler;
  board: BoardModel;
  transport: FakeBoardTransport;
  store: MemoryLogStore;
  clock: () => string;
  /** Simulated ms of an ISO time from `clock`. */
  simMs(iso: string): number;
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
    store: new MemoryLogStore(),
    clock: () => isoFromEpochMs(EPOCH + sched.now()),
    simMs: (iso) => (epochMsFromIso(iso) ?? NaN) - EPOCH,
  };
}

export interface Incarnation {
  adapter: AutodartsLocalAdapter;
  runtime: ArcadeRuntime;
  /** Every fact the adapter emitted, in order. */
  facts: BoardFactDraft[];
  /** Problems the runtime reported (refused or unpersisted facts). */
  errors: string[];
}

/** One launch of the app on the world. `n` keeps each launch's ids apart. */
export function incarnate(world: World, n: number, options: { stateOnlySocket?: boolean } = {}): Incarnation {
  const ids = createUlidSource({ now: () => EPOCH + world.sched.now(), random: seededRandom(`ids:${world.seed}:${n}`) });
  const adapter = new AutodartsLocalAdapter({
    transport: world.transport,
    scheduler: world.sched,
    clock: world.clock,
    ids,
    random: seededRandom(`jitter:${world.seed}:${n}`),
    ...(options.stateOnlySocket !== undefined ? { stateOnlySocket: options.stateOnlySocket } : {}),
  });
  const facts: BoardFactDraft[] = [];
  const errors: string[] = [];
  adapter.subscribe((f) => facts.push(f));
  const runtime = createArcadeRuntime({
    source: adapter,
    store: world.store,
    games: REGISTRY,
    clock: world.clock,
    ids,
    onError: (p) => errors.push(`${p.fact?.type ?? p.command?.type}: ${p.result?.status === 'rejected' ? p.result.message : String(p.error)}`),
  });
  return { adapter, runtime, facts, errors };
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
 * survive an app crash: `watch` the new runtime after a resume.
 */
export class Referee {
  confirms = 0;
  readonly results: HostResult[] = [];
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
    this.unsubscribe?.();
    this.runtime = runtime;
    this.unsubscribe = runtime.subscribe(() => this.check());
    this.check();
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
    this.timer = this.sched.setTimeout(() => {
      this.timer = null;
      void this.runtime!.command('ConfirmTurn', { turnIndex: turn }).then((r) => {
        this.results.push(r);
        this.confirms++;
        this.pending = null;
        this.check();
      });
    }, 500 + this.random() * 3500);
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer !== null) this.sched.clearTimeout(this.timer);
  }
}
