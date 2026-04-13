// HTML templates for the MSAL login loopback pages.

import {
  escapeHtml,
  LOGIN_STYLE,
  SUCCESS_STYLE,
  ERROR_STYLE,
  SCOPE_FLYOUT_STYLE,
} from "./styles.js";
import { logoDarkDataUri, logoLightDataUri } from "./icons.js";
import { layoutHtml } from "./layout.js";
import type { ScopeDefinition } from "../scopes.js";

/** Parameters for the landing page template. */
export interface LandingPageOptions {
  authUrl: string;
  availableScopes?: ScopeDefinition[];
  selectedScopes?: string[];
}

export function landingPageHtml(optsOrAuthUrl: string | LandingPageOptions): string {
  const opts: LandingPageOptions =
    typeof optsOrAuthUrl === "string" ? { authUrl: optsOrAuthUrl } : optsOrAuthUrl;

  const safeAuthUrl = escapeHtml(opts.authUrl);
  const scopes = opts.availableScopes ?? [];
  const selected = new Set<string>(opts.selectedScopes ?? scopes.map((s) => s.scope));
  const hasScopes = scopes.length > 0;

  // Build scope checkbox rows
  const scopeRows = scopes
    .map((s) => {
      const checked = selected.has(s.scope) || s.required ? "checked" : "";
      const disabled = s.required ? "disabled" : "";
      const safeScope = escapeHtml(s.scope);
      const safeLabel = escapeHtml(s.label);
      const safeDesc = escapeHtml(s.description);
      return `<label class="scope-row">
          <input type="checkbox" name="scope" value="${safeScope}" ${checked} ${disabled}>
          <span class="scope-info">
            <span class="scope-label">${safeLabel}</span>
            <span class="scope-desc">${safeDesc}</span>
          </span>
        </label>`;
    })
    .join("\n        ");

  const cogIcon = hasScopes
    ? `<button id="scope-toggle" class="scope-toggle" title="Configure scopes" aria-label="Configure scopes">&#9881;</button>`
    : "";

  const flyoutHtml = hasScopes
    ? `<div id="scope-flyout" class="scope-flyout">
        <div class="scope-flyout-header">
          <span>Permissions</span>
          <button id="scope-close" class="scope-close" aria-label="Close">&times;</button>
        </div>
        <div class="scope-list">
        ${scopeRows}
        </div>
        <button id="scope-save" class="scope-save-btn">Save</button>
      </div>`
    : "";

  const scopeScript = hasScopes
    ? `
    const flyout = document.getElementById('scope-flyout');
    const toggleBtn = document.getElementById('scope-toggle');
    const closeBtn = document.getElementById('scope-close');
    const saveBtn = document.getElementById('scope-save');
    const signInBtn = document.getElementById('sign-in-btn');

    let scopesDirty = false;
    const originalScopes = new Set(Array.from(document.querySelectorAll('input[name="scope"]:checked')).map(cb => cb.value));

    toggleBtn.addEventListener('click', () => {
      flyout.classList.toggle('open');
    });
    closeBtn.addEventListener('click', () => {
      flyout.classList.remove('open');
    });

    function getSelectedScopes() {
      return Array.from(document.querySelectorAll('input[name="scope"]:checked')).map(cb => cb.value);
    }

    function checkDirty() {
      const current = new Set(getSelectedScopes());
      scopesDirty = current.size !== originalScopes.size || [...current].some(s => !originalScopes.has(s));
    }

    document.querySelectorAll('input[name="scope"]').forEach(cb => {
      cb.addEventListener('change', checkDirty);
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        await fetch('/save-scopes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scopes: getSelectedScopes() })
        });
        flyout.classList.remove('open');
        saveBtn.textContent = 'Saved!';
        setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }, 1500);
      } catch {
        saveBtn.textContent = 'Failed';
        setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }, 1500);
      }
    });

    signInBtn.addEventListener('click', async (e) => {
      if (scopesDirty) {
        e.preventDefault();
        signInBtn.style.pointerEvents = 'none';
        signInBtn.textContent = 'Restarting...';
        try {
          await fetch('/restart-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scopes: getSelectedScopes() })
          });
        } catch {}
        signInBtn.textContent = 'Please wait...';
      }
    });`
    : "";

  return layoutHtml({
    title: "graphdo - Sign In",
    extraStyles: LOGIN_STYLE + (hasScopes ? SCOPE_FLYOUT_STYLE : ""),
    body: `<div class="container">
    <div class="card">
      ${cogIcon}
      <h1>Sign in to continue</h1>
      <p class="subtitle">Connect your Microsoft account to enable email and task management through your AI assistant.</p>
      ${flyoutHtml}
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
    script: `    document.getElementById('cancel-btn').addEventListener('click', async () => {
      document.getElementById('cancel-btn').disabled = true;
      await fetch('/cancel', { method: 'POST' }).catch(() => {});
      window.close();
    });${scopeScript}`,
  });
}

export function successPageHtml(): string {
  return layoutHtml({
    title: "graphdo - Signed In",
    extraStyles: SUCCESS_STYLE,
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

export function errorPageHtml(errorMessage: string): string {
  const safeMessage = escapeHtml(errorMessage);

  return layoutHtml({
    title: "graphdo - Sign In Failed",
    extraStyles: ERROR_STYLE,
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
