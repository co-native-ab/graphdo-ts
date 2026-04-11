// HTML template for the logout confirmation page.

import { SUCCESS_STYLE } from "./styles.js";
import { iconDarkDataUri } from "./icons.js";
import { layoutHtml } from "./layout.js";

export function logoutPageHtml(): string {
  return layoutHtml({
    title: "graphdo - Signed Out",
    extraStyles: SUCCESS_STYLE,
    body: `<div class="container">
    <div class="card">
      <img src="${iconDarkDataUri}" alt="" class="page-icon">
      <div class="checkmark">&#10003;</div>
      <h1 class="success">Signed out successfully</h1>
      <p class="message">Your cached tokens have been cleared. You can close this window.</p>
      <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
      <p id="manual-close" style="display:none">If this window didn&rsquo;t close automatically, please close it manually.</p>
    </div>
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
