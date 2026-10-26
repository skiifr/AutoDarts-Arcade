import { AText, FocusGuide, Focusable, Icon, POSTER_ASPECT, PosterArt, PosterCard, arcade, gameAccent, useLayout } from '@arcade/ui-kit';
import { router } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { POSTER_IMAGES } from '@/shell/art';
import { ArcadeScreen } from '@/shell/ArcadeScreen';
import { FILTERS, GAMES, gamesIn, type GameFilter, type GameManifest } from '@/shell/catalog';
import { demo } from '@/shell/demo-session';

const choose = (game: GameManifest) => router.push({ pathname: '/setup', params: { game: game.id } });
const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

function Brand({ size }: { size: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: size * 0.3 }}>
      <AText variant="headline" upper style={{ fontSize: size, lineHeight: size * 1.15, letterSpacing: size * 0.08 }}>
        AutoDarts
      </AText>
      <AText variant="headline" upper color={arcade.frame} style={{ fontSize: size, lineHeight: size * 1.15, letterSpacing: size * 0.08 }}>
        Arcade
      </AText>
    </View>
  );
}

function Poster({ game, width, preferredFocus, onFocus }: { game: GameManifest; width: number; preferredFocus?: boolean; onFocus?: () => void }) {
  const accent = gameAccent(game.id);
  return (
    <PosterCard
      title={game.name}
      accent={accent}
      width={width}
      image={POSTER_IMAGES[game.id]}
      art={<PosterArt gameId={game.id} accent={accent} />}
      badge={game.preview ? 'Preview' : undefined}
      preferredFocus={preferredFocus}
      onFocus={onFocus}
      onPress={() => choose(game)}
      accessibilityLabel={`${game.name}. ${game.pitch} ${game.players.min} to ${game.players.max} players.${game.preview ? ' Preview: demo scoring.' : ''}`}
    />
  );
}

function Tabs({ filter, onSelect, size }: { filter: GameFilter; onSelect: (f: GameFilter) => void; size: number }) {
  const { s } = useLayout();
  return (
    <FocusGuide autoFocus style={{ flexDirection: 'row', alignItems: 'center', gap: s(4) }}>
      {FILTERS.map((f, i) => {
        const active = f.id === filter;
        return (
          <View key={f.id} style={{ flexDirection: 'row', alignItems: 'center', gap: s(4) }}>
            {i > 0 ? <View style={{ width: s(1), height: size, backgroundColor: arcade.frameDim }} /> : null}
            <Focusable onPress={() => onSelect(f.id)} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={f.label} ringRadius={6} focusScale={1.04}>
              <View style={{ paddingHorizontal: s(10), paddingTop: s(2), paddingBottom: s(3), alignItems: 'center' }}>
                <AText variant="headline" upper color={active ? arcade.ink : arcade.inkMute} style={{ fontSize: size, lineHeight: size * 1.15, letterSpacing: size * 0.06 }}>
                  {f.label}
                </AText>
                <View style={{ alignSelf: 'stretch', height: s(2.5), marginTop: s(2), borderRadius: s(2), backgroundColor: active ? arcade.frame : 'transparent' }} />
              </View>
            </Focusable>
          </View>
        );
      })}
    </FocusGuide>
  );
}

function Caption({ game, size }: { game: GameManifest; size: number }) {
  return (
    <AText variant="cond" align="center" numberOfLines={1} style={{ fontSize: size, lineHeight: size * 1.25 }}>
      <AText variant="condBold" upper style={{ fontSize: size, lineHeight: size * 1.25 }}>
        {game.name}
      </AText>
      <AText variant="cond" color={arcade.frame} style={{ fontSize: size, lineHeight: size * 1.25 }}>
        {'  ·  '}
      </AText>
      {game.pitch}
      {game.preview ? (
        <AText variant="cond" color="textDim" style={{ fontSize: size, lineHeight: size * 1.25 }}>
          {'  (preview: demo scoring)'}
        </AText>
      ) : null}
    </AText>
  );
}

