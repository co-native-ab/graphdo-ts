// HTML template for the browser-based option picker page.

import { PICKER_STYLE } from "./styles.js";
import { escapeHtml } from "./escape.js";
import { logoDarkDataUri, logoLightDataUri } from "./icons.js";
import { layoutHtml } from "./layout.js";

interface PickerPageOption {
  id: string;
  label: string;
}

interface PickerPageCreateLink {
  url: string;
  label: string;
  description?: string;
}

interface PickerPageNavigation {
  initialBreadcrumb: string[];
  shareUrlEnabled: boolean;
}

interface PickerPageConfig {
  title: string;
  subtitle: string;
  options: PickerPageOption[];
  /** When true, a refresh button that calls `GET /options` is rendered. */
  refreshEnabled?: boolean;
  filterPlaceholder?: string;
  createLink?: PickerPageCreateLink;
  /**
   * CSRF token embedded in a `<meta name="csrf-token">` tag and required
   * by the hardened POST handlers (see `src/loopback-security.ts`). When
   * omitted, the meta tag is not emitted (legacy callers only — new
   * call sites must always supply it).
   */
  csrfToken?: string;
  /** Per-request CSP nonce; threaded through to inline `<style>` and `<script>`. */
  nonce?: string;
  /** When set, enables navigable folder picker mode. */
  navigation?: PickerPageNavigation;
}

function renderOptionButton(opt: PickerPageOption): string {
  return `<button class="option-btn" data-id="${escapeHtml(opt.id)}" data-label="${escapeHtml(opt.label)}">${escapeHtml(opt.label)}</button>`;
}

