// HTML templates for the MSAL login loopback pages.

import { BASE_STYLE, escapeHtml } from "./styles.js";

export function landingPageHtml(authUrl: string): string {
  const safeAuthUrl = escapeHtml(authUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo - Sign In</title>
  <style>
    ${BASE_STYLE}
    .logo { font-size: 1.8rem; font-weight: 700; color: #0078d4; margin-bottom: 8px; }
    h1 { font-size: 1.3rem; font-weight: 600; margin-bottom: 12px; }
    .subtitle { color: #666; font-size: 0.95rem; line-height: 1.5; margin-bottom: 32px; }
    .sign-in-btn {
      display: inline-block;
      padding: 14px 32px;
      background: #0078d4; cursor: pointer;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      text-decoration: none;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .sign-in-btn:hover { background: #106ebe; box-shadow: 0 2px 8px rgba(0,120,212,0.25); }
    .sign-in-btn:active { background: #005a9e; }
    .footer { margin-top: 24px; font-size: 0.8rem; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">graphdo</div>
      <h1>Sign in to continue</h1>
      <p class="subtitle">Connect your Microsoft account to enable email and task management through your AI assistant.</p>
      <a href="${safeAuthUrl}" class="sign-in-btn">Sign in with Microsoft</a>
    </div>
    <p class="footer">Your credentials are handled directly by Microsoft. graphdo never sees your password.</p>
  </div>
</body>
</html>`;
}

export function successPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo - Signed In</title>
  <style>
    ${BASE_STYLE}
    .checkmark { font-size: 3rem; color: #107c10; margin-bottom: 16px; }
    h1 { font-size: 1.3rem; font-weight: 600; color: #107c10; margin-bottom: 12px; }
    .message { color: #666; font-size: 0.95rem; line-height: 1.5; }
    .countdown { color: #999; margin-top: 16px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="checkmark">&#10003;</div>
      <h1>Authentication successful</h1>
      <p class="message">You can close this window and return to your AI assistant.</p>
      <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
      <p id="manual-close" style="display:none; margin-top: 16px; color: #666; font-size: 0.9rem;">If this window didn&rsquo;t close automatically, please close it manually.</p>
    </div>
  </div>
  <script>
    let remaining = 5;
    const el = document.getElementById('countdown');
    const tick = setInterval(() => {
      remaining--;
      el.textContent = String(remaining);
      if (remaining <= 0) {
        clearInterval(tick);
        window.close();
        setTimeout(() => {
          document.getElementById('countdown').parentElement.style.display = 'none';
          document.getElementById('manual-close').style.display = 'block';
        }, 500);
      }
    }, 1000);
  </script>
</body>
</html>`;
}

export function errorPageHtml(errorMessage: string): string {
  const safeMessage = escapeHtml(errorMessage);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo - Sign In Failed</title>
  <style>
    ${BASE_STYLE}
    .icon { font-size: 3rem; color: #d13438; margin-bottom: 16px; }
    h1 { font-size: 1.3rem; font-weight: 600; color: #d13438; margin-bottom: 12px; }
    .message { color: #666; font-size: 0.95rem; line-height: 1.5; }
    .error-detail { margin-top: 16px; padding: 12px; background: #fef0f0; border-radius: 6px; font-size: 0.85rem; color: #a4262c; word-break: break-word; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="icon">&#10007;</div>
      <h1>Authentication failed</h1>
      <p class="message">Please close this window and try again.</p>
      <div class="error-detail">${safeMessage}</div>
    </div>
  </div>
</body>
</html>`;
}
