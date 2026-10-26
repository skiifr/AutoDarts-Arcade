import { SOURCE_ANOMALY_NOTE_MAX } from '@arcade/event-schema';
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

// ── secret redaction (defence in depth: the allowlisted endpoints never carry secrets) ──────

/**
 * A key whose value is a secret, matched anywhere in its name, in any case: token, password,
 * passwd, secret, key (apiKey, api-key, api_key, x-api-key, privateKeyPem, …), auth
 * (Authorization), cert (certificate), pem, private, credential, session, cookie.
 */
const SECRET_KEY = /token|passw(?:or)?d|secret|key|auth|cert|pem|private|credential|session|cookie/i;

export const REDACTED = '[redacted]';

export function isSecretKey(name: string): boolean {
  return SECRET_KEY.test(name);
}

/**
 * Text with every secret value replaced by `"[redacted]"`, whole: a string, a number, an object
 * or a list under a secret key. Complete JSON (up to MAX_FRAME_CHARS) is parsed and rewritten
 * from the parsed value; anything else (cut-off JSON, plain text, diagnostics notes) is scanned
 * for `"key": value` pairs, nested values matched to their closing bracket or to the end of the
 * text, and for plain-text `key: value` and `key=value`. Never throws.
 */
export function redactSecrets(text: string): string {
  try {
    const head = text.trimStart()[0];
    if ((head === '{' || head === '[') && text.length <= MAX_FRAME_CHARS) {
      const json = parseJson(text);
      if (json.ok) return redactPlainPairs(serialize(json.value, Infinity));
    }
    return redactPlainPairs(redactQuotedPairs(text));
  } catch {
    return REDACTED;
  }
}

/** Index just past the JSON string that starts at `i`, or the end of the text if it never closes. */
function stringEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === '"') return j + 1;
  }
  return text.length;
}

/** A bare value runs to , ; & } ] a line break or an unescaped quote. */
function bareEnd(text: string, i: number): number {
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === ',' || c === ';' || c === '&' || c === '}' || c === ']' || c === '\n' || c === '\r' || c === '"') return j;
  }
  return text.length;
}

/** Index just past the value that starts at `i`: a string, a bracketed value to its match, or a bare run. */
function valueEnd(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return stringEnd(text, i);
  if (c !== '{' && c !== '[') return bareEnd(text, i);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const d = text[j];
    if (d === '"') j = stringEnd(text, j) - 1;
    else if (d === '{' || d === '[') depth++;
    else if (d === '}' || d === ']') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return text.length;
}

function skipBlank(text: string, i: number): number {
  let j = i;
  while (j < text.length && /\s/.test(text[j] as string)) j++;
  return j;
}

/** `"secretKey": value` → `"secretKey": "[redacted]"`, the whole value. */
function redactQuotedPairs(text: string): string {
  let out = '';
  let from = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    const end = stringEnd(text, i);
    const colon = skipBlank(text, end);
    if (text[colon] === ':' && isSecretKey(keyText(text.slice(i, end)))) {
      const at = skipBlank(text, colon + 1);
      out += `${text.slice(from, at)}"${REDACTED}"`;
      from = i = at < text.length ? valueEnd(text, at) : at;
      continue;
    }
    i = end;
  }
  return out + text.slice(from);
}

function keyText(quoted: string): string {
  const json = parseJson(quoted.endsWith('"') && quoted.length > 1 ? quoted : `${quoted}"`);
  return json.ok && typeof json.value === 'string' ? json.value : quoted;
}

const WORD = /[A-Za-z0-9_.-]/;

/**
 * Plain-text `secretKey: value` and `secretKey=value` (in notes, error texts and JSON string
 * values) → `secretKey: [redacted]`. The value runs to , ; & } ] a line break or a quote.
 */
function redactPlainPairs(text: string): string {
  let out = '';
  let from = 0;
  let i = 0;
  while (i < text.length) {
    if (!WORD.test(text[i] as string) || (i > 0 && WORD.test(text[i - 1] as string))) {
      i++;
      continue;
    }
    let end = i;
    while (end < text.length && WORD.test(text[end] as string)) end++;
    let j = end;
    while (j < text.length && (text[j] === '"' || text[j] === "'" || text[j] === '\\' || text[j] === ' ' || text[j] === '\t')) j++;
    if ((text[j] === ':' || text[j] === '=') && isSecretKey(text.slice(i, end))) {
      let at = j + 1;
      while (at < text.length && (text[at] === ' ' || text[at] === '\t' || text[at] === '"' || text[at] === "'" || text[at] === '\\')) at++;
      out += `${text.slice(from, at)}${REDACTED}`;
      from = i = text[at] === '{' || text[at] === '[' ? valueEnd(text, at) : bareEnd(text, at);
      continue;
    }
    i = end;
  }
  return out + text.slice(from);
}

/** Levels `serialize` descends into; deeper values read `[…]`. */
const MAX_DEPTH = 16;

/**
 * A bounded JSON-style rendering of any value, for diagnostics. It never throws and runs no code
 * of the value's: accessors read `[getter]`, and toJSON, toString and valueOf are never called, so
 * a hostile value (a throwing getter or proxy trap, an object that cannot become a string, a
 * cycle, nesting deeper than the stack) cannot break it. Plain JSON data comes out exactly as
 * `JSON.stringify` writes it, except that the whole value under a secret key (`isSecretKey`)
 * reads `[redacted]`. Cycles read `[cycle]`, anything unreadable `[unreadable]`, and writing
 * stops once `budget` characters are out (the result may run a little past it).
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
          // A secret key's whole value goes, whatever it is.
          if (isSecretKey(k)) put(`"${REDACTED}"`);
          else walk(item, depth + 1);
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
  let clean: string;
  let length: string;
  if (typeof value === 'string') {
    // Redacted whole while it can be parsed; a longer text only as far as it can be shown.
    clean = redactSecrets(value.length <= MAX_FRAME_CHARS ? value : value.slice(0, max * 2));
    length = `${value.length}`;
  } else {
    const text = serialize(value, max * 2);
    clean = redactSecrets(text);
    // A long value's rendering stops early, so its length is only a lower bound.
    length = text.length < max * 2 ? `${text.length}` : `${text.length}+`;
  }
  if (clean.length <= max) return clean;
  const suffix = `…(${length} chars)`;
  return `${clean.slice(0, Math.max(0, max - suffix.length))}${suffix}`.slice(0, max);
}

/** Longest `SourceAnomaly.note` (the event schema's cap). */
export const MAX_NOTE_CHARS = SOURCE_ANOMALY_NOTE_MAX;

/** A diagnostics note (or error text) as it may be logged: secrets redacted, at most `max` characters. */
export function cleanNote(note: string, max = MAX_NOTE_CHARS): string {
  const clean = redactSecrets(note.length > max * 4 ? note.slice(0, max * 4) : note);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
