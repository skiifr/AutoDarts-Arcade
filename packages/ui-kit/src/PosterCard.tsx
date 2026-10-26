import type { ReactNode } from 'react';
import { Image, Text, View, type ImageSourcePropType } from 'react-native';
import { AText } from './AText';
import { Focusable } from './Focusable';
import { useLayout } from './layout';
import { arcade, fontFamily } from './theme';

/** Poster height per unit of width (3 : 5.6). */
export const POSTER_ASPECT = 5.6 / 3;
/** Share of the card taken by the vertical title strip. */
const STRIP = 0.32;

export interface PosterCardProps {
  title: string;
  /** The game's accent: fills the title strip. */
  accent: string;
  /** Card width in device-independent pixels (already scaled). Height follows 3 : 5.6. */
  width: number;
  /** Poster illustration for the art area (no text in it: the title is rendered here). */
  image?: ImageSourcePropType;
  /** Drawn instead when there is no image, e.g. an SVG placeholder. */
  art?: ReactNode;
  /** A small corner tag, e.g. "Preview". */
  badge?: string;
  preferredFocus?: boolean;
  onPress?: () => void;
  onFocus?: () => void;
  accessibilityLabel?: string;
}

/**
 * Tall game poster: a vertical title strip in the game's accent and an art area that takes
 * an image. Focus is the shared gold ring (Focusable) and a gentle scale; the thin cyan
 * frame steps aside while focused so there is exactly one focus indicator.
 */
export function PosterCard({ title, accent, width, image, art, badge, preferredFocus, onPress, onFocus, accessibilityLabel }: PosterCardProps) {
  const { s } = useLayout();
  const height = Math.round(width * POSTER_ASPECT);
  const strip = Math.round(width * STRIP);
  const label = title.toUpperCase();
  // Fit the title along the strip: condensed caps average about half an em.
  const fontSize = Math.floor(Math.min(strip * 0.78, (height * 0.88) / Math.max(4, label.length * 0.5)));
  const corner = s(5);
  return (
    <Focusable
      preferredFocus={preferredFocus}
      onPress={onPress}
      onFocus={onFocus}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      focusScale={1.06}
      ringRadius={7}
    >
      {({ focused }) => (
        <View
          style={{
            width,
            height,
            flexDirection: 'row',
            borderRadius: corner,
            overflow: 'hidden',
            borderWidth: s(1.5),
            borderColor: focused ? 'transparent' : arcade.frame,
            backgroundColor: arcade.panel,
          }}
        >
          <View style={{ width: strip, backgroundColor: accent, overflow: 'hidden' }}>
            <View
              style={{
                position: 'absolute',
                width: height,
                height: strip,
                left: (strip - height) / 2,
                top: (height - strip) / 2,
                justifyContent: 'center',
                paddingHorizontal: Math.round(height * 0.035),
                transform: [{ rotate: '-90deg' }],
              }}
            >
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={{
                  color: arcade.onAccent,
                  fontFamily: fontFamily('display'),
                  fontWeight: 'normal',
                  fontSize,
                  lineHeight: Math.round(fontSize * 1.02),
                  letterSpacing: fontSize * 0.02,
                  includeFontPadding: false,
                }}
              >
                {label}
              </Text>
            </View>
          </View>
          <View style={{ width: s(1), backgroundColor: arcade.bgDeep }} />
          <View style={{ flex: 1, overflow: 'hidden', backgroundColor: arcade.panelHi }}>
            {image ? (
              <Image source={image} style={{ width: '100%', height: '100%' }} resizeMode="cover" accessibilityIgnoresInvertColors />
            ) : (
              art
            )}
            {badge ? (
              <View
                style={{
                  position: 'absolute',
                  top: s(6),
                  right: s(6),
                  paddingHorizontal: s(6),
                  paddingVertical: s(2),
                  borderRadius: s(4),
                  backgroundColor: 'rgba(3, 7, 17, 0.86)',
                  borderWidth: s(1),
                  borderColor: arcade.inkDim,
                }}
              >
                <AText variant="kicker" color={arcade.ink} upper style={{ fontSize: s(10), lineHeight: s(12) }}>
                  {badge}
                </AText>
              </View>
            ) : null}
          </View>
        </View>
      )}
    </Focusable>
  );
}
