import { LayoutProvider, palette } from '@arcade/ui-kit';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { INPUT_OVERRIDE } from '@/shell/input-override';

export default function RootLayout() {
  return (
    <SafeAreaProvider style={{ backgroundColor: palette.bg }}>
      <LayoutProvider input={INPUT_OVERRIDE}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'fade',
            contentStyle: { backgroundColor: palette.bg },
          }}
        />
      </LayoutProvider>
    </SafeAreaProvider>
  );
}
