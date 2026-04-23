// HTML template for the browser-based workspace navigator.

import { escapeHtml } from "./escape.js";
import { layoutHtml } from "./layout.js";
import { logoDarkDataUri, logoLightDataUri } from "./icons.js";

export const NAVIGATOR_STYLE = `
  .container {
    max-width: 800px;
    margin: 3rem auto;
    padding: 1rem;
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 2rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  h1 {
    margin: 0 0 0.75rem;
    font-size: 1.75rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .subtitle {
    margin: 0 0 1.5rem;
    font-size: 0.95rem;
    color: var(--text-secondary);
  }

  .drive-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .drive-tab {
    background: none;
    border: none;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9rem;
    color: var(--text-secondary);
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  }

  .drive-tab:hover {
    color: var(--text-primary);
  }

  .drive-tab.active {
    color: var(--brand);
    border-bottom-color: var(--brand);
  }

  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
    font-size: 0.9rem;
    color: var(--text-secondary);
  }

  .breadcrumb {
    background: none;
    border: none;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    color: var(--brand);
    text-decoration: none;
    border-radius: 0.25rem;
    transition: background 0.2s;
  }

  .breadcrumb:hover {
    background: var(--hover-bg);
  }

  .breadcrumb-separator {
    color: var(--text-tertiary);
  }

  .folder-list {
    max-height: 400px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    margin-bottom: 1rem;
  }

  .folder-item {
    display: flex;
    align-items: center;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.2s;
  }

  .folder-item:last-child {
    border-bottom: none;
  }

  .folder-item:hover {
    background: var(--hover-bg);
  }

  .folder-icon {
    margin-right: 0.75rem;
    font-size: 1.25rem;
  }

  .folder-name {
    flex: 1;
    font-size: 0.95rem;
    color: var(--text-primary);
  }

  .action-buttons {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .btn {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 0.5rem;
    font-family: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-primary {
    background: var(--brand);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--brand-hover);
  }

  .btn-secondary {
    background: var(--secondary-btn);
    color: var(--text-primary);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--secondary-btn-hover);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .share-link-section {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }

  .share-link-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    font-family: inherit;
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
  }

  .error-message {
    background: #fee;
    color: #c33;
    padding: 0.75rem;
    border-radius: 0.5rem;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }

  .loading {
    display: inline-block;
    margin-left: 0.5rem;
  }

  .done-card {
    text-align: center;
  }

  .done-icon {
    font-size: 3rem;
    color: var(--success);
    margin-bottom: 1rem;
  }

  .done-message {
    font-size: 1.1rem;
    color: var(--text-primary);
    margin-bottom: 0.5rem;
  }

  .done-detail {
    font-size: 0.9rem;
    color: var(--text-secondary);
    margin-bottom: 1rem;
  }

  .countdown {
    font-size: 0.85rem;
    color: var(--text-tertiary);
  }
`;

interface NavigatorDrive {
  id: string;
  label: string;
}

interface NavigatorPageConfig {
  title: string;
  subtitle: string;
  /** Initial set of drive tabs. Always includes the user's own OneDrive. */
  drives: NavigatorDrive[];
  /** Active tab on first render. */
  initialDriveId: string;
  csrfToken: string;
  nonce: string;
}

function renderDriveTab(drive: NavigatorDrive, active: boolean): string {
  return `<button class="drive-tab${active ? " active" : ""}" data-drive-id="${escapeHtml(drive.id)}">${escapeHtml(drive.label)}</button>`;
}

