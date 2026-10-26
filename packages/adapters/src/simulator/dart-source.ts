import type { BoardFactDraft, Coords, EventSource, Segment } from '@arcade/event-schema';
import type { BoardStatus } from '../autodarts-local/status';
import { Listeners, type BoardSource, type Clock, type FactListener, type IdSource, type RandomSource, type Scheduler, type TimerHandle } from '../ports';
import { coordsFor, parseLabel, randomSegment } from './geometry';

export const SIMULATOR_ADAPTER_VERSION = 'simulator@0.1.0';

/** One step of a scripted dart stream. Labels: T20, D16, S5, SI5, SO5, 25, BULL, MISS, M12. */
export type ScriptStep =
  | { dart: string | Segment; coords?: Coords }
  /** A dart first seen after a reconnect (`recovered: true`). */
  | { recovered: string | Segment; coords?: Coords }
  | { takeout: true }
  /** A takeout the source could not observe (`TakeoutFinished{inferred:true}`). */
  | { inferredTakeout: true }
  | { reset: true }
  | { update: number; to: string | Segment }
  | { withdraw: number }
  | { status: BoardStatus }
  | { connection: 'connecting' | 'resyncing' | 'online' | 'offline'; error?: string }
  /** Pause in ms (only meaningful for the timed `SimulatorSource`). */
  | { wait: number };

interface Dart {
  throwId: string;
  segment: Segment;
}

function seg(s: string | Segment): Segment {
  return typeof s === 'string' ? parseLabel(s) : s;
}

/** Turns steps into board facts; shared by `scriptToFacts` and `SimulatorSource`. */
class FactWriter {
  private readonly ids: IdSource;
  private readonly clock: Clock;
  private readonly source: EventSource;
  private readonly random: RandomSource | undefined;
  private visitKey: string;
  private darts: (Dart | undefined)[] = [];
  private status: BoardStatus | undefined;

  constructor(ids: IdSource, clock: Clock, source: EventSource, random?: RandomSource) {
    this.ids = ids;
    this.clock = clock;
    this.source = source;
    this.random = random;
    this.visitKey = ids();
  }

  get dartCount(): number {
    return this.darts.filter(Boolean).length;
  }

  step(step: ScriptStep, out: BoardFactDraft[]): void {
    if ('dart' in step || 'recovered' in step) {
      const index = this.darts.length;
      if (index >= 3) return; // a board lists at most 3 darts per visit
      const segment = seg('dart' in step ? step.dart : step.recovered);
      const throwId = this.ids();
      const payload: Extract<BoardFactDraft, { type: 'DartDetected' }>['payload'] = {
        throwId,
        segment,
        visitKey: this.visitKey,
        indexInVisit: index,
      };
      const coords = step.coords ?? (this.random ? coordsFor(segment, this.random) : undefined);
      if (coords) payload.coords = coords;
      if ('recovered' in step) payload.recovered = true;
      this.darts.push({ throwId, segment });
      this.push(out, { type: 'DartDetected', payload });
      this.setStatus(out, this.darts.length >= 3 ? 'takeout' : 'throwing');
    } else if ('takeout' in step || 'inferredTakeout' in step) {
      if ('takeout' in step) this.push(out, { type: 'TakeoutStarted', payload: { visitKey: this.visitKey } });
      this.push(out, {
        type: 'TakeoutFinished',
        payload: 'inferredTakeout' in step ? { visitKey: this.visitKey, inferred: true } : { visitKey: this.visitKey },
      });
      this.newVisit();
      this.setStatus(out, 'ready');
    } else if ('reset' in step) {
      this.push(out, { type: 'VisitReset', payload: { visitKey: this.visitKey, reason: 'manual-reset' } });
      for (const d of this.darts) if (d) this.push(out, { type: 'DartWithdrawn', payload: { throwId: d.throwId } });
      this.newVisit();
      this.setStatus(out, 'ready');
    } else if ('update' in step) {
      const d = this.darts[step.update];
      if (!d) return;
      const segment = seg(step.to);
      this.push(out, { type: 'DartUpdated', payload: { throwId: d.throwId, previous: d.segment, segment } });
      d.segment = segment;
    } else if ('withdraw' in step) {
      const d = this.darts[step.withdraw];
      if (!d) return;
      this.push(out, { type: 'DartWithdrawn', payload: { throwId: d.throwId } });
      // A withdrawn last dart frees its position, as on the board; others leave a gap.
      if (step.withdraw === this.darts.length - 1) this.darts.pop();
      else this.darts[step.withdraw] = undefined;
    } else if ('status' in step) {
      this.setStatus(out, step.status);
    } else if ('connection' in step) {
      const payload: { state: typeof step.connection; error?: string } = { state: step.connection };
      if (step.error !== undefined) payload.error = step.error;
      this.push(out, { type: 'SourceConnectionChanged', payload });
    }
  }

