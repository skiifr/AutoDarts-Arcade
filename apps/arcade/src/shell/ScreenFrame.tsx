import { AText, Button, StatusPill, palette, space, useLayout } from '@arcade/ui-kit';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

/** Soft arcade glow behind every screen. */
function Backdrop() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="glow-top" cx="50%" cy="-10%" r="75%">
            <Stop offset="0" stopColor={palette.rose} stopOpacity={0.16} />
            <Stop offset="1" stopColor={palette.bg} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="glow-bottom" cx="85%" cy="115%" r="60%">
            <Stop offset="0" stopColor={palette.cyan} stopOpacity={0.1} />
            <Stop offset="1" stopColor={palette.bg} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#glow-top)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#glow-bottom)" />
      </Svg>
    </View>
  );
}

export interface ScreenFrameProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  /** Extra controls on the right of the header, before the board status. */
  right?: ReactNode;
  boardStatus?: { tone: 'online' | 'demo' | 'offline' | 'connecting'; label: string } | null;
  children: ReactNode;
}

export function ScreenFrame({ title, subtitle, onBack, right, boardStatus = { tone: 'demo', label: 'Demo board' }, children }: ScreenFrameProps) {
  const { s, gutterX, gutterY, input, mode } = useLayout();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <Backdrop />
      <View
        style={{
          flex: 1,
          paddingLeft: gutterX + insets.left,
          paddingRight: gutterX + insets.right,
          paddingTop: gutterY + insets.top,
          paddingBottom: gutterY + insets.bottom,
          gap: s(space.md),
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.md), flexWrap: mode === 'narrow' ? 'wrap' : 'nowrap' }}>
          {onBack && input === 'touch' ? <Button label="Back" icon="◀" variant="ghost" size="sm" onPress={onBack} /> : null}
          <View style={{ flex: 1, minWidth: s(160) }}>
            <AText variant={mode === 'wide' ? 'h2' : 'h3'} upper numberOfLines={1}>
              {title}
            </AText>
            {subtitle ? (
              <AText variant="caption" color="textMute" numberOfLines={1}>
                {subtitle}
              </AText>
            ) : null}
          </View>
          {right}
          {boardStatus ? <StatusPill tone={boardStatus.tone} label={boardStatus.label} /> : null}
        </View>
        {children}
      </View>
    </View>
  );
}
