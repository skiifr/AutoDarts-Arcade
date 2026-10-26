import { AText, Button, StatusPill, arcade, space, useLayout } from '@arcade/ui-kit';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArcadeBackdrop } from './ArcadeScreen';

export interface ScreenFrameProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  /** Extra controls on the right of the header, before the board status. */
  right?: ReactNode;
  boardStatus?: { tone: 'online' | 'demo' | 'offline' | 'connecting'; label: string } | null;
  children: ReactNode;
}

export function ScreenFrame({ title, subtitle, onBack, right, boardStatus = { tone: 'demo', label: 'Demo board' }, children }: ScreenFrameProps) {
  const { s, gutterX, gutterY, input, mode } = useLayout();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: arcade.bg }}>
      <ArcadeBackdrop />
      <View
        style={{
          flex: 1,
          paddingLeft: gutterX + insets.left,
          paddingRight: gutterX + insets.right,
          paddingTop: gutterY + insets.top,
          paddingBottom: gutterY + insets.bottom,
          gap: s(space.md),
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.md), flexWrap: mode === 'narrow' ? 'wrap' : 'nowrap' }}>
          {onBack && input === 'touch' ? <Button label="Back" icon="◀" variant="ghost" size="sm" onPress={onBack} /> : null}
          <View style={{ flex: 1, minWidth: s(160) }}>
            <AText variant="headline" upper numberOfLines={1} style={mode === 'wide' ? undefined : { fontSize: s(22), lineHeight: s(25) }}>
              {title}
            </AText>
            {subtitle ? (
              <AText variant="caption" color="textMute" numberOfLines={1}>
                {subtitle}
              </AText>
            ) : null}
          </View>
          {right}
          {boardStatus ? <StatusPill tone={boardStatus.tone} label={boardStatus.label} /> : null}
        </View>
        {children}
      </View>
    </View>
  );
}