/** A remote hint ("BACK", "OK CHOOSE"); a real button for touch and mouse. */
function Hint({ glyph, label, onPress, remote }: { glyph: ReactNode; label: string; onPress: () => void; remote: boolean }) {
  const { s } = useLayout();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8), padding: s(3) }}>
      <View style={{ width: s(34), height: s(34), borderRadius: s(17), borderWidth: s(2), borderColor: arcade.frame, alignItems: 'center', justifyContent: 'center' }}>{glyph}</View>
      <AText variant="headline" upper style={{ fontSize: s(18), lineHeight: s(21) }}>
        {label}
      </AText>
    </View>
  );
  // On a TV these are reminders of the remote's own buttons, so they never take focus.
  if (remote) return <View accessibilityLabel={`${label}: press the remote's ${label === 'Back' ? 'Back' : 'OK'} button`}>{body}</View>;
  return (
    <Focusable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} ringRadius={20} focusScale={1.03}>
      {body}
    </Focusable>
  );
}

/**
 * W1 · Game selection: a row of tall posters filtered by the tabs, the focused game's
 * one-line pitch, and CHOOSE YOUR GAME. Remote: ◀ ▶ across the posters (the row scrolls to
 * keep the focused one in view), ▲ to the tabs, ▼ back to the posters, OK to choose, Back.
 */
