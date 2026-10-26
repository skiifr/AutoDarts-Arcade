import type { Coords, Segment } from '@arcade/event-schema';
import { Listeners, type RandomSource } from '../ports';
import { coordsFor, neighbourSegment, nudge, parseLabel, randomSegment } from './geometry';

/**
 * A model of an Autodarts 2.x board's local API, driven by physical actions. It produces
 * the `state` frames and `GET /api/state` bodies a real board would (shapes from
 * ARCHITECTURE §4.3 and the community captures, 🟡) and records ground truth for the
 * chaos suite: every physical dart, every detection the board reported, and every visit.
 * No timers: callers (tests, the fake transport, the fake-board tool) decide when
 * actions happen.
 */

export interface RawSegmentOut {
  bed?: string;
  multiplier: number;
  name: string;
  number: number;
}

export interface Detection {
  id: number;
  visit: number;
  segment: Segment;
  coords: Coords;
  /** A false detection: no physical dart behind it. */
  phantom: boolean;
  /** The board retracted it while it was still in the visit. */
  withdrawn: boolean;
  /** Pulled out during a takeout before the takeout finished (it still counts for its visit). */
  pulled?: boolean;
  /** The board reports this dart without coordinates, in every frame (bounce-outs may carry none 🟡). */
  noCoords?: boolean;
  physicalId?: number;
  /** Every reading the board reported for it, oldest first (ground truth for the chaos suite). */
  history: { segment: Segment; coords: Coords }[];
}

export interface PhysicalDart {
  id: number;
  visit: number;
  segment: Segment;
  /** `undetected`: the board never listed it (bounce-out, full board, stuck takeout, stopped). */
  outcome: 'detected' | 'bounce-out' | 'undetected';
  /** It fell out after being detected; the board keeps listing it. */
  fellOut?: boolean;
  detectionId?: number;
}

export interface TruthVisit {
  index: number;
  startedAt: number;
  endedAt?: number;
  endedBy?: 'takeout' | 'reset';
  /** Detection ids listed when the visit ended, in board order. */
  finalDetections: number[];
  /** Every detection id the board ever listed in this visit. */
  everDetections: number[];
}

export interface BoardModelOptions {
  random: RandomSource;
  /** Monotonic ms, for visit timestamps in the ground truth. */
  now?: () => number;
  /** What `GET /api/version` answers. */
  version?: string;
  /** `outside`: `{"bed":"Outside","multiplier":0,"name":"M12","number":12}` (2.0.2 capture); `bare`: `{"name":"M","number":0,"multiplier":0}`. */
  missStyle?: 'outside' | 'bare';
  /** v2 omits `throws` on an empty board (DartLab's capture); older doubles send `[]`. */
  emptyThrows?: 'omit' | 'array';
  cameras?: number;
  /** Also emit `motion_state` frames around takeouts, as HomeDarts' recordings show. */
  noiseFrames?: boolean;
  /**
   * Add `"_simVisit": <visit index>` to every state and `"_simDet": <detection id>` to every
   * listed dart (the adapter ignores unknown fields).
   */
  annotate?: boolean;
  /** The fraction of detections the board reports without coordinates (default 0). */
  noCoordsRate?: number;
}

export function rawSegmentOf(seg: Segment, missStyle: 'outside' | 'bare' = 'outside'): RawSegmentOut {
  switch (seg.bed) {
    case 'miss':
      return missStyle === 'bare' || seg.missSector === undefined
        ? { name: 'M', number: 0, multiplier: 0 }
        : { bed: 'Outside', multiplier: 0, name: `M${seg.missSector}`, number: seg.missSector };
    case 'outer-bull':
      return { bed: 'Single', multiplier: 1, name: '25', number: 25 };
    case 'inner-bull':
      return { bed: 'Double', multiplier: 2, name: 'Bull', number: 25 };
    case 'single-inner':
      return { bed: 'SingleInner', multiplier: 1, name: `S${seg.number}`, number: seg.number };
    case 'single-outer':
      return { bed: 'SingleOuter', multiplier: 1, name: `S${seg.number}`, number: seg.number };
    case 'single':
      return { bed: 'Single', multiplier: 1, name: `S${seg.number}`, number: seg.number };
    case 'double':
      return { bed: 'Double', multiplier: 2, name: `D${seg.number}`, number: seg.number };
    case 'triple':
      return { bed: 'Triple', multiplier: 3, name: `T${seg.number}`, number: seg.number };
  }
}

