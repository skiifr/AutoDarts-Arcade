import { describe, expect, it } from 'vitest';
import type { BoardGetPath } from '../endpoints';
import type { EventsSocket, EventsSocketHandlers, HttpResponse, Transport } from '../ports';
import { makeRig, ofType, type Rig } from '../testing/rig';

/**
 * Reconnect robustness (a page stuck on "board unreachable" after the board came back). The
 * adapter must keep a timer or a bounded request alive in every phase, whatever the
 * transport or its listeners do: a socket that never fires anything, a stale socket's close
 * that arrives after a newer attempt started, a GET that never settles, a listener that throws.
 */

/** A transport around the rig's fake one that can hang sockets and GETs and hold close events. */
class ScriptedTransport implements Transport {
  readonly inner: Transport;
  /** The next N sockets never fire open, message, error or close. */
  hangSockets = 0;
  /** GETs never settle, whatever their timeout (a broken platform transport). */
  hangGets = false;
  /** Close events of sockets the adapter closed itself are held until `releaseCloses`. */
  holdCloses = false;
  private held: (() => void)[] = [];

  constructor(inner: Transport) {
    this.inner = inner;
  }

  get(path: BoardGetPath, options?: { timeoutMs?: number }): Promise<HttpResponse> {
    if (this.hangGets) return new Promise(() => {});
    return this.inner.get(path, options);
  }

  openEvents(options: { stateOnly: boolean }, handlers: EventsSocketHandlers): EventsSocket {
    if (this.hangSockets > 0) {
      this.hangSockets--;
      return { close: () => {} };
    }
    const wrapped: EventsSocketHandlers = {
      ...handlers,
      onClose: (info) => {
        if (this.holdCloses) this.held.push(() => handlers.onClose(info));
        else handlers.onClose(info);
      },
    };
    return this.inner.openEvents(options, wrapped);
  }

  releaseCloses(): void {
    const held = this.held;
    this.held = [];
    for (const f of held) f();
  }
}

function scriptedRig(options: Parameters<typeof makeRig>[0] = {}): { rig: Rig; net: ScriptedTransport } {
  const holder: { net?: ScriptedTransport } = {};
  const rig = makeRig({
    ...options,
    wrapTransport: (inner) => {
      holder.net = new ScriptedTransport(inner);
      return holder.net;
    },
  });
  return { rig, net: holder.net! };
}

const phase = (rig: Rig) => rig.adapter.connectionStatus().phase;

async function untilOnline(rig: Rig, withinMs: number): Promise<number> {
  const t0 = rig.sched.now();
  for (let t = 0; t <= withinMs; t += 10) {
    if (phase(rig) === 'online') return rig.sched.now() - t0;
    await rig.sched.advance(10);
  }
  return Infinity;
}

