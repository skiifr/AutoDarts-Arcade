/**
 * Arcade theme tokens. Sizes are design units: multiply by `s()` from `useLayout()`.
 * Design canvas is 960×540 (a 1080p TV at 2× density) for wide layouts and 390 wide for phones.
 */
export const palette = {
  bg: '#090C17',
  bgRaised: '#0E1323',
  surface: '#141A2E',
  surfaceHi: '#1C2440',
  line: '#26304F',
  lineHi: '#3A4673',
  text: '#F4F6FF',
  textDim: '#AEB6D6',
  textMute: '#6E779E',
  gold: '#FFC53D',
  goldDeep: '#E59A00',
  cyan: '#38E1FF',
  rose: '#FF4F81',
  mint: '#3DDC97',
  amber: '#FFB020',
  onGold: '#1A1203',
  boardDark: '#121829',
  boardLight: '#222A44',
  ringA: '#FF4F81',
  ringB: '#16C6A3',
} as const;
export type PaletteKey = keyof typeof palette;

/**
 * Eight player colours chosen to stay distinct on the dark background. Identity is never
 * colour alone: every player also carries a number badge (ROADMAP P4 accessibility).
 */
export const playerColors = [
  '#FF9F1C',
  '#2EC4FF',
  '#3DDC97',
  '#FF5D8F',
  '#B78CFF',
  '#FFE14D',
  '#4D7CFF',
  '#E8EAF2',
] as const;

export function playerColor(index: number): string {
  return playerColors[((index % playerColors.length) + playerColors.length) % playerColors.length] ?? palette.text;
}

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { sm: 6, md: 10, lg: 16, xl: 22, pill: 999 } as const;

export const type = {
  display: { size: 44, weight: '900', tracking: 1.5 },
  h1: { size: 30, weight: '900', tracking: 1 },
  h2: { size: 22, weight: '800', tracking: 0.5 },
  h3: { size: 17, weight: '800', tracking: 0.3 },
  body: { size: 14, weight: '500', tracking: 0 },
  label: { size: 12, weight: '800', tracking: 1.4 },
  caption: { size: 11.5, weight: '500', tracking: 0.2 },
  score: { size: 26, weight: '900', tracking: 0 },
} as const;
export type TypeVariant = keyof typeof type;
