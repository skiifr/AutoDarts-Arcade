import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  BOARD_EVENTS_PATH,
  BoardModel,
  SCENARIOS,
  runScenario,
  seededRandom,
  type Scenario,
  type Scheduler,
} from '@arcade/adapters';

/**
 * A fake Autodarts board: the local API's read endpoints and event socket, driven by the
 * simulator's board model. It serves exactly what Arcade may read — GET /api/state,
 * /api/version, /api/state/stats, /api/cams/stats and WS /api/events — and answers 404
 * to everything else, including the board-control and secret-bearing routes a real board
 * has (/api/reset, /api/config, /api/system), so a request for one shows up in its log.
 */

export interface FakeBoardOptions {
  port?: number;
  host?: string;
  scenario?: string;
  seed?: string;
  version?: string;
  log?: (line: string) => void;
}

export interface FakeBoard {
  board: BoardModel;
  scenario: Scenario;
  port: number;
  /** Close every event socket (the app should reconnect and resync). */
  dropConnections(): number;
  /** Refuse or accept connections and requests, like a board that vanished from the network. */
  setOnline(online: boolean): void;
  readonly online: boolean;
  readonly clients: number;
  close(): Promise<void>;
}

const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

export async function startFakeBoard(options: FakeBoardOptions = {}): Promise<FakeBoard> {
  const log = options.log ?? (() => {});
  const scenario = SCENARIOS[options.scenario ?? 'random-play'];
  if (!scenario) throw new Error(`Unknown scenario "${options.scenario}". Try: ${Object.keys(SCENARIOS).join(', ')}`);
  const random = seededRandom(options.seed ?? 'fake-board');
  const board = new BoardModel({
    random,
    now: () => realScheduler.now(),
    version: options.version ?? '2.0.2',
    noiseFrames: true,
    ...scenario.board,
  });
  let online = true;
  const sockets = new Set<WebSocket>();

  const send = (res: ServerResponse, status: number, type: string, body: string): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://board');
    if (!online) {
      req.socket.destroy();
      return;
    }
    if (req.method !== 'GET') {
      log(`refused ${req.method} ${url.pathname} (the fake board is read-only)`);
      send(res, 405, 'text/plain', 'method not allowed');
      return;
    }
    switch (url.pathname) {
      case '/api/state':
        send(res, 200, 'application/json', board.stateJson());
        return;
      case '/api/version':
        send(res, 200, 'text/plain', board.versionText());
        return;
      case '/api/state/stats':
        send(res, 200, 'application/json', board.statsJson());
        return;
      case '/api/cams/stats':
        send(res, 200, 'application/json', board.camsStatsJson());
        return;
      default:
        log(`not served: GET ${url.pathname}`);
        send(res, 404, 'text/plain', 'not found');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://board');
    if (!online || url.pathname !== BOARD_EVENTS_PATH) {
      log(`refused socket ${url.pathname}${url.search}`);
      socket.destroy();
      return;
    }
    const stateOnly = url.searchParams.get('type') === 'state';
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      log(`app connected to ${url.pathname}${url.search} (${sockets.size} open)`);
      const off = board.onFrame((text) => {
        if (stateOnly && !text.startsWith('{"type":"state"')) return;
        if (ws.readyState === ws.OPEN) ws.send(text);
      });
      ws.on('close', () => {
        off();
        sockets.delete(ws);
        log(`app disconnected (${sockets.size} open)`);
      });
      ws.on('message', () => log('ignored a message from the app (the board socket is receive-only)'));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3180, options.host ?? '0.0.0.0', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const run = runScenario(board, scenario, realScheduler, random);

  const dropConnections = (): number => {
    const n = sockets.size;
    for (const ws of sockets) ws.terminate();
    return n;
  };

  return {
    board,
    scenario,
    port,
    dropConnections,
    setOnline(next: boolean) {
      online = next;
      if (!next) dropConnections();
    },
    get online() {
      return online;
    },
    get clients() {
      return sockets.size;
    },
    close: async () => {
      run.stop();
      dropConnections();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
