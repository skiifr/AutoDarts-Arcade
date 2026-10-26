import { BOARD_NUMBERS_CLOCKWISE, type Bed } from '@arcade/event-schema';
import { Platform } from 'react-native';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';
import { RADII, bedBand, bedCentroid, polar, sectorPath } from './boardGeometry';
import { palette } from './theme';

export interface BoardSpot {
  number: number;
  bed: Bed;
}

export interface DartboardMarker extends BoardSpot {
  tone?: 'gold' | 'cyan' | 'dim';
}

export interface DartboardProps {
  /** Rendered size in device-independent pixels (already scaled). */
  size: number;
  /** Bed to highlight as the current selection (correction picker). */
  selected?: BoardSpot | null;
  /** Darts to pin on the board (live gameplay). */
  markers?: DartboardMarker[];
  /** Number whose label is emphasised. */
  focusNumber?: number;
  /** Makes beds tappable (touch correction). */
  onSelect?: (spot: BoardSpot) => void;
}

const NUMBER_BEDS: Bed[] = ['single-inner', 'triple', 'single-outer', 'double'];
const MARKER_COLORS = { gold: palette.gold, cyan: palette.cyan, dim: palette.textMute } as const;

/** react-native-svg on the web falls back to a serif font; match the app's sans stack. */
const SVG_FONT = Platform.OS === 'web' ? 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' : undefined;

const isSelected = (sel: BoardSpot | null | undefined, number: number, bed: Bed) =>
  !!sel &&
  sel.bed !== 'inner-bull' &&
  sel.bed !== 'outer-bull' &&
  sel.number === number &&
  (sel.bed === bed || (sel.bed === 'single' && bed === 'single-outer'));

/** Original stylised board: dark singles, rose/teal rings, gold for whatever is selected. */
export function Dartboard({ size, selected, markers = [], focusNumber, onSelect }: DartboardProps) {
  return (
    <Svg width={size} height={size} viewBox="-1.22 -1.22 2.44 2.44" accessibilityLabel="Dartboard">
      <Circle r={1.2} fill={palette.bgRaised} />
      <Circle r={RADII.doubleOut + 0.07} fill="#0B0F1D" />
      {BOARD_NUMBERS_CLOCKWISE.map((number, i) => {
        const missSelected = selected?.bed === 'miss' && selected.number === number;
        const missBand = bedBand('miss');
        return (
          <G key={number}>
            {missSelected ? <Path d={sectorPath(i, missBand[0], RADII.doubleOut + 0.07)} fill={palette.gold} opacity={0.55} /> : null}
            {NUMBER_BEDS.map((bed) => {
              const [r0, r1] = bedBand(bed);
              const ring = bed === 'triple' || bed === 'double';
              const base = ring ? (i % 2 === 0 ? palette.ringA : palette.ringB) : i % 2 === 0 ? palette.boardDark : palette.boardLight;
              const sel = isSelected(selected, number, bed);
              return (
                <Path
                  key={bed}
                  d={sectorPath(i, r0, r1)}
                  fill={sel ? palette.gold : base}
                  opacity={ring && !sel ? 0.9 : 1}
                  stroke={palette.bg}
                  strokeWidth={0.006}
                  onPress={onSelect ? () => onSelect({ number, bed }) : undefined}
                />
              );
            })}
            {(() => {
              const p = polar(i * 18, RADII.numbers);
              const emphasised = focusNumber === number;
              return (
                <SvgText
                  x={p.x}
                  y={p.y + 0.036}
                  fontSize={emphasised ? 0.12 : 0.1}
                  fontWeight="bold"
                  fontFamily={SVG_FONT}
                  fill={emphasised ? palette.gold : palette.textDim}
                  textAnchor="middle"
                >
                  {String(number)}
                </SvgText>
              );
            })()}
          </G>
        );
      })}
      <Circle
        r={RADII.outerBull}
        fill={selected?.bed === 'outer-bull' ? palette.gold : palette.ringB}
        stroke={palette.bg}
        strokeWidth={0.006}
        onPress={onSelect ? () => onSelect({ number: 25, bed: 'outer-bull' }) : undefined}
      />
      <Circle
        r={RADII.innerBull}
        fill={selected?.bed === 'inner-bull' ? palette.gold : palette.ringA}
        stroke={palette.bg}
        strokeWidth={0.006}
        onPress={onSelect ? () => onSelect({ number: 25, bed: 'inner-bull' }) : undefined}
      />
      {markers.map((m, i) => {
        const c = bedCentroid(m.number, m.bed === 'miss' ? 'miss' : m.bed);
        return (
          <G key={`${m.number}-${m.bed}-${i}`}>
            <Circle cx={c.x} cy={c.y} r={0.052} fill={palette.bg} opacity={0.7} />
            <Circle cx={c.x} cy={c.y} r={0.036} fill={MARKER_COLORS[m.tone ?? 'gold']} stroke={palette.bg} strokeWidth={0.012} />
          </G>
        );
      })}
    </Svg>
  );
}
