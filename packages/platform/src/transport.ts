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
 *
 * **Redirects.** Every GET asks for `redirect: 'error'`, which browsers and expo/fetch (the
 * global fetch on Expo native builds) honour. React Native's own fetch ignores it and the
 * iOS and Android stacks follow redirects themselves, so the response is checked as well,
 * before any of the body is read: a response that says it was redirected, comes from any
 * other URL, or is a 3xx is refused and its request aborted. A stack that follows a redirect
 * has already sent that request, though (RISK-REGISTER).
 *
 * **Body cap.** A body that streams (browsers, expo/fetch, Node) is read chunk by chunk and
 * dropped as soon as it passes the cap. React Native's own fetch has no stream, so there the
 * body is buffered natively, within the timeout, before it can be measured.
 */

/** Minimal structural types, so this compiles without DOM or Node type libraries. */
export interface BodyReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}
export interface ResponseLike {
  status: number;
  /** The URL the response came from, after any redirect the stack followed. */
  url?: string;
  /** True if the stack followed a redirect (WHATWG fetch and expo/fetch say so). */
  redirected?: boolean;
  headers: { get(name: string): string | null };
  /** The body as a byte stream, where the fetch has one. */
  body?: { getReader(): BodyReaderLike } | null;
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

const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, ws: 80, https: 443, wss: 443 };

/**
 * A URL in one form for comparison: lower-case scheme, canonical IP host, the port written
 * out even when it is the scheme's default, path and query as given, no fragment. Null for
 * anything else (a name, user info, another scheme), so such a URL never matches a board's.
 * `http://192.168.1.40/x` and `http://192.168.1.40:80/x` are the same URL; so are
 * `http://[fe80:0:0:0:0:0:0:1]:3180/x` and `http://[fe80::1]:3180/x`.
 */
export function normaliseBoardUrl(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]*\]|[^/?#:@[\]]*)(?::(\d*))?([/?][^#]*)?(?:#.*)?$/i.exec(url);
  if (!m) return null;
  const scheme = (m[1] as string).toLowerCase();
  const defaultPort = DEFAULT_PORTS[scheme];
  if (defaultPort === undefined) return null;
  const host = canonicalIpHost((m[2] as string).toLowerCase());
  if (host === null) return null;
  const port = m[3] ? Number(m[3]) : defaultPort;
  const rest = m[4] ?? '/';
  return `${scheme}://${host}:${port}${rest.startsWith('?') ? `/${rest}` : rest}`;
}

interface TextDecoderLike {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

interface Globals {
  fetch?: FetchLike;
  WebSocket?: WebSocketCtor;
  AbortController?: new () => AbortControllerLike;
  TextDecoder?: new (label?: string) => TextDecoderLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/**
 * Reads a body of at most `max` bytes. A declared Content-Length over the cap is refused
 * unread; a streamed body is cancelled as soon as it passes the cap. Without a stream (or a
 * TextDecoder) the whole body is read first and then measured.
 */
async function readCapped(res: ResponseLike, max: number, Decoder: Globals['TextDecoder'], abort: () => void): Promise<string> {
  const tooBig = (): Error => {
    abort();
    return new Error(`response over ${max} bytes`);
  };
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw tooBig();
  const stream = res.body;
  if (!stream || typeof stream.getReader !== 'function' || !Decoder) {
    const text = await res.text();
    if (utf8Length(text) > max) throw tooBig();
    return text;
  }
  const reader = stream.getReader();
  const decoder = new Decoder('utf-8');
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > max) {
      try {
        reader.cancel().catch(() => undefined);
      } catch {
        // the request is aborted anyway
      }
      throw tooBig();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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
    const expected = normaliseBoardUrl(url);
    const timeoutMs = call?.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = Abort ? new Abort() : undefined;
    const abort = (): void => controller?.abort();
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = g.setTimeout(() => {
        abort();
        reject(new Error(`timeout after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      const work = (async () => {
        const init: Parameters<FetchLike>[1] = { method: 'GET', redirect: 'error', headers: { accept: 'application/json, text/plain' } };
        if (controller) init.signal = controller.signal;
        const res = await doFetch(url, init);
        // A redirect could lead off the allowlist or off the home network. Not every stack
        // honours redirect: 'error' (see the top of this file), so check before reading.
        const movedTo = typeof res.url === 'string' && res.url !== '' ? normaliseBoardUrl(res.url) : expected;
        if (res.redirected === true || (res.status >= 300 && res.status < 400) || movedTo !== expected) {
          abort();
          throw new BoardRequestRefused(`GET ${path} was redirected; redirects are refused`);
        }
        const body = await readCapped(res, maxBody, g.TextDecoder, abort);
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
