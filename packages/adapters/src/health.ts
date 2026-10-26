import type { BoardFactDraft, EventSource } from '@arcade/event-schema';
import type { BoardStatus } from './autodarts-local/status';
import { Listeners, type Clock, type Scheduler, type TimerHandle, type Transport } from './ports';

/** One board-health reading (ARCHITECTURE §9.7). */
export interface BoardHealthSample {
  at: string;
  /** Overall detection frame rate, from `GET /api/state/stats`. */
  fps?: number;
  /** Per-camera frame rates in camera order, from `GET /api/cams/stats`. */
  camFps?: number[];
  /** Set when a read failed; the other fields are then partial or absent. */
  error?: string;
}

export const HEALTH_INTERVAL_MS = 30_000;
const MAX_CAMERAS = 8;

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** `{"fps": 12.5}` (HomeDarts' recording of `/api/state/stats`). */
export function parseStateStats(body: string): number | undefined {
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === 'object' && v !== null ? finite((v as { fps?: unknown }).fps) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `{"fps": [29.9, 30, 29.8]}` (HomeDarts' recording of `/api/cams/stats`). A list of
 * `{fps}` objects, as in `/api/system`'s `camStats`, is accepted too.
 */
export function parseCamsStats(body: string): number[] | undefined {
  try {
    const v: unknown = JSON.parse(body);
    const list: unknown = Array.isArray(v) ? v : typeof v === 'object' && v !== null ? (v as { fps?: unknown }).fps : undefined;
    if (!Array.isArray(list)) return undefined;
    const fps = list
      .slice(0, MAX_CAMERAS)
      .map((item: unknown) => finite(typeof item === 'object' && item !== null ? (item as { fps?: unknown }).fps : item));
    return fps.every((f): f is number => f !== undefined) ? fps : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Samples the two allowlisted stats endpoints every 30 s while a game runs — at most two
 * small requests per 30 s, well within NF8. The host starts it with the game and stops
 * it at the end; samples go to listeners and can be logged with `healthFact`.
 */
export class BoardHealthSampler {
  private readonly transport: Transport;
  private readonly scheduler: Scheduler;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly listeners = new Listeners<BoardHealthSample>();
  private timer: TimerHandle | null = null;
  private running = false;
  private inFlight = false;

  constructor(options: { transport: Transport; scheduler: Scheduler; clock: Clock; intervalMs?: number }) {
    this.transport = options.transport;
    this.scheduler = options.scheduler;
    this.clock = options.clock;
    this.intervalMs = options.intervalMs ?? HEALTH_INTERVAL_MS;
  }

  onSample(listener: (sample: BoardHealthSample) => void): () => void {
    return this.listeners.add(listener);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Starts sampling; the first sample is taken after one interval. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Takes one sample now (also used by the interval). */
  async sample(): Promise<BoardHealthSample> {
    const s: BoardHealthSample = { at: this.clock() };
    const errors: string[] = [];
    try {
      const r = await this.transport.get('/api/state/stats');
      const fps = r.status === 200 ? parseStateStats(r.body) : undefined;
      if (fps === undefined) errors.push(`state stats HTTP ${r.status}`);
      else s.fps = fps;
    } catch (e) {
      errors.push(`state stats: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const r = await this.transport.get('/api/cams/stats');
      const cams = r.status === 200 ? parseCamsStats(r.body) : undefined;
      if (cams === undefined) errors.push(`cams stats HTTP ${r.status}`);
      else s.camFps = cams;
    } catch (e) {
      errors.push(`cams stats: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (errors.length > 0) s.error = errors.join('; ').slice(0, 200);
    this.listeners.emit(s);
    return s;
  }

  private schedule(): void {
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      if (!this.running) return;
      if (!this.inFlight) {
        this.inFlight = true;
        void this.sample().finally(() => {
          this.inFlight = false;
        });
      }
      this.schedule();
    }, this.intervalMs);
  }
}

/** A health sample as a loggable `BoardStatusChanged` fact (`health` per §7.4). */
export function healthFact(sample: BoardHealthSample, status: BoardStatus, source: EventSource): BoardFactDraft | null {
  if (sample.fps === undefined && sample.camFps === undefined) return null;
  const health: { fps?: number; camFps?: number[] } = {};
  if (sample.fps !== undefined) health.fps = sample.fps;
  if (sample.camFps !== undefined) health.camFps = sample.camFps;
  return { type: 'BoardStatusChanged', payload: { status, health }, source, occurredAt: sample.at };
}
