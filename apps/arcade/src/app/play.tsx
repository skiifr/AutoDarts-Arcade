import { points } from '@arcade/event-schema';
import {
  AText,
  Banner,
  Button,
  DartChip,
  Dartboard,
  Panel,
  PlayerBadge,
  palette,
  space,
  useLayout,
  type BannerProps,
} from '@arcade/ui-kit';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { gameById } from '@/shell/catalog';
import { demo, useDemo, type ShellBanner, type ShellState } from '@/shell/demo-session';
import { ScreenFrame } from '@/shell/ScreenFrame';

const DEFAULT_PLAYERS = [
  { name: 'Alex', colorIndex: 0 },
  { name: 'Jo', colorIndex: 1 },
  { name: 'Sam', colorIndex: 2 },
];

function bannerFor(kind: ShellBanner, state: ShellState): BannerProps | null {
  const next = state.players[(state.current + 1) % Math.max(1, state.players.length)];
  switch (kind) {
    case 'takeout':
      return {
        tone: 'gold',
        icon: '✋',
        title: 'Remove darts',
        detail: next ? `Next up: ${next.name}. The turn ends when the board is clear.` : undefined,
        action: { label: 'Board clear', onPress: demo.takeout },
      };
    case 'offline':
      return {
        tone: 'amber',
        icon: '⚠',
        title: 'Board connection lost — reconnecting (try 3)',
        detail: 'Throws will sync when the board is back.',
        action: { label: 'Enter manually', onPress: () => router.push({ pathname: '/fix', params: { add: '1' } }) },
      };
    case 'review':
      return {
        tone: 'cyan',
        icon: '⚠',
        title: 'This turn needs review',
        detail: 'Darts were recovered after a reconnect. Check them before play continues.',
        action: { label: 'Fix', onPress: () => router.push('/fix') },
      };
    case 'stuck':
      return {
        tone: 'rose',
        icon: '⛔',
        title: 'Board stuck in takeout',
        detail: 'A reset is only sent if Board control is turned on in Settings.',
        action: { label: 'Dismiss', onPress: () => demo.setBanner('none') },
      };
    case 'none':
      return null;
  }
}

