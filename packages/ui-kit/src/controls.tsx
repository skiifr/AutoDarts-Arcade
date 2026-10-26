import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { AText } from './AText';
import { Focusable } from './Focusable';
import { useLayout } from './layout';
import { palette, playerColor, radius, space } from './theme';

// ── Button ───────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  /** A short glyph shown before the label, e.g. "▶" or "✎". */
  icon?: string;
  preferredFocus?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

const BUTTON_COLORS: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: palette.gold, fg: palette.onGold, border: palette.gold },
  secondary: { bg: palette.surfaceHi, fg: palette.text, border: palette.lineHi },
  ghost: { bg: 'transparent', fg: palette.textDim, border: palette.line },
  danger: { bg: '#3A1424', fg: palette.rose, border: palette.rose },
};

export function Button({ label, onPress, variant = 'secondary', size = 'md', icon, preferredFocus, disabled, style }: ButtonProps) {
  const { s } = useLayout();
  const c = BUTTON_COLORS[variant];
  const padV = size === 'lg' ? 12 : size === 'md' ? 9 : 6;
  const padH = size === 'lg' ? 26 : size === 'md' ? 18 : 12;
  return (
    <Focusable
      onPress={onPress}
      preferredFocus={preferredFocus}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      ringRadius={radius.md + 2}
      style={style}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: s(space.sm),
          paddingVertical: s(padV),
          paddingHorizontal: s(padH),
          borderRadius: s(radius.md),
          backgroundColor: c.bg,
          borderWidth: s(1),
          borderColor: c.border,
        }}
      >
        {icon ? (
          <AText variant="label" color={c.fg}>
            {icon}
          </AText>
        ) : null}
        <AText variant={size === 'lg' ? 'h3' : 'label'} color={c.fg} upper>
          {label}
        </AText>
      </View>
    </Focusable>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function Panel({ children, style, tone = 'surface' }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: 'surface' | 'raised' }) {
  const { s } = useLayout();
  return (
    <View
      style={[
        {
          backgroundColor: tone === 'surface' ? palette.surface : palette.bgRaised,
          borderColor: palette.line,
          borderWidth: s(1),
          borderRadius: s(radius.lg),
          padding: s(space.lg),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ── StatusPill ───────────────────────────────────────────────────────────────

export type BoardStatusTone = 'online' | 'demo' | 'offline' | 'connecting';

const STATUS_COLORS: Record<BoardStatusTone, string> = {
  online: palette.mint,
  demo: palette.cyan,
  offline: palette.amber,
  connecting: palette.textMute,
};

export function StatusPill({ tone, label }: { tone: BoardStatusTone; label: string }) {
  const { s } = useLayout();
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`Board status: ${label}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: s(space.sm),
        paddingVertical: s(5),
        paddingHorizontal: s(space.md),
        borderRadius: s(radius.pill),
        backgroundColor: palette.bgRaised,
        borderWidth: s(1),
        borderColor: palette.line,
      }}
    >
      <View style={{ width: s(8), height: s(8), borderRadius: s(4), backgroundColor: STATUS_COLORS[tone] }} />
      <AText variant="caption" color="textDim">
        {label}
      </AText>
    </View>
  );
}

// ── Banner ───────────────────────────────────────────────────────────────────

export type BannerTone = 'gold' | 'amber' | 'cyan' | 'rose';

const BANNER_COLORS: Record<BannerTone, string> = {
  gold: palette.gold,
  amber: palette.amber,
  cyan: palette.cyan,
  rose: palette.rose,
};

export interface BannerProps {
  tone: BannerTone;
  icon: string;
  title: string;
  detail?: string;
  action?: { label: string; onPress: () => void };
}

export function Banner({ tone, icon, title, detail, action }: BannerProps) {
  const { s } = useLayout();
  const color = BANNER_COLORS[tone];
  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutUp.duration(160)}
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: s(space.md),
        paddingVertical: s(space.sm),
        paddingHorizontal: s(space.lg),
        borderRadius: s(radius.md),
        backgroundColor: palette.bgRaised,
        borderWidth: s(1.5),
        borderColor: color,
      }}
    >
      <AText variant="h3" color={color}>
        {icon}
      </AText>
      <View style={{ flex: 1 }}>
        <AText variant="label" color={color} upper>
          {title}
        </AText>
        {detail ? (
          <AText variant="caption" color="textDim">
            {detail}
          </AText>
        ) : null}
      </View>
      {action ? <Button label={action.label} onPress={action.onPress} size="sm" variant="ghost" /> : null}
    </Animated.View>
  );
}

// ── Stepper (◀ value ▶) ──────────────────────────────────────────────────────

export interface StepperProps {
  label: string;
  value: string;
  onPrev: () => void;
  onNext: () => void;
  preferredFocus?: boolean;
}

export function Stepper({ label, value, onPrev, onNext, preferredFocus }: StepperProps) {
  const { s } = useLayout();
  const arrow = (glyph: string, onPress: () => void, focus?: boolean) => (
    <Focusable
      onPress={onPress}
      preferredFocus={focus}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${glyph === '◀' ? 'previous' : 'next'}`}
      ringRadius={radius.sm + 2}
    >
      <View
        style={{
          width: s(30),
          height: s(30),
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: s(radius.sm),
          backgroundColor: palette.surfaceHi,
        }}
      >
        <AText variant="label" color="gold">
          {glyph}
        </AText>
      </View>
    </Focusable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.sm) }}>
      <AText variant="caption" color="textDim" style={{ flex: 1 }}>
        {label}
      </AText>
      {arrow('◀', onPrev, preferredFocus)}
      <AText variant="h3" align="center" style={{ minWidth: s(92) }}>
        {value}
      </AText>
      {arrow('▶', onNext)}
    </View>
  );
}

