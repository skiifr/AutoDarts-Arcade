import { AText, Button, Focusable, Panel, PlayerBadge, Stepper, palette, radius, space, useLayout } from '@arcade/ui-kit';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { DEMO_PROFILES, gameById } from '@/shell/catalog';
import { demo } from '@/shell/demo-session';
import { ScreenFrame } from '@/shell/ScreenFrame';

interface SetupPlayer {
  key: string;
  name: string;
  colorIndex: number;
}

const ORDERS = ['As listed', 'Random'];

function nextColor(players: SetupPlayer[]): number {
  for (let c = 0; c < 8; c++) if (!players.some((p) => p.colorIndex === c)) return c;
  return players.length % 8;
}

function IconButton({ glyph, label, onPress }: { glyph: string; label: string; onPress: () => void }) {
  const { s } = useLayout();
  return (
    <Focusable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} ringRadius={radius.sm + 2}>
      <View
        style={{
          width: s(28),
          height: s(28),
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: s(radius.sm),
          backgroundColor: palette.surfaceHi,
        }}
      >
        <AText variant="label" color="textDim">
          {glyph}
        </AText>
      </View>
    </Focusable>
  );
}

/** W2 · Player setup. */
export default function SetupScreen() {
  const { s, mode } = useLayout();
  const params = useLocalSearchParams<{ game?: string }>();
  const game = gameById(params.game);
  const [players, setPlayers] = useState<SetupPlayer[]>([
    { key: 'Alex', name: 'Alex', colorIndex: 0 },
    { key: 'Jo', name: 'Jo', colorIndex: 1 },
  ]);
  const [guestCount, setGuestCount] = useState(0);
  const [optionIndex, setOptionIndex] = useState<Record<string, number>>(() =>
    Object.fromEntries(game.options.map((o) => [o.key, o.defaultIndex])),
  );
  const [order, setOrder] = useState(0);
  const wide = mode === 'wide';

  const add = (name: string) => {
    if (players.length >= game.players.max) return;
    setPlayers((ps) => [...ps, { key: `${name}-${ps.length}`, name, colorIndex: nextColor(ps) }]);
  };
  const remove = (key: string) => setPlayers((ps) => ps.filter((p) => p.key !== key));
  const moveUp = (index: number) =>
    setPlayers((ps) => {
      if (index === 0) return ps;
      const next = [...ps];
      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
      return next;
    });

  const recent = DEMO_PROFILES.filter((n) => !players.some((p) => p.name === n)).slice(0, 3);
  const tooFew = players.length < game.players.min;
  const start = () => {
    const list = ORDERS[order] === 'Random' ? [...players].sort(() => Math.random() - 0.5) : players;
    const roundsOption = game.options.find((o) => o.key === 'rounds');
    const rounds = roundsOption ? Number(roundsOption.values[optionIndex.rounds ?? 0]) : 3;
    demo.start(game.id, list.map((p) => ({ name: p.name, colorIndex: p.colorIndex })), rounds);
    router.replace('/play');
  };

  const playerList = (
    <Panel style={{ flex: wide ? 1.3 : undefined, gap: s(space.sm) }}>
      <AText variant="label" color="textMute" upper>
        Turn order
      </AText>
      {players.map((p, i) => (
        <View key={p.key} style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.sm) }}>
          <View style={{ flex: 1 }}>
            <PlayerBadge number={i + 1} colorIndex={p.colorIndex} name={p.name} size="sm" />
          </View>
          {i > 0 ? <IconButton glyph="↑" label={`Move ${p.name} up`} onPress={() => moveUp(i)} /> : <View style={{ width: s(28) + s(4) }} />}
          <IconButton glyph="✕" label={`Remove ${p.name}`} onPress={() => remove(p.key)} />
        </View>
      ))}
      {Array.from({ length: Math.max(0, Math.min(4, game.players.max) - players.length) }, (_, i) => (
        <View
          key={`empty-${i}`}
          style={{
            paddingVertical: s(6),
            paddingHorizontal: s(space.md),
            borderRadius: s(radius.md),
            borderWidth: s(1),
            borderStyle: 'dashed',
            borderColor: palette.line,
          }}
        >
          <AText variant="caption" color="textMute">
            {players.length + i + 1} — empty —
          </AText>
        </View>
      ))}
    </Panel>
  );

  const addPanel = (
    <Panel style={{ flex: wide ? 1 : undefined, gap: s(space.sm) }}>
      <AText variant="label" color="textMute" upper>
        Add player
      </AText>
      {recent.map((name, i) => (
        <Button key={name} label={`+ ${name}`} variant="secondary" onPress={() => add(name)} preferredFocus={i === 0} />
      ))}
      <Button
        label="+ Guest"
        variant="ghost"
        onPress={() => {
          setGuestCount((g) => g + 1);
          add(`Guest ${guestCount + 1}`);
        }}
      />
    </Panel>
  );

  const optionsPanel = (
    <Panel style={{ gap: s(space.md) }}>
      <AText variant="label" color="textMute" upper>
        Options
      </AText>
      <View style={{ flexDirection: wide ? 'row' : 'column', flexWrap: 'wrap', columnGap: s(space.xxl), rowGap: s(space.md) }}>
        {game.options.map((o) => {
          const idx = optionIndex[o.key] ?? o.defaultIndex;
          const step = (d: number) => setOptionIndex((m) => ({ ...m, [o.key]: (idx + d + o.values.length) % o.values.length }));
          return (
            <View key={o.key} style={{ minWidth: wide ? s(300) : undefined }}>
              <Stepper label={o.label} value={o.values[idx] ?? ''} onPrev={() => step(-1)} onNext={() => step(1)} />
            </View>
          );
        })}
        <View style={{ minWidth: wide ? s(300) : undefined }}>
          <Stepper
            label="Turn order"
            value={ORDERS[order] ?? ''}
            onPrev={() => setOrder((o) => (o + 1) % 2)}
            onNext={() => setOrder((o) => (o + 1) % 2)}
          />
        </View>
      </View>
    </Panel>
  );

  const footer = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.lg) }}>
      <AText variant="caption" color={tooFew ? 'amber' : 'textMute'} style={{ flex: 1 }}>
        ⓘ {game.players.min}–{game.players.max} players{tooFew ? ` · add ${game.players.min - players.length} more to start` : ' · demo board ready'}
      </AText>
      <Button label="Start game" icon="▶" variant="primary" size="lg" disabled={tooFew} onPress={start} />
    </View>
  );

  return (
    <ScreenFrame title={`${game.name} · Players & options`} subtitle="Step 2 of 2" onBack={() => router.back()}>
      {wide ? (
        <View style={{ flex: 1, gap: s(space.md) }}>
          <View style={{ flex: 1, flexDirection: 'row', gap: s(space.lg) }}>
            {playerList}
            {addPanel}
          </View>
          {optionsPanel}
          {footer}
        </View>
      ) : (
        <>
          <ScrollView contentContainerStyle={{ gap: s(space.md), paddingBottom: s(space.lg) }}>
            {playerList}
            {addPanel}
            {optionsPanel}
          </ScrollView>
          {footer}
        </>
      )}
    </ScreenFrame>
  );
}
