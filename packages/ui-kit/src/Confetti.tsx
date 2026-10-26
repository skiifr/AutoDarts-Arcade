import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import { palette, playerColors } from './theme';

interface Piece {
  x: number;
  delay: number;
  duration: number;
  sway: number;
  spin: number;
  size: number;
  color: string;
}

/** Small deterministic PRNG so the burst is stable across renders and pure for React. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLORS = [palette.gold, palette.cyan, palette.rose, palette.mint, ...playerColors.slice(4, 6)];

function makePieces(count: number, width: number): Piece[] {
  const rand = mulberry32(count * 7919 + Math.round(width));
  return Array.from({ length: count }, () => ({
    x: rand() * width,
    delay: rand() * 1800,
    duration: 2200 + rand() * 1600,
    sway: 10 + rand() * 30,
    spin: 180 + rand() * 540,
    size: 6 + rand() * 8,
    color: COLORS[Math.floor(rand() * COLORS.length)] ?? palette.gold,
  }));
}

function ConfettiPiece({ piece, height }: { piece: Piece; height: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(piece.delay, withRepeat(withTiming(1, { duration: piece.duration, easing: Easing.linear }), -1, false));
  }, [piece.delay, piece.duration, t]);
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: piece.x + Math.sin(t.value * Math.PI * 4) * piece.sway },
      { translateY: -30 + t.value * (height + 60) },
      { rotate: `${t.value * piece.spin}deg` },
    ],
  }));
  return (
    <Animated.View
      style={[
        { position: 'absolute', left: 0, top: 0, width: piece.size, height: piece.size * 0.45, borderRadius: 1.5, backgroundColor: piece.color },
        style,
      ]}
    />
  );
}

/**
 * Celebration burst for the victory screen. Keep `count` within the quality tier's budget:
 * ≤ 40 on the Fire TV Stick (Standard tier), more on iPad (ARCHITECTURE §9.2).
 */
export function Confetti({ count, width, height }: { count: number; width: number; height: number }) {
  const pieces = makePieces(count, width);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {pieces.map((p, i) => (
        <ConfettiPiece key={i} piece={p} height={height} />
      ))}
    </View>
  );
}
