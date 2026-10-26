import { BOARD_NUMBERS_CLOCKWISE } from '@arcade/event-schema';
import { RADII, bedBand, polar, sectorPath } from '@arcade/ui-kit';
import { Platform } from 'react-native';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';

const SVG_FONT = Platform.OS === 'web' ? '"BarlowCondensed-Bold", "Arial Narrow", sans-serif' : 'BarlowCondensed-Bold';

/** Parses a route label ("T20", "D12", "S5", "25", "BULL") into a board spot to light up. */
function spotOf(label: string): { number: number; ring: 'S' | 'D' | 'T' } | null {
  if (label === 'BULL') return { number: 25, ring: 'D' };
  if (label === '25') return { number: 25, ring: 'S' };
  const ring = label[0];
  const number = Number(label.slice(1));
  return ring === 'S' || ring === 'D' || ring === 'T' ? { number, ring } : null;
}

/**
 * A front-on, low-key dartboard for behind a stage's hero number, with the live targets
 * (e.g. a checkout route) lit in the game's accent.
 */
export function StageBoard({ size, highlight = [], accent }: { size: number; highlight?: readonly string[]; accent: string }) {
  const lit = highlight.map(spotOf).filter((x): x is NonNullable<typeof x> => x !== null);
  const isLit = (number: number, ring: 'S' | 'D' | 'T') => lit.some((l) => l.number === number && l.ring === ring);
  return (
    <Svg width={size} height={size} viewBox="-1.22 -1.22 2.44 2.44">
      <Circle r={1.2} fill="#030A1C" stroke={accent} strokeOpacity={0.45} strokeWidth={0.012} />
      <Circle r={RADII.doubleOut + 0.02} fill="#0A0E16" />
      {BOARD_NUMBERS_CLOCKWISE.map((number, i) => {
        const even = i % 2 === 0;
        const beds = [
          { band: bedBand('single-inner'), fill: even ? '#16181D' : '#5D5544', ring: 'S' as const },
          { band: bedBand('triple'), fill: even ? '#7A1F24' : '#1E5A35', ring: 'T' as const },
          { band: bedBand('single-outer'), fill: even ? '#16181D' : '#5D5544', ring: 'S' as const },
          { band: bedBand('double'), fill: even ? '#7A1F24' : '#1E5A35', ring: 'D' as const },
        ];
        const p = polar(i * 18, RADII.numbers);
        return (
          <G key={number}>
            {beds.map((b, k) => (
              <Path key={k} d={sectorPath(i, b.band[0], b.band[1])} fill={isLit(number, b.ring) ? accent : b.fill} opacity={isLit(number, b.ring) ? 0.95 : 0.8} stroke="#05070C" strokeWidth={0.006} />
            ))}
            <SvgText x={p.x} y={p.y + 0.04} fontSize={0.12} fontFamily={SVG_FONT} fill={lit.some((l) => l.number === number) ? accent : '#C9D3EA'} textAnchor="middle">
              {String(number)}
            </SvgText>
          </G>
        );
      })}
      <Circle r={RADII.outerBull} fill={isLit(25, 'S') ? accent : '#1E5A35'} />
      <Circle r={RADII.innerBull} fill={isLit(25, 'D') ? accent : '#7A1F24'} />
    </Svg>
  );
}
