import type { Invader, SiegeView } from '@arcade/games/src/siege/module';
import { AText, arcade, fontFamily, useLayout } from '@arcade/ui-kit';
import { Image, Text, View } from 'react-native';
import Svg, { Circle, Ellipse, G, Line, Path, Rect } from 'react-native-svg';
import { INVADER_SPRITES } from '../art';

const SHIELDS = ['#D8352F', '#2F6FE0', '#F2B21B', '#3BA845', '#8E4FD6', '#EE7A1E'];
const STONE = '#D7C6A6';
const STONE_DARK = '#9F8D70';

/** Where each distance band sits (shield centre, share of the field) and how big it is drawn. */
const BANDS: Record<number, { y: number; scale: number }> = {
  1: { y: 0.24, scale: 0.62 },
  2: { y: 0.54, scale: 0.8 },
  3: { y: 0.86, scale: 1 },
};

function shieldColor(number: number): string {
  return SHIELDS[number % SHIELDS.length]!;
}

/** Original cartoon invader seen from behind, carrying a BLANK round shield (the number is live text). */
function InvaderBody({ size, color, kind, damaged }: { size: number; color: string; kind: number; damaged: boolean }) {
  return (
    <Svg width={size} height={size * 1.15} viewBox="0 0 100 115">
      <Ellipse cx={50} cy={110} rx={34} ry={5} fill="#000" opacity={0.25} />
      <Rect x={33} y={84} width={12} height={24} rx={5} fill="#4A3423" />
      <Rect x={55} y={84} width={12} height={24} rx={5} fill="#4A3423" />
      <Path d="M24 50 Q50 34 76 50 L80 90 Q50 98 20 90 Z" fill={kind === 1 ? '#3C7A3A' : kind === 2 ? '#8E2B2B' : '#5C4A86'} />
      <Line x1={84} y1={20} x2={84} y2={96} stroke="#7A5A36" strokeWidth={4} strokeLinecap="round" />
      <Path d="M84 8 L79 22 L89 22 Z" fill="#C9D2E2" />
      <Circle cx={50} cy={30} r={17} fill="#8D97A8" />
      <Path d="M33 30 Q50 6 67 30 Z" fill="#B5BFCD" />
      {kind === 0 ? (
        <>
          <Path d="M34 22 Q22 10 26 0 Q32 12 40 18 Z" fill="#F1E6CF" />
          <Path d="M66 22 Q78 10 74 0 Q68 12 60 18 Z" fill="#F1E6CF" />
        </>
      ) : null}
      {kind === 1 ? <Path d="M48 12 Q60 -4 70 6 Q60 6 54 16 Z" fill="#E2453C" /> : null}
      {kind === 2 ? <Rect x={46} y={6} width={8} height={10} rx={2} fill="#B5BFCD" /> : null}
      <Circle cx={50} cy={66} r={31} fill="#3A2A1C" />
      <Circle cx={50} cy={66} r={28} fill={color} />
      <Circle cx={50} cy={66} r={28} fill="none" stroke="#E6E9F0" strokeWidth={3} opacity={0.85} />
      <Circle cx={50} cy={66} r={19} fill="#000" opacity={0.12} />
      {damaged ? <Path d="M36 46 L46 60 L40 66 L52 80" stroke="#1B120B" strokeWidth={3} fill="none" strokeLinecap="round" /> : null}
    </Svg>
  );
}

function InvaderSprite({ invader, size, x, y }: { invader: Invader; size: number; x: number; y: number }) {
  const kind = Number(invader.id.split('.')[1] ?? 0) % 3;
  const sprite = INVADER_SPRITES[kind];
  const height = size * 1.15;
  const shieldCy = (66 / 115) * height;
  return (
    <View
      accessibilityLabel={`Invader ${invader.number}, strength ${invader.strength} of ${invader.maxStrength}, ${invader.distance} from the wall`}
      style={{ position: 'absolute', left: x - size / 2, top: y - shieldCy, width: size, height }}
    >
      {sprite ? (
        <Image source={invader.strength < invader.maxStrength ? (sprite.damaged ?? sprite.intact) : sprite.intact} style={{ width: size, height }} resizeMode="contain" />
      ) : (
        <InvaderBody size={size} color={shieldColor(invader.number)} kind={kind} damaged={invader.strength < invader.maxStrength} />
      )}
      <View style={{ position: 'absolute', left: 0, right: 0, top: shieldCy - size * 0.28, height: size * 0.56, alignItems: 'center', justifyContent: 'center' }}>
        <Text
          style={{
            color: arcade.ink,
            fontFamily: fontFamily('display'),
            fontWeight: 'normal',
            fontSize: size * (invader.number >= 10 ? 0.34 : 0.4),
            lineHeight: size * 0.44,
            includeFontPadding: false,
            textShadowColor: 'rgba(0,0,0,0.85)',
            textShadowOffset: { width: 0, height: size * 0.02 },
            textShadowRadius: size * 0.03,
          }}
        >
          {invader.number}
        </Text>
      </View>
      {/* Strength pips on the shield's top rim, so the stage's lower plaques never hide them. */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: shieldCy - size * 0.31, flexDirection: 'row', justifyContent: 'center', gap: size * 0.05 }}>
        {Array.from({ length: invader.maxStrength }, (_, i) => (
          <View
            key={i}
            style={{
              width: size * 0.11,
              height: size * 0.11,
              borderRadius: size * 0.055,
              backgroundColor: i < invader.strength ? arcade.danger : 'rgba(0,0,0,0.45)',
              borderWidth: Math.max(1, size * 0.015),
              borderColor: '#FFFFFF',
            }}
          />
        ))}
      </View>
    </View>
  );
}

