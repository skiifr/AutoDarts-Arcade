import { BOARD_PORT } from '@arcade/adapters';

/**
 * Board addresses Arcade will talk to (ARCHITECTURE §9.4–9.5): IP literals on the home
 * network (loopback, RFC 1918, link-local, IPv6 unique-local). Anything else is refused, so
 * a typo or a malicious QR code cannot point the app at the internet.
 *
 * - **Canonical IPv4 only:** four decimal octets, no leading zeros (a lone "0" is fine).
 *   Parsers disagree about anything else: `010.0.0.5` is 10.0.0.5 digit by digit, but URL
 *   parsers and getaddrinfo read it as octal 8.0.0.5, a public address.
 * - **IPv6** is parsed strictly (hex groups only: no zone id, no embedded IPv4) and kept in
 *   RFC 5952 form, the form URL parsers report back.
 * - **No names**, `.local` included, until mDNS discovery exists: Fire OS has no mDNS
 *   resolver, so `autodarts.local` would go to DNS, which can answer with a public address.
 *
 * Every request URL is built from the canonical host (`transport.ts`).
 */

export interface BoardAddress {
  /** Canonical IP literal as written in a URL: `192.168.1.40` or `[fe80::1]`. */
  host: string;
  port: number;
}

export type AddressCheck = { ok: true; address: BoardAddress } | { ok: false; reason: string };

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const CANONICAL_IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** The address itself if it is canonical dotted-decimal IPv4, else null. */
export function canonicalIpv4(host: string): string | null {
  return CANONICAL_IPV4.test(host) ? host : null;
}

/** The eight 16-bit groups of an IPv6 address in hex-group notation, else null. */
function ipv6Groups(text: string): number[] | null {
  const h = text.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(h)) return null;
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0] as string);
  const tail = halves.length === 2 ? groups(halves[1] as string) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

/** RFC 5952: lower-case hex, no leading zeros, the first longest run of two or more zero groups as `::`. */
function formatIpv6(g: readonly number[]): string {
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < g.length; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < g.length && g[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/**
 * The canonical form of an IP literal URL host (IPv6 in brackets), or null if it is not
 * one: `[FE80:0:0:0:0:0:0:1]` → `[fe80::1]`, `010.0.0.5` → null.
 */
export function canonicalIpHost(urlHost: string): string | null {
  if (urlHost.startsWith('[') && urlHost.endsWith(']')) {
    const g = ipv6Groups(urlHost.slice(1, -1));
    return g ? `[${formatIpv6(g)}]` : null;
  }
  return canonicalIpv4(urlHost);
}

/** Canonical loopback 127/8, RFC 1918 (10/8, 172.16/12, 192.168/16) or link-local 169.254/16. */
export function isPrivateIpv4(host: string): boolean {
  if (canonicalIpv4(host) === null) return false;
  const [a, b] = host.split('.').map(Number) as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** ::1, fc00::/7 (unique local) or fe80::/10 (link-local), without brackets. Zone ids are not accepted. */
export function isPrivateIpv6(host: string): boolean {
  const g = ipv6Groups(host);
  if (!g) return false;
  const first = g[0] as number;
  const loopback = g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
  return loopback || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * An mDNS-style host name such as `autodarts.local` or `localhost`. Not accepted as a board
 * address (see the top of this file); W0 uses it to explain why.
 */
export function isLocalName(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  return /^(?=.{1,253}\.local$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.local$/.test(h);
}

/** Whether a URL host (IPv6 in brackets) is an IP literal on the home network, read as URL parsers read it. */
export function isPrivateHost(urlHost: string): boolean {
  const host = canonicalIpHost(urlHost);
  if (host === null) return false;
  return host.startsWith('[') ? isPrivateIpv6(host.slice(1, -1)) : isPrivateIpv4(host);
}

const HOME_ONLY = 'Only addresses on your home network are allowed, like 192.168.x.x or 10.x.x.x.';

/** Why a host that is not a canonical private IP literal is refused, in words for W0. */
function refusal(host: string): string {
  if (host.startsWith('[')) return canonicalIpHost(host) ? HOME_ONLY : 'That is not a valid IPv6 address.';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (canonicalIpv4(host)) return HOME_ONLY;
    if (host.split('.').some((o) => o.length > 1 && o.startsWith('0'))) {
      return 'Write the address without leading zeros, like 10.0.0.5 (010 would mean another address).';
    }
    return 'That is not a valid IP address.';
  }
  if (/^[\d.]+$/.test(host)) return 'Enter all four numbers of the IP address, like 192.168.1.40.';
  return `Enter the board's IP address, like 192.168.1.40. Names such as ${isLocalName(host) ? host : 'autodarts.local'} can't be used yet, because not every device can look them up safely.`;
}

/**
 * Validates an address typed by the user or stored earlier: `192.168.1.40`,
 * `192.168.1.40:3180`, `[fe80::1]:3180`. The port defaults to 3180; the host comes back
 * canonical.
 */
export function parseBoardAddress(input: string): AddressCheck {
  const text = input.trim();
  if (text.length === 0) return { ok: false, reason: 'Enter the board address.' };
  if (/^[a-z]+:\/\//i.test(text) || text.includes('/')) return { ok: false, reason: 'Enter only the address, like 192.168.1.40.' };
  let host: string;
  let portText: string | undefined;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (v6) {
    host = `[${(v6[1] as string).toLowerCase()}]`;
    portText = v6[2];
  } else {
    const parts = text.split(':');
    if (parts.length > 2) return { ok: false, reason: 'Write IPv6 addresses in brackets, like [fe80::1].' };
    host = (parts[0] as string).toLowerCase();
    portText = parts[1];
  }
  let port = BOARD_PORT;
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) return { ok: false, reason: 'The port must be a number.' };
    port = Number(portText);
    if (port < 1 || port > 65535) return { ok: false, reason: 'The port must be between 1 and 65535.' };
  }
  const canonical = canonicalIpHost(host);
  if (canonical === null || !isPrivateHost(canonical)) return { ok: false, reason: refusal(host) };
  return { ok: true, address: { host: canonical, port } };
}

export function formatBoardAddress(a: BoardAddress): string {
  return a.port === BOARD_PORT ? a.host : `${a.host}:${a.port}`;
}
