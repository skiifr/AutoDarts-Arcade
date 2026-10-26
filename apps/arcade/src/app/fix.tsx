import { MISS, points, type Segment } from '@arcade/event-schema';
import {
  AText,
  Button,
  DartChip,
  Dartboard,
  FocusGuide,
  Focusable,
  Panel,
  RADIAL_RINGS,
  movePicker,
  pickerFromSegment,
  pickerNumber,
  pickerToSegment,
  radius,
  sectorIndexOf,
  space,
  useDpad,
  useLayout,
  type BoardSpot,
  type PickerState,
} from '@arcade/ui-kit';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { demo, useDemo } from '@/shell/demo-session';
import { ScreenFrame } from '@/shell/ScreenFrame';

type Selection = number | 'add';

function spotOf(state: PickerState): BoardSpot {
  const bed = RADIAL_RINGS[state.ring] ?? 'single-outer';
  return { number: bed === 'inner-bull' || bed === 'outer-bull' ? 25 : pickerNumber(state), bed };
}

/** W4 · Correction. Touch: tap the board. Remote: OK to edit, arrows to move, OK to finish. */
export default function FixScreen() {
  const { s, mode, input, width, gutterX } = useLayout();
  const state = useDemo();
  const params = useLocalSearchParams<{ add?: string }>();
  const player = state.players[state.current];
  const wide = mode === 'wide';

  const initialSelection: Selection = params.add === '1' || state.turn.length === 0 ? 'add' : state.turn.length - 1;
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const original: Segment | undefined = selection === 'add' ? undefined : state.turn[selection]?.segment;
  const [picker, setPicker] = useState<PickerState>(() => pickerFromSegment(original ?? MISS));
  const [bounceOut, setBounceOut] = useState(false);
  const [editing, setEditing] = useState(false);

  useDpad(
    (dir) => {
      if (dir !== 'select') setPicker((p) => movePicker(p, dir));
    },
    editing,
  );

  const select = (next: Selection) => {
    setSelection(next);
    setBounceOut(false);
    setPicker(pickerFromSegment((next === 'add' ? undefined : state.turn[next]?.segment) ?? MISS));
  };
  const setSpot = (spot: BoardSpot) => {
    setBounceOut(false);
    setPicker((p) => ({ sector: spot.number === 25 ? p.sector : sectorIndexOf(spot.number), ring: RADIAL_RINGS.indexOf(spot.bed as (typeof RADIAL_RINGS)[number]) }));
  };

  const proposed = pickerToSegment(picker);
  const newLabel = bounceOut ? 'BOUNCE-OUT' : proposed.label;
  const before = player?.score ?? 0;
  const after = before - (original ? points(original) : 0) + points(proposed);
  const canAdd = selection !== 'add' || state.turn.length < 3;

  const apply = () => {
    if (selection === 'add') demo.addDart(proposed);
    else demo.correct(selection, proposed);
    router.back();
  };

  const boardSize = wide ? s(268) : Math.min(width - gutterX * 2, s(300));

  const chips = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: s(space.sm) }}>
      {state.turn.map((d, i) => (
        <Focusable key={d.id} onPress={() => select(i)} accessibilityRole="button" accessibilityLabel={`Dart ${i + 1}: ${d.segment.label}`} noRing>
          {({ focused }) => (
            <View style={{ minWidth: s(130) }}>
              <DartChip index={i + 1} label={d.segment.label} points={points(d.segment)} state={selection === i || focused ? 'selected' : d.adjusted ? 'adjusted' : 'filled'} />
            </View>
          )}
        </Focusable>
      ))}
      {state.turn.length < 3 ? (
        <Focusable onPress={() => select('add')} accessibilityRole="button" accessibilityLabel="Add a missed dart" noRing>
          {({ focused }) => (
            <View style={{ minWidth: s(170) }}>
              <DartChip index={state.turn.length + 1} state={selection === 'add' || focused ? 'selected' : 'add'} label="+ add missed dart" />
            </View>
          )}
        </Focusable>
      ) : null}
    </View>
  );

  const board = (
    <FocusGuide trapFocusUp={editing} trapFocusDown={editing} trapFocusLeft={editing} trapFocusRight={editing}>
      <Focusable
        onPress={input === 'remote' ? () => setEditing((e) => !e) : undefined}
        accessibilityRole="adjustable"
        accessibilityLabel={`Board picker, ${newLabel}`}
        accessibilityHint="Press OK to edit, use the arrows to move, OK again to finish"
        focusScale={1.02}
        ringRadius={radius.xl}
        preferredFocus={input === 'remote'}
      >
        {({ focused }) => (
          <View style={{ alignItems: 'center', padding: s(space.sm), gap: s(space.xs) }}>
            <Dartboard size={boardSize} selected={bounceOut ? null : spotOf(picker)} focusNumber={pickerNumber(picker)} onSelect={input === 'touch' ? setSpot : undefined} />
            <AText variant="caption" color={editing ? 'gold' : 'textMute'} align="center">
              {input === 'touch'
                ? 'Tap the segment the dart actually hit'
                : editing
                  ? '◀ ▶ number · ▲ ▼ ring · OK done'
                  : focused
                    ? 'Press OK to edit'
                    : ' '}
            </AText>
          </View>
        )}
      </Focusable>
    </FocusGuide>
  );

  const quick = (
    <View style={{ gap: s(space.sm) }}>
      <AText variant="label" color="textMute" upper>
        Quick
      </AText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: s(space.sm) }}>
        <Button label="Miss" size="sm" onPress={() => setPicker((p) => ({ ...p, ring: RADIAL_RINGS.indexOf('miss') }))} />
        <Button
          label="Bounce-out"
          size="sm"
          onPress={() => {
            setPicker((p) => ({ ...p, ring: RADIAL_RINGS.indexOf('miss') }));
            setBounceOut(true);
          }}
        />
        <Button label="25" size="sm" onPress={() => setPicker((p) => ({ ...p, ring: RADIAL_RINGS.indexOf('outer-bull') }))} />
        <Button label="Bull" size="sm" onPress={() => setPicker((p) => ({ ...p, ring: RADIAL_RINGS.indexOf('inner-bull') }))} />
      </View>
    </View>
  );

  const summary = (
    <Panel tone="raised" style={{ gap: s(space.sm) }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: s(space.md), flexWrap: 'wrap' }}>
        <AText variant="label" color="textMute" upper>
          {selection === 'add' ? `Dart ${state.turn.length + 1}` : `Dart ${selection + 1}`}
        </AText>
        <AText variant="h2" color="textDim">
          {original ? original.label : 'missed'}
        </AText>
        <AText variant="h2" color="textMute">
          →
        </AText>
        <AText variant="h1" color="gold">
          {newLabel}
        </AText>
      </View>
      <AText variant="body" color="textDim">
        Preview: {player?.name ?? 'Player'} {before} → <AText variant="body" color={after === before ? 'textDim' : 'cyan'}>{String(after)}</AText>
      </AText>
    </Panel>
  );

  const actions = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: s(space.sm) }}>
      <Button label="Apply" icon="✓" variant="primary" onPress={apply} disabled={!canAdd} />
      <Button
        label="Not a dart"
        icon="🗑"
        variant="danger"
        disabled={selection === 'add'}
        onPress={() => {
          if (selection !== 'add') demo.voidDart(selection);
          router.back();
        }}
      />
      <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
    </View>
  );

  return (
    <ScreenFrame title={`Fix throws — ${player?.name ?? ''} · Round ${state.round}`} subtitle="Game paused while you fix" onBack={() => router.back()}>
      {wide ? (
        <View style={{ flex: 1, gap: s(space.md) }}>
          {chips}
          <View style={{ flex: 1, flexDirection: 'row', gap: s(space.xl), alignItems: 'center' }}>
            {board}
            <View style={{ flex: 1, gap: s(space.lg) }}>
              {quick}
              {summary}
              {actions}
            </View>
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ gap: s(space.md), paddingBottom: s(space.lg) }}>
          {chips}
          {board}
          {quick}
          {summary}
          {actions}
        </ScrollView>
      )}
    </ScreenFrame>
  );
}
