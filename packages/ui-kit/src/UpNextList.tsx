import { View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';
import { ArcadePanel } from './ArcadePanel';
import { AText } from './AText';
import { Avatar } from './Avatar';
import { useLayout } from './layout';
import { arcade } from './theme';

export interface UpNextPlayer {
  key: string;
  name: string;
  colorIndex: number;
  score: number | string;
  image?: ImageSourcePropType;
  /** A short second line, e.g. "4 destroyed". */
  detail?: string;
  /** Out of the game. */
  out?: boolean;
}

export interface UpNextListProps {
  /** In throwing order, starting with whoever throws after the current player. */
  players: readonly UpNextPlayer[];
  /** How many to show before "+N more". */
  max?: number;
  heading?: string;
  accent?: string;
  /** Column for TV / tablet landscape, a chip row for phones. */
  layout?: 'column' | 'row';
  /** Column entries: big panels for up to two players, compact ones for three. */
  density?: 'full' | 'compact';
  style?: StyleProp<ViewStyle>;
}

/** "Up next": the following players with avatar, name and score, then "+N more". */
export function UpNextList({ players, max = 3, heading = 'Up next', accent = arcade.frame, layout = 'column', density, style }: UpNextListProps) {
  const { s } = useLayout();
  const shown = players.slice(0, max);
  const more = players.length - shown.length;

  if (layout === 'row') {
    return (
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: s(8), flexWrap: 'wrap' }, style]}>
        <AText variant="kicker" color={accent} upper>
          {heading}
        </AText>
        {shown.map((p) => (
          <View
            key={p.key}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: s(6),
              paddingVertical: s(3),
              paddingLeft: s(3),
              paddingRight: s(8),
              borderRadius: s(20),
              backgroundColor: arcade.panel,
              borderWidth: s(1),
              borderColor: arcade.frameDim,
              opacity: p.out ? 0.55 : 1,
            }}
          >
            <Avatar name={p.name} colorIndex={p.colorIndex} image={p.image} size={s(26)} dimmed={p.out} />
            <AText variant="condBold" upper numberOfLines={1}>
              {p.name}
            </AText>
            <AText variant="condBold" color={accent}>
              {p.score}
            </AText>
          </View>
        ))}
        {more > 0 ? (
          <AText variant="cond" color="textDim">
            +{more} more
          </AText>
        ) : null}
      </View>
    );
  }

  const full = (density ?? (shown.length <= 2 ? 'full' : 'compact')) === 'full';
  return (
    <ArcadePanel heading={heading} accent={accent} style={style} contentStyle={{ gap: s(full ? 10 : 6), paddingVertical: s(8) }}>
      {players.length === 0 ? (
        <AText variant="cond" color="textDim" align="center">
          Solo game
        </AText>
      ) : null}
      {shown.map((p) => (
        <View
          key={p.key}
          style={{
            flex: full ? 1 : undefined,
            maxHeight: full ? s(190) : undefined,
            flexDirection: full ? 'column' : 'row',
            alignItems: 'center',
            justifyContent: full ? 'center' : 'flex-start',
            paddingVertical: s(full ? 8 : 6),
            paddingHorizontal: s(full ? 6 : 8),
            gap: s(full ? 4 : 8),
            borderRadius: s(6),
            backgroundColor: arcade.plate,
            borderWidth: s(1),
            borderColor: arcade.frameFaint,
            opacity: p.out ? 0.6 : 1,
          }}
        >
          <Avatar name={p.name} colorIndex={p.colorIndex} image={p.image} size={s(full ? 92 : 46)} dimmed={p.out} />
          <View style={{ alignItems: full ? 'center' : 'flex-start', flex: full ? undefined : 1 }}>
            <AText variant="condBold" upper numberOfLines={1} style={{ fontSize: s(full ? 24 : 20), lineHeight: s(full ? 26 : 21) }}>
              {p.name}
            </AText>
            <AText variant="hero" color={p.out ? 'textMute' : arcade.ink} style={{ fontSize: s(full ? 42 : 32), lineHeight: s(full ? 44 : 33) }}>
              {p.score}
            </AText>
            {p.detail ? (
              <AText variant="kicker" color="textMute" numberOfLines={1} style={{ fontSize: s(10), lineHeight: s(12) }}>
                {p.detail}
              </AText>
            ) : null}
          </View>
        </View>
      ))}
      {more > 0 ? (
        <AText variant="condBold" color="textDim" align="center">
          +{more} more
        </AText>
      ) : null}
    </ArcadePanel>
  );
}
