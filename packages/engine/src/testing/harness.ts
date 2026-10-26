/** Test harness for the engine: deterministic ids and clock, a scripted board, command builders. */
import {
  COMMAND_SCHEMA_VERSION,
  DEFAULT_HOUSE_RULES,
  type ArcadeCommand,
  type ArcadeEvent,
  type BoardFactDraft,
  type EventSource,
  type HouseRules,
  type PlayerRef,
  type Segment,
} from '@arcade/event-schema';
import { SessionHost, type HostResult } from '../host';
import { ulidFromNumber } from '../ids';
import { MemoryLogStore } from '../memory-log-store';
import type { LogStore } from '../ports';
import { gameRegistry, type GameRegistry } from '../registry';
import type { FoldOptions } from '../folder';
import { TEST_GAMES } from './games';

export const registry: GameRegistry = gameRegistry(TEST_GAMES);

/** Sequential valid ULIDs. Separate prefixes keep ids from different sources apart. */
export function counterIds(prefix = '0'): () => string {
  let n = 0;
  return () => ulidFromNumber(++n, prefix);
}

/** ISO timestamps one millisecond apart, without reading the clock. */
export function counterClock(): () => string {
  let n = 0;
  return () => {
    const ms = n++;
    const pad = (v: number, w: number) => String(v).padStart(w, '0');
    const s = Math.floor(ms / 1000);
    return `2026-11-02T${pad(20 + Math.floor(s / 3600), 2)}:${pad(Math.floor(s / 60) % 60, 2)}:${pad(s % 60, 2)}.${pad(ms % 1000, 3)}Z`;
  };
}

export function makePlayers(n: number): PlayerRef[] {
  return Array.from({ length: n }, (_, i) => ({
    playerId: ulidFromNumber(i + 1, '1P'),
    displayName: `Player ${i + 1}`,
    colorIndex: i % 8,
    kind: 'guest' as const,
  }));
}

/** Builds the board facts an adapter would emit, with its own visit keys and throw ids. */
export class Board {
  readonly source: EventSource = { kind: 'simulator', adapterVersion: 'simulator@test' };
  private readonly ids = counterIds('2B');
  private readonly clock = counterClock();
  visitKey = this.ids();
  private index = 0;

  private fact<T extends BoardFactDraft['type']>(type: T, payload: Extract<BoardFactDraft, { type: T }>['payload']): BoardFactDraft {
    return { type, payload, source: this.source, occurredAt: this.clock() } as BoardFactDraft;
  }

  /** A dart; `throwId` lets a test reuse the same id in two scripted worlds. */
  dart(
    segment: Segment,
    opts: { recovered?: boolean; throwId?: string; pendingReview?: boolean } = {},
  ): BoardFactDraft & { throwId: string } {
    const throwId = opts.throwId ?? this.ids();
    const f = this.fact('DartDetected', {
      throwId,
      segment,
      visitKey: this.visitKey,
      indexInVisit: Math.min(this.index++, 2),
      ...(opts.recovered ? { recovered: true as const } : {}),
      ...(opts.pendingReview ? { pendingReview: true as const } : {}),
    });
    return Object.assign(f, { throwId });
  }

  update(throwId: string, previous: Segment, segment: Segment, opts: { pendingReview?: boolean } = {}): BoardFactDraft {
    return this.fact('DartUpdated', { throwId, previous, segment, ...(opts.pendingReview ? { pendingReview: true as const } : {}) });
  }

  withdraw(throwId: string): BoardFactDraft {
    return this.fact('DartWithdrawn', { throwId });
  }

  takeoutStarted(): BoardFactDraft {
    return this.fact('TakeoutStarted', { visitKey: this.visitKey });
  }

  takeout(opts: { inferred?: boolean } = {}): BoardFactDraft {
    const f = this.fact('TakeoutFinished', { visitKey: this.visitKey, ...(opts.inferred ? { inferred: true as const } : {}) });
    this.newVisit();
    return f;
  }

  reset(): BoardFactDraft {
    const f = this.fact('VisitReset', { visitKey: this.visitKey, reason: 'manual-reset' });
    this.newVisit();
    return f;
  }

  connection(state: 'connecting' | 'resyncing' | 'online' | 'offline'): BoardFactDraft {
    return this.fact('SourceConnectionChanged', { state });
  }

