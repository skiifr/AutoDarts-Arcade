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

/** A size-capped, secret-free excerpt for `SourceAnomaly.rawExcerpt` and diagnostics. */
export function excerpt(value: unknown, max = MAX_EXCERPT_CHARS): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  // Truncate before redacting so the regex never scans a huge string.
  const head = text.length > max * 2 ? text.slice(0, max * 2) : text;
  const clean = redactSecrets(head);
  return clean.length > max ? `${clean.slice(0, max - 16)}…(${text.length} chars)` : clean;
}
