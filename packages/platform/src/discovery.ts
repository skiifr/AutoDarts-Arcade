import { BOARD_PORT, parseVersion, type Transport } from '@arcade/adapters';
import { formatBoardAddress, isPrivateIpv4, parseBoardAddress, type BoardAddress } from './address';
import { createBoardTransport, utf8Length } from './transport';

/**
 * Finding the board (ARCHITECTURE §9.4, W0). Order of preference: mDNS, last-known
 * address, manual entry, opt-in subnet probe, demo mode.
 */

export interface BoardCandidate {
  address: BoardAddress;
  /** From `GET /api/version`, when the board answered. */
  version?: string;
  source: 'mdns' | 'last-known' | 'manual' | 'probe';
}

export interface Discovery {
  /** Candidates found so far; implementations should stop when `signal.aborted`. */
  discover(options?: { signal?: { readonly aborted: boolean } }): Promise<BoardCandidate[]>;
}

/**
 * mDNS browsing for `_autodarts-board._tcp` (🟡[C15]). Needs a native module (e.g.
 * react-native-zeroconf) that is not on the verified dependency list (ADR-003), so there
 * is deliberately no implementation yet; W0 falls back to last-known, manual and probe.
 */
export interface MdnsBrowser {
  browse(
    serviceType: '_autodarts-board._tcp',
    onFound: (candidate: BoardCandidate) => void,
  ): { stop(): void };
}

/** AsyncStorage-shaped storage (AsyncStorage on Vega, any key-value store on Expo). */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
}

const LAST_KNOWN_KEY = 'arcade.board.lastKnownAddress';

/**
 * The last board address that worked. A stored value that fails today's check (a name, a
 * leading-zero IPv4, a public address saved by an older build) is discarded on load.
 */
export class LastKnownAddress {
  private readonly storage: KeyValueStorage;

  constructor(storage: KeyValueStorage) {
    this.storage = storage;
  }

  async get(): Promise<BoardAddress | null> {
    const raw = await this.storage.getItem(LAST_KNOWN_KEY);
    if (raw === null) return null;
    const parsed = parseBoardAddress(raw);
    if (parsed.ok) return parsed.address;
    await Promise.resolve(this.storage.removeItem?.(LAST_KNOWN_KEY)).catch(() => undefined);
    return null;
  }

  async set(address: BoardAddress): Promise<void> {
    const parsed = parseBoardAddress(formatBoardAddress(address));
    if (!parsed.ok) throw new Error(parsed.reason);
    await this.storage.setItem(LAST_KNOWN_KEY, formatBoardAddress(parsed.address));
  }

  async clear(): Promise<void> {
    await this.storage.removeItem?.(LAST_KNOWN_KEY);
  }
}

export type TransportFactory = (address: BoardAddress) => Transport;

export const defaultTransportFactory: TransportFactory = (a) => createBoardTransport({ host: a.host, port: a.port });

/**
 * A board answers `GET /api/version` with a few bytes (`2.0.2`, or `{"version":"2.0.2"}`).
 * A longer answer is some other server, so a version check reads no more than this.
 */
export const MAX_VERSION_BODY_BYTES = 128;

/** Transports for version checks (manual, last-known, scan): bodies capped at `MAX_VERSION_BODY_BYTES`. */
export const versionCheckTransportFactory: TransportFactory = (a) =>
  createBoardTransport({ host: a.host, port: a.port, maxBodyBytes: MAX_VERSION_BODY_BYTES });

/**
 * Asks one address for `GET /api/version` (read-only, allowlisted). Returns the candidate
 * only if it answered 200, without a redirect (the transport refuses those), with a short
 * version string; else null.
 */
export async function checkBoard(
  address: BoardAddress,
  options: { transportFactory?: TransportFactory; timeoutMs?: number; source?: BoardCandidate['source'] } = {},
): Promise<BoardCandidate | null> {
  const transport = (options.transportFactory ?? versionCheckTransportFactory)(address);
  try {
    const res = await transport.get('/api/version', { timeoutMs: options.timeoutMs ?? 1500 });
    if (res.status !== 200 || utf8Length(res.body) > MAX_VERSION_BODY_BYTES) return null;
    const version = parseVersion(res.body);
    if (version === undefined) return null;
    return { address, version, source: options.source ?? 'manual' };
  } catch {
    return null;
  }
}

/** Validates a typed address and checks that a board answers there. */
export async function checkManualAddress(
  input: string,
  options: { transportFactory?: TransportFactory; timeoutMs?: number } = {},
): Promise<{ ok: true; candidate: BoardCandidate } | { ok: false; reason: string }> {
  const parsed = parseBoardAddress(input);
  if (!parsed.ok) return parsed;
  const candidate = await checkBoard(parsed.address, { ...options, source: 'manual' });
  return candidate ? { ok: true, candidate } : { ok: false, reason: `No board answered at ${formatBoardAddress(parsed.address)}.` };
}

