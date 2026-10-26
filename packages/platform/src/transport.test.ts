import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardRequestRefused, createBoardTransport, utf8Length, type FetchLike, type ResponseLike, type WebSocketCtor, type WebSocketLike } from './transport';

afterEach(() => {
  vi.useRealTimers();
});

/** Node's http server and TextEncoder, typed structurally: this package compiles without Node's type library. */
interface NodeHttpResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close', cb: () => void): void;
}
interface NodeHttpServer {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number };
  closeAllConnections(): void;
  close(cb: () => void): void;
}
type NodeHttp = { createServer(handler: (req: unknown, res: NodeHttpResponse) => void): NodeHttpServer };
async function nodeHttp(): Promise<NodeHttp> {
  const specifier = 'node:http';
  return (await import(/* @vite-ignore */ specifier)) as NodeHttp;
}
const { TextEncoder: Utf8Encoder } = globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } };

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

  /** A fetch whose response the test shapes; records whether the body was read and the request aborted. */
  function shaped(extra: Partial<ResponseLike>) {
    const seen = { read: false, aborted: false };
    class Abort {
      signal = { aborted: false };
      abort() {
        seen.aborted = true;
      }
    }
    const res: ResponseLike = {
      ...ok(''),
      text: async () => {
        seen.read = true;
        return '2.0.2';
      },
      ...extra,
    };
    return { seen, transport: createBoardTransport({ host: '192.168.1.40', fetch: async () => res, AbortController: Abort }) };
  }

  it.each<[string, Partial<ResponseLike>]>([
    // React Native's own fetch ignores redirect: 'error' and the native stacks follow redirects.
    ['says it was redirected, even back to the same URL', { redirected: true, url: 'http://192.168.1.40:3180/api/version' }],
    ['comes from another path', { url: 'http://192.168.1.40:3180/api/config' }],
    ['comes from another host', { url: 'http://203.0.113.9:3180/api/version' }],
    ['comes from a name', { url: 'http://evil.example:3180/api/version' }],
    ['comes from another port', { url: 'http://192.168.1.40:8080/api/version' }],
    ['comes with user info', { url: 'http://x@192.168.1.40:3180/api/version' }],
    ['is a 3xx the stack handed back', { status: 302 }],
  ])('refuses a response that %s, before reading the body, and aborts the request', async (_, extra) => {
    const { seen, transport } = shaped(extra);
    await expect(transport.get('/api/version')).rejects.toBeInstanceOf(BoardRequestRefused);
    expect(seen).toEqual({ read: false, aborted: true });
  });

  it.each([
    ['192.168.1.40', 80],
    ['192.168.1.40', 3180],
    ['[FE80:0:0:0:0:0:0:1]', 3180],
    ['[fd12:3456:0000::0001]', 80],
  ])('does not take the URL parser’s normal form of %s:%i for a redirect', async (host, port) => {
    // What a WHATWG fetch (browsers, expo/fetch, Node) reports as the response URL.
    const fetch: FetchLike = async (url) => ok('2.0.2', { url: new URL(url).href, redirected: false });
    await expect(createBoardTransport({ host, port, fetch }).get('/api/version')).resolves.toEqual({ status: 200, body: '2.0.2' });
  });

  /** A response body that arrives as byte chunks, like WHATWG and expo/fetch bodies. */
  function streamed(chunks: Uint8Array[]) {
    const seen = { reads: 0, cancelled: false, aborted: false };
    class Abort {
      signal = { aborted: false };
      abort() {
        seen.aborted = true;
      }
    }
    const res: ResponseLike = {
      ...ok(''),
      text: async () => {
        throw new Error('text() must not be used when the body streams');
      },
      body: {
        getReader: () => ({
          read: async () => {
            const value = chunks[seen.reads++];
            return value ? { done: false, value } : { done: true };
          },
          cancel: async () => {
            seen.cancelled = true;
          },
        }),
      },
    };
    return { seen, fetch: (async () => res) as FetchLike, Abort };
  }

  it('stops reading a streamed body as soon as it passes the cap', async () => {
    const { seen, fetch, Abort } = streamed(Array.from({ length: 50 }, () => new Uint8Array(1000)));
    const t = createBoardTransport({ host: '192.168.1.40', maxBodyBytes: 2500, fetch, AbortController: Abort });
    await expect(t.get('/api/state')).rejects.toThrow(/over 2500 bytes/);
    expect(seen).toEqual({ reads: 3, cancelled: true, aborted: true });
  });

  it('decodes a streamed body, a character split across chunks included', async () => {
    const bytes = new Utf8Encoder().encode('{"name":"Zoë 🎯"}');
    const { fetch, Abort } = streamed([bytes.slice(0, 11), bytes.slice(11, 15), bytes.slice(15)]);
    const t = createBoardTransport({ host: '192.168.1.40', maxBodyBytes: bytes.byteLength, fetch, AbortController: Abort });
    await expect(t.get('/api/state')).resolves.toEqual({ status: 200, body: '{"name":"Zoë 🎯"}' });
  });

  it('with a real fetch, never reads a body past the cap, even with no Content-Length', async () => {
    const http = await nodeHttp();
    let written = 0;
    let closed = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); // chunked: no Content-Length
      const chunk = ' '.repeat(16 * 1024);
      const timer = setInterval(() => {
        if (written >= 8 * 1024 * 1024) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(chunk);
        written += chunk.length;
      }, 2);
      res.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const t = createBoardTransport({ host: '127.0.0.1', port: server.address().port, maxBodyBytes: 64 * 1024, timeoutMs: 10_000 });
      await expect(t.get('/api/state')).rejects.toThrow(/over 65536 bytes/);
      const until = Date.now() + 3000;
      while (!closed && Date.now() < until) await new Promise<void>((r) => setTimeout(() => r(), 10));
      expect(closed).toBe(true);
      expect(written).toBeLessThan(1024 * 1024);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
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
