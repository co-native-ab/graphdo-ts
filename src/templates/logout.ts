// HTML template for the logout confirmation page.

import { LOGOUT_CONFIRM_STYLE, SUCCESS_STYLE } from "./styles.js";
import { escapeHtml } from "./escape.js";
import { logoDarkDataUri, logoLightDataUri } from "./icons.js";
import { layoutHtml } from "./layout.js";

export interface LogoutPageOptions {
  /**
   * CSRF token. Embedded in a `<meta name="csrf-token">` tag — the page
   * reads it from the meta tag and includes it in the JSON body of
   * `POST /confirm` and `POST /cancel`. Required by the hardened logout
   * loopback server (see `src/auth.ts#showLogoutPage`).
   */
  csrfToken?: string;
  /** Per-request CSP nonce; threaded through to inline `<style>` and `<script>`. */
  nonce?: string;
}

export function logoutPageHtml(opts: LogoutPageOptions = {}): string {
  return layoutHtml({
    title: "graphdo - Sign Out",
    extraStyles: LOGOUT_CONFIRM_STYLE + SUCCESS_STYLE,
    nonce: opts.nonce,
    extraHead:
      opts.csrfToken !== undefined
        ? `<meta name="csrf-token" content="${escapeHtml(opts.csrfToken)}">`
        : "",
    body: `<div class="container">
    <div class="card">
      <div id="confirm-view">
        <h1>Sign out?</h1>
        <p class="subtitle">This will clear your cached tokens and sign you out of Microsoft Graph.</p>
        <div class="btn-group">
          <button id="sign-out-btn" class="sign-out-btn">Sign Out</button>
          <button id="cancel-btn" class="cancel-btn">Cancel</button>
        </div>
      </div>
      <div id="done-view" hidden>
        <div class="checkmark">&#10003;</div>
        <h1 class="success">Signed out successfully</h1>
        <p class="message">Your cached tokens have been cleared. You can close this window.</p>
        <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
        <p id="manual-close" hidden>If this window didn&rsquo;t close automatically, please close it manually.</p>
      </div>
    </div>
    <picture>
      <source srcset="${logoLightDataUri}" media="(prefers-color-scheme: dark)">
      <img src="${logoDarkDataUri}" alt="graphdo" class="brand-footer">
    </picture>
  </div>`,
    script: `    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';
    const signOutBtn = document.getElementById('sign-out-btn');
    const cancelBtn = document.getElementById('cancel-btn');

    signOutBtn.addEventListener('click', async () => {
      signOutBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        const res = await fetch('/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrfToken: csrfToken }),
        });
        if (!res.ok) throw new Error(await res.text());
        document.getElementById('confirm-view').hidden = true;
        document.getElementById('done-view').hidden = false;
        let remaining = 5;
        const el = document.getElementById('countdown');
        const tick = setInterval(() => {
          remaining--;
          el.textContent = String(remaining);
          if (remaining <= 0) {
            clearInterval(tick);
            window.close();
            setTimeout(() => {
              document.getElementById('countdown').parentElement.hidden = true;
              document.getElementById('manual-close').hidden = false;
            }, 500);
          }
        }, 1000);
      } catch (_err) {
        signOutBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener('click', async () => {
      signOutBtn.disabled = true;
      cancelBtn.disabled = true;
      await fetch('/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken: csrfToken }),
      }).catch(() => {});
      window.close();
    });`,
  });
}
