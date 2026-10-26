/**
 * Epoch milliseconds → ISO-8601 UTC (`2026-11-02T20:14:03.120Z`) without reading the
 * clock, so simulations and tests in pure packages can build a `Clock` from virtual time.
 * Uses Howard Hinnant's days-to-civil algorithm.
 */
export function isoFromEpochMs(ms: number): string {
  const t = Math.floor(ms);
  const days = Math.floor(t / 86_400_000);
  let rem = t - days * 86_400_000;
  const hh = Math.floor(rem / 3_600_000);
  rem -= hh * 3_600_000;
  const mi = Math.floor(rem / 60_000);
  rem -= mi * 60_000;
  const ss = Math.floor(rem / 1000);
  const mss = rem - ss * 1000;

  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);

  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${p2(m)}-${p2(d)}T${p2(hh)}:${p2(mi)}:${p2(ss)}.${String(mss).padStart(3, '0')}Z`;
}

/** 2026-11-02T20:00:00.000Z, the default start of simulated time. */
export const SIM_EPOCH_MS = 1_793_649_600_000;

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * ISO-8601 (`2026-11-02T20:14:03.120Z`, or with a `±hh:mm` offset) → epoch milliseconds,
 * without `Date`, so pure code can measure durations on an injected wall clock. Returns
 * undefined for anything else. Inverse of `isoFromEpochMs` (Hinnant's days-from-civil).
 */
export function epochMsFromIso(iso: string): number | undefined {
  const m = ISO_PATTERN.exec(iso);
  if (!m) return undefined;
  const [, ys, mos, ds, hs, mis, ss, frac, zone] = m as unknown as [string, string, string, string, string, string, string, string | undefined, string];
  const mo = Number(mos);
  const d = Number(ds);
  const h = Number(hs);
  const mi = Number(mis);
  const s = Number(ss);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return undefined;
  const y = Number(ys) - (mo <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146_097 + doe - 719_468;
  const ms = frac === undefined ? 0 : Math.floor(Number(`0.${frac}`) * 1000 + 1e-6);
  let offsetMin = 0;
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    offsetMin = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  }
  return days * 86_400_000 + h * 3_600_000 + mi * 60_000 + s * 1000 + ms - offsetMin * 60_000;
}
