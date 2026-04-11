// Shared CSS and HTML utilities for browser-facing pages.

export const BASE_STYLE = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      color: #333;
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
      background: white;
      border-radius: 12px;
      padding: 40px 32px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }`;

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
