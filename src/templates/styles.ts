// Shared CSS and HTML utilities for browser-facing pages.
// All CSS is built from design tokens — see ADR-0002.

import {
  purple,
  grey,
  complementary,
  dark,
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
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ${fontFamily};
      background: linear-gradient(160deg, ${purple.minus3} 0%, ${grey.grey1} 100%);
      color: ${grey.grey4};
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 40px 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    .card {
      background: ${grey.white};
      border-radius: 16px;
      padding: 48px 40px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
      animation: slideUp 0.4s ease-out;
    }
    .brand-footer {
      display: block;
      height: 12px;
      margin: ${spacing.xxl} auto 0;
      opacity: 0.18;
      animation: slideUp 0.4s ease-out 0.1s both;
    }
    h1 {
      font-size: 1.4rem;
      font-weight: ${fontWeight.bold};
      color: ${purple.plus2};
      margin-bottom: ${spacing.sm};
    }
    .subtitle {
      color: ${grey.grey4};
      font-size: ${fontSize.base};
      line-height: 1.6;
      margin-bottom: ${spacing.xxl};
    }
    .message {
      color: ${grey.grey4};
      font-size: ${fontSize.base};
      line-height: 1.6;
    }
    .countdown {
      color: ${grey.grey3};
      margin-top: ${spacing.xl};
      font-size: ${fontSize.sm};
    }
    .btn-group {
      display: flex;
      flex-direction: column;
      gap: ${spacing.md};
      width: 100%;
    }
    .cancel-btn {
      display: block;
      width: 100%;
      padding: 14px;
      background: transparent;
      cursor: pointer;
      color: ${grey.grey4};
      border: 1.5px solid ${grey.grey1};
      border-radius: ${borderRadius.lg};
      font-size: ${fontSize.md};
      font-family: ${fontFamily};
      font-weight: ${fontWeight.regular};
      transition: all 0.2s ease;
    }
    .cancel-btn:hover {
      background: ${grey.grey1};
      border-color: ${grey.grey2};
    }
    .cancel-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    @media (prefers-color-scheme: dark) {
      body {
        background: linear-gradient(160deg, ${dark.bg1} 0%, ${dark.bg2} 100%);
        color: ${dark.text};
      }
      .card {
        background: ${dark.surface};
        box-shadow: ${dark.cardShadow};
      }
      h1 { color: ${dark.heading}; }
      .subtitle, .message { color: ${dark.text}; }
      .countdown { color: ${dark.textMuted}; }
      .brand-footer { opacity: 0.3; }
      .cancel-btn {
        color: ${dark.text};
        border-color: ${dark.border};
      }
      .cancel-btn:hover {
        background: ${dark.surfaceHover};
        border-color: ${dark.borderHover};
      }
    }`;

// ---------------------------------------------------------------------------
// Login-specific styles
// ---------------------------------------------------------------------------

export const LOGIN_STYLE = `
    .sign-in-btn {
      display: block;
      width: 100%;
      padding: 16px;
      background: ${purple.brand};
      cursor: pointer;
      color: ${grey.white};
      border: none;
      border-radius: ${borderRadius.lg};
      font-size: ${fontSize.md};
      font-family: ${fontFamily};
      font-weight: ${fontWeight.semibold};
      text-decoration: none;
      text-align: center;
      transition: all 0.2s ease;
    }
    .sign-in-btn:hover {
      background: ${purple.plus1};
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(102, 89, 167, 0.3);
    }
    .sign-in-btn:active {
      background: ${purple.plus2};
      transform: translateY(0);
    }
    @media (prefers-color-scheme: dark) {
      .sign-in-btn:hover {
        box-shadow: 0 6px 20px rgba(102, 89, 167, 0.4);
      }
    }`;

export const SUCCESS_STYLE = `
    .checkmark {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: ${complementary.teal.light};
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto ${spacing.xl};
      font-size: 1.5rem;
      color: ${complementary.teal.base};
    }
    h1.success { color: ${complementary.teal.base}; }
    #manual-close {
      margin-top: ${spacing.lg};
      color: ${grey.grey4};
      font-size: ${fontSize.base};
    }
    @media (prefers-color-scheme: dark) {
      .checkmark { background: rgba(170, 189, 181, 0.15); }
      #manual-close { color: ${dark.text}; }
    }`;

export const ERROR_STYLE = `
    .icon {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: ${complementary.peach.light};
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto ${spacing.xl};
      font-size: 1.5rem;
      color: ${complementary.peach.base};
    }
    h1.error { color: ${complementary.peach.base}; }
    .error-detail {
      margin-top: ${spacing.xl};
      padding: ${spacing.lg};
      background: ${complementary.peach.light};
      border-left: 3px solid ${complementary.peach.base};
      border-radius: ${borderRadius.md};
      font-size: ${fontSize.sm};
      color: ${complementary.peach.base};
      text-align: left;
      word-break: break-word;
    }
    @media (prefers-color-scheme: dark) {
      .icon { background: rgba(249, 170, 143, 0.12); }
      .error-detail {
        background: rgba(249, 170, 143, 0.08);
        border-left-color: ${complementary.peach.base};
      }
    }`;

export const LOGOUT_CONFIRM_STYLE = `
    .sign-out-btn {
      display: block;
      width: 100%;
      padding: 16px;
      background: ${complementary.peach.base};
      cursor: pointer;
      color: ${grey.white};
      border: none;
      border-radius: ${borderRadius.lg};
      font-size: ${fontSize.md};
      font-family: ${fontFamily};
      font-weight: ${fontWeight.semibold};
      transition: all 0.2s ease;
    }
    .sign-out-btn:hover {
      background: ${complementary.peach.hover};
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(249, 170, 143, 0.3);
    }
    .sign-out-btn:active { transform: translateY(0); }
    .sign-out-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    @media (prefers-color-scheme: dark) {
      .sign-out-btn:hover {
        box-shadow: 0 6px 20px rgba(249, 170, 143, 0.4);
      }
    }`;

// ---------------------------------------------------------------------------
// Picker-specific styles
// ---------------------------------------------------------------------------

export const PICKER_STYLE = `
    .container { max-width: 440px; }
    .card { text-align: left; }
    .card h1 { text-align: center; }
    .subtitle { text-align: center; }
    .option-btn {
      display: block;
      width: 100%;
      padding: 16px 18px;
      margin-bottom: ${spacing.sm};
      background: ${grey.white};
      border: 1.5px solid ${grey.grey2};
      border-radius: ${borderRadius.lg};
      font-size: ${fontSize.md};
      font-family: ${fontFamily};
      cursor: pointer;
      text-align: left;
      transition: all 0.2s ease;
    }
    .option-btn:hover {
      border-color: ${purple.brand};
      background: ${purple.minus3};
      transform: translateY(-1px);
      box-shadow: ${shadow.hoverLight};
    }
    .option-btn:active { transform: translateY(0); background: ${purple.minus3}; }
    .option-btn.selected {
      border-color: ${purple.brand};
      background: ${purple.minus3};
      pointer-events: none;
    }
    .option-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .done { text-align: center; }
    .done h1 { color: ${complementary.teal.base}; }
    .done .message { margin-bottom: 0; }
    .error { color: ${complementary.peach.base}; margin-top: ${spacing.lg}; text-align: center; }
    #manual-close {
      margin-top: ${spacing.lg};
      color: ${grey.grey4};
      font-size: ${fontSize.base};
    }
    @media (prefers-color-scheme: dark) {
      .option-btn {
        background: ${dark.surface};
        border-color: ${dark.border};
        color: ${dark.text};
      }
      .option-btn:hover {
        border-color: ${purple.brand};
        background: ${dark.surfaceHover};
      }
      .option-btn:active { background: ${dark.surfaceHover}; }
      .option-btn.selected {
        border-color: ${purple.brand};
        background: ${dark.surfaceHover};
      }
      #manual-close { color: ${dark.text}; }
    }`;

// ---------------------------------------------------------------------------
// HTML utility
// ---------------------------------------------------------------------------

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
