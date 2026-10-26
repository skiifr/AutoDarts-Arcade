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

  it.each([
    ['TOKEN', '{"TOKEN":"T-1"}'],
    ['PASSWORD', '{"PASSWORD":"P-1"}'],
    ['passwd', '{"passwd":"P-1"}'],
    ['SECRET', '{"SECRET":"S-1"}'],
    ['api-key', '{"api-key":"AK-1"}'],
    ['x-api-key', '{"x-api-key":"AK-1"}'],
    ['Authorization', '{"Authorization":"Bearer AK-1"}'],
    ['auth', '{"auth":{"user":"u","pass":"AK-1"}}'],
    ['privateKeyPem', '{"privateKeyPem":"-----BEGIN AK-1"}'],
    ['certificate', '{"certificate":"AK-1"}'],
    ['credential', '{"credentials":["AK-1"]}'],
    ['session', '{"sessionId":"AK-1"}'],
    ['cookie', '{"Cookie":"sid=AK-1"}'],
    ['apiKey, an object value', '{"apiKey":{"value":"AK-123"}}'],
    ['apiKey, a list value', '{"apiKey":["AK 123"]}'],
    ['apiKey, nested and with a comma', '{"cfg":{"apiKey":{"id":1,"value":"AK-123"},"keep":1}}'],
    ['a bare value with a space', '{"token":Bearer AK-123}'],
    ['cut off mid-value', '{"apiKey":{"value":"AK-123'],
    ['in plain text', 'Authorization: Bearer AK-123; apiKey=AK-123 & x'],
    ['in a quoted plain-text value', 'status "token: \\"AK-123\\""'],
  ])('redacts the whole value: %s', (_label, text) => {
    const out = redactSecrets(text);
    expect(out).not.toMatch(/AK|T-1|P-1|S-1|BEGIN/);
    expect(out).toContain('[redacted]');
  });

  it('keeps everything else, and the board’s fields untouched', () => {
    const frame = '{"type":"state","data":{"status":"Throw","event":"Throw detected","numThrows":1,"throws":[{"bouncer":false,"coords":{"x":0.1,"y":0.2},"segment":{"bed":"Single","multiplier":1,"name":"S5","number":5}}]}}';
    expect(redactSecrets(frame)).toBe(frame);
    expect(excerpt(JSON.parse(frame))).toBe(frame);
  });

  it('excerpts of values redact by key, whatever the value', () => {
    const out = excerpt({ board: { apiKey: { value: 'AK-1', list: ['AK-2'] }, Authorization: 'Bearer AK-3' }, keep: 'k' });
    expect(out).not.toMatch(/AK/);
    expect(out).toContain('"keep":"k"');
  });
});
