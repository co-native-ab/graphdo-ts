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

interface NavigatorFolder {
  id: string;
  name: string;
}

interface NavigatorDrive {
  id: string;
  label: string;
}

interface NavigatorPageConfig {
  title: string;
  subtitle: string;
  drives: NavigatorDrive[];
  activeDriveId: string;
  breadcrumbs: Array<{ id: string; label: string }>;
  folders: NavigatorFolder[];
  csrfToken: string;
  nonce: string;
}

function renderDriveTab(drive: NavigatorDrive, active: boolean): string {
  return `<button class="drive-tab${active ? " active" : ""}" data-drive-id="${escapeHtml(drive.id)}">${escapeHtml(drive.label)}</button>`;
}

function renderBreadcrumb(crumb: { id: string; label: string }, isLast: boolean): string {
  if (isLast) {
    return `<span class="breadcrumb-current">${escapeHtml(crumb.label)}</span>`;
  }
  return `<button class="breadcrumb" data-item-id="${escapeHtml(crumb.id)}">${escapeHtml(crumb.label)}</button><span class="breadcrumb-separator">/</span>`;
}

function renderFolder(folder: NavigatorFolder): string {
  return `<div class="folder-item" data-id="${escapeHtml(folder.id)}">
    <span class="folder-icon">📁</span>
    <span class="folder-name">${escapeHtml(folder.name)}</span>
  </div>`;
}

