import { BOARD_PORT } from '@arcade/adapters';
import {
  checkBoard,
  checkManualAddress,
  defaultTransportFactory,
  formatBoardAddress,
  isPrivateIpv4,
  parseBoardAddress,
  probeSubnet,
  type BoardAddress,
  type BoardCandidate,
  type TransportFactory,
} from '@arcade/platform';
import {
  AText,
  Button,
  Focusable,
  Panel,
  StatusPill,
  Stepper,
  connectionBadge,
  palette,
  radius,
  space,
  useLayout,
  type BoardStatusTone,
  type PaletteKey,
} from '@arcade/ui-kit';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, ScrollView, TextInput, View } from 'react-native';
import { boardLink, useBoardLink } from '@/live/board-link';
import { HAS_LOCAL_NETWORK_PROMPT, afterLocalNetworkPrompt, lastKnownAddress, localNetworkNote } from '@/live/settings';
import { ScreenFrame } from '@/shell/ScreenFrame';

type Flow =
  | { step: 'idle' }
  | { step: 'checking'; address: BoardAddress; again: boolean }
  | { step: 'linking'; address: BoardAddress }
  | { step: 'failed'; reason: string };

interface LastKnown {
  address: BoardAddress;
  /** `unchecked`: iOS before the Local Network note, so nothing is sent yet. */
  status: 'unchecked' | 'checking' | 'online' | 'silent';
  version?: string;
}

interface Scan {
  running: boolean;
  prefix: string;
  done: number;
  total: number;
  found: BoardCandidate[];
}

/** Home-router subnets to offer for the scan when the address field gives no hint. */
const COMMON_SUBNETS = ['192.168.1', '192.168.0', '192.168.178', '192.168.2', '10.0.0', '10.0.1', '172.16.0'];
const SCAN_SIZE = 254;
const MAX_FOUND_TILES = 4;

const prefixOf = (host: string): string | null => (isPrivateIpv4(host) ? host.split('.').slice(0, 3).join('.') : null);
const hostPort = (a: BoardAddress): string => `${a.host}:${a.port}`;

function subnetOptions(typed: string, last: BoardAddress | null): string[] {
  const parsed = parseBoardAddress(typed);
  const hints = [parsed.ok ? prefixOf(parsed.address.host) : null, last ? prefixOf(last.host) : null];
  return [...new Set([...hints.filter((p): p is string => p !== null), ...COMMON_SUBNETS])];
}

/** The reason a board did not answer, plus what to try. */
function noAnswerHint(reason: string): string {
  if (Platform.OS === 'web') return `${reason} A browser can only reach the fake board; a real board needs the app (README).`;
  if (HAS_LOCAL_NETWORK_PROMPT) return `${reason} Check that the board is on, and that Local Network access is allowed (Settings › Privacy & Security › Local Network).`;
  return `${reason} Check the address, and that the board is on and on this network.`;
}

const TONE_COLOR: Record<BoardStatusTone, PaletteKey> = { online: 'mint', demo: 'cyan', offline: 'amber', connecting: 'textDim' };

