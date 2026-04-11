// Design tokens — single source of truth for all visual constants.
// See ADR-0002 for rationale. Every color, font, and spacing value used
// in served HTML originates from this file.

// ---------------------------------------------------------------------------
// Colors — Primary Purple Scale
// ---------------------------------------------------------------------------

export const purple = {
  brand: "#6659a7",
  plus1: "#3c2f7f",
  plus2: "#120457",
  minus1: "#9289c0",
  minus2: "#beb8da",
  minus3: "#eae8f3",
} as const;

// ---------------------------------------------------------------------------
// Colors — Greyscale
// ---------------------------------------------------------------------------

export const grey = {
  black: "#000000",
  grey4: "#636466",
  grey3: "#8a8c8e",
  grey2: "#c7c8ca",
  grey1: "#efeff0",
  white: "#ffffff",
} as const;

// ---------------------------------------------------------------------------
// Colors — Complementary (functional use only: status indicators)
// ---------------------------------------------------------------------------

export const complementary = {
  sandstone: { base: "#dac48a", light: "#F8F2E6" },
  teal: { base: "#AABDB5", light: "#dae2df" },
  cobalt: { base: "#5271AC", light: "#DCE2EE" },
  peach: { base: "#F9AA8F", hover: "#e8926e", light: "#FDE4DC" },
} as const;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const fontFamily = "'Lexend', Arial, sans-serif";

export const fontWeight = {
  light: 300,
  regular: 400,
  semibold: 600,
  bold: 700,
} as const;

export const fontSize = {
  xs: "0.8rem",
  sm: "0.85rem",
  base: "0.95rem",
  md: "1rem",
  lg: "1.3rem",
  xl: "1.4rem",
  xxl: "1.8rem",
  icon: "3rem",
} as const;

// ---------------------------------------------------------------------------
// Spacing
// ---------------------------------------------------------------------------

export const spacing = {
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  xxl: "32px",
  xxxl: "40px",
} as const;

// ---------------------------------------------------------------------------
// Border radius
// ---------------------------------------------------------------------------

export const borderRadius = {
  sm: "6px",
  md: "8px",
  lg: "12px",
} as const;

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

export const shadow = {
  card: `0 2px 12px rgba(0, 0, 0, 0.08)`,
  hover: `0 2px 8px rgba(102, 89, 167, 0.25)`,
  hoverLight: `0 2px 8px rgba(102, 89, 167, 0.15)`,
} as const;

// ---------------------------------------------------------------------------
// Google Fonts URL
// ---------------------------------------------------------------------------

export const googleFontsUrl =
  "https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;600;700&display=swap";
