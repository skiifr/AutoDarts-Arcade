import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardRequestRefused, createBoardTransport, utf8Length, type FetchLike, type ResponseLike, type WebSocketCtor, type WebSocketLike } from './transport';

afterEach(() => {
  vi.useRealTimers();
});

const ok = (body: string, extra: Partial<ResponseLike> = {}): ResponseLike => ({
  status: 200,
  headers: { get: () => null },
  text: async () => body,
  ...extra,
});

describe('HTTP transport', () => {
  it('refuses a public address at creation', () => {
    expect(() => createBoardTransport({ host: '8.8.8.8', fetch: vi.fn<FetchLike>() })).toThrow(BoardRequestRefused);
    expect(() => createBoardTransport({ host: 'example.com', fetch: vi.fn<FetchLike>() })).toThrow(BoardRequestRefused);
  });

  it.each(['010.0.0.5', '172.016.0.1', '192.168.01.40', '0x0a.0.0.1', 'autodarts.local', 'localhost'])(
    'refuses %s before any request or socket: a URL parser would not read it as a private address',
    (host) => {
      const fetch = vi.fn<FetchLike>();
      const Ws = vi.fn();
      expect(() => createBoardTransport({ host, fetch, WebSocket: Ws as unknown as WebSocketCtor })).toThrow(BoardRequestRefused);
      expect(fetch).not.toHaveBeenCalled();
      expect(Ws).not.toHaveBeenCalled();
    },
  );

  it('builds every request URL from the canonical host', async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return ok('2.0.2');
    };
    await createBoardTransport({ host: '[FE80:0:0:0:0:0:0:1]', fetch }).get('/api/version');
    await createBoardTransport({ host: '192.168.1.40', port: 80, fetch }).get('/api/version');
    expect(urls).toEqual(['http://[fe80::1]:3180/api/version', 'http://192.168.1.40:80/api/version']);
    const sockets: string[] = [];
    class RecordingWs extends FakeWs {
      constructor(url: string) {
        super(url);
        sockets.push(url);
      }
    }
    createBoardTransport({ host: '[FD12:3456:0:0:0:0:0:1]', fetch, WebSocket: RecordingWs }).openEvents({ stateOnly: true }, { onOpen() {}, onMessage() {}, onClose() {} });
    expect(sockets).toEqual(['ws://[fd12:3456::1]:3180/api/events?type=state']);
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
