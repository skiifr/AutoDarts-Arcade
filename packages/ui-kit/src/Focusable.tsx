import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, type PressableProps, type StyleProp, type View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useLayout } from './layout';
import { palette } from './theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * On the web, a mouse click also focuses the element. Only show the focus treatment when the
 * last interaction was a key press, like the browser's :focus-visible.
 */
let webKeyboardMode = false;
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (webKeyboardMode = true), true);
  window.addEventListener('pointerdown', () => (webKeyboardMode = false), true);
}

export interface FocusState {
  focused: boolean;
  pressed: boolean;
}

export interface FocusableProps extends Omit<PressableProps, 'style' | 'children'> {
  children: ReactNode | ((state: FocusState) => ReactNode);
  style?: StyleProp<ViewStyle> | ((state: FocusState) => StyleProp<ViewStyle>);
  /** Take focus when the screen mounts (TV preferred focus; keyboard focus on web). */
  preferredFocus?: boolean;
  /** Scale applied while focused. */
  focusScale?: number;
  /** Corner radius of the focus ring, in design units. */
  ringRadius?: number;
  /** Hide the gold focus ring (for elements that draw their own focus state). */
  noRing?: boolean;
}

/**
 * Every interactive element in the arcade goes through this: one focus look (gold ring,
 * gentle scale) for TV remotes and keyboards, and plain presses for touch.
 */
export function Focusable({
  children,
  style,
  preferredFocus,
  focusScale = 1.05,
  ringRadius = 10,
  noRing,
  onFocus,
  onBlur,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: FocusableProps) {
  const { s, input } = useLayout();
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);
  const scale = useSharedValue(1);
  const ref = useRef<View>(null);

  useEffect(() => {
    if (preferredFocus && Platform.OS === 'web') {
      (ref.current as unknown as { focus?: () => void } | null)?.focus?.();
    }
  }, [preferredFocus]);

  // Remote and keyboard users need to see focus; touch users never do.
  const visibleFocus = focused && !disabled && (input === 'remote' || webKeyboardMode);

  useEffect(() => {
    scale.value = withTiming(visibleFocus ? focusScale : 1, { duration: 140 });
  }, [visibleFocus, focusScale, scale]);

  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const state: FocusState = { focused: visibleFocus, pressed };
  const showRing = visibleFocus && !noRing;

  return (
    <AnimatedPressable
      ref={ref}
      {...rest}
      disabled={disabled}
      hasTVPreferredFocus={preferredFocus}
      focusable={!disabled}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      onPressIn={(e) => {
        setPressed(true);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setPressed(false);
        onPressOut?.(e);
      }}
      style={[
        {
          borderRadius: s(ringRadius),
          borderWidth: s(2),
          borderColor: showRing ? palette.gold : 'transparent',
          opacity: disabled ? 0.45 : pressed && input === 'touch' ? 0.82 : 1,
        },
        showRing && {
          shadowColor: palette.gold,
          shadowOpacity: 0.55,
          shadowRadius: s(10),
          shadowOffset: { width: 0, height: 0 },
        },
        { outlineStyle: 'solid', outlineWidth: 0 },
        typeof style === 'function' ? style(state) : style,
        animated,
      ]}
    >
      {typeof children === 'function' ? children(state) : children}
    </AnimatedPressable>
  );
}
