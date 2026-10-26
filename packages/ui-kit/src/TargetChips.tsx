import { Fragment } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { AText } from './AText';
import { useLayout } from './layout';
import { arcade } from './theme';

/**
 * A route of targets as chips: "T20 · T19 · D12". Live data only (a checkout hint, the next
 * numbers to close); the screen hides it when there is nothing to suggest.
 */
export function TargetChips({ labels, accent, size = 'lg', style }: { labels: readonly string[]; accent: string; size?: 'md' | 'lg'; style?: StyleProp<ViewStyle> }) {
  const { s } = useLayout();
  const font = size === 'lg' ? 34 : 24;
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`Suggested: ${labels.join(', ')}`}
      style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: s(8) }, style]}
    >
      {labels.map((label, i) => (
        <Fragment key={`${label}-${i}`}>
          {i > 0 ? <View style={{ width: s(6), height: s(6), borderRadius: s(3), backgroundColor: accent }} /> : null}
          <View
            style={{
              minWidth: s(size === 'lg' ? 74 : 54),
              alignItems: 'center',
              paddingHorizontal: s(10),
              paddingVertical: s(1),
              borderRadius: s(7),
              backgroundColor: 'rgba(3, 7, 17, 0.9)',
              borderWidth: s(1.5),
              borderColor: accent,
            }}
          >
            <AText variant="hero" color={arcade.ink} style={{ fontSize: s(font), lineHeight: s(font * 1.12) }}>
              {label}
            </AText>
          </View>
        </Fragment>
      ))}
    </View>
  );
}
