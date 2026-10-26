import { MISS, makeSegment, miss, type Bed, type Coords, type Segment } from '@arcade/event-schema';
import { excerpt } from './raw';

/**
 * Autodarts raw segment → normalized `Segment` (ARCHITECTURE §7.3).
 *
 * The result is derived from `number` and `multiplier` first; `bed` and `name` are only
 * hints. Known hint spellings come from the community sources (🟡):
 * - misses: `{"name":"M12","bed":"Outside","multiplier":0,"number":12}` (DartLab's 2.0.2
 *   capture) and `{"name":"M","number":0,"multiplier":0}` (HomeDarts' doubles);
 * - inner bull: `{"name":"Bull","number":25,"bed":"Double","multiplier":2}` (HomeDarts),
 *   `bed: "DoubleBull"` in cloud types;
 * - outer bull: `{"name":"25","number":25,"multiplier":1,"bed":"Single"}` (HomeDarts).
 *
 * A shape that fits no row, or whose hints contradict number × multiplier, is a *fatal*
 * anomaly: the dart is kept as a miss pending review and the adapter emits a correlated
 * `SourceAnomaly`. Unknown but harmless hints (an unseen bed name) are *notes*.
 */

export interface SegmentAnomaly {
  note: string;
  rawExcerpt: string;
}

export interface NormalizedSegment {
  segment: Segment;
  /** Set when the dart could not be read: `segment` is then MISS, pending review. */
  fatal?: SegmentAnomaly;
  /** Harmless oddities worth reporting once (unknown bed or name spellings). */
  notes: string[];
}

export interface NormalizedThrow extends NormalizedSegment {
  coords?: Coords;
}

type BedHint = Bed | 'bull';

const BED_HINTS: Record<string, BedHint> = {
  Single: 'single',
  SingleInner: 'single-inner',
  SingleOuter: 'single-outer',
  Double: 'double',
  Triple: 'triple',
  Outside: 'miss',
  DoubleBull: 'inner-bull',
  SingleBull: 'outer-bull',
  Bull: 'bull',
};

type NameHint =
  | { kind: 'miss'; sector?: number }
  | { kind: 'seg'; number: number; multiplier: number }
  | { kind: 'bull'; which: 'any' | 'outer' | 'inner' }
  | { kind: 'unknown' };

const MULT_PREFIX: Record<string, number> = { S: 1, D: 2, T: 3 };

function parseName(name: string): NameHint {
  const m = /^M(\d{1,2})?$/.exec(name);
  if (m) {
    const sector = m[1] === undefined ? undefined : Number(m[1]);
    return { kind: 'miss', sector };
  }
  if (/^miss$/i.test(name)) return { kind: 'miss' };
  const seg = /^([SDT])(\d{1,2})$/.exec(name);
  if (seg) return { kind: 'seg', multiplier: MULT_PREFIX[seg[1] as string] as number, number: Number(seg[2]) };
  if (name === 'Bull' || name === 'BULL' || name === 'Bullseye') return { kind: 'bull', which: 'any' };
  if (name === 'DB' || name === 'DBull') return { kind: 'bull', which: 'inner' };
  if (name === '25' || name === 'SB' || name === 'SBull') return { kind: 'bull', which: 'outer' };
  return { kind: 'unknown' };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function sectorOf(n: unknown): number | undefined {
  return isInt(n) && n >= 1 && n <= 20 ? n : undefined;
}

/** Whether a name hint agrees with a scoring number × multiplier. */
function nameAgrees(hint: NameHint, number: number, multiplier: number): boolean {
  switch (hint.kind) {
    case 'unknown':
      return true;
    case 'miss':
      return false;
    case 'seg':
      return hint.number === number && hint.multiplier === multiplier;
    case 'bull':
      if (number !== 25) return false;
      return hint.which === 'any' || (hint.which === 'outer') === (multiplier === 1);
  }
}

function bedAgrees(hint: BedHint, number: number, multiplier: number): boolean {
  if (number === 25) {
    if (multiplier === 1) return ['single', 'single-inner', 'single-outer', 'outer-bull', 'bull'].includes(hint);
    return ['double', 'inner-bull', 'bull'].includes(hint);
  }
  if (multiplier === 1) return hint === 'single' || hint === 'single-inner' || hint === 'single-outer';
  if (multiplier === 2) return hint === 'double';
  return hint === 'triple';
}

/** A value for a note, never longer than `max`, without running any of its code. */
function shown(v: unknown, max = 32): string {
  if (typeof v === 'string') return v.slice(0, max);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || v === null || v === undefined) return String(v).slice(0, max);
  return excerpt(v, max);
}

