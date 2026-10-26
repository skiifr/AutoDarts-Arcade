/**
 * The only board endpoints Arcade may touch (owner decision S: the app never writes to
 * the board; ARCHITECTURE §9.5, RISK R17). Every request goes through a transport that
 * enforces this list, and a build-failing test in packages/platform checks it exactly
 * and scans the adapter and platform sources for any other `/api/` path.
 *
 * Deliberately absent: `POST /api/reset` (the app reports a stuck takeout instead of
 * resetting), `/api/events/system`, and `/api/config` and `/api/system`, which return the
 * board's API key and TLS key.
 */
export const BOARD_GET_PATHS = ['/api/state', '/api/version', '/api/state/stats', '/api/cams/stats'] as const;
export type BoardGetPath = (typeof BOARD_GET_PATHS)[number];

/** WebSocket path of the board's event stream. */
export const BOARD_EVENTS_PATH = '/api/events';

/**
 * The one query the events socket may carry, and only when asked for
 * (`stateOnlySocket`). By default the adapter opens the bare path and filters frames by
 * their `type`, as the community clients (HomeDarts, DartLab) and DartLab's real 2.0.2
 * capture do; `?type=state` comes from a static inspection of the 2.0.2 binary and is
 * unverified on a live board. The allowlist accepts both forms.
 */
export const BOARD_EVENTS_QUERY = 'type=state';

/** The Autodarts board's local API port. */
export const BOARD_PORT = 3180;

export function isBoardGetPath(path: string): path is BoardGetPath {
  return (BOARD_GET_PATHS as readonly string[]).includes(path);
}

/**
 * Checks a request path (with an optional query) against the allowlist. GET may only use
 * the four read endpoints with no query; the socket may only use the events path, bare or
 * with `type=state`.
 */
export function isAllowedBoardRequest(kind: 'GET' | 'WS', pathWithQuery: string): boolean {
  const q = pathWithQuery.indexOf('?');
  const path = q === -1 ? pathWithQuery : pathWithQuery.slice(0, q);
  const query = q === -1 ? null : pathWithQuery.slice(q + 1);
  if (kind === 'GET') return query === null && isBoardGetPath(path);
  return path === BOARD_EVENTS_PATH && (query === null || query === BOARD_EVENTS_QUERY);
}