export function navigatorPageHtml(config: NavigatorPageConfig): string {
  const driveTabsHtml = config.drives
    .map((d) => renderDriveTab(d, d.id === config.initialDriveId))
    .join("\n        ");

  return layoutHtml({
    title: `graphdo - ${escapeHtml(config.title)}`,
    extraStyles: NAVIGATOR_STYLE,
    nonce: config.nonce,
    extraHead: `<meta name="csrf-token" content="${escapeHtml(config.csrfToken)}">`,
    body: `<div class="container">
    <div class="card" id="navigator">
      <h1>${escapeHtml(config.title)}</h1>
      <p class="subtitle">${escapeHtml(config.subtitle)}</p>
      <div id="error-container"></div>
      <div class="drive-tabs" id="drive-tabs">
        ${driveTabsHtml}
      </div>
      <div class="breadcrumbs" id="breadcrumbs"></div>
      <div class="folder-list" id="folder-list">
        <div class="folder-item" style="cursor: default; background: none;"><span class="folder-name" style="color: var(--text-tertiary);">Loading…</span></div>
      </div>
      <div class="action-buttons">
        <button id="select-btn" class="btn btn-primary">Use this folder as workspace</button>
        <button id="cancel-btn" class="btn btn-secondary">Cancel</button>
      </div>
      <div class="share-link-section">
        <input id="share-link-input" class="share-link-input" type="text" placeholder="Paste a OneDrive or SharePoint share link..." />
        <button id="resolve-share-btn" class="btn btn-secondary">Add shared drive</button>
      </div>
    </div>
    <picture>
      <source srcset="${logoLightDataUri}" media="(prefers-color-scheme: dark)">
      <img src="${logoDarkDataUri}" alt="graphdo" class="brand-footer">
    </picture>
  </div>`,
    script: `    const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content') || '';

      // Navigation stack: [{ driveId, itemId, itemName, itemPath }]. The
      // last entry is the current location; clicking a breadcrumb pops
      // back to that entry.
      let stack = [{ driveId: ${JSON.stringify(config.initialDriveId)}, itemId: 'root', itemName: '/', itemPath: '/' }];

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
      }

      function showError(msg) {
        document.getElementById('error-container').innerHTML =
          '<div class="error-message">' + escapeHtml(msg) + '</div>';
      }

      function clearError() {
        document.getElementById('error-container').innerHTML = '';
      }

      function showDone(message, detail) {
        document.getElementById('navigator').innerHTML =
          '<div class="done-card"><div class="done-icon">&#10003;</div>' +
          '<div class="done-message">' + escapeHtml(message) + '</div>' +
          '<div class="done-detail">' + escapeHtml(detail) + '</div>' +
          '<div class="countdown">Closing in <span id="countdown">3</span>s&hellip;</div></div>';
        let count = 3;
        const timer = setInterval(() => {
          count--;
          const el = document.getElementById('countdown');
          if (el) el.textContent = String(count);
          if (count <= 0) { clearInterval(timer); window.close(); }
        }, 1000);
      }

      function current() { return stack[stack.length - 1]; }

      function renderBreadcrumbs() {
        const container = document.getElementById('breadcrumbs');
        container.innerHTML = stack.map((entry, idx) => {
          const isLast = idx === stack.length - 1;
          if (isLast) {
            return '<span class="breadcrumb-current">' + escapeHtml(entry.itemName) + '</span>';
          }
          return '<button class="breadcrumb" data-index="' + idx + '">' +
            escapeHtml(entry.itemName) + '</button><span class="breadcrumb-separator">/</span>';
        }).join('');
      }

      function renderFolders(folders) {
        const list = document.getElementById('folder-list');
        if (folders.length === 0) {
          list.innerHTML = '<div class="folder-item" style="cursor: default; background: none;"><span class="folder-name" style="color: var(--text-tertiary);">No subfolders</span></div>';
          return;
        }
        list.innerHTML = folders.map(f =>
          '<div class="folder-item" data-id="' + escapeHtml(f.id) + '" data-name="' + escapeHtml(f.name) + '">' +
            '<span class="folder-icon">&#128193;</span>' +
            '<span class="folder-name">' + escapeHtml(f.name) + '</span>' +
          '</div>'
        ).join('');
      }

      function renderDriveTabs(activeDriveId) {
        document.querySelectorAll('.drive-tab').forEach(tab => {
          tab.classList.toggle('active', tab.dataset.driveId === activeDriveId);
        });
      }

      async function loadCurrent() {
        clearError();
        const entry = current();
        const url = '/children?driveId=' + encodeURIComponent(entry.driveId) +
                    '&itemId=' + encodeURIComponent(entry.itemId);
        try {
          const res = await fetch(url, { method: 'GET', headers: { 'X-CSRF-Token': csrfToken } });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            showError('Failed to load folders: ' + (data.error || res.status));
            return;
          }
          const data = await res.json();
          // Update the current entry with the resolved name/path so
          // breadcrumbs and persisted selection use Graph's canonical values.
          entry.itemName = data.itemName;
          entry.itemPath = data.itemPath;
          renderFolders(data.folders);
          renderBreadcrumbs();
          renderDriveTabs(entry.driveId);
        } catch (err) {
          showError('Network error: ' + err.message);
        }
      }

      function navigateInto(driveId, itemId, itemName) {
        stack.push({ driveId, itemId, itemName: itemName || itemId, itemPath: '' });
        loadCurrent();
      }

      function navigateToBreadcrumb(index) {
        stack = stack.slice(0, index + 1);
        loadCurrent();
      }

      function switchDrive(driveId) {
        stack = [{ driveId, itemId: 'root', itemName: '/', itemPath: '/' }];
        loadCurrent();
      }

      document.getElementById('folder-list').addEventListener('click', (e) => {
        const item = e.target.closest('.folder-item');
        if (item && item.dataset.id) {
          navigateInto(current().driveId, item.dataset.id, item.dataset.name);
        }
      });

      document.getElementById('breadcrumbs').addEventListener('click', (e) => {
        const crumb = e.target.closest('.breadcrumb');
        if (crumb && crumb.dataset.index !== undefined) {
          navigateToBreadcrumb(parseInt(crumb.dataset.index, 10));
        }
      });

      document.getElementById('drive-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.drive-tab');
        if (tab && tab.dataset.driveId) {
          switchDrive(tab.dataset.driveId);
        }
      });

      document.getElementById('select-btn').addEventListener('click', async () => {
        clearError();
        const entry = current();
        if (entry.itemId === 'root') {
          showError('Pick a folder inside the drive — the drive root cannot be the workspace.');
          return;
        }
        const btn = document.getElementById('select-btn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          const res = await fetch('/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({
              driveId: entry.driveId,
              itemId: entry.itemId,
              itemName: entry.itemName,
              itemPath: entry.itemPath,
              csrfToken: csrfToken,
            }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            showError('Selection failed: ' + (data.error || res.status));
            btn.disabled = false;
            btn.textContent = 'Use this folder as workspace';
            return;
          }
          showDone('Workspace configured', entry.itemPath || entry.itemName);
        } catch (err) {
          showError('Network error: ' + err.message);
          btn.disabled = false;
          btn.textContent = 'Use this folder as workspace';
        }
      });

      document.getElementById('cancel-btn').addEventListener('click', async () => {
        try {
          await fetch('/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ csrfToken: csrfToken }),
          });
        } catch (err) { /* swallow */ }
        window.close();
      });

      document.getElementById('resolve-share-btn').addEventListener('click', async () => {
        clearError();
        const input = document.getElementById('share-link-input');
        const url = input.value.trim();
        if (!url) { showError('Please paste a share link'); return; }
        const btn = document.getElementById('resolve-share-btn');
        btn.disabled = true;
        const origLabel = btn.textContent;
        btn.textContent = 'Resolving…';
        try {
          const res = await fetch('/resolve-share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ url: url, csrfToken: csrfToken }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            showError('Failed to resolve link: ' + (data.error || res.status));
            return;
          }
          const data = await res.json();
          // Add a tab if not already present, then jump to the resolved item.
          const tabs = document.getElementById('drive-tabs');
          if (!tabs.querySelector('.drive-tab[data-drive-id="' + CSS.escape(data.driveId) + '"]')) {
            const tab = document.createElement('button');
            tab.className = 'drive-tab';
            tab.dataset.driveId = data.driveId;
            tab.textContent = data.driveLabel || data.driveId;
            tabs.appendChild(tab);
          }
          stack = [
            { driveId: data.driveId, itemId: 'root', itemName: '/', itemPath: '/' },
            { driveId: data.driveId, itemId: data.itemId, itemName: data.name, itemPath: '' },
          ];
          loadCurrent();
          input.value = '';
        } catch (err) {
          showError('Network error: ' + err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = origLabel;
        }
      });

      loadCurrent();`,
  });
}
