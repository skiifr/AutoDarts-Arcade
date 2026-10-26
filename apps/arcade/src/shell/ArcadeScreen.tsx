import { arcade, useLayout } from '@arcade/ui-kit';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { loadArcadeFonts } from './fonts';

loadArcadeFonts();

/**
 * The arcade backdrop: dark navy with a soft cyan glow and, on wide screens, the thin cyan
 * frame line. Decorative only, so on TV it may sit outside the title-safe area.
 */
export function ArcadeBackdrop() {
  const { s, mode, input, gutterX, gutterY } = useLayout();
  const inset = input === 'remote' ? Math.round(Math.min(gutterX, gutterY) * 0.42) : s(5);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="arcade-glow-top" cx="50%" cy="-20%" r="80%">
            <Stop offset="0" stopColor="#1A3F7A" stopOpacity={0.55} />
            <Stop offset="1" stopColor={arcade.bg} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="arcade-glow-bottom" cx="50%" cy="120%" r="70%">
            <Stop offset="0" stopColor={arcade.frame} stopOpacity={0.12} />
            <Stop offset="1" stopColor={arcade.bg} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={arcade.bg} />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#arcade-glow-top)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#arcade-glow-bottom)" />
      </Svg>
      {mode === 'wide' ? (
        <View
          style={{
            position: 'absolute',
            left: inset,
            right: inset,
            top: inset,
            bottom: inset,
            borderRadius: s(6),
            borderWidth: s(1),
            borderColor: arcade.frameDim,
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * A full-screen arcade page without the standard header: backdrop, device insets and the
 * gutters (the 5% title-safe area on TV). W1 and W3 draw their own chrome inside it.
 */
export function ArcadeScreen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { gutterX, gutterY } = useLayout();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: arcade.bg }}>
      <ArcadeBackdrop />
      <View
        style={[
          {
            flex: 1,
            paddingLeft: gutterX + insets.left,
            paddingRight: gutterX + insets.right,
            paddingTop: gutterY + insets.top,
            paddingBottom: gutterY + insets.bottom,
          },
          style,
        ]}
      >
        {children}
      </View>
    </View>
  );
}
