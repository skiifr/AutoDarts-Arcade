/**
 * Checkout hints for Countdown: the route a darts chart would suggest for a remaining score,
 * e.g. 141 → T20 · T19 · D12. Pure and deterministic; the view shows it, the rules never use it.
 */

interface Throw {
  label: string;
  value: number;
  /** How much a chart dislikes aiming here to set up a later dart (lower is better). */
  setup: number;
  /** How much a chart dislikes finishing here with double out; null when it cannot finish. */
  double: number | null;
  /** How much it dislikes finishing here with single out (any dart finishes). */
  single: number;
}

/** Trebles in the order charts reach for them: T20 and T19 first. */
const TREBLE_SETUP: Record<number, number> = { 20: 0, 19: 1, 18: 2, 17: 2, 16: 3, 15: 3, 14: 3, 13: 3, 12: 4, 11: 4, 10: 4 };
/** Doubles in the order charts like to leave them: D20, D16 and D8 first (they halve well). */
const DOUBLE_FINISH: Record<number, number> = { 20: 0, 16: 0, 8: 1, 18: 1, 12: 1, 10: 2, 14: 3, 4: 4, 6: 5, 2: 6, 1: 8 };
/** Odd doubles are a last resort: missing them inside leaves an odd number. */
const ODD_DOUBLE = 6;

const THROWS: Throw[] = [
  ...Array.from({ length: 20 }, (_, i): Throw => {
    const n = 20 - i;
    return { label: `T${n}`, value: n * 3, setup: TREBLE_SETUP[n] ?? 6, double: null, single: 2 };
  }),
  ...Array.from({ length: 20 }, (_, i): Throw => {
    const n = 20 - i;
    return { label: `D${n}`, value: n * 2, setup: 6, double: DOUBLE_FINISH[n] ?? ODD_DOUBLE, single: 1 };
  }),
  ...Array.from({ length: 20 }, (_, i): Throw => {
    const n = 20 - i;
    return { label: `S${n}`, value: n, setup: 1, double: null, single: 0 };
  }),
  { label: 'BULL', value: 50, setup: 5, double: 6, single: 1 },
  { label: '25', value: 25, setup: 4, double: null, single: 1 },
];

export interface CheckoutOptions {
  /** The last dart must be a double (or the bull). Without it, the shortest finish is shown. */
  doubleOut: boolean;
  /** Darts still to throw in this visit (0–3). */
  dartsLeft: number;
}

interface Route {
  throws: Throw[];
  costs: number[];
}

/** Lower total cost first, then the better first dart, then the bigger first dart. */
function better(a: Route, b: Route): boolean {
  const total = (r: Route) => r.costs.reduce((sum, c) => sum + c, 0);
  if (total(a) !== total(b)) return total(a) < total(b);
  for (let i = 0; i < a.costs.length; i++) {
    if (a.costs[i] !== b.costs[i]) return a.costs[i]! < b.costs[i]!;
  }
  return a.throws[0]!.value > b.throws[0]!.value;
}

/**
 * The suggested finish for `remaining` within the darts left, as labels ("T20", "D12",
 * "BULL", "25", "S5"), or null when there is none: above 170 (180 with single out), the
 * bogey numbers (169, 168, 166, 165, 163, 162, 159 with double out), 1 with double out,
 * or not enough darts. Fewest darts first, then the route the usual charts prefer.
 */
export function checkoutHint(remaining: number, { doubleOut, dartsLeft }: CheckoutOptions): string[] | null {
  if (!Number.isInteger(remaining) || remaining < 1) return null;
  const finishCost = (t: Throw) => (doubleOut ? t.double : t.single);
  // The cheapest way to finish on each value (S6 beats D3 beats T2 with single out).
  const finishers = new Map<number, { throw: Throw; cost: number }>();
  const candidates = THROWS.flatMap((t) => {
    const cost = finishCost(t);
    return cost === null ? [] : [{ throw: t, cost }];
  }).sort((a, b) => a.cost - b.cost);
  for (const c of candidates) if (!finishers.has(c.throw.value)) finishers.set(c.throw.value, c);

  for (let darts = 1; darts <= Math.min(3, dartsLeft); darts++) {
    let best: Route | null = null;
    for (const setups of SETUPS[darts - 1]!) {
      const finish = finishers.get(remaining - setups.reduce((sum, t) => sum + t.value, 0));
      if (!finish) continue;
      const route: Route = { throws: [...setups, finish.throw], costs: [...setups.map((t) => t.setup), finish.cost] };
      if (best === null || better(route, best)) best = route;
    }
    if (best !== null) return best.throws.map((t) => t.label);
  }
  return null;
}

/** Every sequence of 0, 1 and 2 setup darts, built once. */
const SETUPS: Throw[][][] = [0, 1, 2].map(setupsFor);

/** Every sequence of `count` setup darts. */
function setupsFor(count: number): Throw[][] {
  if (count === 0) return [[]];
  return THROWS.flatMap((t) => setupsFor(count - 1).map((rest) => [t, ...rest]));
}
