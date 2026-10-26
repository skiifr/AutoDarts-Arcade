import type { ReactNode } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useLayout } from './layout';
import { fontFamily, palette, type PaletteKey, type TypeVariant, type as typeScale } from './theme';

export interface ATextProps {
  variant?: TypeVariant;
  color?: PaletteKey | (string & {});
  upper?: boolean;
  align?: TextStyle['textAlign'];
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  children: ReactNode;
}

const TIGHT: TypeVariant[] = ['kicker', 'condBold', 'headline', 'hero'];

/** Arcade text: one place for the type scale, so every size follows the layout scale. */
export function AText({ variant = 'body', color = 'text', upper, align, numberOfLines, style, children }: ATextProps) {
  const { s } = useLayout();
  const t = typeScale[variant];
  const resolved = color in palette ? palette[color as PaletteKey] : color;
  const family = 'family' in t ? t.family : undefined;
  const lineHeight = variant === 'body' || variant === 'caption' || variant === 'cond' ? 1.4 : TIGHT.includes(variant) ? 1.08 : 1.15;
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          color: resolved,
          fontSize: s(t.size),
          lineHeight: s(t.size * lineHeight),
          // A bundled face carries its own weight; asking for bold on top of it would make
          // iOS pick another face and the web synthesise a fake bold.
          fontFamily: family ? fontFamily(family) : undefined,
          fontWeight: family ? 'normal' : t.weight,
          letterSpacing: s(t.tracking),
          textAlign: align,
          textTransform: upper ? 'uppercase' : undefined,
          fontVariant: variant === 'score' || variant === 'hero' ? ['tabular-nums'] : undefined,
          includeFontPadding: family ? false : undefined,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
