import { FONT_FILES } from '@arcade/ui-kit';
import { loadAsync } from 'expo-font';
import bold from '../../assets/fonts/BarlowCondensed-Bold.ttf';
import display from '../../assets/fonts/BarlowCondensed-ExtraBold.ttf';
import semi from '../../assets/fonts/BarlowCondensed-SemiBold.ttf';

let requested = false;

/**
 * Barlow Condensed (SIL OFL 1.1, assets/fonts/OFL.txt). Native builds embed it through the
 * expo-font config plugin in app.json, so this is a no-op there; it loads the faces on the
 * web and in Expo Go. Text renders in a fallback face until then, never blank.
 */
export function loadArcadeFonts(): void {
  if (requested) return;
  requested = true;
  loadAsync({ [FONT_FILES.display]: display, [FONT_FILES.bold]: bold, [FONT_FILES.semi]: semi }).catch(() => {
    requested = false;
  });
}
