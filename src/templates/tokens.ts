// Design tokens — single source of truth for all visual design values.
//
// Brand colors extracted from Co-native logo assets (assets/icon.png).
// All browser-facing pages consume these tokens via CSS custom properties.

export const DESIGN_TOKENS = {
  color: {
    primary: "#70638c",
    primaryHover: "#5d5275",
    primaryActive: "#4a4260",
    primaryLight: "rgba(112, 99, 140, 0.15)",
    primaryLightSolid: "#f0edf4",
    success: "#107c10",
    error: "#d13438",
    errorLight: "#a4262c",
    errorBackground: "#fef0f0",
    background: "#f5f5f5",
    surface: "#ffffff",
    textPrimary: "#333333",
    textSecondary: "#666666",
    textMuted: "#999999",
    border: "#dddddd",
  },
  font: {
    family:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    sizeSmall: "0.8rem",
    sizeBody: "0.95rem",
    sizeButton: "1rem",
    sizeHeading: "1.3rem",
    sizeLogo: "1.8rem",
    sizePickerHeading: "1.4rem",
    sizeIcon: "3rem",
    weightNormal: "400",
    weightMedium: "500",
    weightSemibold: "600",
    weightBold: "700",
  },
  spacing: {
    pagePadding: "60px 20px",
    pickerPagePadding: "40px 20px",
    cardPadding: "40px 32px",
    buttonPaddingPrimary: "14px 32px",
    buttonPaddingOption: "14px 18px",
    gap4: "4px",
    gap8: "8px",
    gap10: "10px",
    gap12: "12px",
    gap16: "16px",
    gap24: "24px",
    gap32: "32px",
  },
  radius: {
    button: "8px",
    card: "12px",
    detail: "6px",
  },
  shadow: {
    card: "0 2px 12px rgba(0, 0, 0, 0.08)",
    buttonHover: "0 2px 8px rgba(112, 99, 140, 0.25)",
    optionHover: "0 2px 8px rgba(112, 99, 140, 0.15)",
  },
  layout: {
    containerMaxWidth: "420px",
    pickerContainerMaxWidth: "480px",
  },
  transition: {
    fast: "0.15s",
  },
} as const;

/** Generate a CSS `:root` block with custom properties from design tokens. */
export function cssCustomProperties(): string {
  const t = DESIGN_TOKENS;
  return `:root {
    --color-primary: ${t.color.primary};
    --color-primary-hover: ${t.color.primaryHover};
    --color-primary-active: ${t.color.primaryActive};
    --color-primary-light: ${t.color.primaryLight};
    --color-primary-light-solid: ${t.color.primaryLightSolid};
    --color-success: ${t.color.success};
    --color-error: ${t.color.error};
    --color-error-light: ${t.color.errorLight};
    --color-error-bg: ${t.color.errorBackground};
    --color-bg: ${t.color.background};
    --color-surface: ${t.color.surface};
    --color-text: ${t.color.textPrimary};
    --color-text-secondary: ${t.color.textSecondary};
    --color-text-muted: ${t.color.textMuted};
    --color-border: ${t.color.border};
    --font-family: ${t.font.family};
    --font-size-small: ${t.font.sizeSmall};
    --font-size-body: ${t.font.sizeBody};
    --font-size-button: ${t.font.sizeButton};
    --font-size-heading: ${t.font.sizeHeading};
    --font-size-logo: ${t.font.sizeLogo};
    --font-size-picker-heading: ${t.font.sizePickerHeading};
    --font-size-icon: ${t.font.sizeIcon};
    --font-weight-normal: ${t.font.weightNormal};
    --font-weight-medium: ${t.font.weightMedium};
    --font-weight-semibold: ${t.font.weightSemibold};
    --font-weight-bold: ${t.font.weightBold};
    --spacing-page: ${t.spacing.pagePadding};
    --spacing-picker-page: ${t.spacing.pickerPagePadding};
    --spacing-card: ${t.spacing.cardPadding};
    --spacing-btn-primary: ${t.spacing.buttonPaddingPrimary};
    --spacing-btn-option: ${t.spacing.buttonPaddingOption};
    --spacing-gap4: ${t.spacing.gap4};
    --spacing-gap8: ${t.spacing.gap8};
    --spacing-gap10: ${t.spacing.gap10};
    --spacing-gap12: ${t.spacing.gap12};
    --spacing-gap16: ${t.spacing.gap16};
    --spacing-gap24: ${t.spacing.gap24};
    --spacing-gap32: ${t.spacing.gap32};
    --radius-button: ${t.radius.button};
    --radius-card: ${t.radius.card};
    --radius-detail: ${t.radius.detail};
    --shadow-card: ${t.shadow.card};
    --shadow-btn-hover: ${t.shadow.buttonHover};
    --shadow-option-hover: ${t.shadow.optionHover};
    --layout-container: ${t.layout.containerMaxWidth};
    --layout-picker-container: ${t.layout.pickerContainerMaxWidth};
    --transition-fast: ${t.transition.fast};
  }`;
}
