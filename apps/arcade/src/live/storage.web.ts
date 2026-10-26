import type { KeyValueStorage } from '@arcade/platform';

/** Web preview: the browser's localStorage (see `storage.ts` for the native store). */
function local(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // storage disabled
  }
}

export const appStorage: KeyValueStorage = {
  getItem: async (key) => {
    try {
      return local()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (key, value) => {
    try {
      local()?.setItem(key, value);
    } catch {
      // full or disabled: settings are a convenience
    }
  },
  removeItem: async (key) => {
    try {
      local()?.removeItem(key);
    } catch {
      // ignore
    }
  },
};
