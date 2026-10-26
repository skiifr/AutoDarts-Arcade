import { LastKnownAddress } from '@arcade/platform';
import { AppState, Platform } from 'react-native';
import { appStorage } from './storage';

/** The last board address that connected (W0 offers it on launch). */
export const lastKnownAddress = new LastKnownAddress(appStorage);

/**
 * iOS and iPadOS ask for Local Network access the first time the app reaches a LAN
 * address, and that first request can fail while the question is on screen (ARCHITECTURE
 * §9.3). W0 explains this once before the first connect or scan, and retries once.
 * Android and Fire OS have no such prompt.
 */
export const HAS_LOCAL_NETWORK_PROMPT = Platform.OS === 'ios';

const NOTE_KEY = 'arcade.ios.localNetworkNoteSeen';

export const localNetworkNote = {
  async seen(): Promise<boolean> {
    return !HAS_LOCAL_NETWORK_PROMPT || (await appStorage.getItem(NOTE_KEY)) === '1';
  },
  async markSeen(): Promise<void> {
    await appStorage.setItem(NOTE_KEY, '1');
  },
};

/**
 * Waits out the Local Network prompt after a first request failed: gives it time to
 * appear, then waits until the app is active again (the alert makes it inactive).
 */
export function afterLocalNetworkPrompt(delayMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (AppState.currentState === 'active') {
        resolve();
        return;
      }
      const sub = AppState.addEventListener('change', (state) => {
        if (state !== 'active') return;
        sub.remove();
        resolve();
      });
    }, delayMs);
  });
}
