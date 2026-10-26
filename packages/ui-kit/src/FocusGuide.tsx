import * as RN from 'react-native';
import type { FocusGuideProps } from 'react-native';

/**
 * TVFocusGuideView on TV builds; a plain View elsewhere (react-native-web has no TV
 * focus engine). TV-only props are dropped on the fallback so they never reach the DOM.
 */
export function FocusGuide({ autoFocus, trapFocusUp, trapFocusDown, trapFocusLeft, trapFocusRight, destinations, ...viewProps }: FocusGuideProps) {
  const Guide = (RN as Partial<typeof RN>).TVFocusGuideView;
  if (Guide && RN.Platform.isTV) {
    return (
      <Guide
        {...viewProps}
        autoFocus={autoFocus}
        trapFocusUp={trapFocusUp}
        trapFocusDown={trapFocusDown}
        trapFocusLeft={trapFocusLeft}
        trapFocusRight={trapFocusRight}
        destinations={destinations}
      />
    );
  }
  return <RN.View {...viewProps} />;
}