type SegmentInput = Segment | string;

function toSegment(input: SegmentInput | undefined, random: RandomSource): Segment {
  if (input === undefined) return randomSegment(random);
  return typeof input === 'string' ? parseLabel(input) : input;
}

export class BoardModel {
  readonly detections: Detection[] = [];
  readonly physical: PhysicalDart[] = [];
  readonly visits: TruthVisit[] = [];
  readonly version: string;

  private readonly random: RandomSource;
  private readonly now: () => number;
  private readonly missStyle: 'outside' | 'bare';
  private readonly emptyThrows: 'omit' | 'array';
  private readonly cameras: number;
  private readonly noiseFrames: boolean;
  private readonly annotate: boolean;
  private readonly noCoordsRate: number;
  private readonly frames = new Listeners<string>();

  private list: Detection[] = [];
  /** The darts listed when the current takeout began (null outside a takeout). */
  private takeoutList: Detection[] | null = null;
  private status = 'Throw';
  private event = 'Started';
  private running = true;
  private stuck = false;
  private changes = 0;
  private callOffs = 0;

  constructor(options: BoardModelOptions) {
    this.random = options.random;
    this.now = options.now ?? (() => 0);
    this.version = options.version ?? '2.0.2';
    this.missStyle = options.missStyle ?? 'outside';
    this.emptyThrows = options.emptyThrows ?? 'omit';
    this.cameras = options.cameras ?? 3;
    this.noiseFrames = options.noiseFrames ?? false;
    this.annotate = options.annotate ?? false;
    this.noCoordsRate = options.noCoordsRate ?? 0;
    this.openVisit();
  }

  /** Every frame the board pushes on `WS /api/events`, as JSON text. */
  onFrame(listener: (text: string) => void): () => void {
    return this.frames.add(listener);
  }

  /** Increments with every state change (for tests). */
  get stateVersion(): number {
    return this.changes;
  }

  get dartsOnBoard(): number {
    return this.list.length;
  }

  /** Ids of the detections the board lists right now, in board order. */
  listedDetectionIds(): number[] {
    return this.list.map((d) => d.id);
  }

  get isStuck(): boolean {
    return this.stuck;
  }

  /** How many takeouts were called off (ground truth for the chaos suite). */
  get calledOffTakeouts(): number {
    return this.callOffs;
  }

  get currentStatus(): string {
    return this.status;
  }

  get currentVisit(): TruthVisit {
    return this.visits[this.visits.length - 1] as TruthVisit;
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  stateData(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      connected: true,
      event: this.event,
      numThrows: this.list.length,
      running: this.running,
      status: this.status,
    };
    if (this.list.length > 0 || this.emptyThrows === 'array') {
      data.throws = this.list.map((d) => {
        const entry: Record<string, unknown> = { bouncer: false };
        if (!d.noCoords) entry.coords = { x: d.coords.x, y: d.coords.y };
        entry.segment = rawSegmentOf(d.segment, this.missStyle);
        if (this.annotate) entry._simDet = d.id;
        return entry;
      });
    }
    if (this.annotate) data._simVisit = this.currentVisit.index;
    return data;
  }

  /** Body of `GET /api/state`. */
  stateJson(): string {
    return JSON.stringify(this.stateData());
  }

  /** Body of `GET /api/version`: plain text, as HomeDarts reads it. */
  versionText(): string {
    return this.version;
  }

  /** Body of `GET /api/state/stats`. */
  statsJson(): string {
    return JSON.stringify({ fps: Math.round((11 + this.random() * 3) * 10) / 10 });
  }

