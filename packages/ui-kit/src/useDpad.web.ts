import { useEffect } from 'react';
import type { DpadDirection } from './useDpad';

export type { DpadDirection } from './useDpad';

const KEYS: Record<string, DpadDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'select',
};

/** Web stand-in for the TV remote: arrow keys and Enter, for browser previews. */
export function useDpad(handler: (direction: DpadDirection) => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const direction = KEYS[e.key];
      if (!direction) return;
      e.preventDefault();
      handler(direction);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handler, enabled]);
}
