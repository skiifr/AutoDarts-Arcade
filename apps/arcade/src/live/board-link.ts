import type { BoardHealthSample } from '@arcade/adapters';
import { connectBoard, type BoardAddress, type BoardConnection } from '@arcade/platform';
import { EMPTY_TICKER, IDLE_CONNECTION, tickerReduce, trackConnection, type ConnectionView, type TickerState } from '@arcade/ui-kit';
import { useSyncExternalStore } from 'react';

/**
 * The live board link (Phase 2): one `connectBoard` connection at a time, opened by W0
 * and shown raw by the dart ticker. Read-only by construction: the platform transport
 * allows only the four GET endpoints and the events socket (owner decision S).
 */
export interface LinkState {
  address: BoardAddress | null;
  connection: ConnectionView;
  /** From `GET /api/version`. */
  version: string | null;
  /** The latest health sample, and the latest one that had readings. */
  health: BoardHealthSample | null;
  lastReading: BoardHealthSample | null;
  ticker: TickerState;
}

const IDLE: LinkState = {
  address: null,
  connection: IDLE_CONNECTION,
  version: null,
  health: null,
  lastReading: null,
  ticker: EMPTY_TICKER,
};

let state: LinkState = IDLE;
let link: { conn: BoardConnection; off: (() => void)[] } | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<LinkState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getState = (): LinkState => state;

function close(): void {
  if (!link) return;
  const { conn, off } = link;
  link = null;
  off.forEach((f) => f());
  conn.health.stop();
  conn.source.stop();
  set(IDLE);
}

/**
 * A screen's listener threw while the board link was telling it something. The adapter keeps
 * running either way; its default would report the error as uncaught, which can be fatal in a
 * React Native release build, so the link logs it instead.
 */
function listenerErrorLogger(address: BoardAddress): (err: unknown) => void {
  return (err) => console.warn(`[board-link] a listener of the board at ${address.host}:${address.port} threw; the link keeps running`, err);
}

function open(address: BoardAddress): void {
  close();
  const conn = connectBoard(address, { onListenerError: listenerErrorLogger(address) });
  const off = [
    conn.source.subscribe((fact) => set({ ticker: tickerReduce(state.ticker, fact) })),
    conn.source.onConnectionStatus((status) => {
      const wasOnline = state.connection.phase === 'online';
      set({ connection: trackConnection(state.connection, status), version: status.upstreamVersion ?? state.version });
      // A first reading straight away (and after each reconnect), then every 30 s.
      if (status.phase === 'online' && !wasOnline) void conn.health.sample();
    }),
    conn.health.onSample((sample) =>
      set({ health: sample, lastReading: sample.fps !== undefined || sample.camFps !== undefined ? sample : state.lastReading }),
    ),
  ];
  link = { conn, off };
  set({ ...IDLE, address });
  conn.source.start();
  conn.health.start();
}

/** Resolves `online` the first time the current link is online, or `closed` if it is closed or replaced first. */
function whenOnline(): Promise<'online' | 'closed'> {
  const mine = link;
  return new Promise((resolve) => {
    const check = (): void => {
      if (!mine || link !== mine) {
        unsubscribe();
        resolve('closed');
      } else if (state.connection.phase === 'online') {
        unsubscribe();
        resolve('online');
      }
    };
    const unsubscribe = subscribe(check);
    check();
  });
}

export const boardLink = {
  getState,
  subscribe,
  open,
  close,
  whenOnline,
  /** Re-attach now, e.g. back in the foreground (iOS drops sockets while suspended, §6.4). */
  resync: (): void => link?.conn.source.resync(),
  get isOpen(): boolean {
    return link !== null;
  },
};

export function useBoardLink(): LinkState {
  return useSyncExternalStore(subscribe, getState, getState);
}
