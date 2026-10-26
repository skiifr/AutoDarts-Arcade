import type { BoardFactDraft } from '@arcade/event-schema';
import { AutodartsLocalAdapter, type AdapterTiming, type AutodartsLocalOptions } from '../autodarts-local/adapter';
import type { RestoredVisitState } from '../autodarts-local/rebuild';
import type { Transport } from '../ports';
import { createUlidSource, seededRandom } from '../random';
import { BoardModel, type BoardModelOptions } from '../simulator/board-model';
import { FakeBoardTransport, type FaultPlan } from '../simulator/fake-transport';
import { SIM_EPOCH_MS, isoFromEpochMs } from '../simulator/iso-time';
import { VirtualScheduler } from '../simulator/virtual-scheduler';
import { BoardFactDraftSchemaCheck } from './schema-check';

/** Test support: a board model, a fake transport and an adapter on virtual time. */
export interface Rig {
  sched: VirtualScheduler;
  board: BoardModel;
  transport: FakeBoardTransport;
  adapter: AutodartsLocalAdapter;
  facts: BoardFactDraft[];
  /** Facts with the time (virtual ms) they were emitted. */
  timed: { at: number; fact: BoardFactDraft }[];
  random: () => number;
}

export const EPOCH = SIM_EPOCH_MS;

export interface RigOptions {
  seed?: string | number;
  faults?: FaultPlan;
  board?: Partial<Omit<BoardModelOptions, 'random' | 'now'>>;
  restored?: RestoredVisitState;
  timing?: Partial<AdapterTiming>;
  latencyMs?: number;
  stateOnlySocket?: boolean;
  /** Validate every emitted draft against the event schema (default true). */
  validate?: boolean;
  observer?: AutodartsLocalOptions['observer'];
  onListenerError?: AutodartsLocalOptions['onListenerError'];
  /** Extra ms on the adapter's wall clock (not its scheduler): a device that slept, a clock that jumped. */
  wallSkewMs?: () => number;
  /** Put a test transport between the adapter and the fake one (`rig.transport` stays the fake one). */
  wrapTransport?: (inner: FakeBoardTransport) => Transport;
}

export function makeRig(options: RigOptions = {}): Rig {
  const seed = options.seed ?? 1;
  const sched = new VirtualScheduler();
  const random = seededRandom(`rig:${String(seed)}`);
  const boardRandom = seededRandom(`board:${String(seed)}`);
  const netRandom = seededRandom(`net:${String(seed)}`);
  const board = new BoardModel({ random: boardRandom, now: () => sched.now(), ...options.board });
  const transport = new FakeBoardTransport({ board, scheduler: sched, random: netRandom, faults: options.faults, latencyMs: options.latencyMs });
  const ids = createUlidSource({ now: () => EPOCH + sched.now(), random: seededRandom(`ids:${String(seed)}`) });
  const clock = (): string => isoFromEpochMs(EPOCH + sched.now() + (options.wallSkewMs?.() ?? 0));
  const adapter = new AutodartsLocalAdapter({
    transport: options.wrapTransport ? options.wrapTransport(transport) : transport,
    scheduler: sched,
    clock,
    ids,
    random,
    restored: options.restored,
    timing: options.timing,
    stateOnlySocket: options.stateOnlySocket,
    observer: options.observer,
    onListenerError: options.onListenerError,
  });
  const facts: BoardFactDraft[] = [];
  const timed: { at: number; fact: BoardFactDraft }[] = [];
  const check = options.validate === false ? null : new BoardFactDraftSchemaCheck();
  adapter.subscribe((f) => {
    check?.assert(f);
    facts.push(f);
    timed.push({ at: sched.now(), fact: f });
  });
  return { sched, board, transport, adapter, facts, timed, random };
}

export function ofType<T extends BoardFactDraft['type']>(facts: readonly BoardFactDraft[], type: T): Extract<BoardFactDraft, { type: T }>[] {
  return facts.filter((f): f is Extract<BoardFactDraft, { type: T }> => f.type === type);
}

/** Compact, human-readable view of facts for table tests. */
export function brief(facts: readonly BoardFactDraft[]): string[] {
  return facts
    .filter((f) => f.type !== 'SourceConnectionChanged' && f.type !== 'BoardStatusChanged')
    .map((f) => {
      switch (f.type) {
        case 'DartDetected':
          return `detect ${f.payload.indexInVisit}:${f.payload.segment.label}${f.payload.recovered ? ' recovered' : ''}`;
        case 'DartUpdated':
          return `update ${f.payload.previous.label}->${f.payload.segment.label}`;
        case 'DartWithdrawn':
          return 'withdraw';
        case 'TakeoutStarted':
          return 'takeout-start';
        case 'TakeoutFinished':
          return f.payload.inferred ? 'takeout-end inferred' : 'takeout-end';
        case 'VisitReset':
          return 'reset';
        case 'SourceAnomaly':
          return `anomaly ${f.payload.note}`;
        default:
          return (f as { type: string }).type;
      }
    });
}
