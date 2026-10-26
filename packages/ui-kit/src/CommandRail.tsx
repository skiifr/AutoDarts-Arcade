import { Children, Fragment, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { AText } from './AText';
import { Focusable } from './Focusable';
import { Icon, type IconName } from './Icon';
import { useLayout } from './layout';
import { arcade } from './theme';

export interface RailButtonProps {
  label: string;
  icon?: IconName;
  onPress?: () => void;
  preferredFocus?: boolean;
  disabled?: boolean;
  /** "badge": a small outlined pill (the DEMO switch); "solid": a filled call to action. */
  variant?: 'plain' | 'badge' | 'solid';
  /** Shown to screen readers when the label alone is not enough. */
  accessibilityLabel?: string;
  /** Marks a toggle that is on (e.g. the demo drawer is open). */
  active?: boolean;
}

/** A command on the rail, a banner action or a drawer control. Focus is the gold ring. */
export function RailButton({ label, icon, onPress, preferredFocus, disabled, variant = 'plain', accessibilityLabel, active }: RailButtonProps) {
  const { s } = useLayout();
  const badge = variant === 'badge';
  const solid = variant === 'solid';
  return (
    <Focusable
      onPress={onPress}
      preferredFocus={preferredFocus}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={active === undefined ? undefined : { expanded: active }}
      ringRadius={badge ? 14 : 9}
      focusScale={1.04}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(6),
          paddingVertical: s(badge ? 3 : 6),
          paddingHorizontal: s(badge ? 10 : 12),
          borderRadius: s(badge ? 12 : 7),
          backgroundColor: solid ? arcade.panelHi : active ? arcade.panelHi : 'transparent',
          borderWidth: s(1),
          borderColor: badge || solid ? arcade.frameDim : 'transparent',
        }}
      >
        {icon ? <Icon name={icon} size={s(badge ? 14 : 20)} color={badge ? arcade.inkDim : arcade.frame} /> : null}
        <AText variant={badge ? 'kicker' : 'condBold'} color={badge ? arcade.inkDim : arcade.ink} upper={badge}>
          {label}
        </AText>
      </View>
    </Focusable>
  );
}

export interface CommandRailProps {
  /** Two-tone brand ("AutoDarts", "Arcade"); null hides it (narrow phones). */
  brand?: [string, string] | null;
  /** Beside the brand, e.g. the DEMO switch. */
  badge?: ReactNode;
  /** Commands on the right, e.g. Fix throw and Menu. */
  children?: ReactNode;
  /** How far the rail's background bleeds past its parent (the screen gutters): decorative only. */
  bleedX?: number;
  bleedBottom?: number;
  style?: StyleProp<ViewStyle>;
}

function Divider() {
  const { s } = useLayout();
  return <View style={{ width: s(1), height: s(22), backgroundColor: arcade.frameDim }} />;
}

/**
 * The bottom command rail: brand, the DEMO switch and the few commands that must always be
 * one press away. The background may bleed to the screen edges; the contents stay inside
 * the parent's padding (the title-safe area on TV).
 */
export function CommandRail({ brand = ['AutoDarts', 'Arcade'], badge, children, bleedX = 0, bleedBottom = 0, style }: CommandRailProps) {
  const { s } = useLayout();
  const actions = Children.toArray(children).filter(Boolean);
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(10),
          marginHorizontal: -bleedX,
          paddingHorizontal: bleedX,
          marginBottom: -bleedBottom,
          paddingBottom: bleedBottom + s(4),
          paddingTop: s(4),
          backgroundColor: arcade.bgDeep,
          borderTopWidth: s(1),
          borderTopColor: arcade.frameDim,
        },
        style,
      ]}
    >
      {brand ? (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: s(5) }}>
          <AText variant="headline" upper style={{ fontSize: s(20), lineHeight: s(24) }}>
            {brand[0]}
          </AText>
          <AText variant="headline" upper color={arcade.frame} style={{ fontSize: s(20), lineHeight: s(24) }}>
            {brand[1]}
          </AText>
        </View>
      ) : null}
      {badge ? (
        <>
          {brand ? <Divider /> : null}
          {badge}
        </>
      ) : null}
      <View style={{ flex: 1 }} />
      {actions.map((action, i) => (
        <Fragment key={i}>
          {i > 0 ? <Divider /> : null}
          {action}
        </Fragment>
      ))}
    </View>
  );
}