  status(status: 'ready' | 'throwing' | 'takeout' | 'stuck-takeout'): BoardFactDraft {
    return this.fact('BoardStatusChanged', { status });
  }

  private newVisit(): void {
    this.visitKey = this.ids();
    this.index = 0;
  }
}

/** Builds valid commands with fresh command ids. */
export class Commands {
  private readonly ids: () => string;
  private readonly clock = counterClock();

  /** Builders with different prefixes never mint the same commandId. */
  constructor(prefix = '3C') {
    this.ids = counterIds(prefix);
  }

  private make<T extends ArcadeCommand['type']>(type: T, payload: Extract<ArcadeCommand, { type: T }>['payload']): ArcadeCommand {
    return {
      schema: COMMAND_SCHEMA_VERSION,
      commandId: this.ids(),
      type,
      payload,
      actor: 'operator',
      issuedAt: this.clock(),
    } as ArcadeCommand;
  }

  start(gameId: string, players: PlayerRef[], options: Record<string, unknown> = {}, houseRules?: HouseRules) {
    return this.make('StartSession', { gameId, options, players, ...(houseRules ? { houseRules } : {}) });
  }
  correct(throwId: string, segment: Segment) {
    return this.make('CorrectDart', { throwId, segment });
  }
  void(throwId: string, reason: 'false-detection' | 'user' = 'user') {
    return this.make('VoidDart', { throwId, reason });
  }
  add(
    playerId: string,
    turnIndex: number,
    dartIndex: number,
    segment: Segment,
    reason: 'undetected' | 'bounce-out' | 'manual-mode' = 'undetected',
  ) {
    return this.make('AddDart', { playerId, turnIndex, dartIndex, segment, reason });
  }
  skip() {
    return this.make('SkipTurn', {});
  }
  pause(reason: 'menu' | 'correction' | 'app-background' = 'menu') {
    return this.make('Pause', { reason });
  }
  resume(reason?: 'menu' | 'correction' | 'app-background') {
    return this.make('Resume', reason ? { reason } : {});
  }
  confirm(turnIndex: number) {
    return this.make('ConfirmTurn', { turnIndex });
  }
  rematch() {
    return this.make('Rematch', {});
  }
  close(outcome: 'completed' | 'abandoned') {
    return this.make('CloseSession', { outcome });
  }
}

/** A store whose next appends can be made to fail, to test write-ahead behaviour. */
export class FlakyStore implements LogStore {
  readonly inner = new MemoryLogStore();
  failures = 0;
  /** Events durably stored so far, readable synchronously from a listener. */
  persisted = 0;

  async append(sessionId: string, events: readonly ArcadeEvent[]): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('disk full');
    }
    await this.inner.append(sessionId, events);
    this.persisted += events.length;
  }
  load(sessionId: string) {
    return this.inner.load(sessionId);
  }
  listSessions() {
    return this.inner.listSessions();
  }
}

export interface TestRig {
  host: SessionHost;
  store: FlakyStore;
  board: Board;
  cmd: Commands;
  ids: () => string;
  clock: () => string;
  deps: ConstructorParameters<typeof SessionHost>[0];
  /** Feeds facts and commands in order and returns the results. */
  run(...inputs: Input[]): Promise<HostResult[]>;
}

export type Input = BoardFactDraft | ArcadeCommand;

export function isCommand(input: Input): input is ArcadeCommand {
  return 'commandId' in input;
}

export function makeRig(opts: { houseRules?: HouseRules; fold?: FoldOptions; ids?: () => string } = {}): TestRig {
  const store = new FlakyStore();
  const ids = opts.ids ?? counterIds('0E');
  const clock = counterClock();
  const deps = {
    store,
    clock,
    ids,
    games: registry,
    defaultHouseRules: opts.houseRules ?? DEFAULT_HOUSE_RULES,
    fold: { freezeGameStates: true, ...opts.fold },
  };
  const host = new SessionHost(deps);
  return {
    host,
    store,
    board: new Board(),
    cmd: new Commands(),
    ids,
    clock,
    deps,
    async run(...inputs) {
      const out: HostResult[] = [];
      for (const input of inputs) out.push(await (isCommand(input) ? host.dispatch(input) : host.ingest(input)));
      return out;
    },
  };
}

/** The types of the events a result appended, for compact assertions. */
export function types(result: HostResult | undefined): string[] {
  return result?.status === 'applied' ? result.events.map((e) => e.type) : [];
}
