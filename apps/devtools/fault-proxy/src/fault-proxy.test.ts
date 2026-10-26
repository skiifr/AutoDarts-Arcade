import type { BoardFactDraft } from '@arcade/event-schema';
import { connectBoard } from '@arcade/platform';
import { afterEach, describe, expect, it } from 'vitest';
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
