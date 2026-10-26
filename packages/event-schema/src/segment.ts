import { z } from 'zod';

/** Dartboard numbers in clockwise order, starting at the top (20). */
export const BOARD_NUMBERS_CLOCKWISE = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
] as const;

export const BED_VALUES = [
  'single-inner',
  'single-outer',
  'single',
  'double',
  'triple',
  'outer-bull',
  'inner-bull',
  'miss',
] as const;
export const BedSchema = z.enum(BED_VALUES);
export type Bed = z.infer<typeof BedSchema>;

const SegmentNumberSchema = z.union([z.literal(0), z.int().min(1).max(20), z.literal(25)]);

/** Canonical label: "T20", "D16", "S5", "25" (outer bull), "BULL" (inner bull), "MISS". */
export function labelFor(number: number, multiplier: number): string {
  if (multiplier === 0) return 'MISS';
  if (number === 25) return multiplier === 2 ? 'BULL' : '25';
  const prefix = multiplier === 3 ? 'T' : multiplier === 2 ? 'D' : 'S';
  return `${prefix}${number}`;
}

/** Which beds are valid for a number/multiplier pair. */
function allowedBeds(number: number, multiplier: number): readonly Bed[] {
  if (multiplier === 0) return number === 0 ? ['miss'] : [];
  if (number === 25) {
    if (multiplier === 1) return ['outer-bull'];
    if (multiplier === 2) return ['inner-bull'];
    return [];
  }
  if (number < 1 || number > 20) return [];
  if (multiplier === 1) return ['single-inner', 'single-outer', 'single'];
  if (multiplier === 2) return ['double'];
  if (multiplier === 3) return ['triple'];
  return [];
}

export const SegmentSchema = z
  .object({
    number: SegmentNumberSchema,
    multiplier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    bed: BedSchema,
    label: z.string(),
    /** Sector a miss landed beside, when the source reports it (e.g. "M12"). */
    missSector: z.int().min(1).max(20).optional(),
  })
  .superRefine((seg, ctx) => {
    if (!allowedBeds(seg.number, seg.multiplier).includes(seg.bed)) {
      ctx.addIssue({
        code: 'custom',
        message: `bed "${seg.bed}" is not valid for number ${seg.number} × ${seg.multiplier}`,
        path: ['bed'],
      });
    }
    const expected = labelFor(seg.number, seg.multiplier);
    if (seg.label !== expected) {
      ctx.addIssue({ code: 'custom', message: `label must be "${expected}"`, path: ['label'] });
    }
    if (seg.missSector !== undefined && seg.bed !== 'miss') {
      ctx.addIssue({ code: 'custom', message: 'missSector is only valid on a miss', path: ['missSector'] });
    }
  });
export type Segment = z.infer<typeof SegmentSchema>;

/** Points are derived, never stored: number × multiplier (inner bull = 25 × 2 = 50). */
export function points(segment: Pick<Segment, 'number' | 'multiplier'>): number {
  return segment.number * segment.multiplier;
}

export const MISS: Segment = { number: 0, multiplier: 0, bed: 'miss', label: 'MISS' };

export function miss(missSector?: number): Segment {
  return missSector === undefined ? MISS : { ...MISS, missSector };
}

/**
 * Builds a valid segment. `bed` only needs to be given to tell single-inner from
 * single-outer; everything else is derived from number and multiplier.
 */
export function makeSegment(number: number, multiplier: 1 | 2 | 3, bed?: Bed): Segment {
  const beds = allowedBeds(number, multiplier);
  const chosen = bed ?? beds[0];
  if (chosen === undefined || !beds.includes(chosen)) {
    throw new RangeError(`No valid segment for ${number} × ${multiplier}${bed ? ` (${bed})` : ''}`);
  }
  return SegmentSchema.parse({
    number,
    multiplier,
    bed: chosen,
    label: labelFor(number, multiplier),
  });
}

export const OUTER_BULL: Segment = makeSegment(25, 1);
export const INNER_BULL: Segment = makeSegment(25, 2);

export function sameSegment(a: Segment, b: Segment): boolean {
  return a.number === b.number && a.multiplier === b.multiplier && a.bed === b.bed;
}

export const CoordsSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
export type Coords = z.infer<typeof CoordsSchema>;
