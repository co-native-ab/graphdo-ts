// HTML templates for the MSAL login loopback pages.

import { LOGIN_STYLE, SUCCESS_STYLE, ERROR_STYLE } from "./styles.js";
import { escapeHtml } from "./escape.js";
import { logoDarkDataUri, logoLightDataUri } from "./icons.js";
import { layoutHtml } from "./layout.js";

export interface LoginPageOptions {
  /**
   * CSRF token. Embedded in a `<meta name="csrf-token">` tag — the landing
   * page reads it from the meta tag and includes it in the `POST /cancel`
   * body. The success and error pages don't have any state-changing
   * controls, so the token is unused there but is accepted for API
   * symmetry across the three login templates.
   */
  csrfToken?: string;
  /** Per-request CSP nonce; threaded through to inline `<style>` and `<script>`. */
  nonce?: string;
}

export function landingPageHtml(authUrl: string, opts: LoginPageOptions = {}): string {
  const safeAuthUrl = escapeHtml(authUrl);

  return layoutHtml({
    title: "graphdo - Sign In",
    extraStyles: LOGIN_STYLE,
    nonce: opts.nonce,
    extraHead:
      opts.csrfToken !== undefined
        ? `<meta name="csrf-token" content="${escapeHtml(opts.csrfToken)}">`
        : "",
    body: `<div class="container">
    <div class="card">
      <h1>Sign in to continue</h1>
      <p class="subtitle">Connect your Microsoft account to enable email and task management through your AI assistant.</p>
      <div class="btn-group">
        <a href="${safeAuthUrl}" id="sign-in-btn" class="sign-in-btn">Sign in with Microsoft</a>
        <button id="cancel-btn" class="cancel-btn">Cancel</button>
      </div>
    </div>
    <picture>
      <source srcset="${logoLightDataUri}" media="(prefers-color-scheme: dark)">
      <img src="${logoDarkDataUri}" alt="graphdo" class="brand-footer">
    </picture>
  </div>`,
    script: `    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';
    document.getElementById('cancel-btn').addEventListener('click', async () => {
      document.getElementById('cancel-btn').disabled = true;
      await fetch('/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken: csrfToken }),
      }).catch(() => {});
      window.close();
    });`,
  });
}

export function successPageHtml(nonce?: string): string {
  return layoutHtml({
    title: "graphdo - Signed In",
    extraStyles: SUCCESS_STYLE,
    nonce,
    body: `<div class="container">
    <div class="card">
      <div class="checkmark">&#10003;</div>
      <h1 class="success">Authentication successful</h1>
      <p class="message">You can close this window and return to your AI assistant.</p>
      <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
      <p id="manual-close" style="display:none">If this window didn&rsquo;t close automatically, please close it manually.</p>
    </div>
    <picture>
      <source srcset="${logoLightDataUri}" media="(prefers-color-scheme: dark)">
      <img src="${logoDarkDataUri}" alt="graphdo" class="brand-footer">
    </picture>
  </div>`,
    script: `    let remaining = 5;
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
    }, 1000);`,
  });
}

export function errorPageHtml(errorMessage: string, nonce?: string): string {
  const safeMessage = escapeHtml(errorMessage);

  return layoutHtml({
    title: "graphdo - Sign In Failed",
    extraStyles: ERROR_STYLE,
    nonce,
    body: `<div class="container">
    <div class="card">
      <div class="icon">&#10007;</div>
      <h1 class="error">Authentication failed</h1>
      <p class="message">Please close this window and try again.</p>
      <div class="error-detail">${safeMessage}</div>
    </div>
    <picture>
      <source srcset="${logoLightDataUri}" media="(prefers-color-scheme: dark)">
      <img src="${logoDarkDataUri}" alt="graphdo" class="brand-footer">
    </picture>
  </div>`,
  });
}