export interface SubnetProbeOptions {
  /** Any private IPv4 address in the /24 to scan, usually the device's own. */
  near: string;
  port?: number;
  /** Requests in flight at once (default 12). */
  concurrency?: number;
  /** Per-address timeout (default 400 ms). */
  timeoutMs?: number;
  transportFactory?: TransportFactory;
  signal?: { readonly aborted: boolean };
  onFound?: (candidate: BoardCandidate) => void;
}

/**
 * Opt-in probe of `GET /api/version` on port 3180 across a private /24 (W0 "Scan").
 * Concurrency-limited with a short timeout: at most `concurrency` small requests in
 * flight, one per address, ~254 in total.
 */
export async function probeSubnet(options: SubnetProbeOptions): Promise<BoardCandidate[]> {
  if (!isPrivateIpv4(options.near)) throw new Error(`${options.near} is not a private IPv4 address`);
  const prefix = options.near.split('.').slice(0, 3).join('.');
  const port = options.port ?? BOARD_PORT;
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
  const found: BoardCandidate[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < hosts.length && !options.signal?.aborted) {
      const host = hosts[next++] as string;
      const c = await checkBoard(
        { host, port },
        { transportFactory: options.transportFactory, timeoutMs: options.timeoutMs ?? 400, source: 'probe' },
      );
      if (c) {
        found.push(c);
        options.onFound?.(c);
      }
    }
  };
  const n = Math.max(1, Math.min(options.concurrency ?? 12, 32));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return found.sort((a, b) => Number(a.address.host.split('.')[3]) - Number(b.address.host.split('.')[3]));
}

/** Last-known first, then an optional mDNS browser's results (none until one exists). */
export class BoardDiscovery implements Discovery {
  private readonly lastKnown: LastKnownAddress;
  private readonly transportFactory: TransportFactory | undefined;

  constructor(options: { lastKnown: LastKnownAddress; transportFactory?: TransportFactory }) {
    this.lastKnown = options.lastKnown;
    this.transportFactory = options.transportFactory;
  }

  async discover(): Promise<BoardCandidate[]> {
    const last = await this.lastKnown.get();
    if (!last) return [];
    const c = await checkBoard(last, { transportFactory: this.transportFactory, source: 'last-known' });
    return c ? [c] : [];
  }
}

/** What W0 needs of the app's board link to connect, and to take a connection back. */
export interface ConnectLink {
  open(address: BoardAddress): void;
  close(): void;
  /** Settles `online` the first time the link just opened is online, `closed` if it is closed or replaced first. */
  whenOnline(): Promise<'online' | 'closed'>;
}

export interface ConnectAttempt {
  /** True once a newer attempt began or this one was cancelled: stop, and change nothing. */
  readonly stale: boolean;
  /**
   * Opens the link and waits until it is online. True means the attempt succeeded and is
   * done. False if it was cancelled or superseded first (the link it opened is then closed)
   * or the link was closed by someone else.
   */
  link(address: BoardAddress): Promise<boolean>;
}

/**
 * W0's connect attempts, one at a time (§9.4). `begin()` supersedes the attempt before it;
 * `cancel()` (Cancel, Play demo, leaving or unmounting the screen) abandons the pending one
 * and closes the link it opened. A late answer of an abandoned attempt changes nothing, so
 * it can't push the ticker over a demo game. An attempt that got online is done: `cancel()`
 * then leaves its link alone, since the link now belongs to the screen it led to.
 */
export class ConnectAttempts {
  private readonly boardLink: ConnectLink;
  private current: { opened: boolean } | null = null;

  constructor(link: ConnectLink) {
    this.boardLink = link;
  }

  /** Whether an attempt is under way (checking or linking). */
  get pending(): boolean {
    return this.current !== null;
  }

  begin(): ConnectAttempt {
    this.cancel();
    const me = { opened: false };
    this.current = me;
    const stale = (): boolean => this.current !== me;
    return {
      get stale() {
        return stale();
      },
      link: async (address) => {
        if (stale()) return false;
        me.opened = true;
        this.boardLink.open(address);
        const result = await this.boardLink.whenOnline();
        if (stale()) return false;
        this.current = null;
        return result === 'online';
      },
    };
  }

  /** Abandons the pending attempt, if any, and closes the link it opened. */
  cancel(): void {
    const me = this.current;
    if (!me) return;
    this.current = null;
    if (me.opened) this.boardLink.close();
  }
}
