import type { BoardFactDraft } from '@arcade/event-schema';
import { connectBoard } from '@arcade/platform';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import WebSocket from 'ws';
import { startFakeBoard, type FakeBoard } from '../../fake-board/src/server';
import { startFaultProxy, type FaultProxy } from './proxy';

let fb: FakeBoard | undefined;
let proxy: FaultProxy | undefined;
let stopAdapter: (() => void) | undefined;
afterEach(async () => {
  stopAdapter?.();
  await proxy?.close();
  await fb?.close();
  proxy = undefined;
  fb = undefined;
});

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise<void>((r) => setTimeout(() => r(), 15));
  }
}

/** Sends a raw upgrade request for /api/events; resolves with the answer once the proxy closes, or at once if `abandon`. */
function rawUpgrade(port: number, headers: string, options: { abandon?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    let answer = '';
    const s = connect(port, '127.0.0.1', () => {
      s.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\n${headers}\r\n`);
      if (options.abandon) {
        s.destroy();
        resolve('');
      }
    });
    s.on('data', (d: Buffer) => {
      answer += d.toString();
    });
    s.on('close', () => resolve(answer));
    s.on('error', () => resolve(answer));
  });
}

async function setup(faults: Partial<Parameters<typeof startFaultProxy>[0]> = {}) {
  fb = await startFakeBoard({ port: 0, host: '127.0.0.1', scenario: 'idle' });
  proxy = await startFaultProxy({ target: { host: '127.0.0.1', port: fb.port }, listenPort: 0, listenHost: '127.0.0.1', ...faults });
  return { fb, proxy, base: `http://127.0.0.1:${proxy.port}` };
}

describe('fault proxy', () => {
  it('forwards the allowlisted reads and blocks everything else', async () => {
    const { base, proxy } = await setup();
    expect(await (await fetch(`${base}/api/version`)).text()).toBe('2.0.2');
    expect((await fetch(`${base}/api/state`)).status).toBe(200);
    expect((await fetch(`${base}/api/config`)).status).toBe(403);
    expect((await fetch(`${base}/api/system`)).status).toBe(403);
    expect((await fetch(`${base}/api/state`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${base}/api/reset`, { method: 'POST' })).status).toBe(403);
    const refused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events/system`);
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
    expect(proxy.stats.blocked).toBe(5);
  });

  it('20 bad upgrades leave no socket open to the board', async () => {
    const { fb, proxy } = await setup();
    const valid = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n';
    const bad = [
      // Not a WebSocket handshake at all: ws answers 400 and never hands over a socket.
      ...Array.from({ length: 8 }, () => rawUpgrade(proxy.port, 'Upgrade: websocket\r\nConnection: Upgrade\r\n')),
      ...Array.from({ length: 6 }, () => rawUpgrade(proxy.port, `${valid}Sec-WebSocket-Version: 99\r\n`)),
      // A good handshake from an app that leaves at once.
      ...Array.from({ length: 6 }, () => rawUpgrade(proxy.port, `${valid}Sec-WebSocket-Version: 13\r\n`, { abandon: true })),
    ];
    const answers = await Promise.all(bad);
    expect(answers.filter((a) => a.startsWith('HTTP/1.1 400'))).toHaveLength(14);
    await waitFor(() => fb.clients === 0, 2000);
    await new Promise<void>((r) => setTimeout(() => r(), 300));
    expect(fb.clients).toBe(0);
    // And the proxy still relays a good socket afterwards.
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await waitFor(() => fb.clients === 1);
    ws.terminate();
    await waitFor(() => fb.clients === 0);
  });

  it('close() closes the board sockets it relays', async () => {
    const { fb, proxy: p } = await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${p.port}/api/events`);
    ws.on('error', () => {});
    await waitFor(() => fb.clients === 1);
    await p.close();
    proxy = undefined;
    await waitFor(() => fb.clients === 0, 2000);
  });

  it('close() closes a board socket that is still connecting, and an upstream failure closes the app’s socket', async () => {
    // A "board" that accepts TCP, reads the handshake and never answers it.
    const held = new Set<Socket>();
    const silent = createTcpServer((s) => {
      held.add(s);
      s.resume();
      s.on('close', () => held.delete(s));
      s.on('error', () => {});
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const p = await startFaultProxy({ target: { host: '127.0.0.1', port: (silent.address() as { port: number }).port }, listenPort: 0, listenHost: '127.0.0.1' });
    proxy = p;
    const ws = new WebSocket(`ws://127.0.0.1:${p.port}/api/events`);
    ws.on('error', () => {});
    try {
      await waitFor(() => held.size === 1);
      await Promise.race([p.close(), new Promise<void>((r) => setTimeout(() => r(), 2000))]);
      proxy = undefined;
      await waitFor(() => held.size === 0, 2000);
    } finally {
      ws.terminate();
      for (const s of held) s.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }

    // The board refuses the socket: the app's socket is closed too, and nothing is left open.
    const { fb, proxy: p2 } = await setup();
    fb.setOnline(false);
    const app = new WebSocket(`ws://127.0.0.1:${p2.port}/api/events`);
    app.on('error', () => {});
    await new Promise<void>((r) => app.on('close', () => r()));
    expect(fb.clients).toBe(0);
  });

  it('duplicated frames and repeated cuts never duplicate or lose a dart', async () => {
    const { fb, proxy } = await setup({ dup: 1, cutEvery: 3, delayMs: 5 });
    const { source } = connectBoard({ host: '127.0.0.1', port: proxy.port });
    const facts: BoardFactDraft[] = [];
    source.subscribe((f) => facts.push(f));
    source.start();
    stopAdapter = () => source.stop();
    await waitFor(() => source.connectionStatus().phase === 'online');

    const thrown = ['T20', 'S5', 'D1', 'BULL', '25', 'T19'];
    for (const [i, s] of thrown.entries()) {
      fb.board.throwDart({ segment: s });
      await new Promise<void>((r) => setTimeout(() => r(), 120));
      if (i % 3 === 2) {
        fb.board.startTakeout();
        fb.board.finishTakeout();
        await new Promise<void>((r) => setTimeout(() => r(), 120));
      }
    }
    await waitFor(() => facts.filter((f) => f.type === 'TakeoutFinished').length >= 2);
    await waitFor(() => source.connectionStatus().phase === 'online');

    const detected = facts.filter((f): f is Extract<BoardFactDraft, { type: 'DartDetected' }> => f.type === 'DartDetected');
    const live = detected.filter((d) => !facts.some((f) => f.type === 'DartWithdrawn' && f.payload.throwId === d.payload.throwId));
    expect(new Set(detected.map((d) => d.payload.throwId)).size).toBe(detected.length);
    expect(live.map((d) => d.payload.segment.label)).toEqual(['T20', 'S5', 'D1', 'BULL', '25', 'T19']);
    expect(proxy.stats.duplicated).toBeGreaterThan(3);
    expect(proxy.stats.cuts).toBeGreaterThan(0);
  });
});