export default function GamesScreen() {
  const { s, mode, input, width, height, gutterX, gutterY } = useLayout();
  const remote = input === 'remote';
  const [filter, setFilter] = useState<GameFilter>('all');
  const [focusedId, setFocusedId] = useState(() => {
    const last = demo.getState();
    return last.players.length > 0 ? last.gameId : (GAMES[0]?.id ?? '');
  });
  const scroller = useRef<ScrollView>(null);
  const offset = useRef(0);
  const [scrollX, setScrollX] = useState(0);
  const games = gamesIn(filter);
  const shown = games.find((g) => g.id === focusedId) ?? games[0];
  const preferredIndex = Math.max(0, games.findIndex((g) => g.id === focusedId));

  const select = (f: GameFilter) => {
    setFilter(f);
    const list = gamesIn(f);
    if (!list.some((g) => g.id === focusedId) && list[0]) setFocusedId(list[0].id);
    scroller.current?.scrollTo({ x: 0, animated: false });
    offset.current = 0;
    setScrollX(0);
  };

  if (mode !== 'wide') {
    // Phone portrait: a two-column grid of posters. Posters keep their shape and the whole
    // catalogue is visible by scrolling down, which suits thumbs better than a sideways row
    // that hides cards off-screen; the pitch sits under each poster instead of one caption.
    const colGap = s(12);
    const cardW = Math.floor((width - gutterX * 2 - colGap) / 2) - s(4);
    return (
      <ArcadeScreen>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8), marginBottom: s(6) }}>
          <Focusable onPress={goBack} accessibilityRole="button" accessibilityLabel="Back" ringRadius={18}>
            <View style={{ width: s(34), height: s(34), borderRadius: s(17), borderWidth: s(1.5), borderColor: arcade.frame, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="arrow-left" size={s(18)} color={arcade.ink} />
            </View>
          </Focusable>
          <View style={{ flex: 1 }}>
            <Brand size={s(18)} />
          </View>
          <AText variant="kicker" color={arcade.frameDim} upper>
            Demo
          </AText>
        </View>
        <AText variant="headline" upper style={{ fontSize: s(30), lineHeight: s(34) }}>
          Choose your game
        </AText>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginVertical: s(6) }}>
          <Tabs filter={filter} onSelect={select} size={s(16)} />
        </ScrollView>
        <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: colGap, paddingVertical: s(6), paddingBottom: s(24) }}>
          {games.map((g) => (
            <View key={g.id} style={{ width: cardW + s(4), gap: s(4), alignItems: 'center' }}>
              <Poster game={g} width={cardW} />
              <View style={{ width: cardW }}>
                <AText variant="condBold" upper>
                  {g.name}
                </AText>
                <AText variant="cond" color="textDim" style={{ fontSize: s(13), lineHeight: s(16) }}>
                  {g.pitch}
                  {g.preview ? ' Preview: demo scoring.' : ''}
                </AText>
              </View>
            </View>
          ))}
        </ScrollView>
      </ArcadeScreen>
    );
  }

  // Wide: five posters fill the row; with more, the row scrolls inside the safe area.
  const innerW = width - gutterX * 2;
  const gap = s(14);
  const pad = s(9);
  const topH = s(40);
  const bottomH = s(58);
  const captionH = s(26);
  // Each poster also carries the focus ring's border (2 units a side).
  const ring = s(4);
  const cardByWidth = (innerW - pad * 2 - gap * 4) / 5 - ring;
  const cardByHeight = (height - gutterY * 2 - topH - bottomH - captionH - s(28) - pad * 2) / POSTER_ASPECT;
  const cardW = Math.floor(Math.min(cardByWidth, cardByHeight));
  const contentW = pad * 2 + games.length * (cardW + ring) + (games.length - 1) * gap;
  const overflow = contentW > innerW + 1;
  const canLeft = overflow && scrollX > 2;
  const canRight = overflow && scrollX < contentW - innerW - 2;

  const ensureVisible = (index: number) => {
    if (!overflow) return;
    const left = index * (cardW + ring + gap);
    const right = left + cardW + ring + pad * 2;
    let x = offset.current;
    if (left < x) x = left;
    else if (right > x + innerW) x = right - innerW;
    if (x !== offset.current) {
      offset.current = x;
      scroller.current?.scrollTo({ x, animated: true });
    }
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = e.nativeEvent.contentOffset.x;
    setScrollX(e.nativeEvent.contentOffset.x);
  };

  const chevron = (side: 'left' | 'right', visible: boolean) => (
    <View
      pointerEvents="none"
      style={[
        { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center', opacity: visible ? 0.9 : 0 },
        side === 'left' ? { left: -gutterX + s(10) } : { right: -gutterX + s(10) },
      ]}
    >
      <View style={{ transform: [{ rotate: side === 'left' ? '-90deg' : '90deg' }] }}>
        <Icon name="chevron-up" size={s(26)} color={arcade.frame} />
      </View>
    </View>
  );

  return (
    <ArcadeScreen>
      <View style={{ height: topH, flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Brand size={s(19)} />
        </View>
        <Tabs filter={filter} onSelect={select} size={s(20)} />
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <AText variant="headline" upper color={arcade.frameDim} style={{ fontSize: s(16), lineHeight: s(19), letterSpacing: s(1.5) }}>
            Demo
          </AText>
        </View>
      </View>

      <View style={{ flex: 1, justifyContent: 'center' }}>
        <View>
          <FocusGuide autoFocus>
            <ScrollView
              key={filter}
              ref={scroller}
              horizontal
              showsHorizontalScrollIndicator={false}
              onScroll={onScroll}
              scrollEventThrottle={32}
              style={{ flexGrow: 0 }}
              contentContainerStyle={{
                gap,
                padding: pad,
                minWidth: innerW,
                justifyContent: overflow ? 'flex-start' : 'center',
              }}
            >
              {games.map((g, i) => (
                <Poster
                  key={g.id}
                  game={g}
                  width={cardW}
                  preferredFocus={i === preferredIndex}
                  onFocus={() => {
                    setFocusedId(g.id);
                    ensureVisible(i);
                  }}
                />
              ))}
            </ScrollView>
          </FocusGuide>
          {chevron('left', canLeft)}
          {chevron('right', canRight)}
        </View>
        <View style={{ height: captionH, justifyContent: 'center', marginTop: s(4) }}>{shown ? <Caption game={shown} size={s(17)} /> : null}</View>
      </View>

      <View style={{ height: bottomH, flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          <Hint glyph={<Icon name="arrow-left" size={s(18)} color={arcade.frame} />} label="Back" onPress={goBack} remote={remote} />
        </View>
        <View style={{ alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(18) }}>
            <Icon name="chevron-up" size={s(26)} color={arcade.frame} />
            <AText variant="hero" upper style={{ fontSize: s(40), lineHeight: s(44), letterSpacing: s(2) }}>
              Choose your game
            </AText>
            <Icon name="chevron-up" size={s(26)} color={arcade.frame} />
          </View>
          <View style={{ alignSelf: 'stretch', height: s(2), marginTop: s(2), backgroundColor: arcade.frame, borderRadius: s(1) }} />
        </View>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <Hint
            glyph={
              <AText variant="headline" color={arcade.frame} style={{ fontSize: s(15), lineHeight: s(17) }}>
                OK
              </AText>
            }
            label="Choose"
            onPress={() => shown && choose(shown)}
            remote={remote}
          />
        </View>
      </View>
    </ArcadeScreen>
  );
}
