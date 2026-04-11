// Shared CSS and HTML utilities for browser-facing pages.
//
// All styles reference CSS custom properties defined in tokens.ts.
// The cssCustomProperties() output must be included in every page's <style>.

import { cssCustomProperties } from "./tokens.js";

/** Base styles shared by all pages (login, picker). Includes token :root block. */
export const BASE_STYLE = `
    ${cssCustomProperties()}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-family);
      background: var(--color-bg);
      color: var(--color-text);
      display: flex;
      justify-content: center;
      padding: var(--spacing-page);
      min-height: 100vh;
    }
    .container {
      max-width: var(--layout-container);
      width: 100%;
      text-align: center;
    }
    .card {
      background: var(--color-surface);
      border-radius: var(--radius-card);
      padding: var(--spacing-card);
      box-shadow: var(--shadow-card);
    }`;

/** Login page styles — landing, success, and error pages. */
export const LOGIN_STYLES = `
    .logo { font-size: var(--font-size-logo); font-weight: var(--font-weight-bold); color: var(--color-primary); margin-bottom: var(--spacing-gap8); }
    h1 { font-size: var(--font-size-heading); font-weight: var(--font-weight-semibold); margin-bottom: var(--spacing-gap12); }
    .subtitle { color: var(--color-text-secondary); font-size: var(--font-size-body); line-height: 1.5; margin-bottom: var(--spacing-gap32); }
    .sign-in-btn {
      display: inline-block;
      padding: var(--spacing-btn-primary);
      background: var(--color-primary); cursor: pointer;
      color: white;
      border: none;
      border-radius: var(--radius-button);
      font-size: var(--font-size-button);
      font-weight: var(--font-weight-medium);
      text-decoration: none;
      transition: background var(--transition-fast), box-shadow var(--transition-fast);
    }
    .sign-in-btn:hover { background: var(--color-primary-hover); box-shadow: var(--shadow-btn-hover); }
    .sign-in-btn:active { background: var(--color-primary-active); }
    .footer { margin-top: var(--spacing-gap24); font-size: var(--font-size-small); color: var(--color-text-muted); }`;

/** Success page styles (checkmark + countdown). */
export const SUCCESS_STYLES = `
    .checkmark { font-size: var(--font-size-icon); color: var(--color-success); margin-bottom: var(--spacing-gap16); }
    h1 { font-size: var(--font-size-heading); font-weight: var(--font-weight-semibold); color: var(--color-success); margin-bottom: var(--spacing-gap12); }
    .message { color: var(--color-text-secondary); font-size: var(--font-size-body); line-height: 1.5; }
    .countdown { color: var(--color-text-muted); margin-top: var(--spacing-gap16); font-size: 0.85rem; }`;

/** Error page styles (icon + error detail box). */
export const ERROR_STYLES = `
    .icon { font-size: var(--font-size-icon); color: var(--color-error); margin-bottom: var(--spacing-gap16); }
    h1 { font-size: var(--font-size-heading); font-weight: var(--font-weight-semibold); color: var(--color-error); margin-bottom: var(--spacing-gap12); }
    .message { color: var(--color-text-secondary); font-size: var(--font-size-body); line-height: 1.5; }
    .error-detail { margin-top: var(--spacing-gap16); padding: var(--spacing-gap12); background: var(--color-error-bg); border-radius: var(--radius-detail); font-size: 0.85rem; color: var(--color-error-light); word-break: break-word; }`;

/** Picker page styles (option buttons, done state, errors). */
export const PICKER_STYLES = `
    ${cssCustomProperties()}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-family);
      background: var(--color-bg);
      color: var(--color-text);
      display: flex;
      justify-content: center;
      padding: var(--spacing-picker-page);
    }
    .container { max-width: var(--layout-picker-container); width: 100%; }
    h1 { font-size: var(--font-size-picker-heading); margin-bottom: var(--spacing-gap8); }
    .subtitle { color: var(--color-text-secondary); margin-bottom: var(--spacing-gap24); font-size: var(--font-size-body); }
    .option-btn {
      display: block;
      width: 100%;
      padding: var(--spacing-btn-option);
      margin-bottom: var(--spacing-gap10);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-button);
      font-size: var(--font-size-button);
      cursor: pointer;
      text-align: left;
      transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    }
    .option-btn:hover { border-color: var(--color-primary); box-shadow: var(--shadow-option-hover); }
    .option-btn:active { background: var(--color-primary-light-solid); }
    .option-btn.selected { border-color: var(--color-primary); background: var(--color-primary-light-solid); pointer-events: none; }
    .done { text-align: center; padding: var(--spacing-gap32) 0; }
    .done h2 { color: var(--color-success); margin-bottom: var(--spacing-gap8); }
    .done p { color: var(--color-text-secondary); }
    .error { color: var(--color-error); margin-top: var(--spacing-gap16); }
    .countdown { color: var(--color-text-muted); margin-top: var(--spacing-gap8); font-size: 0.9rem; }`;

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
