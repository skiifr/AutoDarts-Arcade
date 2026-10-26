import { Platform, useTVEventHandler } from 'react-native';

export type DpadDirection = 'left' | 'right' | 'up' | 'down' | 'select';

const DIRECTIONS = new Set<string>(['left', 'right', 'up', 'down', 'select']);

/**
 * Raw D-pad presses while `enabled` (e.g. while the correction picker is in edit mode).
 * Pair it with a focus trap so the focus engine doesn't also move focus on the same press.
 */
export function useDpad(handler: (direction: DpadDirection) => void, enabled: boolean): void {
  useTVEventHandler((event) => {
    if (!enabled || !Platform.isTV) return;
    // Android TV reports key-down (0) and key-up (1); act once per press.
    if (event.eventKeyAction === 1) return;
    if (DIRECTIONS.has(event.eventType)) handler(event.eventType as DpadDirection);
  });
}
