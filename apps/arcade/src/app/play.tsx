import {
  AText,
  ArcadePanel,
  CommandRail,
  PlayerPanel,
  RailButton,
  StageBanner,
  StagePlaque,
  UpNextList,
  arcade,
  gameAccent,
  useLayout,
  type BannerProps,
} from '@arcade/ui-kit';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { BackHandler, Modal, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AVATAR_IMAGES } from '@/shell/art';
import { gameById } from '@/shell/catalog';
import { DemoDrawer } from '@/shell/DemoDrawer';
import { demo, useDemo, type ShellBanner, type ShellState } from '@/shell/demo-session';
import { GameStage, StageBackdrop, stageTexts } from '@/shell/stages';

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
        detail: 'Some darts were recovered after a reconnect, so check them.',
        action: { label: 'Fix', onPress: () => router.push('/fix') },
      };
    case 'stuck':
      return {
        tone: 'rose',
        icon: '⛔',
        title: 'Board stuck in takeout',
        detail: 'Reset the board from the Autodarts app. Until then you can enter darts manually.',
        action: { label: 'Enter manually', onPress: () => router.push({ pathname: '/fix', params: { add: '1' } }) },
      };
    case 'none':
      return null;
  }
}

/** Players after the thrower, in throwing order, leaving out anyone who is out. */
function upNext(state: ShellState) {
  const n = state.players.length;
  return Array.from({ length: Math.max(0, n - 1) }, (_, i) => state.players[(state.current + i + 1) % n]!).filter((p) => !p.out);
}

/**
 * W3 · Live gameplay: "Up now" on the left, the game's themed stage in the middle with its
 * title and instruction plaques (the instruction doubles as the warning banner), "Up next" on
 * the right, and the command rail. Fix throw is always one press away; the current turn's
 * three darts are always on screen. Demo darts live in the DEMO drawer, off the main rail.
 */
