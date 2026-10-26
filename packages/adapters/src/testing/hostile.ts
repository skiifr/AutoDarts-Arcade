import fc from 'fast-check';

/**
 * Test support: values built to break code that reads them. Getters and proxy traps that throw,
 * objects that cannot be turned into a string, cycles, nesting deeper than the stack, huge
 * strings. None of these can come out of `JSON.parse`, but a transport is only an interface.
 */

class Boom extends Error {
  constructor(what: string) {
    super(`hostile ${what}`);
  }
}

/** `String(x)` and `${x}` throw: what `JSON.parse('{"toString":0,"valueOf":0}')` gives. */
export const unprintable = (): Record<string, unknown> => JSON.parse('{"toString":0,"valueOf":0}') as Record<string, unknown>;

/** Every listed property is a getter that throws. */
export function throwingGetters(keys: readonly string[] = ['segment', 'coords', 'bouncer', 'number', 'multiplier', 'bed', 'name', 'x', 'y']): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) {
    Object.defineProperty(o, k, {
      enumerable: true,
      get: () => {
        throw new Boom(`getter ${k}`);
      },
    });
  }
  return o;
}

/** A proxy whose every trap throws (`Array.isArray` on it does not, `Object.keys` does). */
export function trappedProxy(): object {
  const trap = (): never => {
    throw new Boom('trap');
  };
  return new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
}

/** A revoked proxy: even `Array.isArray` throws on it. */
export function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

export function cyclic(): Record<string, unknown> {
  const a: Record<string, unknown> = { name: 'M', multiplier: 1 };
  const b: Record<string, unknown> = { a, list: [a] };
  a.self = a;
  a.b = b;
  return a;
}

/** Arrays nested `depth` deep: deeper than any recursive walk's stack. */
export function deep(depth = 200_000): unknown {
  let v: unknown = 'bottom';
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

/** A toJSON that throws (JSON.stringify calls it). */
export const badToJson = (): object => ({
  toJSON: () => {
    throw new Boom('toJSON');
  },
});

const HOSTILE: (() => unknown)[] = [
  unprintable,
  () => throwingGetters(),
  trappedProxy,
  revokedProxy,
  cyclic,
  () => deep(),
  badToJson,
  () => 'x'.repeat(1_000_000),
  () => 10n,
  () => Symbol('s'),
  () => () => 1,
  () => Object.create(null) as object,
  () => [undefined, Symbol('in a list'), () => 2, 3n],
];

/**
 * A maker of one hostile value, fresh on each call. (fast-check inspects the values it generates,
 * and a hostile proxy breaks it too, so the arbitraries hand out makers.)
 */
export const hostileArb: fc.Arbitrary<() => unknown> = fc.integer({ min: 0, max: HOSTILE.length - 1 }).map((i) => HOSTILE[i] as () => unknown);

/** Makers of hostile values on their own and planted where a board throw's fields are read. */
export const hostileThrowArb: fc.Arbitrary<() => unknown> = fc.oneof(
  hostileArb,
  fc.anything().map((v) => () => v),
  hostileArb.map((h) => () => ({ segment: h() })),
  hostileArb.map((h) => () => ({ segment: { name: 'M', multiplier: h() } })),
  hostileArb.map((h) => () => ({ segment: { number: h(), multiplier: 0 } })),
  hostileArb.map((h) => () => ({ segment: { number: 20, multiplier: 1, bed: h(), name: h() } })),
  hostileArb.map((h) => () => ({ segment: { number: 20, multiplier: h(), bed: 'Outside' } })),
  hostileArb.map((h) => () => ({ segment: { number: 20, multiplier: 3 }, coords: h() })),
  hostileArb.map((h) => () => ({ segment: { number: 20, multiplier: 3 }, coords: { x: h(), y: 0.1 }, bouncer: h() })),
);