/** The current player's wall: ten merlons, one per brick, lost ones shown as rubble. */
function Wall({ width, height, bricks, max }: { width: number; height: number; bricks: number; max: number }) {
  const step = 100 / max;
  return (
    <Svg width={width} height={height} viewBox="0 0 100 30" preserveAspectRatio="none">
      <Rect x={0} y={12} width={100} height={18} fill={STONE} />
      {[16, 22, 28].map((y) => (
        <Line key={y} x1={0} y1={y} x2={100} y2={y} stroke={STONE_DARK} strokeWidth={0.4} />
      ))}
      {Array.from({ length: max }, (_, i) => {
        const x = i * step + step * 0.14;
        const w = step * 0.72;
        return i < bricks ? (
          <G key={i}>
            <Rect x={x} y={2} width={w} height={11} fill={STONE} stroke={STONE_DARK} strokeWidth={0.4} />
            <Rect x={x} y={2} width={w} height={2} fill="#F1E6CF" opacity={0.7} />
          </G>
        ) : (
          <Path key={i} d={`M${x} 13 L${x + w * 0.3} 8 L${x + w * 0.55} 11 L${x + w * 0.8} 7 L${x + w} 13 Z`} fill={STONE_DARK} opacity={0.8} />
        );
      })}
    </Svg>
  );
}

/**
 * Siege's stage, drawn from the real view: the current player's wall (live brick count) and
 * their invaders in three bands by distance to the wall, each shield carrying its live number
 * and strength pips. With more than four players every wall is also listed underneath.
 */
export function SiegeStage({ view, width, height }: { view: SiegeView; width: number; height: number }) {
  const { s } = useLayout();
  const seat = Math.max(0, view.scoreboard.findIndex((r) => r.playerId === view.current));
  const lane = view.lanes[seat];
  const me = view.scoreboard[seat];
  if (!lane || !me || width <= 0 || height <= 0) return null;
  const wallH = Math.min(height * 0.2, width * 0.15);
  const wallW = width * 0.94;
  // Up now and Up next already show up to four walls; list them all when some are hidden.
  const strip = view.lanes.length > 4 ? s(34) : 0;
  const fieldTop = wallH;
  const fieldH = height - wallH - strip;
  const shield = Math.min(fieldH * 0.4, width / 4.4);
  const breach = view.breaches.find((b) => b.playerId === me.playerId);

  return (
    <View style={{ width, height }}>
      <View style={{ position: 'absolute', left: (width - wallW) / 2, top: 0 }}>
        <Wall width={wallW} height={wallH} bricks={lane.wall} max={view.maxWall} />
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: wallH * 0.12, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8), paddingHorizontal: s(10), borderRadius: s(5), backgroundColor: 'rgba(3,7,17,0.82)' }}>
            <AText variant="condBold" upper>
              {`${me.name}'s wall`}
            </AText>
            <AText variant="headline" color={lane.wall <= 3 ? arcade.danger : arcade.ink} style={{ fontSize: s(24), lineHeight: s(26) }}>
              {`${lane.wall} / ${view.maxWall}`}
            </AText>
            {breach ? (
              <AText variant="condBold" color={arcade.danger}>
                {`−${breach.bricks} last round`}
              </AText>
            ) : null}
          </View>
        </View>
      </View>

      {[1, 2, 3].map((d) => (
        <View
          key={d}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            top: fieldTop + fieldH * BANDS[d]!.y - s(9),
            paddingHorizontal: s(5),
            borderRadius: s(4),
            backgroundColor: 'rgba(3,7,17,0.6)',
          }}
        >
          <AText variant="kicker" color={arcade.ink} style={{ fontSize: s(11), lineHeight: s(14) }}>
            {d === 1 ? '1 STEP' : `${d} STEPS`}
          </AText>
        </View>
      ))}

      {[3, 2, 1].map((d) => {
        const row = lane.invaders.filter((inv) => inv.distance === d);
        const size = shield * BANDS[d]!.scale * 1.55;
        return row.map((inv, i) => (
          <InvaderSprite key={inv.id} invader={inv} size={size} x={width * 0.12 + ((i + 1) * width * 0.82) / (row.length + 1)} y={fieldTop + fieldH * BANDS[d]!.y} />
        ));
      })}

      {lane.fallen ? (
        <View style={{ position: 'absolute', left: 0, right: 0, top: fieldTop + fieldH * 0.4, alignItems: 'center' }}>
          <AText variant="headline" color={arcade.danger} upper>
            Wall down
          </AText>
        </View>
      ) : lane.invaders.length === 0 ? (
        <View style={{ position: 'absolute', left: 0, right: 0, top: fieldTop + fieldH * 0.4, alignItems: 'center' }}>
          <AText variant="headline" upper>
            Wave cleared
          </AText>
        </View>
      ) : null}

      {strip > 0 ? (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: strip, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignContent: 'center', gap: s(4) }}>
          {view.lanes.map((l, i) => (
            <View
              key={l.playerId}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: s(4),
                paddingHorizontal: s(6),
                borderRadius: s(4),
                backgroundColor: i === seat ? 'rgba(17,34,80,0.95)' : 'rgba(3,7,17,0.82)',
                borderWidth: s(1),
                borderColor: i === seat ? arcade.frame : 'transparent',
                opacity: l.fallen ? 0.5 : 1,
              }}
            >
              <AText variant="kicker" color={arcade.ink} numberOfLines={1} style={{ fontSize: s(11), lineHeight: s(14), maxWidth: s(60) }}>
                {view.scoreboard[i]!.name}
              </AText>
              <AText variant="kicker" color={l.wall <= 3 ? arcade.danger : arcade.ink} style={{ fontSize: s(11), lineHeight: s(14) }}>
                {`${l.wall}`}
              </AText>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
