import { ULID_PATTERN } from '@arcade/event-schema';
import type { Transport } from '@arcade/adapters';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardAddress } from './address';
import { BoardDiscovery, LastKnownAddress, checkManualAddress, probeSubnet, type KeyValueStorage } from './discovery';
import { connectBoard } from './board';
import { systemClock, systemIds, systemScheduler } from './runtime';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
    removeItem: async (k) => {
      delete data[k];
    },
  };
}

/** Boards answer at these hosts; every request is recorded with the number in flight. */
function fakeNetwork(boards: Record<string, string>) {
  let inFlight = 0;
  let maxInFlight = 0;
  const asked: string[] = [];
  const factory = (a: BoardAddress): Transport => ({
    get: async (path) => {
      asked.push(`${a.host}:${a.port}${path}`);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => setTimeout(() => r(), 1));
      inFlight--;
      const version = boards[a.host];
      if (version === undefined) throw new Error('timeout');
      return { status: 200, body: version };
    },
    openEvents: () => {
      throw new Error('not used');
    },
  });
  return { factory, asked, max: () => maxInFlight };
}

describe('last-known address', () => {
  it('stores and returns a validated address', async () => {
    const storage = memoryStorage();
    const lk = new LastKnownAddress(storage);
    expect(await lk.get()).toBeNull();
    await lk.set({ host: '192.168.1.40', port: 3180 });
    expect(await lk.get()).toEqual({ host: '192.168.1.40', port: 3180 });
    await lk.clear();
    expect(await lk.get()).toBeNull();
  });

  it('ignores a stored value that is not a private address', async () => {
    const lk = new LastKnownAddress(memoryStorage({ 'arcade.board.lastKnownAddress': '8.8.8.8' }));
    expect(await lk.get()).toBeNull();
    await expect(lk.set({ host: 'example.com', port: 3180 })).rejects.toThrow();
    await expect(lk.set({ host: '010.0.0.5', port: 3180 })).rejects.toThrow();
  });

  it.each(['010.0.0.5', '172.016.0.1:3181', 'autodarts.local', 'localhost:3180', '8.8.8.8', 'garbage'])(
    'discards a saved %j that fails the check, on load',
    async (saved) => {
      const storage = memoryStorage({ 'arcade.board.lastKnownAddress': saved });
      expect(await new LastKnownAddress(storage).get()).toBeNull();
      expect(storage.data).toEqual({});
    },
  );

  it('keeps a saved address that passes, in canonical form', async () => {
    const storage = memoryStorage({ 'arcade.board.lastKnownAddress': '[FE80:0:0:0:0:0:0:1]:3181' });
    expect(await new LastKnownAddress(storage).get()).toEqual({ host: '[fe80::1]', port: 3181 });
  });

  it('a storage that fails to remove still gives null', async () => {
    const storage: KeyValueStorage = {
      getItem: async () => 'autodarts.local',
      setItem: async () => {},
      removeItem: async () => {
        throw new Error('read-only');
      },
    };
    expect(await new LastKnownAddress(storage).get()).toBeNull();
  });

  it('BoardDiscovery offers the last-known board when it answers', async () => {
    const net = fakeNetwork({ '192.168.1.40': '2.0.2' });
    const lk = new LastKnownAddress(memoryStorage({ 'arcade.board.lastKnownAddress': '192.168.1.40' }));
    const found = await new BoardDiscovery({ lastKnown: lk, transportFactory: net.factory }).discover();
    expect(found).toEqual([{ address: { host: '192.168.1.40', port: 3180 }, version: '2.0.2', source: 'last-known' }]);
  });
});