/** A board segment → normalized `Segment`. Total: whatever `raw` is, it returns and never throws. */
export function normalizeSegment(raw: unknown): NormalizedSegment {
  const notes: string[] = [];
  const fatal = (note: string): NormalizedSegment => ({
    segment: MISS,
    fatal: { note: `unreadable segment (${note}); counted as a miss pending review`, rawExcerpt: excerpt(raw) },
    notes,
  });
  try {
    return readSegment(raw, notes, fatal);
  } catch {
    // A getter or proxy trap that throws: nothing about this segment can be trusted.
    notes.length = 0;
    return fatal('segment could not be read');
  }
}

function readSegment(raw: unknown, notes: string[], fatal: (note: string) => NormalizedSegment): NormalizedSegment {
  if (!isRecord(raw)) return fatal('segment missing or not an object');

  const { number, multiplier, bed, name } = raw;
  let bedHint: BedHint | undefined;
  if (typeof bed === 'string') {
    bedHint = Object.hasOwn(BED_HINTS, bed) ? BED_HINTS[bed] : undefined;
    if (bedHint === undefined) notes.push(`unknown bed "${bed.slice(0, 32)}"`);
  } else if (bed !== undefined && bed !== null) {
    notes.push('bed is not a string');
  }
  let nameHint: NameHint | undefined;
  if (typeof name === 'string') {
    nameHint = parseName(name);
    if (nameHint.kind === 'unknown') notes.push(`unknown segment name "${name.slice(0, 32)}"`);
  }
  const missHinted = bedHint === 'miss' || nameHint?.kind === 'miss';

  // A miss by number × multiplier.
  if (multiplier === 0) {
    if (bedHint !== undefined && bedHint !== 'miss') return fatal(`multiplier 0 with bed "${String(bed)}"`);
    if (nameHint !== undefined && nameHint.kind !== 'miss' && nameHint.kind !== 'unknown') {
      return fatal(`multiplier 0 with name "${String(name)}"`);
    }
    if (number !== undefined && number !== null && !(isInt(number) && number >= 0 && number <= 25)) {
      return fatal('miss with an invalid number');
    }
    const sector = sectorOf(number) ?? (nameHint?.kind === 'miss' ? sectorOf(nameHint.sector) : undefined);
    return { segment: miss(sector), notes };
  }

  // A miss by hints alone (no multiplier given).
  if (missHinted && (multiplier === undefined || multiplier === null)) {
    const sector = sectorOf(number) ?? (nameHint?.kind === 'miss' ? sectorOf(nameHint.sector) : undefined);
    return { segment: miss(sector), notes };
  }
  if (missHinted) return fatal(`miss hint with multiplier ${shown(multiplier)}`);

  if (!isInt(number) || !isInt(multiplier)) return fatal('number or multiplier missing');
  if (multiplier < 1 || multiplier > 3) return fatal(`multiplier ${multiplier}`);
  const scoring = (number >= 1 && number <= 20) || (number === 25 && multiplier <= 2);
  if (!scoring) return fatal(`${number} × ${multiplier} is not a board segment`);
  if (bedHint !== undefined && !bedAgrees(bedHint, number, multiplier)) {
    return fatal(`bed "${String(bed)}" contradicts ${number} × ${multiplier}`);
  }
  if (nameHint !== undefined && !nameAgrees(nameHint, number, multiplier)) {
    return fatal(`name "${String(name)}" contradicts ${number} × ${multiplier}`);
  }

  const m = multiplier as 1 | 2 | 3;
  if (number === 25) return { segment: makeSegment(25, m), notes };
  const singleBed = bedHint === 'single-inner' || bedHint === 'single-outer' ? bedHint : 'single';
  return { segment: makeSegment(number, m, m === 1 ? singleBed : undefined), notes };
}

function normalizeCoords(raw: unknown, notes: string[]): Coords | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (isRecord(raw)) {
    const { x, y } = raw; // read once: a getter may answer differently each time
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  notes.push('coords not two finite numbers');
  return undefined;
}

/** One entry of `state.throws`: `{segment, coords?, bouncer?}`. Total, like `normalizeSegment`. */
export function normalizeThrow(raw: unknown): NormalizedThrow {
  const unreadable = (note: string): NormalizedThrow => ({
    segment: MISS,
    fatal: { note: `${note}; counted as a miss pending review`, rawExcerpt: excerpt(raw) },
    notes: [],
  });
  try {
    if (!isRecord(raw)) return unreadable('throw entry is not an object');
    const result: NormalizedThrow = normalizeSegment(raw.segment);
    const coords = normalizeCoords(raw.coords, result.notes);
    if (raw.bouncer === true) result.notes.push('bouncer: true observed');
    if (result.fatal) result.fatal = { ...result.fatal, rawExcerpt: excerpt(raw) };
    return coords === undefined ? result : { ...result, coords };
  } catch {
    // A getter or proxy trap that throws: nothing about this dart can be trusted.
    return unreadable('throw entry could not be read');
  }
}
