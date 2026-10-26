import { arcade } from '@arcade/ui-kit';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, Line, LinearGradient, Path, Polygon, RadialGradient, Rect, Stop } from 'react-native-svg';
import { STAGE_BACKGROUNDS } from '../art';

const W = 1920;
const H = 1080;

/**
 * Electric arena for the classic games: dark navy, beams and light strips in the game's
 * accent. Static vector placeholder for the `stage-<game>-bg` image slot.
 */
function ArenaBackdrop({ accent, id }: { accent: string; id: string }) {
  const beams = [-520, -260, 0, 260, 520];
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
      <Defs>
        <LinearGradient id={`${id}-base`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#020817" />
          <Stop offset="0.55" stopColor="#06194A" />
          <Stop offset="1" stopColor="#020611" />
        </LinearGradient>
        <LinearGradient id={`${id}-beam`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={accent} stopOpacity={0.32} />
          <Stop offset="1" stopColor={accent} stopOpacity={0} />
        </LinearGradient>
        <RadialGradient id={`${id}-centre`} cx="50%" cy="45%" r="45%">
          <Stop offset="0" stopColor={accent} stopOpacity={0.22} />
          <Stop offset="1" stopColor={accent} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={`${id}-floor`} cx="50%" cy="100%" r="55%">
          <Stop offset="0" stopColor={accent} stopOpacity={0.35} />
          <Stop offset="1" stopColor={accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={W} height={H} fill={`url(#${id}-base)`} />
      {beams.map((dx) => (
        <Polygon key={dx} points={`${W / 2 + dx * 0.25 - 18},0 ${W / 2 + dx * 0.25 + 18},0 ${W / 2 + dx * 1.6 + 170},${H} ${W / 2 + dx * 1.6 - 170},${H}`} fill={`url(#${id}-beam)`} />
      ))}
      <Rect x={0} y={0} width={W} height={H} fill={`url(#${id}-centre)`} />
      {/* Stands: slanted strips of lights either side. */}
      {[0, 1, 2, 3, 4].map((row) => (
        <G key={row}>
          <Line x1={0} y1={250 + row * 120} x2={420} y2={160 + row * 95} stroke={accent} strokeOpacity={0.55 - row * 0.07} strokeWidth={7} strokeDasharray="10 16" strokeLinecap="round" />
          <Line x1={W} y1={250 + row * 120} x2={W - 420} y2={160 + row * 95} stroke={accent} strokeOpacity={0.55 - row * 0.07} strokeWidth={7} strokeDasharray="10 16" strokeLinecap="round" />
        </G>
      ))}
      {/* Rig across the top. */}
      <Path d={`M0 70 L${W} 70 M180 0 L560 70 M${W - 180} 0 L${W - 560} 70 M760 0 L860 70 M${W - 760} 0 L${W - 860} 70`} stroke="#3C5A8F" strokeOpacity={0.5} strokeWidth={6} />
      {[620, 700, 1220, 1300].map((x) => (
        <Circle key={x} cx={x} cy={70} r={14} fill={accent} opacity={0.85} />
      ))}
      <Rect x={0} y={H * 0.84} width={W} height={H * 0.16} fill="#010410" opacity={0.6} />
      <Ellipse cx={W / 2} cy={H} rx={W * 0.55} ry={H * 0.2} fill={`url(#${id}-floor)`} />
      <Line x1={0} y1={H * 0.84} x2={W} y2={H * 0.84} stroke={accent} strokeOpacity={0.35} strokeWidth={3} />
    </Svg>
  );
}

/**
 * Siege's valley: sky, hills, a distant castle and the road the invaders march up. The live
 * wall and invaders are drawn by the stage on top; nothing here carries game data.
 */
function SiegeBackdrop() {
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
      <Defs>
        <LinearGradient id="siege-sky" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#1E9FD8" />
          <Stop offset="0.6" stopColor="#8FE0F2" />
          <Stop offset="1" stopColor="#D8F6EE" />
        </LinearGradient>
        <LinearGradient id="siege-grass" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#58B34A" />
          <Stop offset="1" stopColor="#2C6E2E" />
        </LinearGradient>
        <LinearGradient id="siege-shade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#000814" stopOpacity={0} />
          <Stop offset="1" stopColor="#000814" stopOpacity={0.55} />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={W} height={H} fill="url(#siege-sky)" />
      <Circle cx={1520} cy={150} r={70} fill="#FFF6C8" opacity={0.85} />
      {[
        [260, 120, 70],
        [1180, 90, 90],
        [1650, 260, 60],
        [520, 230, 50],
      ].map(([x, y, r]) => (
        <G key={`${x}`} opacity={0.9}>
          <Ellipse cx={x} cy={y} rx={r! * 1.6} ry={r! * 0.55} fill="#FFFFFF" />
          <Ellipse cx={x! + r! * 0.5} cy={y! - r! * 0.25} rx={r! * 0.9} ry={r! * 0.5} fill="#FFFFFF" />
        </G>
      ))}
      <Path d="M0 520 L240 330 L420 460 L640 280 L860 470 L1080 300 L1300 460 L1520 320 L1720 450 L1920 360 L1920 600 L0 600 Z" fill="#6E8FB8" opacity={0.75} />
      <Path d="M0 560 Q 300 470 620 540 T 1240 520 T 1920 540 L1920 700 L0 700 Z" fill="#7CC160" />
      {/* Distant castle, centred behind the stage. */}
      <G opacity={0.95}>
        <Rect x={760} y={380} width={400} height={170} fill="#C9B79A" />
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
          <Rect key={i} x={764 + i * 40} y={360} width={24} height={24} fill="#C9B79A" />
        ))}
        <Rect x={700} y={300} width={90} height={250} fill="#B9A587" />
        <Rect x={1130} y={300} width={90} height={250} fill="#B9A587" />
        <Polygon points="690,300 745,220 800,300" fill="#D9792B" />
        <Polygon points="1120,300 1175,220 1230,300" fill="#D9792B" />
        <Path d="M920 550 L920 470 Q960 430 1000 470 L1000 550 Z" fill="#5B4632" />
        <Line x1={745} y1={220} x2={745} y2={170} stroke="#5B4632" strokeWidth={5} />
        <Polygon points="745,170 790,184 745,198" fill="#E2453C" />
        <Line x1={1175} y1={220} x2={1175} y2={170} stroke="#5B4632" strokeWidth={5} />
        <Polygon points="1175,170 1220,184 1175,198" fill="#E2453C" />
      </G>
      <Path d="M0 620 Q 480 560 960 600 T 1920 610 L1920 1080 L0 1080 Z" fill="url(#siege-grass)" />
      {/* The road up to the gate. */}
      <Path d="M930 560 L990 560 L1340 1080 L580 1080 Z" fill="#C79A5E" opacity={0.9} />
      <Path d="M950 560 L970 560 L1060 1080 L860 1080 Z" fill="#DDB57A" opacity={0.7} />
      {[
        [120, 700, 70],
        [300, 820, 90],
        [1640, 720, 80],
        [1820, 860, 100],
        [480, 660, 45],
        [1460, 660, 50],
      ].map(([x, y, r]) => (
        <G key={`t${x}`}>
          <Rect x={x! - r! * 0.12} y={y!} width={r! * 0.24} height={r! * 0.9} fill="#6B4B2E" />
          <Circle cx={x} cy={y} r={r} fill="#2F7D32" />
          <Circle cx={x! - r! * 0.3} cy={y! - r! * 0.3} r={r! * 0.45} fill="#47A148" />
        </G>
      ))}
      <Rect x={0} y={0} width={W} height={H} fill="url(#siege-shade)" />
    </Svg>
  );
}

/** Full-screen themed backdrop for W3: a painted image when the slot is filled, else vector art. */
export function StageBackdrop({ gameId, accent }: { gameId: string; accent: string }) {
  const image = STAGE_BACKGROUNDS[gameId];
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: arcade.bg }]}>
      {image ? (
        <Image source={image} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : gameId === 'siege' ? (
        <SiegeBackdrop />
      ) : (
        <ArenaBackdrop accent={accent} id={`arena-${gameId}`} />
      )}
    </View>
  );
}