describe('reconnect: the adapter never waits on something that cannot happen', () => {
  it('keeps retrying when a connection-status listener throws (the retry timer is armed first)', async () => {
    const errors: unknown[] = [];
    const rig = makeRig({ onListenerError: (e) => errors.push(e) });
    let throwing = false;
    rig.adapter.onConnectionStatus((s) => {
      if (throwing && s.phase === 'offline') throw new Error('UI listener blew up');
    });
    rig.adapter.start();
    await rig.sched.advance(100);
    expect(phase(rig)).toBe('online');
    throwing = true;
    rig.transport.setReachable(false);
    await rig.sched.advance(5000);
    rig.transport.setReachable(true);
    expect(await untilOnline(rig, 2000)).toBeLessThanOrEqual(2000);
    expect(errors.length).toBeGreaterThan(1);
  });

  it('keeps going when a facts listener throws during the resync', async () => {
    const errors: unknown[] = [];
    const rig = makeRig({ onListenerError: (e) => errors.push(e) });
    rig.adapter.subscribe((f) => {
      if (f.type === 'DartDetected') throw new Error('subscriber blew up');
    });
    rig.board.throwDart({ segment: 'T20' });
    rig.adapter.start();
    expect(await untilOnline(rig, 500)).toBeLessThan(500);
    // The other subscriber (the rig's) still got the fact.
    expect(ofType(rig.facts, 'DartDetected')).toHaveLength(1);
    expect(errors).toHaveLength(1);
    rig.board.throwDart({ segment: 'S5' });
    await rig.sched.advance(50);
    expect(ofType(rig.facts, 'DartDetected')).toHaveLength(2);
  });

  it('abandons a socket that never opens, closes or errors, and retries', async () => {
    const { rig, net } = scriptedRig();
    net.hangSockets = 3;
    rig.adapter.start();
    // Three timed-out sockets count as refusals: the third retry waits the 5 s cap.
    expect(await untilOnline(rig, 10_000)).toBeLessThan(10_000);
    const errors = ofType(rig.facts, 'SourceConnectionChanged').flatMap((f) => (f.payload.error ? [f.payload.error] : []));
    expect(errors[0]).toMatch(/socket open timed out/);
    expect(rig.transport.requests.filter((r) => r.kind === 'WS')).toHaveLength(1); // the hung ones never reached the board
  });

  it('ignores a stale socket’s close that arrives after a newer attempt started', async () => {
    const { rig, net } = scriptedRig();
    net.hangSockets = 1;
    net.holdCloses = true;
    rig.adapter.start();
    await rig.sched.advance(1100); // the first socket timed out; the second attempt is under way
    rig.transport.cutSockets();
    expect(await untilOnline(rig, 3000)).toBeLessThan(3000);
    net.holdCloses = false;
    net.releaseCloses(); // every close the adapter caused, delivered late
    await rig.sched.advance(20_000);
    expect(phase(rig)).toBe('online');
    rig.board.throwDart({ segment: 'D16' });
    await rig.sched.advance(50);
    expect(ofType(rig.facts, 'DartDetected').map((f) => f.payload.segment.label)).toEqual(['D16']);
  });

  it('abandons a connect attempt whose GET never settles (watchdog: its timeout plus 1 s) and retries', async () => {
    const { rig, net } = scriptedRig();
    net.hangGets = true;
    rig.adapter.start();
    await rig.sched.advance(1000 + 1000 + 50);
    const offline = ofType(rig.facts, 'SourceConnectionChanged').find((f) => f.payload.state === 'offline');
    expect(offline?.payload.error).toMatch(/no answer/);
    expect(rig.sched.pendingTimers).toBeGreaterThan(0);
    net.hangGets = false;
    expect(await untilOnline(rig, 3500)).toBeLessThan(3500);
  });

  it('abandons a liveness poll that never settles, goes offline and comes back', async () => {
    const { rig, net } = scriptedRig();
    rig.adapter.start();
    await rig.sched.advance(100);
    net.hangGets = true;
    // Liveness after 5 s, its poll is abandoned after 2 + 1 s, a retry after 1 s is abandoned too.
    await rig.sched.advance(5000 + 3000 + 1000 + 3000 + 100);
    expect(ofType(rig.facts, 'SourceConnectionChanged').at(-1)?.payload.state).not.toBe('online');
    net.hangGets = false;
    expect(await untilOnline(rig, 4000)).toBeLessThan(4000);
  });

  it('a poll that fails after the connection was replaced does not touch the new attempt', async () => {
    const rig = makeRig({ latencyMs: 400 });
    rig.adapter.start();
    await rig.sched.advance(3000);
    expect(phase(rig)).toBe('online');
    await rig.sched.advance(5000); // liveness poll in flight (answer due in 800 ms)
    rig.adapter.resync(); // the app came back to the foreground
    rig.transport.setReachable(false); // the old poll now fails
    await rig.sched.advance(300);
    rig.transport.setReachable(true);
    expect(await untilOnline(rig, 6000)).toBeLessThan(6000);
    await rig.sched.advance(30_000);
    expect(phase(rig)).toBe('online');
  });
});