  private newVisit(): void {
    this.visitKey = this.ids();
    this.darts = [];
  }

  private setStatus(out: BoardFactDraft[], status: BoardStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.push(out, { type: 'BoardStatusChanged', payload: { status } });
  }

  private push(out: BoardFactDraft[], body: Pick<BoardFactDraft, 'type' | 'payload'>): void {
    out.push({ ...body, source: this.source, occurredAt: this.clock() } as BoardFactDraft);
  }
}

export interface ScriptOptions {
  ids: IdSource;
  clock: Clock;
  source?: EventSource;
  /** Give darts plausible coordinates. Omit for coordinate-free facts. */
  random?: RandomSource;
}

/**
 * Board facts for a script, synchronously: the quickest way to feed the engine's session
 * host in tests. `wait` steps are ignored.
 */
export function scriptToFacts(steps: readonly ScriptStep[], options: ScriptOptions): BoardFactDraft[] {
  const w = new FactWriter(options.ids, options.clock, options.source ?? { kind: 'simulator', adapterVersion: SIMULATOR_ADAPTER_VERSION }, options.random);
  const out: BoardFactDraft[] = [];
  for (const s of steps) w.step(s, out);
  return out;
}

export interface SimulatorPace {
  /** Time between darts. */
  dartMs: readonly [number, number];
  /** Time from the last dart to the takeout starting. */
  takeoutDelayMs: readonly [number, number];
  /** Probability a visit ends after 2 darts (a bounce-out the host pads as a miss). */
  shortVisit: number;
}

export const DEMO_PACE: SimulatorPace = { dartMs: [900, 2200], takeoutDelayMs: [1500, 3000], shortVisit: 0.08 };

export interface SimulatorSourceOptions {
  scheduler: Scheduler;
  clock: Clock;
  ids: IdSource;
  random: RandomSource;
  /** Play this script (with its waits); otherwise play random visits when `autoplay`. */
  script?: readonly ScriptStep[];
  loop?: boolean;
  autoplay?: boolean;
  pace?: SimulatorPace;
}

/**
 * Demo mode (ARCHITECTURE §9.4): a dart source that emits board facts directly, from a
 * script or from seeded random play, on the injected scheduler. `throwDart` and `takeout`
 * let a UI or a test drive it by hand.
 */
export class SimulatorSource implements BoardSource {
  readonly kind = 'simulator' as const;
  private readonly o: SimulatorSourceOptions;
  private readonly facts = new Listeners<BoardFactDraft>();
  private readonly writer: FactWriter;
  private timer: TimerHandle | null = null;
  private running = false;
  private cursor = 0;

  constructor(options: SimulatorSourceOptions) {
    this.o = options;
    this.writer = new FactWriter(options.ids, options.clock, { kind: 'simulator', adapterVersion: SIMULATOR_ADAPTER_VERSION }, options.random);
  }

  subscribe(listener: FactListener): () => void {
    return this.facts.add(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.apply({ connection: 'online' });
    this.apply({ status: 'ready' });
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.o.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  throwDart(segment?: string | Segment): void {
    this.apply({ dart: segment ?? randomSegment(this.o.random) });
  }

  takeout(): void {
    this.apply({ takeout: true });
  }

  apply(step: ScriptStep): void {
    const out: BoardFactDraft[] = [];
    this.writer.step(step, out);
    for (const f of out) this.facts.emit(f);
  }

  private between([lo, hi]: readonly [number, number]): number {
    return lo + this.o.random() * (hi - lo);
  }

  private scheduleNext(delay: number): void {
    if (!this.running) return;
    this.timer = this.o.scheduler.setTimeout(() => {
      this.timer = null;
      if (this.running) this.tick();
    }, delay);
  }

  private tick(): void {
    const script = this.o.script;
    if (script) {
      if (this.cursor >= script.length) {
        if (!this.o.loop) return;
        this.cursor = 0;
      }
      const step = script[this.cursor++] as ScriptStep;
      if ('wait' in step) this.scheduleNext(step.wait);
      else {
        this.apply(step);
        this.scheduleNext(0);
      }
      return;
    }
    if (!this.o.autoplay) return;
    const pace = this.o.pace ?? DEMO_PACE;
    const n = this.writer.dartCount;
    const visitOver = n >= 3 || (n === 2 && this.o.random() < pace.shortVisit);
    if (visitOver) {
      this.takeout();
      this.scheduleNext(this.between(pace.dartMs));
    } else {
      this.throwDart();
      this.scheduleNext(this.writer.dartCount >= 3 ? this.between(pace.takeoutDelayMs) : this.between(pace.dartMs));
    }
  }
}
