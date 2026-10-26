import { BOARD_NUMBERS_CLOCKWISE, type Bed } from '@arcade/event-schema';

/**
 * Display geometry for the stylised dartboard, normalised so the outer double wire is r = 1.
 * Rings are slightly exaggerated versus a real board so they make bigger touch targets;
 * this is for drawing and picking only, never for scoring.
 */
export const RADII = {
  innerBull: 0.055,
  outerBull: 0.115,
  tripleIn: 0.55,
  tripleOut: 0.64,
  doubleIn: 0.9,
  doubleOut: 1,
  numbers: 1.13,
} as const;

const SECTOR_DEG = 360 / 20;

/** Radial band for a numbered bed. */
export function bedBand(bed: Bed): [number, number] {
  switch (bed) {
    case 'single-inner':
      return [RADII.outerBull, RADII.tripleIn];
    case 'triple':
      return [RADII.tripleIn, RADII.tripleOut];
    case 'single-outer':
    case 'single':
      return [RADII.tripleOut, RADII.doubleIn];
    case 'double':
      return [RADII.doubleIn, RADII.doubleOut];
    case 'outer-bull':
      return [RADII.innerBull, RADII.outerBull];
    case 'inner-bull':
      return [0, RADII.innerBull];
    case 'miss':
      return [RADII.doubleOut, RADII.numbers - 0.05];
  }
}

/** Point at `angleDeg` clockwise from 12 o'clock and radius `r` (SVG coordinates, y down). */
export function polar(angleDeg: number, r: number): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180;
  return { x: r * Math.sin(a), y: -r * Math.cos(a) };
}

export function sectorIndexOf(number: number): number {
  return (BOARD_NUMBERS_CLOCKWISE as readonly number[]).indexOf(number);
}

/** SVG path for an annular sector of the given number, between radii r0 and r1. */
export function sectorPath(sectorIndex: number, r0: number, r1: number): string {
  const a0 = sectorIndex * SECTOR_DEG - SECTOR_DEG / 2;
  const a1 = a0 + SECTOR_DEG;
  const p0 = polar(a0, r1);
  const p1 = polar(a1, r1);
  const p2 = polar(a1, r0);
  const p3 = polar(a0, r0);
  const f = (n: number) => n.toFixed(4);
  return `M${f(p0.x)},${f(p0.y)} A${r1},${r1} 0 0 1 ${f(p1.x)},${f(p1.y)} L${f(p2.x)},${f(p2.y)} A${r0},${r0} 0 0 0 ${f(p3.x)},${f(p3.y)} Z`;
}

/** Centre of a bed, for drawing a dart marker when the source gave no coordinates. */
export function bedCentroid(number: number, bed: Bed): { x: number; y: number } {
  if (bed === 'inner-bull') return { x: 0, y: 0 };
  const [r0, r1] = bedBand(bed);
  const r = (r0 + r1) / 2;
  if (bed === 'outer-bull') return polar(45, r);
  const index = sectorIndexOf(number);
  return polar((index < 0 ? 0 : index) * SECTOR_DEG, r);
}
