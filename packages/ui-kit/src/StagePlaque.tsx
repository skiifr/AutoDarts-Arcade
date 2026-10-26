import { useState, type ReactNode } from 'react';
import { Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { AText } from './AText';
import { RailButton } from './CommandRail';
import type { BannerProps, BannerTone } from './controls';
import { Icon, type IconName } from './Icon';
import { useLayout } from './layout';
import { arcade, type TypeVariant } from './theme';

/** "ROUND 4 OF 10" with the numbers picked out in the accent. */
function Highlighted({ text, accent, variant, style }: { text: string; accent: string; variant: TypeVariant; style?: object }) {
  const parts = text.split(/(\d+)/);
  return (
    <AText variant={variant} upper align="center" style={style}>
      {parts.map((part, i) =>
        /^\d+$/.test(part) ? (
          <Text key={i} style={{ color: accent }}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </AText>
  );
}

function Plate({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { s } = useLayout();
  return (
    <View
      style={[
        {
          alignSelf: 'center',
          alignItems: 'center',
          paddingHorizontal: s(20),
          paddingVertical: s(5),
          borderRadius: s(8),
          backgroundColor: 'rgba(6, 13, 29, 0.88)',
          borderWidth: s(1),
          borderColor: arcade.frameDim,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface StagePlaqueProps {
  kind: 'title' | 'instruction';
  /** Game name on the title plaque, the instruction on the other ("HIT THE INVADERS' NUMBERS"). */
  title: string;
  /** The small line: "ROUND 4 OF 10" above the title, "DART 3 OF 3" under the instruction. */
  kicker?: string;
  accent: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * The stage's two plaques: the game title with the round above the stage, and the
 * instruction under it. Texts are always live; a painted frame can go behind later.
 */
export function StagePlaque({ kind, title, kicker, accent, style }: StagePlaqueProps) {
  const { s } = useLayout();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  // Shrink a long line to fit rather than cut it: condensed caps run about half an em.
  const fit = (base: number, padding: number) => (width > 0 ? Math.min(base, Math.floor((width - padding) / Math.max(1, title.length * 0.52))) : base);
  if (kind === 'title') {
    const size = fit(s(60), s(8));
    const text = {
      fontSize: size,
      lineHeight: Math.round(size * 1.02),
      letterSpacing: s(2.5),
    };
    return (
      <View style={[{ alignItems: 'center' }, style]} onLayout={onLayout}>
        {kicker ? (
          <Plate style={{ paddingHorizontal: s(22), paddingVertical: s(3) }}>
            <Highlighted text={kicker} accent={accent} variant="condBold" style={{ fontSize: s(20), lineHeight: s(22), letterSpacing: s(1.4) }} />
          </Plate>
        ) : null}
        {/* A dimensional title: the accent as an extrusion behind light lettering. */}
        <View>
          <AText variant="hero" color={accent} upper align="center" numberOfLines={1} style={[text, { position: 'absolute', left: 0, right: 0, top: s(3.5) }]}>
            {title}
          </AText>
          <AText
            variant="hero"
            color={arcade.ink}
            upper
            align="center"
            numberOfLines={1}
            style={[text, { textShadowColor: 'rgba(0, 0, 0, 0.7)', textShadowOffset: { width: 0, height: s(5) }, textShadowRadius: s(6) }]}
          >
            {title}
          </AText>
        </View>
      </View>
    );
  }
  return (
    <View style={[{ alignItems: 'center' }, style]} onLayout={onLayout}>
      <Plate style={{ alignSelf: 'stretch', paddingTop: s(4), paddingBottom: s(kicker ? 14 : 6) }}>
        <AText variant="headline" upper align="center" numberOfLines={1} style={{ fontSize: fit(s(34), s(44)), lineHeight: s(37) }}>
          {title}
        </AText>
      </Plate>
      {kicker ? (
        <Plate style={{ marginTop: -s(11), paddingHorizontal: s(18), paddingVertical: s(1) }}>
          <Highlighted text={kicker} accent={accent} variant="condBold" style={{ fontSize: s(18), lineHeight: s(20), letterSpacing: s(1.4) }} />
        </Plate>
      ) : null}
    </View>
  );
}

/** Gold is the focus ring, so the "gold" takeout tone is drawn white here. */
const TONES: Record<BannerTone, string> = {
  gold: arcade.ink,
  amber: arcade.warn,
  cyan: arcade.frame,
  rose: arcade.danger,
};
const ICONS: Record<BannerTone, IconName> = { gold: 'hand', amber: 'warning', cyan: 'review', rose: 'stop' };

/**
 * A warning in the instruction plaque's place (takeout, board offline, needs review, stuck),
 * over the themed stage. Its action is a normal focusable button, reachable by D-pad.
 */
export function StageBanner({ tone, title, detail, action, style }: BannerProps & { style?: StyleProp<ViewStyle> }) {
  const { s } = useLayout();
  const color = TONES[tone];
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[
        {
          flexDirection: 'row',
          alignItems: 'stretch',
          alignSelf: 'stretch',
          borderRadius: s(8),
          overflow: 'hidden',
          backgroundColor: 'rgba(3, 7, 17, 0.94)',
          borderWidth: s(1),
          borderColor: arcade.frameDim,
        },
        style,
      ]}
    >
      <View style={{ width: s(46), alignItems: 'center', justifyContent: 'center', backgroundColor: color }}>
        <Icon name={ICONS[tone]} size={s(26)} color={arcade.onAccent} />
      </View>
      <View style={{ flex: 1, justifyContent: 'center', paddingVertical: s(6), paddingHorizontal: s(12) }}>
        <AText variant="headline" color={color} upper numberOfLines={2} style={{ fontSize: s(25), lineHeight: s(27) }}>
          {title}
        </AText>
        {detail ? (
          <AText variant="cond" color="textDim" numberOfLines={2} style={{ fontSize: s(15), lineHeight: s(18) }}>
            {detail}
          </AText>
        ) : null}
      </View>
      {action ? (
        <View style={{ justifyContent: 'center', paddingRight: s(10) }}>
          <RailButton label={action.label} onPress={action.onPress} variant="solid" />
        </View>
      ) : null}
    </Animated.View>
  );
}