function BoardTile({ address, version, note, pill, onPress }: { address: BoardAddress; version?: string; note: string; pill?: { tone: BoardStatusTone; label: string }; onPress: () => void }) {
  const { s } = useLayout();
  return (
    <Focusable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Connect to the board at ${hostPort(address)}`} ringRadius={radius.md + 2} focusScale={1.03}>
      {({ focused }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: s(space.md),
            paddingVertical: s(space.sm),
            paddingHorizontal: s(space.md),
            borderRadius: s(radius.md),
            backgroundColor: palette.surfaceHi,
            borderWidth: s(1),
            borderColor: focused ? palette.gold : palette.lineHi,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <AText variant="h3" color={focused ? 'gold' : 'text'} numberOfLines={1}>
              Board @ {hostPort(address)}
            </AText>
            <AText variant="caption" color="textMute" numberOfLines={1}>
              {note}
            </AText>
          </View>
          {version ? (
            <AText variant="label" color="textDim">
              v{version}
            </AText>
          ) : null}
          {pill ? <StatusPill tone={pill.tone} label={pill.label} /> : null}
        </View>
      )}
    </Focusable>
  );
}

/** W0 · Connect board (ARCHITECTURE §9.4, §10): last-known address, manual entry, opt-in scan, demo. */
export default function ConnectScreen() {
  const { s, mode, width } = useLayout();
  const wide = mode === 'wide';
  const live = useBoardLink();
  const [address, setAddress] = useState('');
  const [touched, setTouched] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [flow, setFlow] = useState<Flow>({ step: 'idle' });
  const [lastKnown, setLastKnown] = useState<LastKnown | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [scan, setScan] = useState<Scan | null>(null);
  const [pickedPrefix, setPickedPrefix] = useState<string | null>(null);
  /** Bumped by every connect and cancel, so a superseded attempt stops where it is. */
  const attempt = useRef(0);
  const noteAnswer = useRef<((go: boolean) => void) | null>(null);
  const scanSignal = useRef<{ aborted: boolean } | null>(null);

  // Offer the last board that connected. On iOS, nothing is sent before the Local Network note.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const last = await lastKnownAddress.get().catch(() => null);
      if (!alive || !last) return;
      const seen = await localNetworkNote.seen();
      if (!alive) return;
      setAddress((a) => (a.length === 0 ? formatBoardAddress(last) : a));
      setLastKnown({ address: last, status: seen ? 'checking' : 'unchecked' });
      if (!seen) return;
      const c = await checkBoard(last, { source: 'last-known' });
      if (alive) setLastKnown((k) => (k && hostPort(k.address) === hostPort(last) && k.status === 'checking' ? { address: last, status: c ? 'online' : 'silent', version: c?.version } : k));
    })();
    const signal = scanSignal;
    return () => {
      alive = false;
      if (signal.current) signal.current.aborted = true;
    };
  }, []);

  /** iOS: explain the Local Network prompt once, before the first LAN request. `first` → retry once. */
  const openLocalNetwork = async (): Promise<{ go: boolean; first: boolean }> => {
    if (await localNetworkNote.seen()) return { go: true, first: false };
    const go = await new Promise<boolean>((resolve) => {
      noteAnswer.current = resolve;
      setNoteOpen(true);
    });
    if (go) await localNetworkNote.markSeen();
    return { go, first: go };
  };
  const answerNote = (go: boolean) => {
    setNoteOpen(false);
    noteAnswer.current?.(go);
    noteAnswer.current = null;
  };

  const connect = async (text: string) => {
    const mine = ++attempt.current;
    const stale = () => mine !== attempt.current;
    setTouched(true);
    const parsed = parseBoardAddress(text);
    if (!parsed.ok) {
      setFlow({ step: 'failed', reason: parsed.reason });
      return;
    }
    const gate = await openLocalNetwork();
    if (stale()) return;
    if (!gate.go) {
      setFlow({ step: 'idle' });
      return;
    }
    setFlow({ step: 'checking', address: parsed.address, again: false });
    let check = await checkManualAddress(text);
    if (!check.ok && gate.first && !stale()) {
      // The first LAN request on iOS can fail while the prompt is up: try once more after it.
      setFlow({ step: 'checking', address: parsed.address, again: true });
      await afterLocalNetworkPrompt();
      if (stale()) return;
      check = await checkManualAddress(text);
    }
    if (stale()) return;
    if (!check.ok) {
      setFlow({ step: 'failed', reason: noAnswerHint(check.reason) });
      return;
    }
    const target = check.candidate.address;
    boardLink.open(target);
    setFlow({ step: 'linking', address: target });
    if ((await boardLink.whenOnline()) !== 'online' || stale()) return;
    void lastKnownAddress.set(target).catch(() => undefined);
    setLastKnown({ address: target, status: 'online', version: boardLink.getState().version ?? check.candidate.version });
    setFlow({ step: 'idle' });
    router.push('/ticker');
  };

  const cancel = () => {
    attempt.current++;
    boardLink.close();
    setFlow({ step: 'idle' });
  };

  const connectTo = (a: BoardAddress) => {
    const text = formatBoardAddress(a);
    setAddress(text);
    void connect(text);
  };

  // ── scan ──
  const subnets = subnetOptions(address, lastKnown?.address ?? null);
  const prefix = pickedPrefix !== null && subnets.includes(pickedPrefix) ? pickedPrefix : (subnets[0] as string);
  const stepPrefix = (d: 1 | -1) => {
    const i = subnets.indexOf(prefix);
    setPickedPrefix(subnets[(i + d + subnets.length) % subnets.length] ?? prefix);
  };

  const toggleScan = async () => {
    if (scanSignal.current) {
      scanSignal.current.aborted = true;
      scanSignal.current = null;
      setScan((sc) => sc && { ...sc, running: false });
      return;
    }
    const signal = { aborted: false };
    scanSignal.current = signal;
    const gate = await openLocalNetwork();
    if (!gate.go || signal.aborted) {
      if (scanSignal.current === signal) scanSignal.current = null;
      return;
    }
    const target = prefix;
    const once = (): Promise<BoardCandidate[]> => {
      let done = 0;
      setScan({ running: true, prefix: target, done: 0, total: SCAN_SIZE, found: [] });
      // Count answered addresses for the progress bar (one GET /api/version each).
      const counting: TransportFactory = (a) => {
        const t = defaultTransportFactory(a);
        return {
          ...t,
          get: (path, options) =>
            t.get(path, options).finally(() => {
              done++;
              if (!signal.aborted) setScan((sc) => sc && { ...sc, done });
            }),
        };
      };
      return probeSubnet({
        near: `${target}.1`,
        transportFactory: counting,
        signal,
        onFound: (c) => {
          if (!signal.aborted) setScan((sc) => sc && { ...sc, found: [...sc.found, c] });
        },
      });
    };
    let found = await once();
    if (found.length === 0 && gate.first && !signal.aborted) {
      await afterLocalNetworkPrompt();
      if (!signal.aborted) found = await once();
    }
    if (scanSignal.current === signal) scanSignal.current = null;
    if (!signal.aborted) setScan((sc) => sc && { ...sc, running: false, found });
  };

  // ── derived view ──
  const parsed = parseBoardAddress(address);
  const explicitPort = /^(\[[^\]]*\]|[^:[\]]*):/.test(address.trim());
  const linking = flow.step === 'linking' && live.address !== null;
  const busy = flow.step === 'checking' || linking;
  const badge = connectionBadge(live.connection);

  let status: { text: string; color: PaletteKey };
  if (flow.step === 'checking') {
    status = flow.again
      ? { text: 'Asking again now that iOS has asked about Local Network access…', color: 'textDim' }
      : { text: `Looking for a board at ${hostPort(flow.address)}…`, color: 'textDim' };
  } else if (linking) {
    const why = live.connection.outage && live.connection.error ? ` · ${live.connection.error}` : '';
    status = { text: `${badge.label}${why}`, color: TONE_COLOR[badge.tone] };
  } else if (flow.step === 'failed') {
    status = { text: flow.reason, color: 'rose' };
  } else if (touched && address.trim().length > 0 && !parsed.ok) {
    status = { text: parsed.reason, color: 'rose' };
  } else {
    status = { text: 'Arcade only reads from the board. It never changes its settings.', color: 'textMute' };
  }

  const others = (scan?.found ?? []).filter((c) => !lastKnown || hostPort(c.address) !== hostPort(lastKnown.address));
  const lastPill: Record<LastKnown['status'], { tone: BoardStatusTone; label: string } | undefined> = {
    unchecked: undefined,
    checking: { tone: 'connecting', label: 'Checking' },
    online: { tone: 'online', label: 'Online' },
    silent: { tone: 'offline', label: 'Not answering' },
  };

  const found = (
    <Panel style={{ gap: s(space.md) }}>
      <AText variant="label" color="textMute" upper>
        Found on this network
      </AText>
      {lastKnown ? (
        <BoardTile
          address={lastKnown.address}
          version={lastKnown.version}
          note={lastKnown.status === 'unchecked' ? 'Last used · press to connect' : 'Last used'}
          pill={lastPill[lastKnown.status]}
          onPress={() => connectTo(lastKnown.address)}
        />
      ) : null}
      {others.slice(0, MAX_FOUND_TILES).map((c) => (
        <BoardTile key={hostPort(c.address)} address={c.address} version={c.version} note="Found by the scan" pill={{ tone: 'online', label: 'Online' }} onPress={() => connectTo(c.address)} />
      ))}
      {others.length > MAX_FOUND_TILES ? (
        <AText variant="caption" color="textMute">
          and {others.length - MAX_FOUND_TILES} more on {scan?.prefix}.x
        </AText>
      ) : null}
      {!lastKnown && others.length === 0 ? (
        <View style={{ padding: s(space.md), borderRadius: s(radius.md), borderWidth: s(1), borderStyle: 'dashed', borderColor: palette.line }}>
          <AText variant="h3" color="textDim">
            {scan?.running ? 'Looking…' : scan ? 'No boards found' : 'No boards found yet'}
          </AText>
          <AText variant="caption" color="textMute">
            Scan your network, or enter the IP address shown in the Autodarts app.
          </AText>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.md), flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: s(200) }}>
          <Stepper label="Network" value={`${prefix}.x`} onPrev={() => stepPrefix(-1)} onNext={() => stepPrefix(1)} />
        </View>
        <Button label={scan?.running ? 'Stop scan' : scan ? 'Scan again' : 'Scan network'} icon="⌕" size="sm" onPress={() => void toggleScan()} />
      </View>
      {scan ? (
        <View style={{ gap: s(space.xs) }} accessibilityLiveRegion="polite">
          <View style={{ height: s(6), borderRadius: s(3), backgroundColor: palette.line, overflow: 'hidden' }}>
            <View style={{ width: `${Math.round((100 * scan.done) / scan.total)}%`, height: '100%', backgroundColor: scan.running ? palette.cyan : palette.mint }} />
          </View>
          <AText variant="caption" color="textMute">
            {scan.running ? `Scanning ${scan.prefix}.x · ${scan.done} of ${scan.total}` : `Scanned ${scan.prefix}.x`} · {scan.found.length} found
          </AText>
        </View>
      ) : (
        <AText variant="caption" color="textMute">
          The scan asks each address on {prefix}.x for its board version on port {BOARD_PORT}, a few at a time. It takes up to 10 seconds.
        </AText>
      )}
    </Panel>
  );

  const manual = (
    <Panel style={{ gap: s(space.md) }}>
      <AText variant="label" color="textMute" upper>
        Or enter the board&apos;s IP address
      </AText>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(space.sm) }}>
        <TextInput
          value={address}
          onChangeText={(t) => {
            setAddress(t);
            if (flow.step === 'failed') setFlow({ step: 'idle' });
          }}
          onFocus={() => setInputFocused(true)}
          onBlur={() => {
            setInputFocused(false);
            setTouched(true);
          }}
          onSubmitEditing={() => {
            if (!busy) void connect(address);
          }}
          returnKeyType="go"
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
            borderColor: inputFocused ? palette.gold : palette.lineHi,
            outlineStyle: 'solid',
            outlineWidth: 0,
          }}
        />
        {explicitPort ? null : (
          <AText variant="h3" color="textMute">
            :{BOARD_PORT}
          </AText>
        )}
        <Button
          label={busy ? 'Cancel' : 'Connect'}
          variant={busy ? 'ghost' : 'secondary'}
          disabled={!busy && address.trim().length === 0}
          onPress={busy ? cancel : () => void connect(address)}
        />
      </View>
      <View accessibilityLiveRegion="polite">
        <AText variant="caption" color={status.color}>
          {status.text}
        </AText>
      </View>
    </Panel>
  );

  const demoPanel = (
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
  );

  const column = (children: ReactNode) =>
    wide ? (
      <ScrollView style={{ flex: 1.2 }} contentContainerStyle={{ gap: s(space.lg) }} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    ) : (
      children
    );

  const body = (
    <>
      {column(
        <>
          {found}
          {manual}
        </>,
      )}
      {demoPanel}
    </>
  );

  return (
    <ScreenFrame
      title="Connect your board"
      subtitle="AutoDarts Arcade"
      boardStatus={busy ? (flow.step === 'checking' ? { tone: 'connecting', label: 'Looking…' } : badge) : { tone: 'offline', label: 'No board' }}
    >
      {wide ? (
        <View style={{ flex: 1, flexDirection: 'row', gap: s(space.lg) }}>{body}</View>
      ) : (
        <ScrollView contentContainerStyle={{ gap: s(space.lg), paddingBottom: s(space.lg) }} keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>
      )}

      <Modal visible={noteOpen} transparent animationType="fade" onRequestClose={() => answerNote(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(5,7,14,0.82)', alignItems: 'center', justifyContent: 'center', padding: s(space.xl) }}>
          <Panel style={{ width: Math.min(width - s(space.xl) * 2, s(440)), gap: s(space.md) }}>
            <AText variant="h2" upper color="gold">
              Allow Local Network
            </AText>
            <AText variant="body" color="textDim">
              Arcade reads your board over your home network. iOS will now ask whether AutoDarts Arcade may find and connect to devices on your
              local network. Choose Allow.
            </AText>
            <AText variant="caption" color="textMute">
              The first try can fail while that question is on screen, so Arcade tries once more after you answer. You can change it later in
              Settings › Privacy & Security › Local Network.
            </AText>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: s(space.sm), flexWrap: 'wrap' }}>
              <Button label="Not now" variant="ghost" onPress={() => answerNote(false)} />
              <Button label="Continue" icon="▶" variant="primary" preferredFocus onPress={() => answerNote(true)} />
            </View>
          </Panel>
        </View>
      </Modal>
    </ScreenFrame>
  );
}