// ── PlayerBadge ──────────────────────────────────────────────────────────────

export interface PlayerBadgeProps {
  /** 1-based position shown inside the colour square, so identity is never colour alone. */
  number: number;
  colorIndex: number;
  name: string;
  score?: number | string;
  active?: boolean;
  size?: 'sm' | 'md';
}

export function PlayerBadge({ number, colorIndex, name, score, active, size = 'md' }: PlayerBadgeProps) {
  const { s } = useLayout();
  const color = playerColor(colorIndex);
  const box = size === 'md' ? 26 : 20;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: s(space.sm),
        paddingVertical: s(size === 'md' ? 7 : 4),
        paddingHorizontal: s(space.sm),
        borderRadius: s(radius.md),
        backgroundColor: active ? palette.surfaceHi : 'transparent',
        borderWidth: s(1.5),
        borderColor: active ? color : 'transparent',
      }}
    >
      <View
        style={{
          width: s(box),
          height: s(box),
          borderRadius: s(radius.sm),
          backgroundColor: color,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <AText variant="label" color="onGold">
          {number}
        </AText>
      </View>
      <AText variant={size === 'md' ? 'h3' : 'body'} upper numberOfLines={1} style={{ flex: 1 }}>
        {name}
      </AText>
      {score !== undefined ? (
        <AText variant={size === 'md' ? 'h2' : 'h3'} color={active ? 'gold' : 'text'} style={{ fontVariant: ['tabular-nums'] }}>
          {score}
        </AText>
      ) : null}
    </View>
  );
}

// ── DartChip ─────────────────────────────────────────────────────────────────

export type DartChipState = 'empty' | 'filled' | 'selected' | 'adjusted' | 'add';

export interface DartChipProps {
  index: number;
  label?: string;
  points?: number;
  state: DartChipState;
  /** `lg` for read-at-a-distance chips (the dart ticker). */
  size?: 'md' | 'lg';
}

/** One dart of a turn: "① T20 60". Purely visual; wrap in Focusable to make it selectable. */
export function DartChip({ index, label, points, state, size = 'md' }: DartChipProps) {
  const { s } = useLayout();
  const lg = size === 'lg';
  const border =
    state === 'selected' ? palette.gold : state === 'adjusted' ? palette.cyan : state === 'add' ? palette.lineHi : palette.line;
  const dot = lg ? 30 : 20;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: s(lg ? space.md : space.sm),
        paddingVertical: s(lg ? 12 : 6),
        paddingHorizontal: s(lg ? space.lg : space.md),
        borderRadius: s(lg ? radius.lg : radius.md),
        borderWidth: s(1.5),
        borderStyle: state === 'add' ? 'dashed' : 'solid',
        borderColor: border,
        backgroundColor: state === 'empty' || state === 'add' ? 'transparent' : palette.surfaceHi,
      }}
    >
      <View
        style={{
          width: s(dot),
          height: s(dot),
          borderRadius: s(dot / 2),
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: state === 'empty' ? palette.line : palette.gold,
        }}
      >
        <AText variant={lg ? 'label' : 'caption'} color={state === 'empty' ? 'textMute' : 'onGold'} style={{ fontWeight: '900' }}>
          {index}
        </AText>
      </View>
      <AText variant={lg ? 'h1' : 'h3'} color={state === 'empty' ? 'textMute' : state === 'add' ? 'textDim' : 'text'} style={{ flex: 1 }}>
        {state === 'empty' ? '·  ·  ·' : state === 'add' ? '+ add missed dart' : label}
      </AText>
      {points !== undefined && state !== 'empty' && state !== 'add' ? (
        <AText variant={lg ? 'h2' : 'h3'} color={state === 'adjusted' ? 'cyan' : 'textDim'} style={{ fontVariant: ['tabular-nums'] }}>
          {points}
        </AText>
      ) : null}
    </View>
  );
}
