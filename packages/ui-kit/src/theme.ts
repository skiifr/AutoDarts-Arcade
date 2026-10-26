import { Platform } from 'react-native';

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

// ── Arcade look ("Visual system" in docs/design/asset-spec.md) ──────────────────────────

/**
 * Tokens for the arcade screens: dark navy, thin cyan frame lines, and gold for the remote
 * focus ring ONLY. Nothing decorative (avatar rings, banners, plaques, accents) is gold.
 */
export const arcade = {
  bg: '#060D1D',
  bgDeep: '#030711',
  panel: '#0A1630',
  panelHi: '#112250',
  plate: '#08122A',
  frame: '#2CD5F2',
  frameDim: '#1B7E96',
  frameFaint: 'rgba(44, 213, 242, 0.22)',
  ink: '#F4F7FF',
  inkDim: '#B4C0E2',
  inkMute: '#71809F',
  /** Text on a bright accent strip. */
  onAccent: '#06101F',
  /** The one focus indicator. Same value as `palette.gold`. */
  focus: palette.gold,
  danger: '#FF4F6D',
  warn: '#FF8A3D',
} as const;

/**
 * One accent per game: title strips, plaque titles and stage highlights. Accents are fills
 * and text, never outlines around focusable things, so they never compete with the gold ring.
 * Siege's amber is pushed towards orange to keep it clear of the focus gold.
 */
export const gameAccents = {
  siege: '#FF9A1F',
  territory: '#A8E83A',
  balloon: '#FF4FA8',
  countdown: '#2FE3FF',
  cricket: '#A66CFF',
  'around-the-clock': '#22D07A',
} as const;

/** "#RRGGBB" at the given opacity, for tints of an accent. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function gameAccent(gameId: string): string {
  return (gameAccents as Record<string, string>)[gameId] ?? arcade.frame;
}

/**
 * Bold condensed display face: Barlow Condensed (SIL OFL 1.1), bundled by the app in
 * apps/arcade/assets/fonts and loaded with expo-font under these names (the PostScript
 * names, which are also the file names, so iOS and Android agree). The web gets a stack
 * so a missing font degrades to a narrow system face instead of a serif.
 */
export const FONT_FILES = {
  display: 'BarlowCondensed-ExtraBold',
  bold: 'BarlowCondensed-Bold',
  semi: 'BarlowCondensed-SemiBold',
} as const;
export type FontRole = keyof typeof FONT_FILES;

export function fontFamily(role: FontRole): string {
  return Platform.OS === 'web' ? `"${FONT_FILES[role]}", "Arial Narrow", "Roboto Condensed", system-ui, sans-serif` : FONT_FILES[role];
}

export const type = {
  display: { size: 44, weight: '900', tracking: 1.5 },
  h1: { size: 30, weight: '900', tracking: 1 },
  h2: { size: 22, weight: '800', tracking: 0.5 },
  h3: { size: 17, weight: '800', tracking: 0.3 },
  body: { size: 14, weight: '500', tracking: 0 },
  label: { size: 12, weight: '800', tracking: 1.4 },
  caption: { size: 11.5, weight: '500', tracking: 0.2 },
  score: { size: 26, weight: '900', tracking: 0 },
  // Condensed arcade styles. Sizes are design units; at 1080p one unit is 2 px.
  /** Small caps line: "UP NOW", "ROUND 4 OF 10". */
  kicker: { size: 13, weight: '700', tracking: 1.6, family: 'bold' },
  /** Readable condensed body: captions, details. */
  cond: { size: 15, weight: '600', tracking: 0.3, family: 'semi' },
  /** Names, tab labels, button labels. */
  condBold: { size: 18, weight: '700', tracking: 0.8, family: 'bold' },
  /** Plaque instructions and section titles. */
  headline: { size: 28, weight: '800', tracking: 1, family: 'display' },
  /** Big scores. */
  hero: { size: 56, weight: '800', tracking: 0.5, family: 'display' },
} as const;
export type TypeVariant = keyof typeof type;
