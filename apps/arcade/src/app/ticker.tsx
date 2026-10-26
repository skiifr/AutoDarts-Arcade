import { points } from '@arcade/event-schema';
import {
  AText,
  BOARD_STATUS_LABELS,
  Banner,
  Button,
  DartChip,
  Panel,
  connectionBadge,
  palette,
  radius,
  space,
  tickerTime,
  useLayout,
  type BannerProps,
  type PaletteKey,
  type TickerEntry,
  type TickerTone,
} from '@arcade/ui-kit';
import { router, useNavigation } from 'expo-router';
import { useEffect } from 'react';
import { AppState, Platform, ScrollView, View } from 'react-native';
import { boardLink, useBoardLink, type LinkState } from '@/live/board-link';
import { ScreenFrame } from '@/shell/ScreenFrame';

const TONE_COLOR: Record<TickerTone, PaletteKey> = {
  dart: 'gold',
  takeout: 'cyan',
  status: 'textDim',
  connection: 'amber',
  anomaly: 'rose',
};

const STATUS_COLOR: Partial<Record<string, PaletteKey>> = {
  throwing: 'mint',
  ready: 'mint',
  takeout: 'gold',
  'stuck-takeout': 'rose',
  error: 'rose',
};

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function Tag({ label, color }: { label: string; color: PaletteKey }) {
  const { s } = useLayout();
  return (
    <View style={{ borderWidth: s(1), borderColor: palette[color], borderRadius: s(radius.pill), paddingHorizontal: s(6), paddingVertical: s(1) }}>
      <AText variant="caption" color={color} upper style={{ fontWeight: '800' }}>
        {label}
      </AText>
    </View>
  );
}

function Fact({ entry }: { entry: TickerEntry }) {
  const { s } = useLayout();
  return (
    <View style={{ paddingVertical: s(5), borderBottomWidth: s(1), borderBottomColor: palette.line, gap: s(1) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.sm) }}>
        <AText variant="caption" color="textMute" style={{ fontVariant: ['tabular-nums'] }}>
          {tickerTime(entry.at)}
        </AText>
        <AText variant="label" color={TONE_COLOR[entry.tone]} numberOfLines={1} style={{ flex: 1 }}>
          {entry.type}
        </AText>
        {entry.recovered ? <Tag label="Recovered" color="cyan" /> : null}
        {entry.inferred ? <Tag label="Inferred" color="amber" /> : null}
      </View>
      <AText variant="body" color="textDim" numberOfLines={2}>
        {entry.summary}
      </AText>
    </View>
  );
}

function Reading({ label, value, color = 'text', detail }: { label: string; value: string; color?: PaletteKey; detail?: string }) {
  const { s } = useLayout();
  return (
    <View style={{ gap: s(1) }}>
      <AText variant="label" color="textMute" upper>
        {label}
      </AText>
      <AText variant="h3" color={color} numberOfLines={2}>
        {value}
      </AText>
      {detail ? (
        <AText variant="caption" color="textMute" numberOfLines={2}>
          {detail}
        </AText>
      ) : null}
    </View>
  );
}

function bannerFor(live: LinkState): (BannerProps & { kind: string }) | null {
  const c = live.connection;
  if (c.outage) {
    return {
      kind: 'offline',
      tone: 'amber',
      icon: '⚠',
      title: `Board connection lost — reconnecting (try ${Math.max(1, c.attempt)})`,
      detail: c.error ? `Last error: ${c.error}` : 'Darts thrown meanwhile come through, marked recovered, when the board is back.',
    };
  }
  if (live.ticker.boardStatus === 'stuck-takeout') {
    return { kind: 'stuck', tone: 'rose', icon: '⛔', title: 'Board stuck in takeout', detail: 'Reset the board from the Autodarts app.' };
  }
  if (live.ticker.inTakeout || live.ticker.boardStatus === 'takeout') {
    return { kind: 'takeout', tone: 'gold', icon: '✋', title: 'Takeout', detail: 'The board reports darts being removed.' };
  }
  return null;
}

/**
 * The dart ticker: a raw, honest view of what the board reports, as the first end-to-end
 * check of the live adapter. No game engine.
 */
