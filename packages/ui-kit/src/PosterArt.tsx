import Svg, { Circle, Defs, G, Line, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { arcade } from './theme';

export interface PosterArtProps {
  gameId: string;
  accent: string;
}

const W = 200;
const H = 560;

/** One dart, pointing down-left from (x, y) to its tip. */
function Dart({ x, y, angle, color }: { x: number; y: number; angle: number; color: string }) {
  return (
    <G transform={`translate(${x} ${y}) rotate(${angle})`}>
      <Line x1={0} y1={0} x2={0} y2={-34} stroke="#C9D2E8" strokeWidth={2.4} strokeLinecap="round" />
      <Rect x={-3.2} y={-58} width={6.4} height={26} rx={3} fill="#E9B04A" />
      <Path d="M0 -56 L-13 -80 L-2 -74 Z M0 -56 L13 -80 L2 -74 Z" fill={color} />
      <Path d="M-1.5 -74 L0 -86 L1.5 -74 Z" fill={color} />
    </G>
  );
}

/**
 * Simple vector poster art for games that have no illustration yet (Around the Clock, and
 * any new game). Fills the poster's art area (2 : 5.6) and contains no text: the title is
 * rendered by the card. Replace with painted art through the poster image slot.
 */
export function PosterArt({ gameId, accent }: PosterArtProps) {
  const id = `poster-${gameId}`;
  const done = 13;
  const cx = 100;
  const cy = 236;
  const r = 78;
  const progress = (done / 20) * 2 * Math.PI;
  const arcEnd = { x: cx + r * Math.sin(progress), y: cy - r * Math.cos(progress) };
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
      <Defs>
        <LinearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#0E3B33" />
          <Stop offset="0.55" stopColor="#072018" />
          <Stop offset="1" stopColor={arcade.bgDeep} />
        </LinearGradient>
        <RadialGradient id={`${id}-glow`} cx="50%" cy="42%" r="55%">
          <Stop offset="0" stopColor={accent} stopOpacity={0.55} />
          <Stop offset="1" stopColor={accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={W} height={H} fill={`url(#${id}-sky)`} />
      <Rect x={0} y={0} width={W} height={H} fill={`url(#${id}-glow)`} />
      {gameId === 'around-the-clock' ? (
        <G>
          {[150, 122].map((rr) => (
            <Circle key={rr} cx={cx} cy={cy} r={rr} stroke={accent} strokeOpacity={0.18} strokeWidth={1.5} fill="none" />
          ))}
          <Circle cx={cx} cy={cy} r={r + 16} fill="#06140F" stroke={accent} strokeOpacity={0.5} strokeWidth={2} />
          <Path
            d={`M ${cx} ${cy - r} A ${r} ${r} 0 ${progress > Math.PI ? 1 : 0} 1 ${arcEnd.x} ${arcEnd.y}`}
            stroke={accent}
            strokeWidth={9}
            strokeLinecap="round"
            fill="none"
          />
          {Array.from({ length: 20 }, (_, i) => {
            const a = ((i + 1) / 20) * 2 * Math.PI;
            const lit = i < done;
            return (
              <Circle
                key={i}
                cx={cx + (r + 1) * Math.sin(a)}
                cy={cy - (r + 1) * Math.cos(a)}
                r={lit ? 5.5 : 4}
                fill={lit ? '#EFFFF6' : '#28423A'}
                stroke={lit ? accent : 'none'}
                strokeWidth={2}
              />
            );
          })}
          <Circle cx={cx} cy={cy} r={22} fill="#0B2A20" stroke={accent} strokeWidth={3} />
          <Circle cx={cx} cy={cy} r={9} fill={accent} />
          <Dart x={arcEnd.x + 4} y={arcEnd.y + 6} angle={-140} color={accent} />
          {[0, 1, 2, 3, 4].map((i) => (
            <Circle key={`step-${i}`} cx={46 + i * 27} cy={420 - (i % 2) * 14 + i * 16} r={9 - i} fill={accent} opacity={0.75 - i * 0.12} />
          ))}
        </G>
      ) : (
        <Circle cx={cx} cy={cy} r={120} stroke={accent} strokeOpacity={0.4} strokeWidth={3} fill="none" />
      )}
    </Svg>
  );
}
