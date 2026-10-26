import { BOARD_EVENTS_PATH, type BoardGetPath } from './endpoints';
import { MAX_FRAME_CHARS, redactSecrets } from './raw';

/** Where a raw entry came from. Only allowlisted endpoints can be named here (R17). */
export type RawChannel = `GET ${BoardGetPath}` | `WS ${typeof BOARD_EVENTS_PATH}` | 'note';

export interface RawEntry {
  /** ISO time the entry was recorded. */
  at: string;
  channel: RawChannel;
  /** Secret-redacted, truncated text. */
  data: string;
  /** Original length, when `data` was truncated. */
  truncatedFrom?: number;
}

export interface RingOptions {
  /** Most entries kept. */
  maxEntries?: number;
  /** Most characters kept across all entries. */
  maxChars?: number;
  /** Longest single entry. */
  maxEntryChars?: number;
}

/**
 * Size-capped buffer of recent raw frames and responses for diagnostics exports
 * (ARCHITECTURE §9.5). It only ever receives data from allowlisted endpoints, and redacts the
 * whole value of any secret-looking key (`redactSecrets`) as a second line of defence: the
 * text is redacted before it is cut, so a cut can never expose part of a secret.
 */
export class RawFrameRing {
  private readonly entries: RawEntry[] = [];
  private chars = 0;
  private readonly maxEntries: number;
  private readonly maxChars: number;
  private readonly maxEntryChars: number;

  constructor(options: RingOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.maxChars = options.maxChars ?? 512 * 1024;
    this.maxEntryChars = options.maxEntryChars ?? 16 * 1024;
  }

  push(at: string, channel: RawChannel, text: string): void {
    // A frame the adapter may parse is redacted whole; a longer one only as far as it is kept.
    const clean = redactSecrets(text.length > MAX_FRAME_CHARS ? text.slice(0, this.maxEntryChars) : text);
    const entry: RawEntry = { at, channel, data: clean.length > this.maxEntryChars ? clean.slice(0, this.maxEntryChars) : clean };
    if (text.length > this.maxEntryChars || clean.length > this.maxEntryChars) entry.truncatedFrom = text.length;
    this.entries.push(entry);
    this.chars += entry.data.length;
    while (this.entries.length > this.maxEntries || (this.chars > this.maxChars && this.entries.length > 1)) {
      const dropped = this.entries.shift() as RawEntry;
      this.chars -= dropped.data.length;
    }
  }

  snapshot(): RawEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get size(): number {
    return this.entries.length;
  }

  get totalChars(): number {
    return this.chars;
  }

  /** JSON Lines, one entry per line, for the share-sheet export. */
  exportJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }

  clear(): void {
    this.entries.length = 0;
    this.chars = 0;
  }
}
