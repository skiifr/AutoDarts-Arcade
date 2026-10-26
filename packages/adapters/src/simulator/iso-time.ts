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
