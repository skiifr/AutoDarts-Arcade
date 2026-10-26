import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

export type IconName = 'target' | 'menu' | 'chevron-up' | 'chevron-down' | 'arrow-left' | 'hand' | 'warning' | 'review' | 'stop' | 'play' | 'dart';

/** Line icons drawn in SVG so they look the same on every platform and font. */
export function Icon({ name, size, color }: { name: IconName; size: number; color: string }) {
  const stroke = { stroke: color, strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'target' ? (
        <>
          <Circle cx={12} cy={12} r={8.5} {...stroke} />
          <Circle cx={12} cy={12} r={4} {...stroke} />
          <Circle cx={12} cy={12} r={1.2} fill={color} />
        </>
      ) : null}
      {name === 'menu' ? (
        <>
          <Line x1={4} y1={6.5} x2={20} y2={6.5} {...stroke} />
          <Line x1={4} y1={12} x2={20} y2={12} {...stroke} />
          <Line x1={4} y1={17.5} x2={20} y2={17.5} {...stroke} />
        </>
      ) : null}
      {name === 'chevron-up' ? <Path d="M5 15 L12 8 L19 15" {...stroke} /> : null}
      {name === 'chevron-down' ? <Path d="M5 9 L12 16 L19 9" {...stroke} /> : null}
      {name === 'arrow-left' ? <Path d="M19 12 H5 M11 6 L5 12 L11 18" {...stroke} /> : null}
      {name === 'hand' ? (
        <Path d="M8 12 V5.5 a1.5 1.5 0 0 1 3 0 V11 V4 a1.5 1.5 0 0 1 3 0 V11 V5.5 a1.5 1.5 0 0 1 3 0 V14 c0 4 -2.5 6.5 -6 6.5 c-2.6 0 -4.2 -1.4 -5.6 -3.6 L4 13.6 a1.5 1.5 0 0 1 2.4 -1.8 Z" {...stroke} />
      ) : null}
      {name === 'warning' ? (
        <>
          <Path d="M12 3.5 L21.5 20 H2.5 Z" {...stroke} />
          <Line x1={12} y1={10} x2={12} y2={14} {...stroke} />
          <Circle cx={12} cy={17} r={1.2} fill={color} />
        </>
      ) : null}
      {name === 'review' ? (
        <>
          <Circle cx={10.5} cy={10.5} r={6.5} {...stroke} />
          <Line x1={15.5} y1={15.5} x2={20.5} y2={20.5} {...stroke} />
          <Line x1={10.5} y1={7.5} x2={10.5} y2={11} {...stroke} />
          <Circle cx={10.5} cy={13.6} r={1} fill={color} />
        </>
      ) : null}
      {name === 'stop' ? (
        <>
          <Path d="M8 3 H16 L21 8 V16 L16 21 H8 L3 16 V8 Z" {...stroke} />
          <Line x1={8} y1={12} x2={16} y2={12} {...stroke} />
        </>
      ) : null}
      {name === 'play' ? <Path d="M8 5 L19 12 L8 19 Z" fill={color} /> : null}
      {name === 'dart' ? (
        <>
          <Line x1={4} y1={20} x2={11} y2={13} {...stroke} />
          <Rect x={10.5} y={8.5} width={4} height={6} rx={1.5} transform="rotate(45 12.5 11.5)" fill={color} />
          <Path d="M15 9 L20 4 M15 9 L19.5 9.5 M15 9 L14.5 4.5" {...stroke} />
        </>
      ) : null}
    </Svg>
  );
}
