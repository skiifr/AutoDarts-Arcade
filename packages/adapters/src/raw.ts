import { z } from 'zod';

/**
 * Raw Autodarts local-API shapes (ARCHITECTURE §4.3, all 🟡 community-sourced). Parsing is
 * deliberately lenient about extra fields and strict about the fields the adapter uses:
 * anything that fails becomes a `SourceAnomaly`, never an exception.
 */

/** Frames or bodies larger than this are dropped with an anomaly (UTF-16 code units). */
export const MAX_FRAME_CHARS = 256 * 1024;
/** `SourceAnomaly.rawExcerpt` is capped by the schema at 2000; we keep it smaller. */
export const MAX_EXCERPT_CHARS = 512;
/** A visit holds at most 3 darts; anything beyond a generous margin is malformed. */
const MAX_THROWS = 16;

export const KNOWN_STATUSES = [
  'Stopped',
  'Starting',
  'Throw',
  'Takeout',
  'Takeout in progress',
  'Calibrating',
  'calibrating',
  'Error',
  'error',
] as const;

export const KNOWN_EVENTS = [
  'Stopped',
  'Stopping',
  'Starting',
  'Started',
  'Throw detected',
  'Takeout started',
  'Takeout finished',
  'Manual reset',
  'Calibration started',
  'Calibration finished',
] as const;

const RawStateSchema = z.looseObject({
  connected: z.boolean().optional(),
  running: z.boolean().optional(),
  status: z.string().max(64).optional(),
  event: z.string().max(64).optional(),
  numThrows: z.number().int().min(0).max(1000).optional(),
  // v2 omits the key on an empty board; v1 and some doubles send []. null is tolerated.
  throws: z.array(z.unknown()).max(MAX_THROWS).nullable().optional(),
});
export type RawState = z.infer<typeof RawStateSchema>;

const EnvelopeSchema = z.looseObject({ type: z.string().max(64), data: z.unknown() });

export type ParsedFrame =
  | { kind: 'state'; data: RawState }
  | { kind: 'other'; type: string; data: unknown }
  | { kind: 'invalid'; note: string };

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Validates the `data` of a `state` frame or the body of `GET /api/state`. */
export function parseStateData(value: unknown): { ok: true; data: RawState } | { ok: false; note: string } {
  const r = RawStateSchema.safeParse(value);
  return r.success ? { ok: true, data: r.data } : { ok: false, note: `invalid state: ${describeIssues(r.error)}` };
}

export function parseStateBody(text: string): { ok: true; data: RawState } | { ok: false; note: string } {
  if (text.length > MAX_FRAME_CHARS) return { ok: false, note: `state body over ${MAX_FRAME_CHARS} chars` };
  const json = parseJson(text);
  if (!json.ok) return { ok: false, note: 'state body is not JSON' };
  return parseStateData(json.value);
}

/** Parses one WebSocket frame: `{"type": "...", "data": {...}}`. */
export function parseEventFrame(text: string): ParsedFrame {
  if (text.length > MAX_FRAME_CHARS) return { kind: 'invalid', note: `frame over ${MAX_FRAME_CHARS} chars dropped` };
  const json = parseJson(text);
  if (!json.ok) return { kind: 'invalid', note: 'frame is not JSON' };
  const env = EnvelopeSchema.safeParse(json.value);
  if (!env.success) return { kind: 'invalid', note: `frame envelope: ${describeIssues(env.error)}` };
  if (env.data.type !== 'state') return { kind: 'other', type: env.data.type, data: env.data.data };
  const state = parseStateData(env.data.data);
  return state.ok ? { kind: 'state', data: state.data } : { kind: 'invalid', note: state.note };
}

const SECRET_VALUE = /("[A-Za-z0-9_]*(?:key|Key|KEY|token|Token|secret|Secret|password|Password|cert|Cert)"\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}\]\s]+)/g;

