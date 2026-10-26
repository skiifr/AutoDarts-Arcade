const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A syntactically valid ULID made from a number: deterministic ids for previews and tests. */
export function ulidFromNumber(n: number, prefix = ''): string {
  let out = '';
  let v = n;
  for (let i = 0; i < 26 - prefix.length; i++) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return prefix + out;
}

/** Ids for a dry-run preview: valid ULIDs that cannot collide with real time-based ones. */
export function previewIds(): () => string {
  let n = 0;
  return () => ulidFromNumber(++n, '7ZZZZZZZ');
}