  /** Body of `GET /api/cams/stats`. */
  camsStatsJson(): string {
    const fps = Array.from({ length: this.cameras }, () => Math.round((29 + this.random() * 1.2) * 10) / 10);
    return JSON.stringify({ fps });
  }

  // ── physical actions ─────────────────────────────────────────────────────

  /** A dart hits the board. The board lists it unless it cannot see it. */
  throwDart(options: { segment?: SegmentInput; bounceOut?: boolean } = {}): PhysicalDart {
    const segment = toSegment(options.segment, this.random);
    const dart: PhysicalDart = { id: this.physical.length + 1, visit: this.currentVisit.index, segment, outcome: 'detected' };
    this.physical.push(dart);
    if (options.bounceOut) {
      dart.outcome = 'bounce-out';
      return dart;
    }
    if (!this.running || this.stuck || this.status === 'Takeout in progress' || this.list.length >= 3) {
      dart.outcome = 'undetected';
      return dart;
    }
    const det = this.addDetection(segment, false);
    det.physicalId = dart.id;
    dart.detectionId = det.id;
    this.event = 'Throw detected';
    this.status = this.list.length >= 3 ? 'Takeout' : 'Throw';
    this.changed();
    return dart;
  }

  /** A dart bounces off the board: nobody detects it (§6.3). */
  bounceOut(segment?: SegmentInput): PhysicalDart {
    return this.throwDart({ segment, bounceOut: true });
  }

  /** A detected dart falls out. The board does not notice and keeps listing it. */
  fallOut(index = this.list.length - 1): void {
    const det = this.list[index];
    const dart = det?.physicalId === undefined ? undefined : this.physical[det.physicalId - 1];
    if (dart) dart.fellOut = true;
  }

  /** The board reports a dart that is not there (a hand, a shadow). */
  phantom(segment?: SegmentInput): Detection | null {
    if (!this.running || this.stuck || this.status === 'Takeout in progress' || this.list.length >= 3) return null;
    const det = this.addDetection(toSegment(segment, this.random), true);
    this.event = 'Throw detected';
    this.status = this.list.length >= 3 ? 'Takeout' : 'Throw';
    this.changed();
    return det;
  }

  /** The board retracts one of its detections outside a takeout (🟡[C2]). */
  withdraw(index = this.list.length - 1): Detection | null {
    if (this.status === 'Takeout in progress') return null;
    const [det] = this.list.splice(index, 1);
    if (!det) return null;
    det.withdrawn = true;
    this.status = this.list.length >= 3 ? 'Takeout' : 'Throw';
    this.changed();
    return det;
  }

  /** The board changes its mind about a dart: a neighbouring segment, nudged coordinates. */
  changeDetection(index?: number, segment?: SegmentInput): Detection | null {
    if (this.list.length === 0 || this.status === 'Takeout in progress') return null;
    const i = index ?? Math.floor(this.random() * this.list.length);
    const det = this.list[i];
    if (!det) return null;
    det.segment = segment === undefined ? neighbourSegment(det.segment, this.random) : toSegment(segment, this.random);
    det.coords = nudge(det.coords, this.random);
    det.history.push({ segment: det.segment, coords: det.coords });
    this.event = 'Throw detected';
    this.changed();
    return det;
  }

  startTakeout(): void {
    if (this.status === 'Takeout in progress' || !this.running) return;
    this.status = 'Takeout in progress';
    this.event = 'Takeout started';
    this.takeoutList = [...this.list];
    this.changed();
    this.motion(true);
  }

  /**
   * During a takeout, one dart comes out (default: the first listed), as on a real board where
   * darts are pulled one at a time. The board lists the rest; the takeout goes on. Pulling the
   * last dart leaves an empty board still in takeout until `finishTakeout()`.
   */
  pullDart(index = 0): Detection | null {
    if (this.status !== 'Takeout in progress' || this.stuck) return null;
    const [det] = this.list.splice(index, 1);
    if (!det) return null;
    det.pulled = true;
    this.changed();
    return det;
  }

