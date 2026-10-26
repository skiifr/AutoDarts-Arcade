import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { G, Line, Path, Rect } from 'react-native-svg';
import { AText } from './AText';
import { useLayout } from './layout';
import { arcade } from './theme';

/**
 * Framed navy panel with an optional heading plate ("UP NOW", "UP NEXT"). Frames are thin
 * cyan lines; the heading takes the game's accent. Never gold: gold is the focus ring.
 */
export function ArcadePanel({
  heading,
  accent = arcade.frame,
  children,
  style,
  contentStyle,
}: {
  heading?: string;
  accent?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const { s } = useLayout();
  return (
    <View
      style={[
        {
          backgroundColor: arcade.panel,
          borderRadius: s(8),
          borderWidth: s(1),
          borderColor: arcade.frameDim,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {heading ? (
        <View
          style={{
            paddingVertical: s(5),
            alignItems: 'center',
            backgroundColor: arcade.plate,
            borderBottomWidth: s(1),
            borderBottomColor: arcade.frameDim,
          }}
        >
          <AText variant="headline" color={accent} upper style={{ fontSize: s(22), lineHeight: s(24), letterSpacing: s(1.5) }}>
            {heading}
          </AText>
        </View>
      ) : null}
      <View style={[{ flex: 1, padding: s(8) }, contentStyle]}>{children}</View>
    </View>
  );
}

/** A small dart, drawn diagonally, for filled dart slots. */
export function DartGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <G transform="rotate(-45 20 20)">
        <Line x1={20} y1={36} x2={20} y2={24} stroke="#D7DEEE" strokeWidth={2.2} strokeLinecap="round" />
        <Rect x={17.4} y={12} width={5.2} height={13} rx={2.4} fill="#E2B357" />
        <Path d="M20 13 L11 1 L18 4 Z M20 13 L29 1 L22 4 Z" fill={color} />
      </G>
    </Svg>
  );
}
