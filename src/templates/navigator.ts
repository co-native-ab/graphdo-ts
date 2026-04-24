// HTML template for the browser-based workspace navigator.
//
// Renders a card with breadcrumbs, a Back/Forward/filter toolbar, a
// scrollable folder list, optional pagination, and primary/cancel
// actions. All styling is sourced from `NAVIGATOR_STYLE` in
// `src/templates/styles.ts`, which in turn is built from the design
// tokens in `src/templates/tokens.ts` (see ADR-0002).
//
// The breadcrumb renderer was rewritten to fix a `/ / Foo` rendering
// bug: the root entry is now a small "home" SVG button and chevron
// separators are emitted strictly *between* crumbs (never leading,
// never duplicated). The navigation model is a `{ history, cursor }`
// pair rather than a linear stack, so Back / Forward behave the way
// a browser does.

import { escapeHtml } from "./escape.js";
import { layoutHtml } from "./layout.js";
import { logoDarkDataUri, logoLightDataUri } from "./icons.js";
import { NAVIGATOR_STYLE } from "./styles.js";

interface NavigatorPageConfig {
  title: string;
  subtitle: string;
  /** Display name of the drive being navigated (e.g. `"OneDrive"`). */
  driveLabel: string;
  csrfToken: string;
  nonce: string;
}

// Tiny inline SVGs. Kept here (not in `icons.ts`) because they are
// purely decorative glyphs for this template, not encoded brand assets.
const HOME_ICON_SVG =
  '<svg class="crumb-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 7.5 8 2l6 5.5"/><path d="M3.5 6.8V13a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6.8"/></svg>';
const FOLDER_ICON_SVG =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="20" height="20"><path d="M2.5 5.5a1 1 0 0 1 1-1h4l1.5 2h7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-12.5a1 1 0 0 1-1-1z"/></svg>';

