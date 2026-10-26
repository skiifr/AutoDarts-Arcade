import type { BoardFactDraft } from '@arcade/event-schema';
import { connectBoard } from '@arcade/platform';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeBoard, type FakeBoard } from './server';

/** End to end over real sockets: platform transport + adapter ↔ fake board. */

let fb: FakeBoard | undefined;
let stopAdapter: (() => void) | undefined;
afterEach(async () => {
  stopAdapter?.();
  await fb?.close();
  fb = undefined;
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise<void>((r) => setTimeout(() => r(), 15));
  }
}

const darts = (facts: BoardFactDraft[]): string[] =>
  facts.flatMap((f) => (f.type === 'DartDetected' ? [`${f.payload.segment.label}${f.payload.recovered ? '*' : ''}`] : []));

describe('fake board', () => {
  it('serves only the read endpoints', async () => {
    fb = await startFakeBoard({ port: 0, host: '127.0.0.1', scenario: 'idle' });
    const base = `http://127.0.0.1:${fb.port}`;
    expect(await (await fetch(`${base}/api/version`)).text()).toBe('2.0.2');
    expect((await fetch(`${base}/api/state`)).headers.get('content-type')).toBe('application/json');
    expect((await fetch(`${base}/api/state/stats`)).status).toBe(200);
    expect((await fetch(`${base}/api/cams/stats`)).status).toBe(200);
    expect((await fetch(`${base}/api/config`)).status).toBe(404);
    expect((await fetch(`${base}/api/system`)).status).toBe(404);
    expect((await fetch(`${base}/api/reset`, { method: 'POST' })).status).toBe(405);
  });

  it('lets the browser preview read it cross-origin, and only with GET', async () => {
    fb = await startFakeBoard({ port: 0, host: '127.0.0.1', scenario: 'idle' });
    const base = `http://127.0.0.1:${fb.port}`;
    const origin = { origin: 'http://localhost:8081' };
    for (const path of ['/api/state', '/api/version', '/api/state/stats', '/api/cams/stats']) {
      const res = await fetch(`${base}${path}`, { headers: origin });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
    const preflight = await fetch(`${base}/api/state`, {
      method: 'OPTIONS',
      headers: { ...origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'accept' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET');

    // Nothing else is opened up: other paths get no CORS headers, and writes stay refused.
    const config = await fetch(`${base}/api/config`, { headers: origin });
    expect(config.status).toBe(404);
    expect(config.headers.get('access-control-allow-origin')).toBeNull();
    const reset = await fetch(`${base}/api/reset`, { method: 'POST', headers: origin });
    expect(reset.status).toBe(405);
    expect(reset.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`${base}/api/reset`, { method: 'OPTIONS', headers: origin })).status).toBe(405);
  });

  it('streams a visit to the adapter, and the adapter resyncs after a dropped connection', async () => {
    fb = await startFakeBoard({ port: 0, host: '127.0.0.1', scenario: 'idle' });
    const board = fb.board;
    const { source } = connectBoard({ host: '127.0.0.1', port: fb.port });
    const facts: BoardFactDraft[] = [];
    source.subscribe((f) => facts.push(f));
    source.start();
    stopAdapter = () => source.stop();
    await waitFor(() => source.connectionStatus().phase === 'online');
    expect(source.version).toBe('2.0.2');

    board.throwDart({ segment: 'T20' });
    board.throwDart({ segment: 'BULL' });
    board.throwDart({ segment: 'M12' });
    board.startTakeout();
    board.finishTakeout();
    await waitFor(() => facts.some((f) => f.type === 'TakeoutFinished'));
    expect(darts(facts)).toEqual(['T20', 'BULL', 'MISS']);

    fb.dropConnections();
    await waitFor(() => source.connectionStatus().phase !== 'online');
    board.throwDart({ segment: 'D16' }); // while reconnecting
    await waitFor(() => source.connectionStatus().phase === 'online', 2000);
    await waitFor(() => darts(facts).length === 4);
    expect(darts(facts).at(-1)).toBe('D16*');
  });
});
