import {
  BOARD_EVENTS_PATH,
  BOARD_EVENTS_QUERY,
  BOARD_PORT,
  isAllowedBoardRequest,
  type BoardGetPath,
  type EventsSocket,
  type EventsSocketHandlers,
  type HttpResponse,
  type Transport,
} from '@arcade/adapters';
import { canonicalIpHost, isPrivateHost } from './address';

/**
 * `Transport` over the global `fetch` and `WebSocket`, which React Native and Node 22 both
 * provide. It is the one place the app touches the board, and it enforces:
 * - the endpoint allowlist (owner decision S: GET /api/state, /api/version,
 *   /api/state/stats, /api/cams/stats and WS /api/events[?type=state]; nothing else,
 *   no other method), checked again at runtime even though the types already forbid it;
 * - a private board address: a canonical IP literal on the home network (`address.ts`).
 *   Every URL is built from the canonical host, which is checked again before each request
 *   and each socket, so what is checked is what a URL parser will reach;
 * - request timeouts, no redirects, and size caps on bodies and frames.
 */

/** Minimal structural types, so this compiles without DOM or Node type libraries. */
export interface ResponseLike {
  status: number;
  url?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export interface AbortSignalLike {
  readonly aborted: boolean;
}
export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}
export type FetchLike = (
  url: string,
  init: { method: 'GET'; signal?: AbortSignalLike; redirect?: 'error'; headers?: Record<string, string> },
) => Promise<ResponseLike>;

export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface BoardTransportOptions {
  host: string;
  port?: number;
  /** Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Defaults to `globalThis.WebSocket`. */
  WebSocket?: WebSocketCtor;
  /** Defaults to `globalThis.AbortController` when present. */
  AbortController?: new () => AbortControllerLike;
  /** Default request timeout; a call's own `timeoutMs` wins. */
  timeoutMs?: number;
  /** Largest accepted response body in bytes (default 256 KiB). */
  maxBodyBytes?: number;
  /** Largest accepted WebSocket frame in bytes (default 256 KiB). */
  maxFrameBytes?: number;
}

export const DEFAULT_MAX_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 1500;

export class BoardRequestRefused extends Error {
  override name = 'BoardRequestRefused';
}

/** UTF-8 length of a string without TextEncoder (not on every Hermes build). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Asserts a request is on the allowlist; throws `BoardRequestRefused` otherwise. */
export function assertAllowed(kind: 'GET' | 'WS', pathWithQuery: string): void {
  if (!isAllowedBoardRequest(kind, pathWithQuery)) {
    throw new BoardRequestRefused(`${kind} ${pathWithQuery} is not on the board allowlist`);
  }
}

interface Globals {
  fetch?: FetchLike;
  WebSocket?: WebSocketCtor;
  AbortController?: new () => AbortControllerLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export function createBoardTransport(options: BoardTransportOptions): Transport {
  const g = globalThis as unknown as Globals;
  const port = options.port ?? BOARD_PORT;
  const host = canonicalIpHost(options.host);
  if (host === null || !isPrivateHost(host)) {
    throw new BoardRequestRefused(`${options.host} is not a private board address`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BoardRequestRefused(`invalid port ${port}`);
  const doFetch = options.fetch ?? g.fetch;
  const Ws = options.WebSocket ?? g.WebSocket;
  const Abort = options.AbortController ?? g.AbortController;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BYTES;
  const maxFrame = options.maxFrameBytes ?? DEFAULT_MAX_BYTES;

  /** The URL of an allowlisted path, from the canonical host, checked again here before every request and socket. */
  const boardUrl = (scheme: 'http' | 'ws', pathWithQuery: string): string => {
    if (!isPrivateHost(host)) throw new BoardRequestRefused(`${host} is not a private board address`);
    return `${scheme}://${host}:${port}${pathWithQuery}`;
  };

  async function get(path: BoardGetPath, call?: { timeoutMs?: number }): Promise<HttpResponse> {
    assertAllowed('GET', path);
    if (!doFetch) throw new Error('fetch is not available');
    const url = boardUrl('http', path);
    const timeoutMs = call?.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = Abort ? new Abort() : undefined;
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = g.setTimeout(() => {
        controller?.abort();
        reject(new Error(`timeout after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      const work = (async () => {
        const init: Parameters<FetchLike>[1] = { method: 'GET', redirect: 'error', headers: { accept: 'application/json, text/plain' } };
        if (controller) init.signal = controller.signal;
        const res = await doFetch(url, init);
        // A redirect could lead off the allowlist; refuse it (React Native follows them).
        if (res.url && res.url.toLowerCase().replace(/\/$/, '') !== url.toLowerCase()) {
          throw new BoardRequestRefused(`redirected from ${path}`);
        }
        const declared = Number(res.headers.get('content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > maxBody) throw new Error(`response over ${maxBody} bytes`);
        const body = await res.text();
        if (utf8Length(body) > maxBody) throw new Error(`response over ${maxBody} bytes`);
        return { status: res.status, body };
      })();
      return await Promise.race([work, timeout]);
    } finally {
      g.clearTimeout(timer);
    }
  }

  function openEvents(opts: { stateOnly: boolean }, handlers: EventsSocketHandlers): EventsSocket {
    const path = opts.stateOnly ? `${BOARD_EVENTS_PATH}?${BOARD_EVENTS_QUERY}` : BOARD_EVENTS_PATH;
    assertAllowed('WS', path);
    const url = boardUrl('ws', path);
    let closed = false;
    const finish = (info: { code?: number; reason?: string; error?: string }): void => {
      if (closed) return;
      closed = true;
      handlers.onClose(info);
    };
    if (!Ws) {
      g.setTimeout(() => finish({ error: 'WebSocket is not available' }), 0);
      return { close: () => finish({ code: 1000 }) };
    }
    let ws: WebSocketLike;
    try {
      ws = new Ws(url);
    } catch (e) {
      g.setTimeout(() => finish({ error: e instanceof Error ? e.message : String(e) }), 0);
      return { close: () => finish({ code: 1000 }) };
    }
    let lastError: string | undefined;
    ws.onopen = () => {
      if (!closed) handlers.onOpen();
    };
    ws.onmessage = (ev) => {
      if (closed) return;
      if (typeof ev.data !== 'string') {
        const size = typeof (ev.data as { byteLength?: unknown })?.byteLength === 'number' ? (ev.data as { byteLength: number }).byteLength : 0;
        handlers.onRejectedFrame?.({ reason: 'binary', size });
        return;
      }
      const size = ev.data.length > maxFrame / 3 ? utf8Length(ev.data) : ev.data.length;
      if (size > maxFrame) {
        handlers.onRejectedFrame?.({ reason: 'oversize', size });
        return;
      }
      handlers.onMessage(ev.data);
    };
    ws.onerror = (ev) => {
      const m = (ev as { message?: unknown })?.message;
      lastError = typeof m === 'string' && m.length > 0 ? m : 'socket error';
    };
    ws.onclose = (ev) => {
      const info: { code?: number; reason?: string; error?: string } = {};
      if (typeof ev?.code === 'number') info.code = ev.code;
      if (typeof ev?.reason === 'string' && ev.reason.length > 0) info.reason = ev.reason;
      if (lastError !== undefined) info.error = lastError;
      finish(info);
    };
    return {
      close: () => {
        try {
          ws.close(1000, 'client close');
        } catch {
          finish({ code: 1000 });
        }
      },
    };
  }

  return { get, openEvents };
}
