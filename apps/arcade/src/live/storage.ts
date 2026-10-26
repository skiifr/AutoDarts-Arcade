import type { KeyValueStorage } from '@arcade/platform';
import Storage from 'expo-sqlite/kv-store';

/**
 * Small app settings (the last board address, whether the iOS Local Network note was
 * shown) in expo-sqlite's key-value store on iOS, Android and Fire OS. The web preview
 * uses `storage.web.ts` instead: expo-sqlite on the web needs cross-origin isolation,
 * which would block the preview's requests to the board.
 *
 * Settings are a convenience, so a storage failure never stops a connection: reads give
 * null and writes are dropped.
 */
export const appStorage: KeyValueStorage = {
  getItem: (key) => Storage.getItem(key).catch(() => null),
  setItem: (key, value) => Storage.setItem(key, value).catch(() => undefined),
  removeItem: (key) => Storage.removeItem(key).catch(() => undefined),
};
