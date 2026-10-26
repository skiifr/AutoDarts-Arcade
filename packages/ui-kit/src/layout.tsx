import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { PixelRatio, Platform, useWindowDimensions } from 'react-native';

/** How the user drives the UI: a TV remote (D-pad) or touch. */
export type InputMode = 'remote' | 'touch';
/** Wide = the 16:9 wireframe layouts (TV, tablets, landscape). Narrow = phone portrait. */
export type LayoutMode = 'wide' | 'narrow';

export interface LayoutInfo {
  width: number;
  height: number;
  input: InputMode;
  mode: LayoutMode;
  scale: number;
  /** Converts design units to device-independent pixels. */
  s: (units: number) => number;
  /** Horizontal and vertical safe padding: title-safe 5% on TV (Amazon overscan rule). */
  gutterX: number;
  gutterY: number;
}

const LayoutContext = createContext<LayoutInfo | null>(null);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function computeLayout(width: number, height: number, input: InputMode): LayoutInfo {
  const mode: LayoutMode = width >= height && width >= 700 ? 'wide' : 'narrow';
  const scale =
    mode === 'wide' ? clamp(Math.min(width / 960, height / 540), 0.72, 2.4) : clamp(width / 390, 0.85, 1.5);
  const s = (units: number) => PixelRatio.roundToNearestPixel(units * scale);
  const gutterX = input === 'remote' ? Math.round(width * 0.05) : s(mode === 'wide' ? 20 : 14);
  const gutterY = input === 'remote' ? Math.round(height * 0.05) : s(mode === 'wide' ? 14 : 10);
  return { width, height, input, mode, scale, s, gutterX, gutterY };
}

export function LayoutProvider({ children, input }: { children: ReactNode; input?: InputMode }) {
  const { width, height } = useWindowDimensions();
  const resolvedInput: InputMode = input ?? (Platform.isTV ? 'remote' : 'touch');
  const value = useMemo(() => computeLayout(width, height, resolvedInput), [width, height, resolvedInput]);
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutInfo {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used inside <LayoutProvider>');
  return ctx;
}
