import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBoardAddress, isPrivateHost, parseBoardAddress } from './address';
import { BoardRequestRefused, createBoardTransport, utf8Length, type FetchLike, type ResponseLike, type WebSocketLike } from './transport';

afterEach(() => {
  vi.useRealTimers();
});

const ok = (body: string, extra: Partial<ResponseLike> = {}): ResponseLike => ({
  status: 200,
  headers: { get: () => null },
  text: async () => body,
  ...extra,
});

describe('board addresses', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.7', true],
    ['172.16.0.1', true],
    ['172.31.255.254', true],
    ['192.168.1.40', true],
    ['169.254.10.20', true],
    ['autodarts.local', true],
    ['my-board.local', true],
    ['localhost', true],
    ['[::1]', true],
    ['[fe80::1]', true],
    ['[fd12:3456::1]', true],
    ['172.32.0.1', false],
    ['172.15.0.1', false],
    ['8.8.8.8', false],
    ['192.169.0.1', false],
    ['100.64.0.1', false],
    ['example.com', false],
    ['autodarts.local.evil.com', false],
    ['[2001:db8::1]', false],
    ['999.168.1.1', false],
  ])('%s private: %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it('parses what people type', () => {
    expect(parseBoardAddress(' 192.168.1.40 ')).toEqual({ ok: true, address: { host: '192.168.1.40', port: 3180 } });
    expect(parseBoardAddress('192.168.1.40:3181')).toEqual({ ok: true, address: { host: '192.168.1.40', port: 3181 } });
    expect(parseBoardAddress('Autodarts.LOCAL')).toEqual({ ok: true, address: { host: 'autodarts.local', port: 3180 } });
    expect(parseBoardAddress('[FE80::1]:3180')).toEqual({ ok: true, address: { host: '[fe80::1]', port: 3180 } });
    expect(formatBoardAddress({ host: '192.168.1.40', port: 3180 })).toBe('192.168.1.40');
    expect(formatBoardAddress({ host: '192.168.1.40', port: 81 })).toBe('192.168.1.40:81');
  });

  it.each(['', 'http://192.168.1.40', '192.168.1.40/api/config', '8.8.8.8', 'board.example.com', '192.168.1.40:0', '192.168.1.40:abc', 'fe80::1'])(
    'refuses %j',
    (input) => {
      expect(parseBoardAddress(input).ok).toBe(false);
    },
  );
});

describe('HTTP transport', () => {
  it('refuses a public address at creation', () => {
    expect(() => createBoardTransport({ host: '8.8.8.8', fetch: vi.fn<FetchLike>() })).toThrow(BoardRequestRefused);
    expect(() => createBoardTransport({ host: 'example.com', fetch: vi.fn<FetchLike>() })).toThrow(BoardRequestRefused);
  });

  it('returns status and body', async () => {
    const t = createBoardTransport({ host: '192.168.1.40', fetch: async () => ok('{"status":"Throw"}', { status: 200 }) });
    await expect(t.get('/api/state')).resolves.toEqual({ status: 200, body: '{"status":"Throw"}' });
  });

  it('times out and aborts a request that hangs', async () => {
    vi.useFakeTimers();
    let aborted = false;
    class Abort {
      signal = { aborted: false };
      abort() {
        aborted = true;
      }
    }
    const t = createBoardTransport({ host: '192.168.1.40', fetch: () => new Promise(() => {}), AbortController: Abort });
    const p = t.get('/api/state', { timeoutMs: 700 });
    const check = expect(p).rejects.toThrow(/timeout after 700 ms/);
    await vi.advanceTimersByTimeAsync(700);
    await check;
    expect(aborted).toBe(true);
  });

  it('refuses a redirect', async () => {
    const t = createBoardTransport({ host: '192.168.1.40', fetch: async () => ok('{}', { url: 'http://192.168.1.40:3180/api/config' }) });
    await expect(t.get('/api/state')).rejects.toBeInstanceOf(BoardRequestRefused);
  });

  it('caps the body by Content-Length and by actual size', async () => {
    const big = createBoardTransport({ host: '192.168.1.40', maxBodyBytes: 100, fetch: async () => ok('x', { headers: { get: () => '5000' } }) });
    await expect(big.get('/api/state')).rejects.toThrow(/over 100 bytes/);
    const sneaky = createBoardTransport({ host: '192.168.1.40', maxBodyBytes: 100, fetch: async () => ok('é'.repeat(60)) });
    await expect(sneaky.get('/api/state')).rejects.toThrow(/over 100 bytes/);
  });

  it('counts UTF-8 bytes', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('🎯')).toBe(4);
  });
});

class FakeWs implements WebSocketLike {
  static last: FakeWs | undefined;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onclose: WebSocketLike['onclose'] = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.last = this;
  }
  close(): void {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
}

describe('WebSocket transport', () => {
  function open(stateOnly: boolean, maxFrameBytes?: number) {
    const events: string[] = [];
    const t = createBoardTransport({ host: '192.168.1.40', WebSocket: FakeWs, fetch: vi.fn<FetchLike>(), maxFrameBytes });
    const sock = t.openEvents(
      { stateOnly },
      {
        onOpen: () => events.push('open'),
        onMessage: (m) => events.push(`msg ${m}`),
        onRejectedFrame: (r) => events.push(`rejected ${r.reason} ${r.size}`),
        onClose: (c) => events.push(`close ${c.code ?? ''} ${c.error ?? ''}`.trim()),
      },
    );
    return { events, sock, ws: FakeWs.last as FakeWs };
  }

  it('opens /api/events?type=state or the bare path', () => {
    expect(open(true).ws.url).toBe('ws://192.168.1.40:3180/api/events?type=state');
    expect(open(false).ws.url).toBe('ws://192.168.1.40:3180/api/events');
  });

  it('delivers text frames and rejects binary and oversized ones', () => {
    const { events, ws } = open(true, 64);
    ws.onopen?.({});
    ws.onmessage?.({ data: '{"type":"state","data":{}}' });
    ws.onmessage?.({ data: new ArrayBuffer(8) });
    ws.onmessage?.({ data: 'x'.repeat(65) });
    expect(events).toEqual(['open', 'msg {"type":"state","data":{}}', 'rejected binary 8', 'rejected oversize 65']);
  });

  it('reports close exactly once, with the error that preceded it', () => {
    const { events, ws, sock } = open(true);
    ws.onerror?.({ message: 'ECONNREFUSED' });
    ws.onclose?.({ code: 1006 });
    ws.onclose?.({ code: 1006 });
    sock.close();
    expect(events).toEqual(['close 1006 ECONNREFUSED']);
  });

  it('close() closes the socket', () => {
    const { ws, sock, events } = open(false);
    sock.close();
    expect(ws.closed).toBe(true);
    expect(events).toEqual(['close 1000']);
  });
});
