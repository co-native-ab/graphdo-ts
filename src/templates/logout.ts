// HTML template for the logout confirmation page.

import { LOGOUT_CONFIRM_STYLE, SUCCESS_STYLE } from "./styles.js";
import { iconDarkDataUri } from "./icons.js";
import { layoutHtml } from "./layout.js";

export function logoutPageHtml(): string {
  return layoutHtml({
    title: "graphdo - Sign Out",
    extraStyles: LOGOUT_CONFIRM_STYLE + SUCCESS_STYLE,
    body: `<div class="container">
    <div class="card">
      <img src="${iconDarkDataUri}" alt="" class="page-icon">
      <div id="confirm-view">
        <h1>Sign out?</h1>
        <p class="subtitle">This will clear your cached tokens and sign you out of Microsoft Graph.</p>
        <div class="btn-group">
          <button id="sign-out-btn" class="sign-out-btn">Sign Out</button>
          <button id="cancel-btn" class="cancel-btn">Cancel</button>
        </div>
      </div>
      <div id="done-view" style="display:none">
        <div class="checkmark">&#10003;</div>
        <h1 class="success">Signed out successfully</h1>
        <p class="message">Your cached tokens have been cleared. You can close this window.</p>
        <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
        <p id="manual-close" style="display:none">If this window didn&rsquo;t close automatically, please close it manually.</p>
      </div>
    </div>
  </div>`,
    script: `    const signOutBtn = document.getElementById('sign-out-btn');
    const cancelBtn = document.getElementById('cancel-btn');

    signOutBtn.addEventListener('click', async () => {
      signOutBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        const res = await fetch('/confirm', { method: 'POST' });
        if (!res.ok) throw new Error(await res.text());
        document.getElementById('confirm-view').style.display = 'none';
        document.getElementById('done-view').style.display = 'block';
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
      } catch (_err) {
        signOutBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener('click', async () => {
      signOutBtn.disabled = true;
      cancelBtn.disabled = true;
      await fetch('/cancel', { method: 'POST' }).catch(() => {});
      window.close();
    });`,
  });
}