/**
 * Replaces the value of any JSON key that ends in key/token/secret/password/cert. The
 * allowlisted endpoints never carry secrets; this is defence in depth for diagnostics.
 */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_VALUE, '$1"[redacted]"');
}

/** Levels `serialize` descends into; deeper values read `[…]`. */
const MAX_DEPTH = 16;

/**
 * A bounded JSON-style rendering of any value, for diagnostics. It never throws and runs no code
 * of the value's: accessors read `[getter]`, and toJSON, toString and valueOf are never called, so
 * a hostile value (a throwing getter or proxy trap, an object that cannot become a string, a
 * cycle, nesting deeper than the stack) cannot break it. Plain JSON data comes out exactly as
 * `JSON.stringify` writes it. Cycles read `[cycle]`, anything unreadable `[unreadable]`, and
 * writing stops once `budget` characters are out (the result may run a little past it).
 */
export function serialize(value: unknown, budget: number): string {
  const out: string[] = [];
  let used = 0;
  const path = new Set<object>();
  const put = (s: string): void => {
    out.push(s);
    used += s.length;
  };
  const full = (): boolean => used >= budget;

  const walk = (v: unknown, depth: number): void => {
    switch (typeof v) {
      case 'string':
        put(JSON.stringify(v.length > budget ? v.slice(0, budget) : v));
        return;
      case 'number':
        put(Number.isFinite(v) ? String(v) : 'null');
        return;
      case 'boolean':
        put(v ? 'true' : 'false');
        return;
      case 'bigint':
        put(v.toString(10));
        return;
      case 'undefined':
        put('null');
        return;
      case 'symbol':
      case 'function':
        put('null');
        return;
    }
    if (v === null) {
      put('null');
      return;
    }
    const obj = v as object;
    if (path.has(obj)) {
      put('"[cycle]"');
      return;
    }
    if (depth >= MAX_DEPTH) {
      put('"[…]"');
      return;
    }
    path.add(obj);
    try {
      if (Array.isArray(obj)) {
        const length = Number(Object.getOwnPropertyDescriptor(obj, 'length')?.value ?? 0);
        put('[');
        for (let i = 0; i < length && !full(); i++) {
          if (i > 0) put(',');
          const d = Object.getOwnPropertyDescriptor(obj, String(i));
          if (d && !('value' in d)) put('"[getter]"');
          else walk(d?.value, depth + 1);
        }
        put(']');
      } else {
        put('{');
        let first = true;
        for (const k of Object.keys(obj)) {
          if (full()) break;
          const d = Object.getOwnPropertyDescriptor(obj, k);
          if (!d) continue;
          const item = 'value' in d ? d.value : '[getter]';
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
          put(`${first ? '' : ','}${JSON.stringify(k)}:`);
          first = false;
          walk(item, depth + 1);
        }
        put('}');
      }
    } catch {
      put('"[unreadable]"');
    } finally {
      path.delete(obj);
    }
  };

  try {
    if (typeof value === 'undefined') return 'undefined';
    if (typeof value === 'function') return '[function]';
    if (typeof value === 'symbol') return '[symbol]';
    walk(value, 0);
    return out.join('');
  } catch {
    return '[unreadable]';
  }
}

/** A size-capped, secret-free excerpt for `SourceAnomaly.rawExcerpt` and diagnostics. Never throws. */
export function excerpt(value: unknown, max = MAX_EXCERPT_CHARS): string {
  // Truncate before redacting so the regex never scans a huge string.
  const text = typeof value === 'string' ? value : serialize(value, max * 2);
  const head = text.length > max * 2 ? text.slice(0, max * 2) : text;
  const clean = redactSecrets(head);
  if (clean.length <= max) return clean;
  // A long value's serialization stops early, so its length is only a lower bound.
  const length = typeof value === 'string' || text.length < max * 2 ? `${text.length}` : `${text.length}+`;
  const suffix = `…(${length} chars)`;
  return `${clean.slice(0, Math.max(0, max - suffix.length))}${suffix}`.slice(0, max);
}
