import { AText, Button, Focusable, GameTileArt, Panel, palette, radius, space, useLayout } from '@arcade/ui-kit';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { CATEGORIES, GAMES, type GameCategory, type GameManifest } from '@/shell/catalog';
import { ScreenFrame } from '@/shell/ScreenFrame';

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);

function GameTile({ game, width, preferredFocus, onFocus }: { game: GameManifest; width: number; preferredFocus?: boolean; onFocus: () => void }) {
  const { s } = useLayout();
  return (
    <Focusable
      preferredFocus={preferredFocus}
      onFocus={onFocus}
      onPress={() => router.push({ pathname: '/setup', params: { game: game.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${game.name}, ${game.players.min} to ${game.players.max} players`}
      focusScale={1.07}
      ringRadius={radius.lg + 2}
    >
      {({ focused }) => (
        <View
          style={{
            width,
            borderRadius: s(radius.lg),
            overflow: 'hidden',
            backgroundColor: palette.surface,
            borderWidth: s(1),
            borderColor: focused ? palette.gold : palette.line,
          }}
        >
          <GameTileArt gameId={game.id} width={width} />
          <View style={{ padding: s(space.md), gap: s(2) }}>
            <AText variant="h3" upper numberOfLines={1} color={focused ? 'gold' : 'text'}>
              {game.name}
            </AText>
            <AText variant="caption" color="textMute">
              {game.players.min === game.players.max ? game.players.min : `${game.players.min}–${game.players.max}`} players
            </AText>
          </View>
        </View>
      )}
    </Focusable>
  );
}

/** W1 · Game selection. */
export default function GamesScreen() {
  const { s, mode, width, gutterX } = useLayout();
  const [category, setCategory] = useState<GameCategory>('party');
  const games = GAMES.filter((g) => g.category === category);
  const [focusedId, setFocusedId] = useState<string>(games[0]?.id ?? '');
  const focused = GAMES.find((g) => g.id === focusedId) ?? games[0];
  const wide = mode === 'wide';
  // Subtract the Focusable ring border (2 units each side) so two tiles fit per row on phones.
  const tileWidth = wide ? s(220) : Math.floor((width - gutterX * 2 - s(space.md)) / 2 - s(4));

  return (
    <ScreenFrame title="Arcade" subtitle="Choose a game" onBack={() => router.back()}>
      <View style={{ flexDirection: 'row', gap: s(space.sm) }}>
        {CATEGORIES.map((c) => {
          const active = c.id === category;
          return (
            <Focusable
              key={c.id}
              onPress={() => {
                setCategory(c.id);
                setFocusedId(GAMES.find((g) => g.category === c.id)?.id ?? '');
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              ringRadius={radius.pill}
            >
              <View
                style={{
                  paddingVertical: s(6),
                  paddingHorizontal: s(space.lg),
                  borderRadius: s(radius.pill),
                  backgroundColor: active ? palette.gold : palette.surface,
                  borderWidth: s(1),
                  borderColor: active ? palette.gold : palette.line,
                }}
              >
                <AText variant="label" upper color={active ? 'onGold' : 'textDim'}>
                  {c.label}
                </AText>
              </View>
            </Focusable>
          );
        })}
      </View>

      {wide ? (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: s(space.lg), paddingVertical: s(space.lg), paddingHorizontal: s(space.lg) }}
            style={{ flexGrow: 0, marginHorizontal: -s(space.lg) }}
          >
            {games.map((g, i) => (
              <GameTile key={g.id} game={g} width={tileWidth} preferredFocus={i === 0} onFocus={() => setFocusedId(g.id)} />
            ))}
          </ScrollView>
          {focused ? (
            <Panel style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.xl) }}>
              <View style={{ flex: 1, gap: s(space.xs) }}>
                <AText variant="h2" upper color="gold">
                  {focused.name}
                </AText>
                <AText variant="body" color="textDim">
                  {focused.tagline}
                </AText>
                <AText variant="caption" color="textMute">
                  ~{focused.minutes} min · 3 darts per turn · Skill {stars(focused.skill)}
                  {focused.teams ? ' · Teams supported' : ''}
                </AText>
              </View>
              <Button
                label="Choose"
                icon="▸"
                variant="primary"
                onPress={() => router.push({ pathname: '/setup', params: { game: focused.id } })}
              />
            </Panel>
          ) : null}
        </>
      ) : (
        <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: s(space.md), paddingBottom: s(space.xl) }}>
          {games.map((g, i) => (
            <View key={g.id} style={{ gap: s(space.xs) }}>
              <GameTile game={g} width={tileWidth} preferredFocus={i === 0} onFocus={() => setFocusedId(g.id)} />
              <AText variant="caption" color="textMute" style={{ width: tileWidth }}>
                {g.tagline}
              </AText>
            </View>
          ))}
        </ScrollView>
      )}
    </ScreenFrame>
  );
}
