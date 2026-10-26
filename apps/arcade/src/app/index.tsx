import { AText, Button, Panel, palette, radius, space, useLayout } from '@arcade/ui-kit';
import { router } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { ScreenFrame } from '@/shell/ScreenFrame';

/** W0 · Connect board (ARCHITECTURE §10). Discovery and the live adapter land in Phase 2. */
export default function ConnectScreen() {
  const { s, mode } = useLayout();
  const [address, setAddress] = useState('');
  const wide = mode === 'wide';

  return (
    <ScreenFrame title="Connect your board" subtitle="AutoDarts Arcade · shell build" boardStatus={{ tone: 'offline', label: 'No board' }}>
      <View style={{ flex: 1, flexDirection: wide ? 'row' : 'column', gap: s(space.lg) }}>
        <View style={{ flex: wide ? 1.2 : undefined, gap: s(space.lg) }}>
          <Panel style={{ gap: s(space.md) }}>
            <AText variant="label" color="textMute" upper>
              Found on this network
            </AText>
            <View
              style={{
                padding: s(space.md),
                borderRadius: s(radius.md),
                borderWidth: s(1),
                borderStyle: 'dashed',
                borderColor: palette.line,
              }}
            >
              <AText variant="h3" color="textDim">
                No boards found yet
              </AText>
              <AText variant="caption" color="textMute">
                Automatic discovery arrives with the board connection in the next build.
              </AText>
            </View>
          </Panel>

          <Panel style={{ gap: s(space.md) }}>
            <AText variant="label" color="textMute" upper>
              Or enter the board&apos;s address
            </AText>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.sm) }}>
              <TextInput
                value={address}
                onChangeText={setAddress}
                placeholder="e.g. 192.168.1.40"
                placeholderTextColor={palette.textMute}
                keyboardType="numbers-and-punctuation"
                autoCorrect={false}
                autoCapitalize="none"
                accessibilityLabel="Board IP address"
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: palette.text,
                  fontSize: s(16),
                  fontWeight: '700',
                  paddingVertical: s(8),
                  paddingHorizontal: s(space.md),
                  borderRadius: s(radius.md),
                  backgroundColor: palette.bgRaised,
                  borderWidth: s(1),
                  borderColor: palette.lineHi,
                  outlineStyle: 'solid',
                  outlineWidth: 0,
                }}
              />
              <AText variant="h3" color="textMute">
                :3180
              </AText>
              <Button label="Connect" disabled />
            </View>
            <AText variant="caption" color="textMute">
              Connecting to a real board is part of the next build. Use demo mode to try the arcade now.
            </AText>
          </Panel>
        </View>

        <Panel tone="raised" style={{ flex: wide ? 1 : undefined, justifyContent: 'space-between', gap: s(space.lg) }}>
          <View style={{ gap: s(space.sm) }}>
            <AText variant="h1" color="gold" upper>
              Demo mode
            </AText>
            <AText variant="body" color="textDim">
              Play every screen with simulated darts. Nothing connects to your board.
            </AText>
          </View>
          <Button label="Play demo" icon="▶" variant="primary" size="lg" preferredFocus onPress={() => router.push('/games')} />
          <AText variant="caption" color="textMute">
            ⓘ On iPhone and iPad, iOS will ask for &quot;Local Network&quot; access when you connect. It&apos;s needed to reach the board.
          </AText>
        </Panel>
      </View>
    </ScreenFrame>
  );
}
