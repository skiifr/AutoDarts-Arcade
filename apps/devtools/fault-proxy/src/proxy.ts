import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { isAllowedBoardRequest, seededRandom } from '@arcade/adapters';

/**
 * An HTTP + WebSocket proxy between the app and a board (real or fake) that forwards only
 * the allowlisted read endpoints (GET /api/state, /api/version, /api/state/stats,
 * /api/cams/stats; WS /api/events[?type=state]) and injects faults into the board's
 * frames: drop, duplicate, delay, reorder, and cut the socket every N frames. Everything
 * else is answered 403 and logged, so the proxy also shows whether a client ever asks
 * for a forbidden route.
 *
 * A socket to the board is opened only after the app's WebSocket handshake has completed,
 * and every one is tracked: it is closed when either side fails or closes, and by
 * `cutAll()` and `close()`, whether it is relaying or still connecting.
 */

export interface FaultProxyOptions {
  target: { host: string; port: number };
  listenPort: number;
  listenHost?: string;
  /** Probability a board frame is dropped. */
  drop?: number;
  /** Probability a board frame is sent twice. */
  dup?: number;
  /** Added latency per frame in ms (frames stay in order). */
  delayMs?: number;
  /** Extra random latency 0..jitter ms per frame (frames stay in order). */
  jitterMs?: number;
  /** Probability a frame is held back past later ones. */
  reorder?: number;
  /** Close the app's socket after this many relayed frames. */
  cutEvery?: number;
  seed?: string;
  log?: (line: string) => void;
}

export interface FaultProxyStats {
  framesIn: number;
  framesOut: number;
  dropped: number;
  duplicated: number;
  reordered: number;
  cuts: number;
  httpForwarded: number;
  blocked: number;
}

export interface FaultProxy {
  port: number;
  stats: FaultProxyStats;
  /** Close every app socket and its board socket now, relaying or still connecting. Returns how many pairs. */
  cutAll(): number;
  /** While on, refuse all requests and sockets, like a board that left the network. */
  setOutage(on: boolean): void;
  readonly outage: boolean;
  close(): Promise<void>;
}

const MAX_BODY = 256 * 1024;

export async function startFaultProxy(o: FaultProxyOptions): Promise<FaultProxy> {
  const log = o.log ?? (() => {});
  const random = seededRandom(o.seed ?? 'fault-proxy');
  const stats: FaultProxyStats = { framesIn: 0, framesOut: 0, dropped: 0, duplicated: 0, reordered: 0, cuts: 0, httpForwarded: 0, blocked: 0 };
  /** Every app socket with its board socket, from the moment the board socket is opened (connecting or relaying). */
  const pairs = new Set<{ client: WebSocket; upstream: WebSocket; end(): void }>();
  let outage = false;
  let closing = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/';
    if (outage) {
      req.socket.destroy();
      return;
    }
    if (req.method !== 'GET' || !isAllowedBoardRequest('GET', path)) {
      stats.blocked++;
      log(`BLOCKED ${req.method} ${path} (not on the board allowlist)`);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked by fault-proxy: not on the board allowlist');
      return;
    }
    const up = httpRequest(
      { host: o.target.host, port: o.target.port, path, method: 'GET', headers: { accept: req.headers.accept ?? '*/*' }, timeout: 5000 },
      (upRes) => {
        const chunks: Buffer[] = [];
        let size = 0;
        upRes.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) {
            upRes.destroy();
            res.writeHead(502).end('upstream body too large');
            return;
          }
          chunks.push(c);
        });
        upRes.on('end', () => {
          if (res.headersSent) return;
          stats.httpForwarded++;
          res.writeHead(upRes.statusCode ?? 502, { 'content-type': upRes.headers['content-type'] ?? 'application/octet-stream' });
          res.end(Buffer.concat(chunks));
        });
      },
    );
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', (e) => {
      log(`upstream GET ${path} failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(502).end('upstream unreachable');
    });
    up.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = req.url ?? '/';
    if (closing || outage || !isAllowedBoardRequest('WS', path)) {
      if (!closing && !outage) {
        stats.blocked++;
        log(`BLOCKED socket ${path} (not on the board allowlist)`);
      }
      socket.destroy();
      return;
    }
    socket.on('error', () => socket.destroy());
    // The app's handshake first: ws answers a bad one with 400 (or drops a socket that is
    // already gone) and never calls back, so nothing is opened to the board for it.
    wss.handleUpgrade(req, socket, head, (client) => {
      if (closing || outage) {
        client.terminate();
        return;
      }
      relay(client, path);
    });
  });

  /** Opens the board socket for an app socket that completed its handshake, and relays between them. */
  function relay(client: WebSocket, path: string): void {
    const upstream = new WebSocket(`ws://${o.target.host}:${o.target.port}${path}`, { maxPayload: MAX_BODY });
    let lastAt = 0;
    let relayed = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const end = (): void => {
      if (!pairs.delete(pair)) return;
      for (const t of timers) clearTimeout(t);
      client.terminate();
      upstream.terminate();
      log(`closed ${path}`);
    };
    const pair = { client, upstream, end };
    pairs.add(pair);
    upstream.once('open', () => log(`relaying ${path}`));
    upstream.on('error', (e) => {
      log(`upstream socket ${path} failed: ${e.message}`);
      end();
    });
    const deliver = (text: string, at: number): void => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (client.readyState !== client.OPEN) return;
        client.send(text);
        stats.framesOut++;
        relayed++;
        if (o.cutEvery && relayed % o.cutEvery === 0) {
          stats.cuts++;
          log(`cut after ${relayed} frames`);
          end();
        }
      }, Math.max(0, at - Date.now()));
      timers.add(t);
    };
    upstream.on('message', (data, isBinary) => {
      stats.framesIn++;
      if (isBinary) return;
      const text = data.toString();
      if (o.drop && random() < o.drop) {
        stats.dropped++;
        return;
      }
      const copies = o.dup && random() < o.dup ? 2 : 1;
      if (copies === 2) stats.duplicated++;
      for (let i = 0; i < copies; i++) {
        let at = Date.now() + (o.delayMs ?? 0) + (o.jitterMs ? random() * o.jitterMs : 0);
        if (o.reorder && random() < o.reorder) {
          stats.reordered++;
          at += 50 + random() * 400;
        } else {
          at = Math.max(at, lastAt);
          lastAt = at;
        }
        deliver(text, at);
      }
    });
    client.on('message', () => log('dropped a message from the app (the board socket is receive-only)'));
    // Either side ending, before or after the board socket opened, ends both.
    upstream.on('close', end);
    client.on('close', end);
    client.on('error', end);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.listenPort, o.listenHost ?? '0.0.0.0', () => resolve());
  });

  /** Ends every pair, relaying or still connecting to the board. */
  const cutAll = (): number => {
    const n = pairs.size;
    for (const p of [...pairs]) p.end();
    stats.cuts += n;
    return n;
  };

  return {
    port: (server.address() as AddressInfo).port,
    stats,
    cutAll,
    setOutage(on: boolean) {
      outage = on;
      if (on) cutAll();
    },
    get outage() {
      return outage;
    },
    close: async () => {
      closing = true;
      for (const p of [...pairs]) p.end();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
