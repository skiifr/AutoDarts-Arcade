import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalIpHost, formatBoardAddress, isPrivateHost, parseBoardAddress } from './address';

/**
 * Board addresses must be on the home network (ARCHITECTURE §9.5). What this module accepts
 * has to be what a URL parser and getaddrinfo will actually reach: `010.0.0.5` is 10.0.0.5
 * digit by digit, but octal 8.0.0.5 to them.
 */

describe('board addresses', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.7', true],
    ['10.0.0.0', true],
    ['172.16.0.1', true],
    ['172.31.255.254', true],
    ['192.168.1.40', true],
    ['169.254.10.20', true],
    ['[::1]', true],
    ['[fe80::1]', true],
    ['[fd12:3456::1]', true],
    ['[fe80:0:0:0:0:0:0:1]', true],
    ['[FE80::0001]', true],
    ['172.32.0.1', false],
    ['172.15.0.1', false],
    ['8.8.8.8', false],
    ['192.169.0.1', false],
    ['100.64.0.1', false],
    ['999.168.1.1', false],
    ['[2001:db8::1]', false],
    ['[::]', false],
    // Leading zeros: octal to URL parsers and getaddrinfo, so public addresses in disguise.
    ['010.0.0.5', false],
    ['172.016.0.1', false],
    ['192.168.01.40', false],
    ['127.0.0.01', false],
    ['00.0.0.0', false],
    // Other forms URL parsers accept as IPv4.
    ['0x0a.0.0.1', false],
    ['10.1', false],
    ['167772161', false],
    // Names: Fire OS has no mDNS resolver, so DNS answers, and may answer with a public address.
    ['autodarts.local', false],
    ['my-board.local', false],
    ['localhost', false],
    ['example.com', false],
    ['autodarts.local.evil.com', false],
    // IPv6 forms that are not plain hex groups.
    ['[fe80::1%en0]', false],
    ['[::ffff:192.168.1.1]', false],
    ['[fe80::1::2]', false],
    ['[1:2:3:4:5:6:7:8:9]', false],
    ['[fe80::12345]', false],
    ['[fe80:0:0:0:0:0:0:0:1]', false],
    ['fe80::1', false],
  ])('%s private: %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it('canonicalises IP literals and refuses everything else', () => {
    expect(canonicalIpHost('192.168.1.40')).toBe('192.168.1.40');
    expect(canonicalIpHost('0.0.0.0')).toBe('0.0.0.0');
    expect(canonicalIpHost('[FE80:0000:0000:0000:0000:0000:0000:0001]')).toBe('[fe80::1]');
    expect(canonicalIpHost('[0:0:0:0:0:0:0:1]')).toBe('[::1]');
    expect(canonicalIpHost('[fd00:0:0:1:0:0:0:1]')).toBe('[fd00:0:0:1::1]');
    expect(canonicalIpHost('[fd00:1:0:0:1:0:0:1]')).toBe('[fd00:1::1:0:0:1]');
    expect(canonicalIpHost('[fd00:1:0:2:3:4:5:6]')).toBe('[fd00:1:0:2:3:4:5:6]');
    expect(canonicalIpHost('[1:0:0:0:0:0:0:0]')).toBe('[1::]');
    expect(canonicalIpHost('010.0.0.5')).toBeNull();
    expect(canonicalIpHost('autodarts.local')).toBeNull();
  });

  it('writes IPv6 the way a URL parser does', () => {
    const group = fc.oneof(fc.constant(0), fc.constant(0), fc.integer({ min: 0, max: 0xffff }));
    fc.assert(
      fc.property(fc.array(group, { minLength: 8, maxLength: 8 }), fc.boolean(), (groups, padded) => {
        const long = groups.map((g) => (padded ? g.toString(16).padStart(4, '0') : g.toString(16))).join(':');
        expect(canonicalIpHost(`[${long}]`)).toBe(new URL(`http://[${long}]/`).hostname);
      }),
      { numRuns: 2000 },
    );
  });

  it('parses what people type', () => {
    expect(parseBoardAddress(' 192.168.1.40 ')).toEqual({ ok: true, address: { host: '192.168.1.40', port: 3180 } });
    expect(parseBoardAddress('192.168.1.40:3181')).toEqual({ ok: true, address: { host: '192.168.1.40', port: 3181 } });
    expect(parseBoardAddress('[FE80::1]:3180')).toEqual({ ok: true, address: { host: '[fe80::1]', port: 3180 } });
    expect(parseBoardAddress('[fe80:0:0:0:0:0:0:1]')).toEqual({ ok: true, address: { host: '[fe80::1]', port: 3180 } });
    expect(formatBoardAddress({ host: '192.168.1.40', port: 3180 })).toBe('192.168.1.40');
    expect(formatBoardAddress({ host: '192.168.1.40', port: 81 })).toBe('192.168.1.40:81');
  });

  it.each(['', 'http://192.168.1.40', '192.168.1.40/api/config', '8.8.8.8', 'board.example.com', '192.168.1.40:0', '192.168.1.40:abc', 'fe80::1', '010.0.0.5', 'autodarts.local', '[fe80::1%25en0]'])(
    'refuses %j',
    (input) => {
      expect(parseBoardAddress(input).ok).toBe(false);
    },
  );

  it('explains why a name or a leading zero is refused', () => {
    const name = parseBoardAddress('autodarts.local');
    expect(name.ok).toBe(false);
    expect(!name.ok && name.reason).toMatch(/IP address/);
    expect(!name.ok && name.reason).toMatch(/autodarts\.local/);
    const zeros = parseBoardAddress('010.0.0.5');
    expect(!zeros.ok && zeros.reason).toMatch(/leading zero/i);
  });

  /** Typed text made of the pieces people (and QR codes) use: digits, dots, hex, brackets. */
  const typed = fc
    .array(fc.constantFrom('0', '1', '7', '8', '9', '10', '01', '010', '172', '016', '192', '168', '255', '256', '.', ':', '[', ']', 'fe80', 'fd', 'x', 'a', '::', '0x'), { maxLength: 12 })
    .map((parts) => parts.join(''));

  it('whatever it accepts, a URL parser reads as the same host, on the home network', () => {
    fc.assert(
      fc.property(typed, (text) => {
        const parsed = parseBoardAddress(text);
        if (!parsed.ok) return;
        const url = new URL(`http://${parsed.address.host}:${parsed.address.port}/api/version`);
        expect(url.hostname).toBe(parsed.address.host);
        expect(isPrivateHost(url.hostname)).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  it('every dotted quad it accepts is one a URL parser reads digit for digit', () => {
    const octet = fc.oneof(fc.integer({ min: 0, max: 255 }).map(String), fc.integer({ min: 0, max: 255 }).map((n) => `0${n}`), fc.integer({ min: 0, max: 99 }).map((n) => `00${n}`));
    fc.assert(
      fc.property(fc.tuple(octet, octet, octet, octet), (o) => {
        const host = o.join('.');
        const parsed = parseBoardAddress(host);
        if (!parsed.ok) return;
        expect(new URL(`http://${host}/`).hostname).toBe(host);
      }),
      { numRuns: 3000 },
    );
  });
});