export function pickerPageHtml(config: PickerPageConfig): string {
  const optionButtons = config.options.map(renderOptionButton).join("\n          ");

  const filterPlaceholder = escapeHtml(config.filterPlaceholder ?? "Filter...");

  const refreshButton = config.refreshEnabled
    ? `<button id="refresh-btn" class="refresh-btn" type="button" title="Refresh list" aria-label="Refresh">&#x21bb; Refresh</button>`
    : "";

  const createLinkHtml =
    config.createLink !== undefined
      ? `<div class="create-link-box">
        <a href="${escapeHtml(config.createLink.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(config.createLink.label)} &#8599;</a>${
          config.createLink.description !== undefined
            ? `<p class="create-link-desc">${escapeHtml(config.createLink.description)}</p>`
            : ""
        }
      </div>`
      : "";

  const breadcrumbHtml =
    config.navigation !== undefined
      ? `<nav id="breadcrumb" class="breadcrumb">${config.navigation.initialBreadcrumb
          .map((s) => `<span>${escapeHtml(s)}</span>`)
          .join(" / ")}</nav>`
      : "";

  const shareUrlFormHtml =
    config.navigation?.shareUrlEnabled === true
      ? `<div class="share-url-form">
        <label for="share-url-input">Or paste a OneDrive folder share link:</label>
        <div class="share-url-row">
          <input id="share-url-input" type="url" placeholder="https://...sharepoint.com/..." autocomplete="off" />
          <button id="share-url-btn" class="share-url-btn" type="button">Open link</button>
        </div>
      </div>`
      : "";

  const selectCurrentBtn =
    config.navigation !== undefined
      ? `<button id="select-current-btn" class="select-current-btn" type="button" disabled>Select this folder</button>`
      : "";

  return layoutHtml({
    title: `graphdo - ${escapeHtml(config.title)}`,
    extraStyles: PICKER_STYLE,
    nonce: config.nonce,
    extraHead:
      config.csrfToken !== undefined
        ? `<meta name="csrf-token" content="${escapeHtml(config.csrfToken)}">`
        : "",
    body: `<div class="container">
    <div class="card" id="picker">
      <h1>${escapeHtml(config.title)}</h1>
      <p class="subtitle">${escapeHtml(config.subtitle)}</p>
      <div class="toolbar">
        <input id="filter-input" class="filter-input" type="text" placeholder="${filterPlaceholder}" autocomplete="off" spellcheck="false" />
        ${refreshButton}
      </div>
      ${breadcrumbHtml}
      <div id="options-list">
        ${optionButtons}
      </div>
      <p id="no-match" class="no-match" style="display:none">No matches.</p>
      <div id="pagination" class="pagination" style="display:none">
        <button id="prev-btn" class="page-btn" type="button" aria-label="Previous page">&laquo; Prev</button>
        <span id="page-status" class="page-status" aria-live="polite"></span>
        <button id="next-btn" class="page-btn" type="button" aria-label="Next page">Next &raquo;</button>
      </div>
      ${shareUrlFormHtml}
      ${createLinkHtml}
      <div class="btn-group" style="margin-top: 16px">
        ${selectCurrentBtn}
        <button id="cancel-btn" class="cancel-btn">Cancel</button>
      </div>
    </div>
    <div class="card done" id="done" style="display:none" hidden>
      <h1>&#10003; Done</h1>
      <p class="message">Selected: <strong id="selected-label"></strong></p>
      <p class="message" style="margin-top: 16px;">You can switch back to your AI assistant now.</p>
      <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
      <p id="manual-close" style="display:none">If this window didn&rsquo;t close automatically, please close it manually.</p>
    </div>
    <div id="error" class="error" style="display:none"></div>
    <picture>
      <source srcset="${logoLightDataUri}" media="(prefers-color-scheme: dark)">
      <img src="${logoDarkDataUri}" alt="graphdo" class="brand-footer">
    </picture>
  </div>`,
    script: `    const refreshEnabled = ${String(config.refreshEnabled === true)};
    const navigationEnabled = ${String(config.navigation !== undefined)};
    const shareUrlEnabled = ${String(config.navigation?.shareUrlEnabled === true)};
    const PAGE_SIZE = 10;
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';
    const list = document.getElementById('options-list');
    const noMatch = document.getElementById('no-match');
    const filterInput = document.getElementById('filter-input');
    const pagination = document.getElementById('pagination');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const pageStatus = document.getElementById('page-status');
    let currentPage = 0;

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Applies the filter across ALL options, then paginates the filtered
    // subset so at most PAGE_SIZE buttons are visible at a time. Filter
    // text is always evaluated over the full option list (never just the
    // current page) so the user can find any item by typing, regardless
    // of which page it lives on.
    function applyFilterAndPaginate() {
      const q = filterInput.value.toLowerCase().trim();
      const allBtns = list.querySelectorAll('.option-btn');
      const matched = [];
      for (const btn of allBtns) {
        const label = (btn.dataset.label || '').toLowerCase();
        const isMatch = q.length === 0 || label.indexOf(q) !== -1;
        if (isMatch) {
          matched.push(btn);
        } else {
          btn.style.display = 'none';
        }
      }

      const totalPages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
      if (currentPage >= totalPages) currentPage = totalPages - 1;
      if (currentPage < 0) currentPage = 0;

      const start = currentPage * PAGE_SIZE;
      const end = start + PAGE_SIZE;
      for (let i = 0; i < matched.length; i++) {
        matched[i].style.display = (i >= start && i < end) ? '' : 'none';
      }

      noMatch.style.display = matched.length === 0 ? 'block' : 'none';

      if (matched.length > PAGE_SIZE) {
        pagination.style.display = '';
        pageStatus.textContent = 'Page ' + (currentPage + 1) + ' of ' + totalPages + ' (' + matched.length + ' total)';
        prevBtn.disabled = currentPage === 0;
        nextBtn.disabled = currentPage >= totalPages - 1;
      } else {
        pagination.style.display = 'none';
      }
    }

    function wireOptionButtons() {
      list.querySelectorAll('.option-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const label = btn.dataset.label;
          btn.classList.add('selected');
          list.querySelectorAll('.option-btn').forEach(b => { b.disabled = true; });
          document.getElementById('cancel-btn').disabled = true;
          if (navigationEnabled) {
            const selectCurrentBtn = document.getElementById('select-current-btn');
            if (selectCurrentBtn) selectCurrentBtn.disabled = true;
          }
          try {
            if (navigationEnabled) {
              const res = await fetch('/navigate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, csrfToken: csrfToken }),
              });
              if (!res.ok) throw new Error(await res.text());
              const data = await res.json();
              const opts = Array.isArray(data.options) ? data.options : [];
              list.innerHTML = opts.map(o =>
                '<button class="option-btn" data-id="' + escapeHtml(o.id) + '" data-label="' + escapeHtml(o.label) + '">' + escapeHtml(o.label) + '</button>'
              ).join('\\n');
              wireOptionButtons();
              currentPage = 0;
              applyFilterAndPaginate();
              const bc = document.getElementById('breadcrumb');
              if (bc && Array.isArray(data.breadcrumb)) {
                bc.innerHTML = data.breadcrumb.map(s => '<span>' + escapeHtml(s) + '</span>').join(' / ');
              }
              const selectBtn = document.getElementById('select-current-btn');
              if (selectBtn) selectBtn.disabled = false;
              document.getElementById('cancel-btn').disabled = false;
            } else {
              const res = await fetch('/select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, label: label, csrfToken: csrfToken }),
              });
              if (!res.ok) throw new Error(await res.text());
              showDoneCard(label);
            }
          } catch (err) {
            document.getElementById('error').style.display = 'block';
            document.getElementById('error').textContent = 'Failed: ' + err.message;
            list.querySelectorAll('.option-btn').forEach(b => { b.disabled = false; });
            document.getElementById('cancel-btn').disabled = false;
            btn.classList.remove('selected');
            if (navigationEnabled) {
              const selectBtn = document.getElementById('select-current-btn');
              if (selectBtn && !selectBtn.dataset.everNavigated) selectBtn.disabled = true;
            }
          }
        });
      });
    }

    function showDoneCard(label) {
      document.getElementById('picker').style.display = 'none';
      document.getElementById('selected-label').textContent = label;
      const doneEl = document.getElementById('done');
      doneEl.removeAttribute('hidden');
      doneEl.style.display = 'block';
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
    }

    wireOptionButtons();
    applyFilterAndPaginate();
    filterInput.addEventListener('input', () => {
      // Reset to the first page whenever the filter changes so matches
      // aren't hidden on a later page.
      currentPage = 0;
      applyFilterAndPaginate();
    });
    prevBtn.addEventListener('click', () => {
      if (currentPage > 0) {
        currentPage--;
        applyFilterAndPaginate();
      }
    });
    nextBtn.addEventListener('click', () => {
      currentPage++;
      applyFilterAndPaginate();
    });

    if (navigationEnabled) {
      const selectCurrentBtn = document.getElementById('select-current-btn');
      if (selectCurrentBtn) {
        selectCurrentBtn.addEventListener('click', async () => {
          selectCurrentBtn.disabled = true;
          list.querySelectorAll('.option-btn').forEach(b => { b.disabled = true; });
          document.getElementById('cancel-btn').disabled = true;
          document.getElementById('error').style.display = 'none';
          try {
            const res = await fetch('/select-current', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ csrfToken: csrfToken }),
            });
            if (!res.ok) throw new Error(await res.text());
            const bc = document.getElementById('breadcrumb');
            const label = bc ? bc.textContent : 'Selected';
            showDoneCard(label || 'Selected');
          } catch (err) {
            document.getElementById('error').style.display = 'block';
            document.getElementById('error').textContent = 'Failed: ' + err.message;
            selectCurrentBtn.disabled = false;
            list.querySelectorAll('.option-btn').forEach(b => { b.disabled = false; });
            document.getElementById('cancel-btn').disabled = false;
          }
        });
      }
    }

    if (shareUrlEnabled) {
      const shareUrlBtn = document.getElementById('share-url-btn');
      const shareUrlInput = document.getElementById('share-url-input');
      if (shareUrlBtn && shareUrlInput) {
        shareUrlBtn.addEventListener('click', async () => {
          const url = shareUrlInput.value.trim();
          if (!url) return;
          shareUrlBtn.disabled = true;
          shareUrlInput.disabled = true;
          document.getElementById('error').style.display = 'none';
          try {
            const res = await fetch('/share-url', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: url, csrfToken: csrfToken }),
            });
            const data = await res.json();
            if (!res.ok) {
              throw new Error(data.error || ('Request failed: ' + String(res.status)));
            }
            if (data.kind === 'select') {
              showDoneCard(data.selected.label);
            } else {
              const opts = Array.isArray(data.options) ? data.options : [];
              list.innerHTML = opts.map(o =>
                '<button class="option-btn" data-id="' + escapeHtml(o.id) + '" data-label="' + escapeHtml(o.label) + '">' + escapeHtml(o.label) + '</button>'
              ).join('\\n');
              wireOptionButtons();
              currentPage = 0;
              applyFilterAndPaginate();
              const bc = document.getElementById('breadcrumb');
              if (bc && Array.isArray(data.breadcrumb)) {
                bc.innerHTML = data.breadcrumb.map(s => '<span>' + escapeHtml(s) + '</span>').join(' / ');
              }
              const selectBtn = document.getElementById('select-current-btn');
              if (selectBtn) selectBtn.disabled = false;
              shareUrlInput.value = '';
              shareUrlBtn.disabled = false;
              shareUrlInput.disabled = false;
            }
          } catch (err) {
            document.getElementById('error').style.display = 'block';
            document.getElementById('error').textContent = 'Failed: ' + err.message;
            shareUrlBtn.disabled = false;
            shareUrlInput.disabled = false;
          }
        });
      }
    }

    if (refreshEnabled) {
      const refreshBtn = document.getElementById('refresh-btn');
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.classList.add('loading');
        document.getElementById('error').style.display = 'none';
        try {
          const res = await fetch('/options');
          if (!res.ok) throw new Error('Refresh failed: ' + res.status);
          const data = await res.json();
          const opts = Array.isArray(data.options) ? data.options : [];
          list.innerHTML = opts.map(o =>
            '<button class="option-btn" data-id="' + escapeHtml(o.id) + '" data-label="' + escapeHtml(o.label) + '">' + escapeHtml(o.label) + '</button>'
          ).join('\\n');
          wireOptionButtons();
          currentPage = 0;
          applyFilterAndPaginate();
        } catch (err) {
          document.getElementById('error').style.display = 'block';
          document.getElementById('error').textContent = 'Refresh failed: ' + err.message;
        } finally {
          refreshBtn.classList.remove('loading');
          refreshBtn.disabled = false;
        }
      });
    }

    document.getElementById('cancel-btn').addEventListener('click', async () => {
      document.getElementById('cancel-btn').disabled = true;
      list.querySelectorAll('.option-btn').forEach(b => { b.disabled = true; });
      await fetch('/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken: csrfToken }),
      }).catch(() => {});
      window.close();
    });`,
  });
}