  /**
   * The board calls a takeout off: the hand left with every dart still in. The status returns to
   * throwing ("Takeout" with 3 darts); nothing new happened, so the event stays "Takeout
   * started". Only before any dart was pulled; returns whether it happened.
   */
  callOffTakeout(): boolean {
    const startedWith = this.takeoutList;
    if (this.status !== 'Takeout in progress' || this.stuck || !startedWith || startedWith.length === 0 || startedWith.length !== this.list.length) return false;
    this.takeoutList = null;
    this.status = this.list.length >= 3 ? 'Takeout' : 'Throw';
    this.callOffs++;
    this.changed();
    this.motion(false);
    return true;
  }

  /** All darts are off the board. */
  finishTakeout(): void {
    if (this.status !== 'Takeout in progress' || this.stuck) return;
    this.closeVisit('takeout');
    this.status = 'Throw';
    this.event = 'Takeout finished';
    this.changed();
    this.motion(false);
  }

  /** Start and finish a takeout in one step (callers wanting timing call both halves). */
  takeout(): void {
    this.startTakeout();
    this.finishTakeout();
  }

  /** A hand in front of the cameras on an empty board: an empty takeout. */
  handInFront(): void {
    if (this.list.length > 0) return;
    this.takeout();
  }

  /**
   * 2.0.2's stuck takeout (🟡[C12]): a takeout starts again on the empty board and holds,
   * counting no darts until a manual reset.
   */
  stickTakeout(): void {
    if (this.list.length > 0) {
      this.startTakeout();
      this.finishTakeout();
    }
    this.status = 'Takeout in progress';
    this.event = 'Takeout started';
    this.stuck = true;
    this.changed();
  }

  /** The player resets the board in Autodarts: the visit's detections are discarded. */
  manualReset(): void {
    this.closeVisit('reset');
    this.stuck = false;
    this.status = 'Throw';
    this.event = 'Manual reset';
    this.changed();
  }

  stopDetection(): void {
    this.running = false;
    this.status = 'Stopped';
    this.event = 'Stopped';
    this.changed();
  }

  startDetection(): void {
    if (this.list.length > 0) this.closeVisit('reset');
    this.running = true;
    this.stuck = false;
    this.status = 'Throw';
    this.event = 'Started';
    this.changed();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private addDetection(segment: Segment, phantom: boolean): Detection {
    const coords = coordsFor(segment, this.random);
    const det: Detection = {
      id: this.detections.length + 1,
      visit: this.currentVisit.index,
      segment,
      coords,
      phantom,
      withdrawn: false,
      history: [{ segment, coords }],
    };
    // Drawn only when asked for, so boards without the option replay the same darts as before.
    if (this.noCoordsRate > 0 && this.random() < this.noCoordsRate) det.noCoords = true;
    this.detections.push(det);
    this.list.push(det);
    this.currentVisit.everDetections.push(det.id);
    return det;
  }

  private openVisit(): void {
    this.visits.push({ index: this.visits.length, startedAt: this.now(), finalDetections: [], everDetections: [] });
  }

  private closeVisit(by: 'takeout' | 'reset'): void {
    const v = this.currentVisit;
    // Darts pulled during the takeout were still in the visit: its darts are those listed when
    // the takeout began.
    v.finalDetections = (by === 'takeout' && this.takeoutList ? this.takeoutList : this.list).map((d) => d.id);
    this.takeoutList = null;
    v.endedAt = this.now();
    v.endedBy = by;
    this.list = [];
    this.openVisit();
  }

  private changed(): void {
    this.changes++;
    this.frames.emit(JSON.stringify({ type: 'state', data: this.stateData() }));
  }

  private motion(hand: boolean): void {
    if (!this.noiseFrames) return;
    this.frames.emit(
      JSON.stringify({
        type: 'motion_state',
        data: { isWaiting: !hand, isStable: !hand, isDart: false, isHand: hand, isTakeoutPartial: hand, isTakeoutFull: !hand },
      }),
    );
  }
}
