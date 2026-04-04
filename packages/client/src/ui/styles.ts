const BASE_COLORS = {
  // Agent state colors (semantic — same in both themes)
  active: '#2d9a50',
  routine: '#3a7ac8',
  idle: '#7a6aaa',
  sleeping: '#999990',

  // Personality trait colors
  openness: '#7a6aaa',
  conscientiousness: '#3a7ac8',
  extraversion: '#c49000',
  agreeableness: '#2d9a50',
  neuroticism: '#cc5555',
};

export const LIGHT_COLORS = {
  ...BASE_COLORS,
  bg: '#f5f5f0',
  bgLight: '#eeeee8',
  bgCard: '#ffffff',
  bgHover: '#e8e8e0',
  border: '#d0d0c8',
  text: '#2a2a2a',
  textDim: '#777770',
  textAccent: '#2a8a6a',
  accent: '#2a8a6a',
  accentDim: '#b8ddd0',
  gold: '#c49000',
  warning: '#cc4444',
};

export const DARK_COLORS = {
  ...BASE_COLORS,
  bg: '#0f0f1a',
  bgLight: '#1a1a2e',
  bgCard: '#16162a',
  bgHover: '#222240',
  border: '#2a2a4a',
  text: '#e0e0e8',
  textDim: '#8888aa',
  textAccent: '#64ffda',
  accent: '#64ffda',
  accentDim: '#1a3a30',
  gold: '#e8b800',
  warning: '#ff6b6b',
};

export type ThemeColors = typeof LIGHT_COLORS;

/** @deprecated Use useTheme().colors instead */
export const COLORS = LIGHT_COLORS;

export const FONTS = {
  pixel: '"Press Start 2P", monospace',
  body: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

export const SIZES = {
  sidebarWidth: '420px' as string | number,
  cardPadding: 12,
  borderRadius: 4,
};
