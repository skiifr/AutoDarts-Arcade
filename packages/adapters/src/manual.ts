import type { BoardFactDraft } from '@arcade/event-schema';
import { Listeners, type BoardSource, type FactListener } from './ports';

export const MANUAL_ADAPTER_VERSION = 'manual@0.1.0';

/**
 * Play without a board (ARCHITECTURE §8.3, manual mode). Darts do not come from this
 * source: the UI sends `AddDart{reason:'manual-mode'}` commands straight to the host, and
 * the host ends turns on "Next player". The source emits no board facts at all — no
 * connection or board status, so the host never pauses for a missing board — and exists
 * so the host can treat every source through the same `BoardSource` interface.
 */
export class ManualSource implements BoardSource {
  readonly kind = 'manual' as const;
  private readonly facts = new Listeners<BoardFactDraft>();
  private running = false;

  subscribe(listener: FactListener): () => void {
    return this.facts.add(listener);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }
}
