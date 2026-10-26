import type { InputMode } from '@arcade/ui-kit';
import { Platform } from 'react-native';

/**
 * Browser previews can pretend to be a TV: open the web build with `?input=remote` to get
 * the TV focus ring and 5% title-safe margins. Arrow keys act as the D-pad only on the W4
 * board picker; elsewhere the browser has no TV focus engine and Tab moves focus instead
 * (see the README). Read once at startup so it survives client-side navigation.
 */
function read(): InputMode | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('input');
  return value === 'remote' || value === 'touch' ? value : undefined;
}

export const INPUT_OVERRIDE = read();
