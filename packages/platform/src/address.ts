import { BOARD_PORT } from '@arcade/adapters';

/**
 * Board addresses Arcade will talk to: loopback, RFC 1918, link-local, IPv6 unique-local,
 * or an mDNS `.local` name (ARCHITECTURE §9.4–9.5). Anything else — a public address or
 * an arbitrary DNS name — is refused, so a typo or a malicious QR code cannot point the
 * app at the internet.
 */

export interface BoardAddress {
  /** Host as written in a URL: an IPv4 address, a `.local` name, or `[ipv6]`. */
  host: string;
  port: number;
}

export type AddressCheck = { ok: true; address: BoardAddress } | { ok: false; reason: string };

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** Loopback 127/8, RFC 1918 (10/8, 172.16/12, 192.168/16) or link-local 169.254/16. */
export function isPrivateIpv4(host: string): boolean {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a, b] = o as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** ::1, fc00::/7 (unique local) or fe80::/10 (link-local). Zone ids are not accepted. */
export function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(h) || !h.includes(':')) return false;
  if (h === '::1') return true;
  const first = h.startsWith('::') ? 0 : parseInt(h.split(':')[0] ?? '', 16);
  if (Number.isNaN(first)) return false;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** An mDNS host name such as `autodarts.local` or `localhost`. */
export function isLocalName(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  return /^(?=.{1,253}\.local$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.local$/.test(h);
}

/** Whether a URL host (IPv6 in brackets) is a private board address. */
export function isPrivateHost(urlHost: string): boolean {
  if (urlHost.startsWith('[') && urlHost.endsWith(']')) return isPrivateIpv6(urlHost.slice(1, -1));
  return isPrivateIpv4(urlHost) || isLocalName(urlHost);
}

/**
 * Validates an address typed by the user or stored earlier: `192.168.1.40`,
 * `192.168.1.40:3180`, `autodarts.local`, `[fe80::1]:3180`. The port defaults to 3180.
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
  if (!isPrivateHost(host)) {
    return { ok: false, reason: 'Only addresses on your home network are allowed (like 192.168.x.x or name.local).' };
  }
  return { ok: true, address: { host, port } };
}

export function formatBoardAddress(a: BoardAddress): string {
  return a.port === BOARD_PORT ? a.host : `${a.host}:${a.port}`;
}
