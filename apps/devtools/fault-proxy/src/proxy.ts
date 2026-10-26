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
  /** Close every relayed socket now. */
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
  const pairs = new Set<{ client: WebSocket; upstream: WebSocket }>();
  let outage = false;

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
    if (outage || !isAllowedBoardRequest('WS', path)) {
      if (!outage) {
        stats.blocked++;
        log(`BLOCKED socket ${path} (not on the board allowlist)`);
      }
      socket.destroy();
      return;
    }
    const upstream = new WebSocket(`ws://${o.target.host}:${o.target.port}${path}`, { maxPayload: MAX_BODY });
    upstream.once('error', (e) => {
      log(`upstream socket ${path} failed: ${e.message}`);
      socket.destroy();
    });
    upstream.once('open', () => {
      wss.handleUpgrade(req, socket, head, (client) => relay(client, upstream, path));
    });
  });

  function relay(client: WebSocket, upstream: WebSocket, path: string): void {
    const pair = { client, upstream };
    pairs.add(pair);
    log(`relaying ${path}`);
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
    upstream.on('close', end);
    client.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.listenPort, o.listenHost ?? '0.0.0.0', () => resolve());
  });

  const cutAll = (): number => {
    const n = pairs.size;
    for (const p of [...pairs]) {
      p.client.terminate();
      p.upstream.terminate();
    }
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
      cutAll();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
