// Shared CSS and HTML utilities for browser-facing pages.
// All CSS is built from design tokens — see ADR-0002.

import {
  purple,
  grey,
  complementary,
  fontFamily,
  fontWeight,
  fontSize,
  spacing,
  borderRadius,
  shadow,
} from "./tokens.js";

// ---------------------------------------------------------------------------
// Base stylesheet (shared by all served pages)
// ---------------------------------------------------------------------------

export const BASE_STYLE = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ${fontFamily};
      background: ${purple.minus3};
      color: ${grey.grey4};
      display: flex;
      justify-content: center;
      padding: 60px 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 420px;
      width: 100%;
      text-align: center;
    }
    .card {
      background: ${grey.white};
      border-radius: ${borderRadius.lg};
      padding: ${spacing.xxxl} ${spacing.xxl};
      box-shadow: ${shadow.card};
    }
    .page-icon {
      height: 32px;
      margin-bottom: ${spacing.lg};
    }
    .logo {
      font-size: ${fontSize.xxl};
      font-weight: ${fontWeight.bold};
      color: ${purple.brand};
      margin-bottom: ${spacing.sm};
    }
    h1 {
      font-size: ${fontSize.lg};
      font-weight: ${fontWeight.semibold};
      margin-bottom: ${spacing.md};
    }
    .subtitle {
      color: ${grey.grey4};
      font-size: ${fontSize.base};
      line-height: 1.5;
      margin-bottom: ${spacing.xxl};
    }
    .message {
      color: ${grey.grey4};
      font-size: ${fontSize.base};
      line-height: 1.5;
    }
    .countdown {
      color: ${grey.grey3};
      margin-top: ${spacing.lg};
      font-size: ${fontSize.sm};
    }
    .footer {
      margin-top: ${spacing.xl};
      font-size: ${fontSize.xs};
      color: ${grey.grey3};
    }`;

// ---------------------------------------------------------------------------
// Login-specific styles
// ---------------------------------------------------------------------------

export const LOGIN_STYLE = `
    .sign-in-btn {
      display: inline-block;
      padding: 14px ${spacing.xxl};
      background: ${purple.brand};
      cursor: pointer;
      color: ${grey.white};
      border: none;
      border-radius: ${borderRadius.md};
      font-size: ${fontSize.md};
      font-family: ${fontFamily};
      font-weight: ${fontWeight.semibold};
      text-decoration: none;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .sign-in-btn:hover {
      background: ${purple.plus1};
      box-shadow: ${shadow.hover};
    }
    .sign-in-btn:active { background: ${purple.plus2}; }`;

export const SUCCESS_STYLE = `
    .checkmark {
      font-size: ${fontSize.icon};
      color: ${complementary.teal.base};
      margin-bottom: ${spacing.lg};
    }
    h1.success { color: ${complementary.teal.base}; }
    #manual-close {
      margin-top: ${spacing.lg};
      color: ${grey.grey4};
      font-size: ${fontSize.base};
    }`;

export const ERROR_STYLE = `
    .icon {
      font-size: ${fontSize.icon};
      color: ${complementary.peach.base};
      margin-bottom: ${spacing.lg};
    }
    h1.error { color: ${complementary.peach.base}; }
    .error-detail {
      margin-top: ${spacing.lg};
      padding: ${spacing.md};
      background: ${complementary.peach.light};
      border-radius: ${borderRadius.sm};
      font-size: ${fontSize.sm};
      color: ${complementary.peach.base};
      word-break: break-word;
    }`;

// ---------------------------------------------------------------------------
// Picker-specific styles
// ---------------------------------------------------------------------------

export const PICKER_STYLE = `
    .container { text-align: left; max-width: 480px; }
    h1 { font-size: ${fontSize.xl}; }
    .subtitle { margin-bottom: ${spacing.xl}; }
    .option-btn {
      display: block;
      width: 100%;
      padding: 14px 18px;
      margin-bottom: 10px;
      background: ${grey.white};
      border: 1px solid ${grey.grey2};
      border-radius: ${borderRadius.md};
      font-size: ${fontSize.md};
      font-family: ${fontFamily};
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .option-btn:hover {
      border-color: ${purple.brand};
      box-shadow: ${shadow.hoverLight};
    }
    .option-btn:active { background: ${purple.minus3}; }
    .option-btn.selected {
      border-color: ${purple.brand};
      background: ${purple.minus3};
      pointer-events: none;
    }
    .done { text-align: center; padding: ${spacing.xxl} 0; }
    .done h2 { color: ${complementary.teal.base}; margin-bottom: ${spacing.sm}; }
    .done p { color: ${grey.grey4}; }
    .error { color: ${complementary.peach.base}; margin-top: ${spacing.lg}; }
    #manual-close {
      margin-top: ${spacing.lg};
      color: ${grey.grey4};
      font-size: ${fontSize.base};
    }`;

// ---------------------------------------------------------------------------
// HTML utility
// ---------------------------------------------------------------------------

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
