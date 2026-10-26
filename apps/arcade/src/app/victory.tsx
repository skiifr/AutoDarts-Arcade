import { AText, Button, Confetti, Panel, PlayerBadge, palette, space, useLayout } from '@arcade/ui-kit';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { demo, standings, useDemo } from '@/shell/demo-session';
import { ScreenFrame } from '@/shell/ScreenFrame';

/** W5 · Victory. Results stay provisional until the players pick what's next. */
export default function VictoryScreen() {
  const { s, mode, input, width, height } = useLayout();
  const state = useDemo();
  const ranked = standings(state.players);
  const winner = ranked[0];
  const wide = mode === 'wide';

  useEffect(() => {
    if (state.players.length === 0) router.replace('/');
  }, [state.players.length]);

  if (!winner) return <View style={{ flex: 1, backgroundColor: palette.bg }} />;

  const rows = ranked.map((p, i) => {
    const hitRate = p.darts > 0 ? Math.round((p.scoringDarts / p.darts) * 100) : 0;
    return (
      <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.md) }}>
        <AText variant="h2" color={i === 0 ? 'gold' : 'textMute'} style={{ width: s(26) }} align="center">
          {i + 1}
        </AText>
        <View style={{ flex: 1 }}>
          <PlayerBadge number={state.players.indexOf(p) + 1} colorIndex={p.colorIndex} name={p.name} score={`${p.score} pts`} active={i === 0} size="sm" />
        </View>
        {wide ? (
          <>
            <AText variant="caption" color="textDim" style={{ width: s(96) }}>
              best turn {p.bestTurn}
            </AText>
            <AText variant="caption" color="textDim" style={{ width: s(96) }}>
              hit-rate {hitRate}%
            </AText>
          </>
        ) : null}
      </View>
    );
  });

  return (
    <ScreenFrame title="Game over" subtitle="Results are provisional until you choose what's next">
      <Confetti count={input === 'remote' ? 36 : 60} width={width} height={height} />
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', gap: s(space.lg), alignItems: 'center' }}>
        <Animated.View entering={ZoomIn.duration(420)}>
          <AText variant={wide ? 'display' : 'h1'} color="gold" upper align="center">
            {wide ? `✦ ${winner.name} wins! ✦` : `${winner.name} wins!`}
          </AText>
        </Animated.View>
        <Panel style={{ width: wide ? s(620) : '100%', gap: s(space.sm) }}>{rows}</Panel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: s(space.sm) }}>
          <Button
            label="Rematch"
            icon="▶"
            variant="primary"
            size="lg"
            preferredFocus
            onPress={() => {
              demo.rematch();
              router.replace('/play');
            }}
          />
          <Button label="New game, same players" onPress={() => router.dismissTo('/games')} />
          <Button label="Main menu" variant="ghost" onPress={() => router.dismissTo('/')} />
        </View>
        <Button label="Fix last turn" icon="✎" variant="ghost" size="sm" onPress={() => router.push('/fix')} />
      </ScrollView>
    </ScreenFrame>
  );
}
