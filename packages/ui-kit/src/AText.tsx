import type { ReactNode } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useLayout } from './layout';
import { palette, type PaletteKey, type TypeVariant, type as typeScale } from './theme';

export interface ATextProps {
  variant?: TypeVariant;
  color?: PaletteKey | (string & {});
  upper?: boolean;
  align?: TextStyle['textAlign'];
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  children: ReactNode;
}

/** Arcade text: one place for the type scale, so every size follows the layout scale. */
export function AText({ variant = 'body', color = 'text', upper, align, numberOfLines, style, children }: ATextProps) {
  const { s } = useLayout();
  const t = typeScale[variant];
  const resolved = color in palette ? palette[color as PaletteKey] : color;
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          color: resolved,
          fontSize: s(t.size),
          lineHeight: s(t.size * (variant === 'body' || variant === 'caption' ? 1.4 : 1.15)),
          fontWeight: t.weight,
          letterSpacing: s(t.tracking),
          textAlign: align,
          textTransform: upper ? 'uppercase' : undefined,
          fontVariant: variant === 'score' ? ['tabular-nums'] : undefined,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
