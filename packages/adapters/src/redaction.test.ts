import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_NOTE_CHARS, cleanNote, excerpt, isSecretKey, redactSecrets } from './raw';
import { RawFrameRing } from './ring-buffer';
import { makeRig } from './testing/rig';

/**
 * No input can make a diagnostics ring entry, an anomaly note or excerpt, or a connection error
 * carry a secret planted under a secret-looking key, or as a plain-text `key=value` (review
 * finding 7). Every planted secret contains MARK, which nothing else generates.
 */

const MARK = 'QZX';
const SECRET_KEYS = [
  'apiKey', 'API_KEY', 'api-key', 'api_key', 'x-api-key', 'key', 'Authorization', 'auth', 'TOKEN', 'accessToken',
  'password', 'PASSWORD', 'passwd', 'secret', 'clientSecret', 'privateKeyPem', 'private_key', 'certificate',
  'tls_cert', 'pem', 'sessionId', 'Cookie', 'credentials',
];

const keyArb = fc.constantFrom(...SECRET_KEYS);
const secretArb = fc.integer({ min: 0, max: 1e9 }).map((n) => `${MARK}${n}`);
/** A secret value of any shape. */
const valueArb = fc.tuple(secretArb, fc.nat(5)).map(([s, shape]) =>
  [s, `Bearer ${s}`, { value: s }, [s], { a: [{ b: s }], c: 1 }, `-----BEGIN PRIVATE KEY-----\n${s}\n-----END`][shape],
);
/** Plain JSON data free of the mark. */
const dataArb = fc.jsonValue().filter((v) => !JSON.stringify(v).includes(MARK));

/** A copy of `data` with `{[key]: value}` put somewhere inside it, at a depth picked by `seed`. */
function plant(data: unknown, key: string, value: unknown, seed: number): unknown {
  if (typeof data !== 'object' || data === null) return { base: data, [key]: value };
  const base: unknown = JSON.parse(JSON.stringify(data));
  let at: unknown = base;
  let s = seed;
  for (;;) {
    const kids = Array.isArray(at) ? at : Object.values(at as object);
    const objects = kids.filter((k) => typeof k === 'object' && k !== null);
    if (objects.length === 0 || s % 3 === 0) break;
    at = objects[s % objects.length];
    s = Math.floor(s / 3);
  }
  if (Array.isArray(at)) at.push({ [key]: value });
  else (at as Record<string, unknown>)[key] = value;
  return base;
}

const plantedArb = fc.tuple(dataArb, keyArb, valueArb, fc.nat()).map(([base, key, value, seed]) => plant(base, key, value, seed));
/** Free text with a `key=secret` or `key: secret` in it, the way a note or a status string might hold one. */
const textArb = fc
  .tuple(fc.string(), keyArb, fc.constantFrom('=', ': ', ' = ', ':"', '": "'), secretArb, fc.string())
  .map(([a, k, sep, s, b]) => `${a.replace(/[A-Za-z0-9_.-]$/, '')} ${k}${sep}${s}${sep.includes('"') ? '"' : ''}`.concat(b.replace(/^[A-Za-z0-9_.-]/, ' ')));

const clean = (s: string): boolean => !s.includes(MARK);

describe('redaction: no planted secret survives', () => {
  it('the key list', () => {
    for (const k of SECRET_KEYS) expect(isSecretKey(k), k).toBe(true);
    for (const k of ['segment', 'coords', 'bed', 'name', 'number', 'multiplier', 'status', 'event', 'throws', 'numThrows', 'bouncer', 'type', 'data', 'fps', 'x', 'y']) {
      expect(isSecretKey(k), k).toBe(false);
    }
  });

  it('in JSON text, whole or cut anywhere', () => {
    fc.assert(
      fc.property(plantedArb, fc.nat(), (v, cut) => {
        const text = JSON.stringify(v);
        expect(clean(redactSecrets(text))).toBe(true);
        const head = text.slice(0, cut % (text.length + 1));
        expect(clean(redactSecrets(head))).toBe(true);
        expect(clean(excerpt(text))).toBe(true);
        expect(clean(excerpt(head))).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });

  it('in values, and in the excerpts of them', () => {
    fc.assert(
      fc.property(plantedArb, (v) => {
        expect(clean(excerpt(v))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('in plain text and notes', () => {
    fc.assert(
      fc.property(textArb, (t) => {
        expect(clean(redactSecrets(t))).toBe(true);
        expect(clean(cleanNote(t))).toBe(true);
        expect(clean(excerpt(t))).toBe(true);
        expect(cleanNote(t).length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
      }),
      { numRuns: 1500 },
    );
  });

  it('in ring-buffer entries, whatever their size', () => {
    fc.assert(
      fc.property(plantedArb, fc.integer({ min: 16, max: 4096 }), (v, maxEntryChars) => {
        const ring = new RawFrameRing({ maxEntryChars });
        const text = JSON.stringify({ type: 'state', data: v });
        ring.push('t', 'WS /api/events', text);
        ring.push('t', 'GET /api/state', text.slice(0, Math.floor(text.length / 2)));
        expect(ring.snapshot().every((e) => clean(e.data))).toBe(true);
        expect(clean(ring.exportJsonl())).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('through the adapter: frames, notes, excerpts, ring entries and errors', async () => {
    const samples = fc.sample(fc.tuple(plantedArb, textArb), { numRuns: 60, seed: 7 });
    const rig = makeRig({ seed: 'redact' });
    rig.adapter.start();
    await rig.sched.advance(200);
    for (const [v, t] of samples) {
      const planted = v as Record<string, unknown>;
      // A valid state with secrets beside the board's fields, an invalid one, a frame that is
      // not JSON, an unknown status, bed and name holding plain-text secrets.
      rig.transport.inject(JSON.stringify({ type: 'state', data: { status: 'Throw', event: 'Throw detected', extra: planted } }));
      rig.transport.inject(JSON.stringify({ type: 'state', data: { status: 7, planted } }));
      rig.transport.inject(`{"type":"state","data":${JSON.stringify(planted)}`);
      rig.transport.inject(JSON.stringify({ type: 'state', data: { status: t.slice(0, 60), event: 'Throw detected' } }));
      rig.transport.inject(
        JSON.stringify({ type: 'state', data: { status: 'Throw', event: 'Throw detected', throws: [{ segment: { number: 99, multiplier: 1, bed: t, name: t, planted }, coords: planted }] } }),
      );
      await rig.sched.advance(50);
    }
    await rig.sched.advance(2000);
    const anomalies = rig.facts.flatMap((f) => (f.type === 'SourceAnomaly' ? [f.payload] : []));
    expect(anomalies.length).toBeGreaterThan(5);
    for (const a of anomalies) {
      expect(clean(a.note), a.note).toBe(true);
      expect(clean(a.rawExcerpt), a.rawExcerpt).toBe(true);
      expect(a.note.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    }
    for (const f of rig.facts) if (f.type === 'SourceConnectionChanged' && f.payload.error) expect(clean(f.payload.error)).toBe(true);
    expect(rig.adapter.ring.snapshot().every((e) => clean(e.data))).toBe(true);
    expect(clean(rig.adapter.diagnostics().rawJsonl)).toBe(true);
  });
});
