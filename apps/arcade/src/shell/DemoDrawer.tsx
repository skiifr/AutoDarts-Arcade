import { AText, FocusGuide, RailButton, arcade, useLayout } from '@arcade/ui-kit';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { demo, type ShellBanner } from './demo-session';

export interface DemoDrawerProps {
  auto: boolean;
  onToggleAuto: () => void;
  onClose: () => void;
  canThrow: boolean;
  style?: StyleProp<ViewStyle>;
}

const STATES: { banner: ShellBanner; label: string }[] = [
  { banner: 'offline', label: 'Offline' },
  { banner: 'review', label: 'Needs review' },
  { banner: 'stuck', label: 'Stuck' },
  { banner: 'none', label: 'Normal' },
];

/**
 * The demo surface: simulated darts and board states, kept off the main command rail and
 * labelled so nobody mistakes it for the real board. Opens from the DEMO switch; Back closes it.
 */
export function DemoDrawer({ auto, onToggleAuto, onClose, canThrow, style }: DemoDrawerProps) {
  const { s } = useLayout();
  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      accessibilityRole="menu"
      accessibilityLabel="Demo controls"
      style={[
        {
          gap: s(8),
          padding: s(8),
          borderRadius: s(8),
          backgroundColor: 'rgba(3, 7, 17, 0.96)',
          borderWidth: s(1),
          borderColor: arcade.frameDim,
        },
        style,
      ]}
    >
      <FocusGuide trapFocusUp trapFocusLeft trapFocusRight style={{ gap: s(6) }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: s(8) }}>
          <AText variant="headline" upper color={arcade.frame} style={{ fontSize: s(20), lineHeight: s(22) }}>
            Demo controls
          </AText>
          <AText variant="cond" color="textDim" style={{ fontSize: s(13), lineHeight: s(16) }}>
            Simulated darts. Nothing here talks to your board.
          </AText>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: s(6) }}>
          <RailButton icon="dart" label="Throw dart" variant="solid" preferredFocus disabled={!canThrow} onPress={() => demo.throwDart()} />
          <RailButton icon="hand" label="Board clear" variant="solid" onPress={demo.takeout} />
          <RailButton icon={auto ? 'stop' : 'play'} label={auto ? 'Stop auto' : 'Auto play'} variant="solid" onPress={onToggleAuto} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: s(6) }}>
          <AText variant="kicker" color="textDim" upper>
            Board state
          </AText>
          {STATES.map((st) => (
            <RailButton key={st.banner} label={st.label} variant="solid" onPress={() => demo.setBanner(st.banner)} />
          ))}
          <RailButton icon="chevron-down" label="Close" onPress={onClose} />
        </View>
      </FocusGuide>
    </Animated.View>
  );
}
