import { View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';
import { ArcadePanel, DartGlyph } from './ArcadePanel';
import { AText } from './AText';
import { Avatar } from './Avatar';
import { useLayout } from './layout';
import { arcade } from './theme';

export interface DartSlot {
  /** "T20", "S5", "MISS"… Empty slots stay visible as a dash. */
  label: string;
  /** Changed by a correction. */
  adjusted?: boolean;
  /** Thrown after the game ended the visit (bust, finish): shown, not scored. */
  void?: boolean;
}

export interface PlayerPanelProps {
  heading?: string;
  name: string;
  colorIndex: number;
  image?: ImageSourcePropType;
  score: number | string;
  /** What the score means in this game: "Wall", "Needs", "Points", "Next". */
  scoreLabel?: string;
  /** The current turn's three darts, in order. Always three slots. */
  darts: readonly (DartSlot | null | undefined)[];
  turnLabel?: string;
  turnValue: number | string;
  accent: string;
  /** Column for TV / tablet landscape, compact row for phones. */
  layout?: 'column' | 'row';
  /** Avatar diameter in the column layout (device-independent pixels). */
  avatarSize?: number;
  style?: StyleProp<ViewStyle>;
}

function Slot({ dart, next, size, accent, compact }: { dart: DartSlot | null | undefined; next: boolean; size: number; accent: string; compact: boolean }) {
  const { s } = useLayout();
  const labelColor = !dart ? arcade.inkMute : dart.void ? arcade.inkMute : dart.adjusted ? arcade.frame : arcade.ink;
  return (
    <View style={{ alignItems: 'center', gap: s(3), flex: 1 }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: s(6),
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: dart ? arcade.panelHi : arcade.plate,
          borderWidth: s(next ? 1.5 : 1),
          borderColor: next ? arcade.frame : arcade.frameDim,
          borderStyle: next ? 'dashed' : 'solid',
          opacity: dart?.void ? 0.5 : 1,
        }}
      >
        {dart ? <DartGlyph size={size * 0.78} color={accent} /> : null}
      </View>
      {compact ? null : (
        <AText
          variant="condBold"
          color={labelColor}
          numberOfLines={1}
          style={{ fontSize: s(19), lineHeight: s(21), textDecorationLine: dart?.void ? 'line-through' : 'none' }}
        >
          {dart ? (dart.adjusted ? `${dart.label}✎` : dart.label) : '—'}
        </AText>
      )}
    </View>
  );
}

/** "Up now": the thrower, their score and the current turn's three darts. */
export function PlayerPanel({
  heading = 'Up now',
  name,
  colorIndex,
  image,
  score,
  scoreLabel,
  darts,
  turnLabel = 'Turn total',
  turnValue,
  accent,
  layout = 'column',
  avatarSize,
  style,
}: PlayerPanelProps) {
  const { s } = useLayout();
  const slots = [darts[0], darts[1], darts[2]];
  const nextIndex = slots.findIndex((d) => !d);

  if (layout === 'row') {
    return (
      <ArcadePanel accent={accent} style={style} contentStyle={{ gap: s(8) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(10) }}>
          <Avatar name={name} colorIndex={colorIndex} image={image} size={s(52)} />
          <View style={{ flex: 1 }}>
            <AText variant="kicker" color={accent} upper>
              {heading}
            </AText>
            <AText variant="headline" upper numberOfLines={1}>
              {name}
            </AText>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            {scoreLabel ? (
              <AText variant="kicker" color="textDim" upper>
                {scoreLabel}
              </AText>
            ) : null}
            <AText variant="hero" style={{ fontSize: s(40), lineHeight: s(42) }}>
              {score}
            </AText>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8) }}>
          {slots.map((d, i) => (
            <View key={i} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: s(6) }}>
              <Slot dart={d} next={i === nextIndex} size={s(30)} accent={accent} compact />
              <AText variant="condBold" color={d ? (d.adjusted ? arcade.frame : arcade.ink) : arcade.inkMute} style={{ flex: 1.4 }}>
                {d ? d.label : '—'}
              </AText>
            </View>
          ))}
          <View style={{ alignItems: 'flex-end' }}>
            <AText variant="kicker" color="textDim" upper>
              {turnLabel}
            </AText>
            <AText variant="headline">{turnValue}</AText>
          </View>
        </View>
      </ArcadePanel>
    );
  }

  return (
    <ArcadePanel heading={heading} accent={accent} style={style} contentStyle={{ justifyContent: 'space-between', alignItems: 'stretch', paddingVertical: s(8), gap: s(3) }}>
      <View style={{ alignItems: 'center', gap: s(4) }}>
        <Avatar name={name} colorIndex={colorIndex} image={image} size={avatarSize ?? s(92)} />
        <AText variant="headline" upper numberOfLines={1} align="center" style={{ fontSize: s(27), lineHeight: s(29) }}>
          {name}
        </AText>
      </View>
      <View
        style={{
          alignItems: 'center',
          marginTop: scoreLabel ? s(6) : 0,
          paddingTop: s(2),
          borderRadius: s(6),
          backgroundColor: arcade.plate,
          borderWidth: s(1),
          borderColor: arcade.frameDim,
        }}
      >
        <AText variant="hero" style={{ fontSize: s(50), lineHeight: s(54) }}>
          {score}
        </AText>
        {scoreLabel ? (
          // The label sits on the plate's top edge like a tab, so it costs no height.
          <View style={{ position: 'absolute', top: -s(8), paddingHorizontal: s(6), backgroundColor: arcade.panel }}>
            <AText variant="kicker" color="textDim" upper>
              {scoreLabel}
            </AText>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: s(6) }}>
        {slots.map((d, i) => (
          <Slot key={i} dart={d} next={i === nextIndex} size={s(42)} accent={accent} compact={false} />
        ))}
      </View>
      <View style={{ alignItems: 'center', borderTopWidth: s(1), borderTopColor: arcade.frameFaint, paddingTop: s(4) }}>
        <AText variant="kicker" color="textDim" upper>
          {turnLabel}
        </AText>
        <AText variant="hero" style={{ fontSize: s(38), lineHeight: s(40) }}>
          {turnValue}
        </AText>
      </View>
    </ArcadePanel>
  );
}