export default function PlayScreen() {
  const { s, mode, input, width, height, gutterX, gutterY } = useLayout();
  const insets = useSafeAreaInsets();
  const state = useDemo();
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [auto, setAuto] = useState(false);
  const [stageBox, setStageBox] = useState({ width: 0, height: 0 });
  const game = gameById(state.gameId);
  const accent = gameAccent(state.gameId);
  const wide = mode === 'wide';
  const remote = input === 'remote';
  const player = state.players[state.current];
  const banner = bannerFor(state.banner, state);
  const texts = stageTexts(state);

  useEffect(() => {
    if (state.players.length === 0) demo.start('siege', DEFAULT_PLAYERS, 5);
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

  // Back closes the demo drawer, otherwise pauses (the pause menu's own Back resumes).
  useEffect(() => {
    const back = () => {
      if (drawerOpen) setDrawerOpen(false);
      else if (!menuOpen) setMenuOpen(true);
      else return false;
      return true;
    };
    if (Platform.OS !== 'web') {
      const sub = BackHandler.addEventListener('hardwareBackPress', back);
      return () => sub.remove();
    }
    // Browser previews: Escape stands in for the remote's Back.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, menuOpen]);

  if (!player) return <View style={{ flex: 1, backgroundColor: arcade.bg }} />;

  // TV: the same inset frame as the approved mockups (well inside the 5% title-safe area);
  // the themed backdrop fills the screen behind it.
  const frameX = (wide && remote ? Math.round(width * 0.119) : gutterX) + Math.max(insets.left, insets.right);
  const frameTop = (wide && remote ? Math.round(height * 0.1) : gutterY) + insets.top;
  const frameBottom = (wide && remote ? Math.round(height * 0.085) : gutterY) + insets.bottom;
  const columnW = Math.round((width - frameX * 2) * 0.227);
  const sideH = height - frameTop - frameBottom - s(58);
  const next = upNext(state);
  const darts = state.turn.map((d) => ({ label: d.segment.label, adjusted: d.adjusted, void: d.scored === false }));
  const takeout = state.banner === 'takeout';
  const round = `Round ${state.round} of ${state.maxRounds}`;

  const upNow = (
    <PlayerPanel
      name={player.name}
      colorIndex={player.colorIndex}
      image={AVATAR_IMAGES[player.colorIndex]}
      score={texts.scores[state.current] ?? player.score}
      scoreLabel={texts.scoreLabel}
      darts={darts}
      turnLabel={state.turnSummary.label}
      turnValue={state.turnSummary.value}
      accent={accent}
      layout={wide ? 'column' : 'row'}
      avatarSize={Math.round(Math.max(s(44), Math.min(columnW * 0.68, sideH - s(12) - s(272))))}
      style={wide ? { flex: 1 } : undefined}
    />
  );

  const queue = (
    <UpNextList
      players={next.map((p) => ({
        key: p.id,
        name: p.name,
        colorIndex: p.colorIndex,
        image: AVATAR_IMAGES[p.colorIndex],
        score: texts.scores[state.players.indexOf(p)] ?? p.score,
      }))}
      accent={accent}
      layout={wide ? 'column' : 'row'}
      style={wide ? { flex: 1 } : undefined}
    />
  );

  const instruction = banner ? (
    <StageBanner key={state.banner} {...banner} />
  ) : (
    <StagePlaque kind="instruction" title={texts.instruction} kicker={texts.kicker} accent={accent} />
  );

  const stage = (
    <View
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
      onLayout={(e) => setStageBox({ width: Math.round(e.nativeEvent.layout.width), height: Math.round(e.nativeEvent.layout.height) })}
    >
      <GameStage state={state} width={stageBox.width} height={stageBox.height} accent={accent} takeout={takeout} />
    </View>
  );

  const rail = (
    <CommandRail
      brand={wide ? undefined : null}
      bleedX={frameX}
      style={{ marginTop: s(8) }}
      badge={
        <RailButton
          label="Demo"
          icon={drawerOpen ? 'chevron-down' : 'chevron-up'}
          variant="badge"
          active={drawerOpen}
          accessibilityLabel="Demo controls: simulated darts"
          onPress={() => setDrawerOpen((o) => !o)}
        />
      }
    >
      <RailButton icon="target" label="Fix throw" preferredFocus={remote} onPress={() => router.push('/fix')} />
      <RailButton icon="menu" label="Menu" onPress={() => setMenuOpen(true)} />
    </CommandRail>
  );

  return (
    <View style={{ flex: 1, backgroundColor: arcade.bg }}>
      <StageBackdrop gameId={state.gameId} accent={accent} />
      <View style={{ flex: 1, paddingLeft: frameX, paddingRight: frameX, paddingTop: frameTop, paddingBottom: frameBottom }}>
        {wide ? (
          <View style={{ flex: 1, flexDirection: 'row', gap: s(16) }}>
            <View style={{ width: columnW, paddingTop: s(12) }}>{upNow}</View>
            <View style={{ flex: 1, gap: s(4) }}>
              {/* Plaques stay above the stage, which may draw up behind the title. */}
              <StagePlaque kind="title" title={game.name} kicker={round} accent={accent} style={{ zIndex: 2 }} />
              {stage}
              <View style={{ zIndex: 2 }}>{instruction}</View>
            </View>
            <View style={{ width: columnW, paddingTop: s(12) }}>{queue}</View>
          </View>
        ) : (
          <View style={{ flex: 1, gap: s(8) }}>
            <StagePlaque kind="title" title={game.name} kicker={round} accent={accent} style={{ transform: [{ scale: 0.72 }], marginVertical: -s(12) }} />
            {upNow}
            {stage}
            {instruction}
            {queue}
          </View>
        )}
        {rail}
      </View>

      {drawerOpen ? (
        <DemoDrawer
          auto={auto}
          onToggleAuto={() => setAuto((a) => !a)}
          onClose={() => setDrawerOpen(false)}
          canThrow={state.turn.length < 3 && !takeout}
          // Over the stage, clear of the darts (Up now) and of the instruction / warning plaque.
          style={
            wide
              ? { position: 'absolute', left: frameX + columnW + s(16), right: frameX + columnW + s(16), bottom: frameBottom + s(124) }
              : { position: 'absolute', left: frameX, right: frameX, bottom: frameBottom + s(170) }
          }
        />
      ) : null}

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(3,7,17,0.82)', alignItems: 'center', justifyContent: 'center', padding: s(24) }}>
          <ArcadePanel heading="Paused" accent={accent} style={{ width: Math.min(width - s(48), s(340)) }} contentStyle={{ gap: s(8), padding: s(14) }}>
            <AText variant="cond" color="textDim" align="center">
              {`${game.name} · ${round}`}
            </AText>
            <RailButton icon="play" label="Resume" variant="solid" preferredFocus onPress={() => setMenuOpen(false)} />
            <RailButton
              icon="target"
              label="Fix throws"
              variant="solid"
              onPress={() => {
                setMenuOpen(false);
                router.push('/fix');
              }}
            />
            <RailButton
              icon="stop"
              label="End game now"
              variant="solid"
              onPress={() => {
                setMenuOpen(false);
                demo.finish();
              }}
            />
            <RailButton
              icon="arrow-left"
              label="Quit to games"
              variant="solid"
              onPress={() => {
                setMenuOpen(false);
                router.dismissTo('/games');
              }}
            />
          </ArcadePanel>
        </View>
      </Modal>
    </View>
  );
}