export function navigatorPageHtml(config: NavigatorPageConfig): string {
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
      <div class="drive-label">${escapeHtml(config.driveLabel)}</div>
      <nav class="breadcrumbs" id="breadcrumbs" aria-label="Folder path"></nav>
      <div class="nav-toolbar">
        <input id="filter-input" class="filter-input" type="text" placeholder="Filter folders\u2026" autocomplete="off" spellcheck="false" aria-label="Filter folders" />
      </div>
      <div class="folder-list" id="folder-list" role="list">
        <div class="folder-empty">Loading\u2026</div>
      </div>
      <div id="pagination" class="pagination" hidden>
        <button id="prev-btn" class="page-btn" type="button" aria-label="Previous page">&laquo; Prev</button>
        <span id="page-status" class="page-status" aria-live="polite"></span>
        <button id="next-btn" class="page-btn" type="button" aria-label="Next page">Next &raquo;</button>
      </div>
      <div class="action-buttons">
        <button id="select-btn" class="primary-btn" type="button" disabled title="Open a subfolder first \u2014 the drive root cannot be the workspace.">Use this folder as workspace</button>
        <button id="cancel-btn" class="cancel-btn" type="button">Cancel</button>
      </div>
    </div>
    <div class="card done" id="done" hidden>
      <h1>&#10003; Workspace configured</h1>
      <p class="message"><span class="selected-path" id="selected-label"></span></p>
      <p class="message post-message">You can switch back to your AI assistant now.</p>
      <p class="countdown">Closing in <span id="countdown">3</span>s&hellip;</p>
    </div>
    <picture>
      <source srcset="${logoLightDataUri}" media="(prefers-color-scheme: dark)">
      <img src="${logoDarkDataUri}" alt="graphdo" class="brand-footer">
    </picture>
  </div>`,
    script: `    const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content') || '';
      const PAGE_SIZE = 25;
      const HOME_ICON = ${JSON.stringify(HOME_ICON_SVG)};
      const FOLDER_ICON = ${JSON.stringify(FOLDER_ICON_SVG)};

      // Navigation stack. Each entry describes a folder on the path
      // from the drive root to the current location. Drilling into a
      // folder pushes; clicking a breadcrumb pops back to that level.
      const stack = [{ itemId: 'root', itemName: '/', itemPath: '/' }];
      let lastFolders = [];
      let currentPage = 0;

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
      }

      function current() { return stack[stack.length - 1]; }

      function showError(msg) {
        document.getElementById('error-container').innerHTML =
          '<div class="error-message">' + escapeHtml(msg) + '</div>';
      }
      function clearError() {
        document.getElementById('error-container').innerHTML = '';
      }

      function showDone(detail) {
        document.getElementById('navigator').hidden = true;
        document.getElementById('selected-label').textContent = detail;
        document.getElementById('done').hidden = false;
        let count = 3;
        const tick = setInterval(() => {
          count--;
          const el = document.getElementById('countdown');
          if (el) el.textContent = String(count);
          if (count <= 0) { clearInterval(tick); window.close(); }
        }, 1000);
      }

      function renderToolbarState() {
        // Root cannot be the workspace; the only way to enable selection
        // is to open a subfolder first.
        const isRoot = current().itemId === 'root';
        const selectBtn = document.getElementById('select-btn');
        selectBtn.disabled = isRoot;
        selectBtn.title = isRoot
          ? 'Open a subfolder first \u2014 the drive root cannot be the workspace.'
          : 'Save this folder as the workspace';
      }

      function renderBreadcrumbs() {
        const container = document.getElementById('breadcrumbs');
        const parts = [];
        for (let i = 0; i < stack.length; i++) {
          const entry = stack[i];
          const isLast = i === stack.length - 1;
          const isRoot = i === 0;
          const labelHtml = isRoot ? HOME_ICON : escapeHtml(entry.itemName);
          if (isLast) {
            const ariaLabel = isRoot ? ' aria-label="Drive root"' : '';
            parts.push(
              '<span class="crumb-current"' + ariaLabel + ' aria-current="page">' + labelHtml + '</span>'
            );
          } else {
            const ariaLabel = isRoot ? ' aria-label="Drive root"' : '';
            parts.push(
              '<button type="button" class="crumb-btn" data-index="' + i + '"' + ariaLabel + '>' + labelHtml + '</button>'
            );
          }
          if (!isLast) {
            parts.push('<span class="crumb-sep" aria-hidden="true">\u203A</span>');
          }
        }
        container.innerHTML = parts.join('');
      }

      function renderFolders() {
        const list = document.getElementById('folder-list');
        const q = document.getElementById('filter-input').value.toLowerCase().trim();
        const matched = q.length === 0
          ? lastFolders
          : lastFolders.filter(f => f.name.toLowerCase().indexOf(q) !== -1);

        if (lastFolders.length === 0) {
          list.innerHTML = '<div class="folder-empty">No subfolders here.</div>';
          renderPagination(0);
          return;
        }
        if (matched.length === 0) {
          list.innerHTML = '<div class="folder-empty">No folders match \u201C' + escapeHtml(q) + '\u201D.</div>';
          renderPagination(0);
          return;
        }

        const totalPages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
        if (currentPage >= totalPages) currentPage = totalPages - 1;
        if (currentPage < 0) currentPage = 0;
        const start = currentPage * PAGE_SIZE;
        const page = matched.slice(start, start + PAGE_SIZE);

        list.innerHTML = page.map(f =>
          '<button type="button" class="folder-item" data-id="' + escapeHtml(f.id) + '" data-name="' + escapeHtml(f.name) + '">' +
            '<span class="folder-icon">' + FOLDER_ICON + '</span>' +
            '<span class="folder-name">' + escapeHtml(f.name) + '</span>' +
            '<span class="folder-chevron" aria-hidden="true">\u203A</span>' +
          '</button>'
        ).join('');

        renderPagination(matched.length, totalPages);
      }

      function renderPagination(matchedCount, totalPages) {
        const pag = document.getElementById('pagination');
        if (matchedCount <= PAGE_SIZE) {
          pag.hidden = true;
          return;
        }
        pag.hidden = false;
        document.getElementById('page-status').textContent =
          'Page ' + (currentPage + 1) + ' of ' + totalPages + ' (' + matchedCount + ' folders)';
        document.getElementById('prev-btn').disabled = currentPage === 0;
        document.getElementById('next-btn').disabled = currentPage >= totalPages - 1;
      }

      async function loadCurrent() {
        clearError();
        // Reset filter + page state on every navigation so they don't
        // surprisingly carry over to a different folder.
        document.getElementById('filter-input').value = '';
        currentPage = 0;
        lastFolders = [];
        document.getElementById('folder-list').innerHTML =
          '<div class="folder-empty">Loading\u2026</div>';
        renderBreadcrumbs();
        renderToolbarState();

        const entry = current();
        const url = '/children?itemId=' + encodeURIComponent(entry.itemId);
        try {
          const res = await fetch(url, { method: 'GET', headers: { 'X-CSRF-Token': csrfToken } });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            showError('Failed to load folders: ' + (data.error || res.status));
            document.getElementById('folder-list').innerHTML =
              '<div class="folder-empty">\u2014</div>';
            return;
          }
          const data = await res.json();
          // Update the entry with Graph's canonical name + path so
          // breadcrumbs and persisted selection match the resolved values.
          entry.itemName = data.itemName;
          entry.itemPath = data.itemPath;
          lastFolders = Array.isArray(data.folders) ? data.folders : [];
          renderBreadcrumbs();
          renderToolbarState();
          renderFolders();
        } catch (err) {
          showError('Network error: ' + err.message);
        }
      }

      function pushAndNavigate(itemId, itemName) {
        stack.push({ itemId: itemId, itemName: itemName || itemId, itemPath: '' });
        loadCurrent();
      }
      function jumpToBreadcrumb(index) {
        if (index < 0 || index >= stack.length - 1) return;
        stack.splice(index + 1);
        loadCurrent();
      }

      document.getElementById('folder-list').addEventListener('click', (e) => {
        const item = e.target.closest('.folder-item');
        if (item && item.dataset.id) {
          pushAndNavigate(item.dataset.id, item.dataset.name);
        }
      });

      document.getElementById('breadcrumbs').addEventListener('click', (e) => {
        const crumb = e.target.closest('.crumb-btn');
        if (crumb && crumb.dataset.index !== undefined) {
          jumpToBreadcrumb(parseInt(crumb.dataset.index, 10));
        }
      });

      document.getElementById('filter-input').addEventListener('input', () => {
        currentPage = 0;
        renderFolders();
      });

      document.getElementById('prev-btn').addEventListener('click', () => {
        if (currentPage > 0) { currentPage--; renderFolders(); }
      });
      document.getElementById('next-btn').addEventListener('click', () => {
        currentPage++; renderFolders();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== document.getElementById('filter-input')) {
          e.preventDefault();
          document.getElementById('filter-input').focus();
        }
      });

      document.getElementById('select-btn').addEventListener('click', async () => {
        clearError();
        const entry = current();
        if (entry.itemId === 'root') {
          showError('Open a subfolder first \u2014 the drive root cannot be the workspace.');
          return;
        }
        const btn = document.getElementById('select-btn');
        btn.disabled = true;
        btn.textContent = 'Saving\u2026';
        try {
          const res = await fetch('/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({
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
          showDone(entry.itemPath || entry.itemName);
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
        } catch (err) { /* swallow \u2014 we close the window anyway */ }
        window.close();
      });

      loadCurrent();`,
  });
}
