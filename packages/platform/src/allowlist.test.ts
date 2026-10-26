import { BOARD_EVENTS_PATH, BOARD_EVENTS_QUERY, BOARD_GET_PATHS, isAllowedBoardRequest, type BoardGetPath } from '@arcade/adapters';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { BoardRequestRefused, createBoardTransport, type FetchLike } from './transport';

declare global {
  interface ImportMeta {
    glob<T>(pattern: string | string[], options: { query: string; import: string; eager: true }): Record<string, T>;
  }
}

/**
 * Owner decision S: the app never writes to the board. This suite fails the build if the
 * allowlist changes, if the transport lets anything else through, or if any `/api/` path
 * outside the allowlist appears as a string literal in the adapter or platform sources.
 */

const ALLOWED_GET = ['/api/state', '/api/version', '/api/state/stats', '/api/cams/stats'];
const ALLOWED_LITERALS = new Set([...ALLOWED_GET, '/api/events', '/api/events?type=state']);

describe('(a) the allowlist, exactly', () => {
  it('is the four read endpoints and the event socket', () => {
    expect([...BOARD_GET_PATHS]).toEqual(ALLOWED_GET);
    expect(BOARD_EVENTS_PATH).toBe('/api/events');
    expect(BOARD_EVENTS_QUERY).toBe('type=state');
  });

  it.each([
    ['GET', '/api/state', true],
    ['GET', '/api/version', true],
    ['GET', '/api/state/stats', true],
    ['GET', '/api/cams/stats', true],
    ['WS', '/api/events', true],
    ['WS', '/api/events?type=state', true],
    // Board control: the app reports a stuck takeout and never resets the board.
    ['GET', '/api/reset', false],
    ['GET', '/api/start', false],
    ['GET', '/api/stop', false],
    ['GET', '/api/restart', false],
    // Secrets: the board API key and TLS key.
    ['GET', '/api/config', false],
    ['GET', '/api/system', false],
    ['GET', '/api/host', false],
    ['WS', '/api/events/system', false],
    // Near misses.
    ['GET', '/api/events', false],
    ['WS', '/api/state', false],
    ['WS', '/api/events?type=all', false],
    ['WS', '/api/events?type=state&x=1', false],
    ['GET', '/api/state?x=1', false],
    ['GET', '/api/state/', false],
    ['GET', '/API/STATE', false],
    ['GET', '/api/state/../config', false],
    ['GET', '/api/cams/0/stats', false],
    ['GET', '', false],
  ] as const)('%s %s → %s', (kind, path, allowed) => {
    expect(isAllowedBoardRequest(kind, path)).toBe(allowed);
  });

  it('the transport refuses anything else before touching the network', async () => {
    const fetch = vi.fn<FetchLike>();
    const t = createBoardTransport({ host: '192.168.1.40', fetch });
    for (const path of ['/api/config', '/api/system', '/api/reset', '/api/events/system', '/api/state?x=1']) {
      await expect(t.get(path as BoardGetPath)).rejects.toBeInstanceOf(BoardRequestRefused);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the transport can only GET and open the event socket', () => {
    const t = createBoardTransport({ host: '192.168.1.40', fetch: vi.fn<FetchLike>() });
    expect(Object.keys(t).sort()).toEqual(['get', 'openEvents']);
  });

  it('every GET is a GET with redirects refused', async () => {
    const fetch = vi.fn<FetchLike>(async () => ({ status: 200, headers: { get: () => null }, text: async () => '2.0.2' }));
    await createBoardTransport({ host: '192.168.1.40', fetch }).get('/api/version');
    expect(fetch).toHaveBeenCalledWith('http://192.168.1.40:3180/api/version', expect.objectContaining({ method: 'GET', redirect: 'error' }));
  });
});

describe('(b) no other /api/ path in the adapter or platform sources', () => {
  const sources = import.meta.glob<string>(['../../adapters/src/**/*.ts', './**/*.ts', '!**/*.test.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  /** Every string literal, template piece and literal type in a file. */
  function literals(file: string, text: string): string[] {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        out.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  }

  it('scans a non-trivial set of files', () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(25);
    expect(files.some((f) => f.includes('adapters/src/autodarts-local/adapter.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('/transport.ts'))).toBe(true);
  });

  it('every /api/ literal is on the allowlist', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const [file, text] of Object.entries(sources)) {
      for (const lit of literals(file, text)) {
        for (const m of lit.matchAll(/\/api\/[A-Za-z0-9_\-/.?=&%]*/g)) {
          seen++;
          if (!ALLOWED_LITERALS.has(m[0])) offenders.push(`${file}: "${m[0]}" in "${lit.slice(0, 80)}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(seen).toBeGreaterThan(10);
  });

  it('the scanner itself catches a forbidden path', () => {
    const bad = literals('x.ts', "const p = '/api/config'; type T = `${'/api/reset'}`; const q = `ws://h/api/system/${1}`;");
    expect(bad.join(' ')).toMatch(/\/api\/config.*\/api\/reset.*\/api\/system/);
  });
});
