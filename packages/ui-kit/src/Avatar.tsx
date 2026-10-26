import { Image, Text, View, type ImageSourcePropType } from 'react-native';
import { arcade, fontFamily, playerColor } from './theme';

export interface AvatarProps {
  name: string;
  colorIndex: number;
  /** Diameter in device-independent pixels (already scaled). */
  size: number;
  /** An illustrated or photo avatar. Without one, the player's initials on their colour. */
  image?: ImageSourcePropType;
  /** Greyed out, e.g. a player who is out of the game. */
  dimmed?: boolean;
}

/** "Alex" → "A", "Guest 3" → "G3", "Mary Jo Smith" → "MS". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

/**
 * A player's face. Identity is never colour alone: the initials (or the picture) carry it,
 * and screens always print the name beside it.
 *
 * The decorative ring is a thin cyan frame line separated by a dark gap. It is never gold
 * and never a rounded rectangle, so it cannot be mistaken for the remote's focus ring.
 */
export function Avatar({ name, colorIndex, size, image, dimmed }: AvatarProps) {
  const ring = Math.max(1, Math.round(size * 0.025));
  const gap = Math.max(2, Math.round(size * 0.045));
  const inner = size - 2 * (ring + gap);
  const initials = initialsOf(name);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`${name}'s avatar`}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: ring,
        borderColor: dimmed ? arcade.inkMute : arcade.frameDim,
        backgroundColor: arcade.bgDeep,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: dimmed ? 0.55 : 1,
      }}
    >
      <View
        style={{
          width: inner,
          height: inner,
          borderRadius: inner / 2,
          overflow: 'hidden',
          backgroundColor: playerColor(colorIndex),
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {image ? (
          <Image source={image} style={{ width: inner, height: inner }} resizeMode="cover" accessibilityIgnoresInvertColors />
        ) : (
          <Text
            style={{
              color: arcade.onAccent,
              fontFamily: fontFamily('display'),
              fontWeight: 'normal',
              fontSize: inner * (initials.length > 1 ? 0.42 : 0.52),
              lineHeight: inner * (initials.length > 1 ? 0.5 : 0.6),
              includeFontPadding: false,
              textAlign: 'center',
            }}
          >
            {initials}
          </Text>
        )}
      </View>
    </View>
  );
}