describe('manual address', () => {
  it('validates the text and asks GET /api/version', async () => {
    const net = fakeNetwork({ '192.168.1.40': '2.0.2' });
    expect(await checkManualAddress('192.168.1.40', { transportFactory: net.factory })).toEqual({
      ok: true,
      candidate: { address: { host: '192.168.1.40', port: 3180 }, version: '2.0.2', source: 'manual' },
    });
    expect(net.asked).toEqual(['192.168.1.40:3180/api/version']);
    expect(await checkManualAddress('192.168.1.41', { transportFactory: net.factory })).toEqual({ ok: false, reason: 'No board answered at 192.168.1.41.' });
    expect((await checkManualAddress('8.8.8.8', { transportFactory: net.factory })).ok).toBe(false);
    expect(net.asked).toHaveLength(2);
  });

  it('does not take an arbitrary web server for a board', async () => {
    const net = fakeNetwork({ '192.168.1.9': '<html>router</html>' });
    expect((await checkManualAddress('192.168.1.9', { transportFactory: net.factory })).ok).toBe(false);
  });
});

describe('subnet probe (opt-in)', () => {
  it('asks every host of the /24 once, at most N at a time, and finds the board', async () => {
    const net = fakeNetwork({ '192.168.1.40': '2.0.2', '192.168.1.77': '2.1.0-beta.5' });
    const found: string[] = [];
    const result = await probeSubnet({ near: '192.168.1.23', concurrency: 8, transportFactory: net.factory, onFound: (c) => found.push(c.address.host) });
    expect(result.map((c) => [c.address.host, c.version])).toEqual([
      ['192.168.1.40', '2.0.2'],
      ['192.168.1.77', '2.1.0-beta.5'],
    ]);
    expect(found.sort()).toEqual(['192.168.1.40', '192.168.1.77']);
    expect(net.asked).toHaveLength(254);
    expect(new Set(net.asked).size).toBe(254);
    expect(net.asked.every((u) => u.endsWith(':3180/api/version'))).toBe(true);
    expect(net.max()).toBeLessThanOrEqual(8);
  });

  it('stops when cancelled and refuses public networks', async () => {
    const net = fakeNetwork({});
    const signal = { aborted: false };
    const p = probeSubnet({ near: '10.0.0.5', concurrency: 4, transportFactory: net.factory, signal });
    signal.aborted = true;
    await p;
    expect(net.asked.length).toBeLessThan(10);
    await expect(probeSubnet({ near: '8.8.8.8' })).rejects.toThrow(/not a private/);
  });
});

describe('runtime', () => {
  it('systemScheduler drives real (or fake) timers', async () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    systemScheduler.setTimeout(() => fired.push(1), 100);
    const h = systemScheduler.setTimeout(() => fired.push(2), 100);
    systemScheduler.clearTimeout(h);
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toEqual([1]);
  });

  it('systemIds are ordered ULIDs and systemClock is ISO', () => {
    const a = systemIds();
    const b = systemIds();
    expect(ULID_PATTERN.test(a)).toBe(true);
    expect(b > a).toBe(true);
    expect(systemClock()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('connectBoard wires the adapter and sampler to one private-address transport', () => {
    const c = connectBoard({ host: '192.168.1.40', port: 3180 });
    expect(c.source.kind).toBe('autodarts-local');
    expect(c.health.isRunning).toBe(false);
    expect(() => connectBoard({ host: '1.1.1.1', port: 3180 })).toThrow();
  });

  it("connectBoard hands onListenerError to both the adapter's and the sampler's listeners", async () => {
    vi.stubGlobal('fetch', async () => ({ status: 200, headers: { get: () => null }, text: async () => '{"fps": 12}' }));
    const errors: string[] = [];
    const c = connectBoard({ host: '192.168.1.40', port: 3180 }, { onListenerError: (e) => errors.push((e as Error).message) });
    let heard = 0;
    c.source.onConnectionStatus(() => {
      throw new Error('status listener');
    });
    c.source.onConnectionStatus(() => heard++);
    c.health.onSample(() => {
      throw new Error('sample listener');
    });
    c.source.stop();
    const sample = await c.health.sample();
    expect(sample.fps).toBe(12);
    expect(errors).toEqual(['status listener', 'sample listener']);
    expect(heard).toBe(1);
  });
});
