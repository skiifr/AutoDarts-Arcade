import { Platform } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { palette, playerColors } from './theme';

/** react-native-svg on the web falls back to a serif font; match the app's sans stack. */
const SVG_FONT = Platform.OS === 'web' ? 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' : undefined;

/** Original, procedural key art for each game tile. 160×100 canvas, scaled to `width`. */
export function GameTileArt({ gameId, width }: { gameId: string; width: number }) {
  const height = (width * 100) / 160;
  const gradId = `tile-${gameId}`;
  const [top, bottom] = TILE_GRADIENTS[gameId] ?? [palette.surfaceHi, palette.bgRaised];
  return (
    <Svg width={width} height={height} viewBox="0 0 160 100">
      <Defs>
        <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={top} stopOpacity={0.9} />
          <Stop offset="1" stopColor={bottom} stopOpacity={1} />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={160} height={100} fill={`url(#${gradId})`} />
      {ART[gameId]?.() ?? null}
    </Svg>
  );
}

const TILE_GRADIENTS: Record<string, [string, string]> = {
  siege: ['#5A1630', '#120A1C'],
  territory: ['#0E4A4A', '#0A1420'],
  balloon: ['#3B2470', '#110D24'],
  countdown: ['#5C3B05', '#140E05'],
  cricket: ['#123A66', '#0A1222'],
  'around-the-clock': ['#1F4A22', '#0A140C'],
};

const ART: Record<string, () => React.ReactElement> = {
  siege: () => (
    <G>
      {[
        [38, 26, '20'],
        [82, 16, '5'],
        [122, 34, '1'],
      ].map(([x, y, n]) => (
        <G key={String(n)}>
          <Circle cx={Number(x)} cy={Number(y)} r={11} fill={palette.rose} opacity={0.9} />
          <SvgText x={Number(x)} y={Number(y) + 4} fontSize={11} fontWeight="bold" fontFamily={SVG_FONT} fill="#fff" textAnchor="middle">
            {String(n)}
          </SvgText>
        </G>
      ))}
      <Path
        d="M0 100 V70 H14 V62 H26 V70 H40 V62 H52 V70 H66 V62 H78 V70 H92 V62 H104 V70 H118 V62 H130 V70 H144 V62 H160 V100 Z"
        fill="#1A1028"
        stroke={palette.gold}
        strokeWidth={1.5}
      />
    </G>
  ),
  territory: () => (
    <G transform="translate(80 92)">
      {Array.from({ length: 9 }, (_, i) => {
        const a0 = ((-90 - 81 + i * 18) * Math.PI) / 180;
        const a1 = a0 + (18 * Math.PI) / 180;
        const r = 78;
        return (
          <Path
            key={i}
            d={`M0 0 L${r * Math.cos(a0)} ${r * Math.sin(a0)} A${r} ${r} 0 0 1 ${r * Math.cos(a1)} ${r * Math.sin(a1)} Z`}
            fill={playerColors[i % 4]}
            opacity={i % 3 === 1 ? 0.25 : 0.75}
            stroke="#0A1420"
            strokeWidth={1.5}
          />
        );
      })}
    </G>
  ),
  balloon: () => (
    <G>
      {[
        [36, 40, playerColors[3]],
        [66, 30, palette.cyan],
        [98, 44, palette.gold],
        [126, 32, playerColors[2]],
      ].map(([x, y, c], i) => (
        <G key={i}>
          <Line x1={Number(x)} y1={Number(y) + 15} x2={Number(x) + (i % 2 ? 4 : -4)} y2={96} stroke={palette.textMute} strokeWidth={1} />
          <Circle cx={Number(x)} cy={Number(y)} r={14} fill={String(c)} />
          <Circle cx={Number(x) - 5} cy={Number(y) - 5} r={3.5} fill="#fff" opacity={0.45} />
        </G>
      ))}
    </G>
  ),
  countdown: () => (
    <G>
      <Path d="M30 84 A50 50 0 0 1 130 84" stroke={palette.line} strokeWidth={8} fill="none" strokeLinecap="round" />
      <Path d="M30 84 A50 50 0 0 1 104 41" stroke={palette.gold} strokeWidth={8} fill="none" strokeLinecap="round" />
      <SvgText x={80} y={78} fontSize={30} fontWeight="bold" fontFamily={SVG_FONT} fill="#fff" textAnchor="middle">
        501
      </SvgText>
    </G>
  ),
  cricket: () => (
    <G>
      {['20', '19', '18'].map((n, row) => (
        <G key={n}>
          <SvgText x={34} y={32 + row * 24} fontSize={16} fontWeight="bold" fontFamily={SVG_FONT} fill="#fff" textAnchor="middle">
            {n}
          </SvgText>
          {row >= 0 ? <Line x1={66} y1={38 + row * 24} x2={80} y2={22 + row * 24} stroke={palette.cyan} strokeWidth={3} /> : null}
          {row <= 1 ? <Line x1={66} y1={22 + row * 24} x2={80} y2={38 + row * 24} stroke={palette.cyan} strokeWidth={3} /> : null}
          {row === 0 ? <Circle cx={73} cy={30} r={11} stroke={palette.gold} strokeWidth={2.5} fill="none" /> : null}
          <Rect x={98} y={22 + row * 24} width={36 - row * 10} height={14} rx={3} fill={palette.gold} opacity={0.75} />
        </G>
      ))}
    </G>
  ),
  'around-the-clock': () => (
    <G transform="translate(80 52)">
      {Array.from({ length: 20 }, (_, i) => {
        const a = ((i * 18 - 90) * Math.PI) / 180;
        return <Circle key={i} cx={38 * Math.cos(a)} cy={38 * Math.sin(a)} r={i < 7 ? 4.5 : 3} fill={i < 7 ? palette.mint : palette.line} />;
      })}
      <SvgText x={0} y={7} fontSize={20} fontWeight="bold" fontFamily={SVG_FONT} fill="#fff" textAnchor="middle">
        7
      </SvgText>
    </G>
  ),
};
