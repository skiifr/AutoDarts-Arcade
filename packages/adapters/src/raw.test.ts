import { describe, expect, it } from 'vitest';
import { MAX_FRAME_CHARS, excerpt, parseEventFrame, parseStateBody, redactSecrets } from './raw';

describe('parseEventFrame', () => {
  it('reads the {type, data} envelope of a state frame', () => {
    const f = parseEventFrame('{"type":"state","data":{"connected":true,"running":true,"status":"Throw","event":"Takeout finished","numThrows":0}}');
    expect(f).toEqual({
      kind: 'state',
      data: { connected: true, running: true, status: 'Throw', event: 'Takeout finished', numThrows: 0 },
    });
  });

  it('passes other frame types through untouched', () => {
    expect(parseEventFrame('{"type":"cam_stats","data":{"id":0,"fps":29.9}}')).toEqual({ kind: 'other', type: 'cam_stats', data: { id: 0, fps: 29.9 } });
    expect(parseEventFrame('{"type":"motion_state","data":{"isHand":true}}').kind).toBe('other');
  });

  it('keeps unknown fields of the state (version drift is tolerated)', () => {
    const f = parseEventFrame('{"type":"state","data":{"status":"Throw","newField":1}}');
    expect(f.kind === 'state' && f.data.newField).toBe(1);
  });

  it.each([
    ['not JSON', 'not json', /not JSON/],
    ['no envelope type', '{"data":{}}', /envelope/],
    ['throws not a list', '{"type":"state","data":{"throws":"T20"}}', /invalid state/],
    ['too many throws', `{"type":"state","data":{"throws":${JSON.stringify(Array(17).fill({}))}}}`, /invalid state/],
    ['status not a string', '{"type":"state","data":{"status":3}}', /invalid state/],
    ['data not an object', '{"type":"state","data":[1,2]}', /invalid state/],
  ])('rejects %s', (_l, text, note) => {
    const f = parseEventFrame(text);
    expect(f.kind).toBe('invalid');
    if (f.kind === 'invalid') expect(f.note).toMatch(note);
  });

  it('drops frames over the size cap without parsing them', () => {
    const big = `{"type":"state","data":{"status":"${'x'.repeat(MAX_FRAME_CHARS)}"}}`;
    expect(parseEventFrame(big)).toEqual({ kind: 'invalid', note: expect.stringMatching(/over/) });
  });
});

describe('parseStateBody', () => {
  it('accepts a body with the throws key missing (empty board, v2)', () => {
    expect(parseStateBody('{"connected":true,"running":true,"status":"Throw","event":"Takeout finished","numThrows":0}').ok).toBe(true);
  });

  it('accepts throws: null', () => {
    const r = parseStateBody('{"status":"Throw","throws":null}');
    expect(r.ok && r.data.throws).toBeNull();
  });
});

describe('excerpt and redaction', () => {
  it('caps excerpts', () => {
    expect(excerpt('y'.repeat(10_000)).length).toBeLessThanOrEqual(512);
    expect(excerpt({ a: 1 })).toBe('{"a":1}');
  });

  it('redacts key, token, secret, password and cert values', () => {
    const text = '{"board_id":"b1","api_key":"SECRET1","apiKey":"SECRET2","tls_cert":"-----BEGIN","token":42,"x":"keep"}';
    const out = redactSecrets(text);
    expect(out).not.toMatch(/SECRET|BEGIN|42/);
    expect(out).toContain('"x":"keep"');
    expect(out).toContain('"board_id":"b1"');
  });
});