/** W3 · Live gameplay. */
export default function PlayScreen() {
  const { s, mode, input, width, gutterX } = useLayout();
  const state = useDemo();
  const [menuOpen, setMenuOpen] = useState(false);
  const [auto, setAuto] = useState(false);
  const game = gameById(state.gameId);
  const wide = mode === 'wide';
  const player = state.players[state.current];
  const turnTotal = state.turn.reduce((sum, d) => sum + points(d.segment), 0);
  const lastDart = state.turn.find((d) => d.id === state.lastDartId);
  const banner = bannerFor(state.banner, state);

  useEffect(() => {
    if (state.players.length === 0) demo.start('siege', DEFAULT_PLAYERS, 3);
  }, [state.players.length]);

  useEffect(() => {
    if (state.finished) router.replace('/victory');
  }, [state.finished]);

  useEffect(() => {
    activateKeepAwakeAsync('play').catch(() => undefined);
    return () => {
      deactivateKeepAwake('play').catch(() => undefined);
    };
  }, []);

  // Demo autoplay: throw, wait, clear the board, repeat.
  useEffect(() => {
    if (!auto || menuOpen || state.finished) return;
    const t = setTimeout(() => (state.banner === 'takeout' ? demo.takeout() : demo.throwDart()), state.banner === 'takeout' ? 1300 : 1100);
    return () => clearTimeout(t);
  }, [auto, menuOpen, state]);

  if (!player) return <View style={{ flex: 1, backgroundColor: palette.bg }} />;

  const boardSize = wide ? s(290) : Math.min(width - gutterX * 2, s(300));
  const markers = state.turn.map((d, i) => ({
    number: d.segment.bed === 'miss' ? (d.segment.missSector ?? 20) : d.segment.number,
    bed: d.segment.bed,
    tone: i === state.turn.length - 1 ? ('gold' as const) : ('cyan' as const),
  }));
  const prompt =
    state.banner === 'takeout' || state.turn.length >= 3 ? 'Remove darts to end the turn' : `Dart ${state.turn.length + 1} of 3 — throw now`;

  const standings = (
    <View style={{ gap: s(space.xs) }}>
      {state.players.map((p, i) => (
        <PlayerBadge key={p.id} number={i + 1} colorIndex={p.colorIndex} name={p.name} score={p.score} active={i === state.current} size={wide ? 'md' : 'sm'} />
      ))}
    </View>
  );

  const stage = (
    <View style={{ alignItems: 'center', justifyContent: 'center', gap: s(space.sm), flex: wide ? 1 : undefined }}>
      <Dartboard size={boardSize} markers={markers} />
      <View style={{ height: s(34), justifyContent: 'center' }}>
        {lastDart ? (
          <Animated.View key={lastDart.id} entering={ZoomIn.duration(260)} style={{ flexDirection: 'row', alignItems: 'baseline', gap: s(space.sm) }}>
            <AText variant="h1" color={points(lastDart.segment) > 0 ? 'gold' : 'textMute'}>
              {lastDart.segment.label}
            </AText>
            <AText variant="h3" color="textDim">
              {points(lastDart.segment) > 0 ? `+${points(lastDart.segment)}` : 'no score'}
            </AText>
          </Animated.View>
        ) : (
          <AText variant="caption" color="textMute" upper>
            Waiting for the first dart
          </AText>
        )}
      </View>
    </View>
  );

  const compactTurn = (
    <View style={{ gap: s(space.sm) }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <AText variant="label" color="textMute" upper>
          {player.name} · this turn
        </AText>
        <AText variant="h2" color="gold">
          {turnTotal}
        </AText>
      </View>
      <View style={{ flexDirection: 'row', gap: s(space.sm) }}>
        {[0, 1, 2].map((i) => {
          const d = state.turn[i];
          return (
            <View key={i} style={{ flex: 1 }}>
              <DartChip index={i + 1} label={d?.segment.label} state={!d ? 'empty' : d.adjusted ? 'adjusted' : 'filled'} />
            </View>
          );
        })}
      </View>
    </View>
  );

  const turnPanel = (
    <View style={{ gap: s(space.sm) }}>
      <AText variant="label" color="textMute" upper>
        {player.name} · this turn
      </AText>
      {[0, 1, 2].map((i) => {
        const d = state.turn[i];
        return (
          <DartChip
            key={i}
            index={i + 1}
            label={d?.segment.label}
            points={d ? points(d.segment) : undefined}
            state={!d ? 'empty' : d.adjusted ? 'adjusted' : 'filled'}
          />
        );
      })}
      <View style={{ height: s(1), backgroundColor: palette.line, marginVertical: s(space.xs) }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <AText variant="label" color="textMute" upper>
          Turn
        </AText>
        <AText variant="score" color="gold">
          {turnTotal}
        </AText>
      </View>
    </View>
  );

  const controls = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.sm), flexWrap: 'wrap' }}>
      <AText variant="body" color="text" style={{ flex: 1, minWidth: s(150) }}>
        {prompt}
      </AText>
      <AText variant="label" color="cyan" upper>
        Demo
      </AText>
      <Button label="Throw" icon="🎯" size="sm" onPress={() => demo.throwDart()} preferredFocus={input === 'remote'} disabled={state.turn.length >= 3} />
      <Button label="Board clear" icon="✋" size="sm" onPress={demo.takeout} />
      <Button label={auto ? 'Stop' : 'Auto'} icon={auto ? '■' : '▶'} size="sm" variant="ghost" onPress={() => setAuto((a) => !a)} />
      <Button label="Fix" icon="✎" size="sm" variant="primary" onPress={() => router.push('/fix')} />
    </View>
  );

  return (
    <ScreenFrame
      title={`Round ${state.round} / ${state.maxRounds} · ${game.name}`}
      subtitle={`${player.name} to throw`}
      right={<Button label="Menu" size="sm" variant="ghost" onPress={() => setMenuOpen(true)} />}
    >
      {wide ? (
        <View style={{ flex: 1, flexDirection: 'row', gap: s(space.lg) }}>
          <Panel style={{ width: s(210), gap: s(space.sm) }}>
            <AText variant="label" color="textMute" upper>
              Standings
            </AText>
            {standings}
          </Panel>
          {stage}
          <Panel style={{ width: s(210) }}>{turnPanel}</Panel>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ gap: s(space.md), paddingBottom: s(space.md) }}>
          {standings}
          <Panel>{compactTurn}</Panel>
          {stage}
        </ScrollView>
      )}
      {banner ? <Banner key={state.banner} {...banner} /> : null}
      {controls}

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(5,7,14,0.82)', alignItems: 'center', justifyContent: 'center', padding: s(space.xl) }}>
          <Panel style={{ width: Math.min(width - s(space.xl) * 2, s(380)), gap: s(space.sm) }}>
            <AText variant="h2" upper color="gold">
              Paused
            </AText>
            <Button label="Resume" icon="▶" variant="primary" preferredFocus onPress={() => setMenuOpen(false)} />
            <Button
              label="Fix throws"
              icon="✎"
              onPress={() => {
                setMenuOpen(false);
                router.push('/fix');
              }}
            />
            <AText variant="label" color="textMute" upper style={{ marginTop: s(space.sm) }}>
              Demo: show a board state
            </AText>
            <View style={{ flexDirection: 'row', gap: s(space.sm), flexWrap: 'wrap' }}>
              {(['offline', 'review', 'stuck'] as const).map((b) => (
                <Button
                  key={b}
                  label={b === 'offline' ? 'Offline' : b === 'review' ? 'Needs review' : 'Stuck'}
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    demo.setBanner(b);
                    setMenuOpen(false);
                  }}
                />
              ))}
            </View>
            <View style={{ height: s(1), backgroundColor: palette.line, marginVertical: s(space.xs) }} />
            <Button
              label="End game now"
              onPress={() => {
                setMenuOpen(false);
                demo.finish();
              }}
            />
            <Button
              label="Quit to games"
              variant="danger"
              onPress={() => {
                setMenuOpen(false);
                router.dismissTo('/games');
              }}
            />
          </Panel>
        </View>
      </Modal>
    </ScreenFrame>
  );
}