export default function TickerScreen() {
  const { s, mode } = useLayout();
  const live = useBoardLink();
  const navigation = useNavigation();
  const wide = mode === 'wide';

  // Leaving the screen (Back on the remote, browser back, Disconnect) closes the link.
  useEffect(() => navigation.addListener('beforeRemove', () => boardLink.close()), [navigation]);

  // iOS drops sockets while the app is suspended: re-attach on return (§6.4).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let previous = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      if (previous === 'background' && next === 'active') boardLink.resync();
      previous = next;
    });
    return () => sub.remove();
  }, []);

  const disconnect = () => {
    boardLink.close();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (!live.address) {
    return (
      <ScreenFrame title="Dart ticker" subtitle="Live board facts" boardStatus={{ tone: 'offline', label: 'Not connected' }}>
        <Panel style={{ gap: s(space.md), alignSelf: 'center', maxWidth: s(440) }}>
          <AText variant="h2" upper>
            Not connected
          </AText>
          <AText variant="body" color="textDim">
            Connect a board first. The ticker shows what it reports.
          </AText>
          <Button label="Connect a board" icon="◀" variant="primary" preferredFocus onPress={() => router.replace('/')} />
        </Panel>
      </ScreenFrame>
    );
  }

  const { connection: c, ticker: t } = live;
  const badge = connectionBadge(c);
  const reading = live.lastReading;
  const readFailed = live.health?.error !== undefined && live.health !== reading;
  const fpsValue = reading?.fps !== undefined ? `${reading.fps.toFixed(1)} fps` : reading?.camFps ? 'cameras only' : '—';
  const fpsDetail = [
    reading?.camFps ? `Cameras ${reading.camFps.map((f) => f.toFixed(1)).join(' · ')}` : null,
    reading ? `read ${tickerTime(reading.at)}` : 'waiting for the first reading',
    readFailed ? 'last read failed' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const visitTotal = t.darts.reduce((sum, d) => sum + points(d.segment), 0);
  const banner = bannerFor(live);

  const readings = (
    <Panel style={{ gap: s(space.md), width: wide ? s(228) : undefined }}>
      <Reading
        label="Connection"
        value={badge.label}
        color={badge.tone === 'online' ? 'mint' : badge.tone === 'offline' ? 'amber' : 'textDim'}
        detail={c.outage && c.error ? c.error : c.reconnects > 0 ? `Reconnected ${c.reconnects}×` : `${live.address.host}:${live.address.port}`}
      />
      <Reading
        label="Board status"
        value={t.boardStatus ? BOARD_STATUS_LABELS[t.boardStatus] : 'Not reported yet'}
        color={t.boardStatus ? (STATUS_COLOR[t.boardStatus] ?? 'text') : 'textMute'}
        detail={c.outage ? 'Last reported before the connection dropped' : t.inTakeout ? 'Takeout in progress' : undefined}
      />
      <Reading label="Board version" value={live.version ?? '—'} color={live.version ? 'text' : 'textMute'} />
      <Reading label="Camera FPS" value={fpsValue} color={reading ? 'text' : 'textMute'} detail={fpsDetail} />
      <Reading
        label="Facts seen"
        value={String(t.counts.facts)}
        detail={`${count(t.counts.darts, 'dart')} · ${count(t.counts.takeouts, 'takeout')} · ${t.counts.recovered} recovered · ${t.counts.inferred} inferred`}
      />
    </Panel>
  );

  const visit = (
    <Panel style={{ flex: wide ? 1 : undefined, gap: s(space.sm) }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <AText variant="label" color="textMute" upper>
          This visit
        </AText>
        <AText variant="h2" color="gold" style={{ fontVariant: ['tabular-nums'] }}>
          {visitTotal}
        </AText>
      </View>
      {[0, 1, 2].map((i) => {
        const d = t.darts.find((x) => x.indexInVisit === i);
        const flagged = d && (d.recovered || d.updated);
        return (
          <View key={i} style={{ gap: s(2) }}>
            <DartChip size="lg" index={i + 1} label={d?.segment.label} points={d ? points(d.segment) : undefined} state={!d ? 'empty' : flagged ? 'adjusted' : 'filled'} />
            {flagged ? (
              <AText variant="caption" color="cyan">
                {[d.recovered ? 'recovered: already on the board when Arcade (re)connected' : null, d.updated ? 're-read by the board' : null].filter(Boolean).join(' · ')}
              </AText>
            ) : null}
          </View>
        );
      })}
      <AText variant="caption" color="textMute">
        {t.inTakeout ? 'Takeout in progress: the board clears this visit when the darts are out.' : t.darts.length === 0 ? 'Waiting for a dart.' : `${t.darts.length} of 3 darts`}
      </AText>
      {t.previous.length > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: s(space.sm), flexWrap: 'wrap', marginTop: s(space.xs) }}>
          <AText variant="label" color="textMute" upper>
            Previous visit
          </AText>
          <AText variant="h3" color="textDim">
            {t.previous.map((d) => d.segment.label).join('  ')}
          </AText>
          <AText variant="caption" color="textMute">
            {t.previous.reduce((sum, d) => sum + points(d.segment), 0)} pts
          </AText>
        </View>
      ) : null}
    </Panel>
  );

  const facts = t.entries.length === 0 ? (
    <AText variant="caption" color="textMute">
      Nothing reported yet.
    </AText>
  ) : (
    t.entries.map((e) => <Fact key={e.n} entry={e} />)
  );
  const factsHeader = (
    <AText variant="label" color="textMute" upper>
      Board facts · newest first
    </AText>
  );

  return (
    <ScreenFrame
      title="Dart ticker"
      subtitle={`Board @ ${live.address.host}:${live.address.port} · raw board facts, no game`}
      right={<Button label="Disconnect" icon="✕" size="sm" variant="danger" onPress={disconnect} />}
      boardStatus={badge}
    >
      {wide ? (
        <>
          <View style={{ flex: 1, flexDirection: 'row', gap: s(space.lg) }}>
            {readings}
            {visit}
            <Panel style={{ width: s(330), gap: s(space.sm), paddingRight: s(space.sm) }}>
              {factsHeader}
              <ScrollView style={{ flex: 1 }}>{facts}</ScrollView>
            </Panel>
          </View>
          {banner ? <Banner key={banner.kind} {...banner} /> : null}
        </>
      ) : (
        <ScrollView contentContainerStyle={{ gap: s(space.md), paddingBottom: s(space.lg) }}>
          {banner ? <Banner key={banner.kind} {...banner} /> : null}
          {visit}
          {readings}
          <Panel style={{ gap: s(space.sm) }}>
            {factsHeader}
            {facts}
          </Panel>
        </ScrollView>
      )}
    </ScreenFrame>
  );
}