export function navigatorPageHtml(config: NavigatorPageConfig): string {
  const driveTabsHtml = config.drives
    .map((d) => renderDriveTab(d, d.id === config.activeDriveId))
    .join("\n        ");

  const breadcrumbsHtml = config.breadcrumbs
    .map((crumb, idx) => renderBreadcrumb(crumb, idx === config.breadcrumbs.length - 1))
    .join("\n        ");

  const foldersHtml =
    config.folders.length > 0
      ? config.folders.map(renderFolder).join("\n          ")
      : '<div class="folder-item" style="cursor: default; background: none;"><span class="folder-name" style="color: var(--text-tertiary);">No subfolders</span></div>';

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
      <div class="breadcrumbs" id="breadcrumbs">
        ${breadcrumbsHtml}
      </div>
      <div class="folder-list" id="folder-list">
        ${foldersHtml}
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
  </div>
  <script nonce="${escapeHtml(config.nonce)}">
    (function() {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
      
      let currentDrive = ${JSON.stringify(config.activeDriveId)};
      let currentItem = ${JSON.stringify(config.breadcrumbs[config.breadcrumbs.length - 1]?.id || "")};
      let currentPath = ${JSON.stringify(config.breadcrumbs.map(b => b.label).join("/"))};
      
      function showError(msg) {
        const container = document.getElementById('error-container');
        container.innerHTML = '<div class="error-message">' + escapeHtml(msg) + '</div>';
      }
      
      function clearError() {
        document.getElementById('error-container').innerHTML = '';
      }
      
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
      
      function showDone(message, detail) {
        document.getElementById('navigator').innerHTML = 
          '<div class="done-card"><div class="done-icon">✓</div>' +
          '<div class="done-message">' + escapeHtml(message) + '</div>' +
          '<div class="done-detail">' + escapeHtml(detail) + '</div>' +
          '<div class="countdown">Closing in <span id="countdown">3</span> seconds...</div></div>';
        
        let count = 3;
        const timer = setInterval(() => {
          count--;
          const el = document.getElementById('countdown');
          if (el) el.textContent = String(count);
          if (count <= 0) {
            clearInterval(timer);
            window.close();
          }
        }, 1000);
      }
      
      async function loadChildren(driveId, itemId) {
        clearError();
        const scope = driveId === 'me' ? 'me' : driveId;
        const url = '/children?scope=' + encodeURIComponent(scope) + '&itemId=' + encodeURIComponent(itemId);
        
        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: { 'X-CSRF-Token': csrfToken }
          });
          if (!res.ok) {
            const text = await res.text();
            showError('Failed to load folders: ' + text);
            return;
          }
          const data = await res.json();
          renderFolders(data.folders);
          renderBreadcrumbs(data.breadcrumbs);
          currentDrive = driveId;
          currentItem = itemId;
          currentPath = data.path;
        } catch (err) {
          showError('Network error: ' + err.message);
        }
      }
      
      function renderFolders(folders) {
        const list = document.getElementById('folder-list');
        if (folders.length === 0) {
          list.innerHTML = '<div class="folder-item" style="cursor: default; background: none;"><span class="folder-name" style="color: var(--text-tertiary);">No subfolders</span></div>';
          return;
        }
        list.innerHTML = folders.map(f => 
          '<div class="folder-item" data-id="' + escapeHtml(f.id) + '">' +
          '<span class="folder-icon">📁</span>' +
          '<span class="folder-name">' + escapeHtml(f.name) + '</span>' +
          '</div>'
        ).join('');
      }
      
      function renderBreadcrumbs(breadcrumbs) {
        const container = document.getElementById('breadcrumbs');
        container.innerHTML = breadcrumbs.map((crumb, idx) => {
          if (idx === breadcrumbs.length - 1) {
            return '<span class="breadcrumb-current">' + escapeHtml(crumb.label) + '</span>';
          }
          return '<button class="breadcrumb" data-item-id="' + escapeHtml(crumb.id) + '">' + 
                 escapeHtml(crumb.label) + '</button><span class="breadcrumb-separator">/</span>';
        }).join('');
      }
      
      document.getElementById('folder-list').addEventListener('click', (e) => {
        const item = e.target.closest('.folder-item');
        if (item && item.dataset.id) {
          loadChildren(currentDrive, item.dataset.id);
        }
      });
      
      document.getElementById('breadcrumbs').addEventListener('click', (e) => {
        const crumb = e.target.closest('.breadcrumb');
        if (crumb && crumb.dataset.itemId) {
          loadChildren(currentDrive, crumb.dataset.itemId);
        }
      });
      
      document.getElementById('drive-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.drive-tab');
        if (tab && tab.dataset.driveId) {
          loadChildren(tab.dataset.driveId, 'root');
        }
      });
      
      document.getElementById('select-btn').addEventListener('click', async () => {
        clearError();
        const btn = document.getElementById('select-btn');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        
        try {
          const res = await fetch('/select', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
              driveId: currentDrive,
              itemId: currentItem,
              path: currentPath,
              csrfToken
            })
          });
          
          if (!res.ok) {
            const text = await res.text();
            showError('Selection failed: ' + text);
            btn.disabled = false;
            btn.textContent = 'Use this folder as workspace';
            return;
          }
          
          showDone('Workspace configured', currentPath);
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
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ csrfToken })
          });
        } catch (err) {
          console.error('Cancel failed:', err);
        }
        window.close();
      });
      
      document.getElementById('resolve-share-btn').addEventListener('click', async () => {
        clearError();
        const input = document.getElementById('share-link-input');
        const url = input.value.trim();
        if (!url) {
          showError('Please paste a share link');
          return;
        }
        
        const btn = document.getElementById('resolve-share-btn');
        btn.disabled = true;
        btn.textContent = 'Resolving...';
        
        try {
          const res = await fetch('/resolve-share', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ url, csrfToken })
          });
          
          if (!res.ok) {
            const text = await res.text();
            showError('Failed to resolve link: ' + text);
            btn.disabled = false;
            btn.textContent = 'Add shared drive';
            return;
          }
          
          const data = await res.json();
          
          // Add new drive tab
          const tabs = document.getElementById('drive-tabs');
          const newTab = document.createElement('button');
          newTab.className = 'drive-tab';
          newTab.dataset.driveId = data.driveId;
          newTab.textContent = data.name || data.driveId;
          tabs.appendChild(newTab);
          
          // Navigate to it
          loadChildren(data.driveId, data.itemId);
          
          input.value = '';
          btn.disabled = false;
          btn.textContent = 'Add shared drive';
        } catch (err) {
          showError('Network error: ' + err.message);
          btn.disabled = false;
          btn.textContent = 'Add shared drive';
        }
      });
    })();
  </script>`,
  });
}
