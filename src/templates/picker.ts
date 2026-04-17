// HTML template for the browser-based option picker page.

import { escapeHtml, PICKER_STYLE } from "./styles.js";
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

interface PickerPageConfig {
  title: string;
  subtitle: string;
  options: PickerPageOption[];
  /** When true, a refresh button that calls `GET /options` is rendered. */
  refreshEnabled?: boolean;
  filterPlaceholder?: string;
  createLink?: PickerPageCreateLink;
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

  return layoutHtml({
    title: `graphdo - ${escapeHtml(config.title)}`,
    extraStyles: PICKER_STYLE,
    body: `<div class="container">
    <div class="card" id="picker">
      <h1>${escapeHtml(config.title)}</h1>
      <p class="subtitle">${escapeHtml(config.subtitle)}</p>
      <div class="toolbar">
        <input id="filter-input" class="filter-input" type="text" placeholder="${filterPlaceholder}" autocomplete="off" spellcheck="false" />
        ${refreshButton}
      </div>
      <div id="options-list">
        ${optionButtons}
      </div>
      <p id="no-match" class="no-match" style="display:none">No matches.</p>
      ${createLinkHtml}
      <div class="btn-group" style="margin-top: 16px">
        <button id="cancel-btn" class="cancel-btn">Cancel</button>
      </div>
    </div>
    <div class="card done" id="done" style="display:none">
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
    const list = document.getElementById('options-list');
    const noMatch = document.getElementById('no-match');
    const filterInput = document.getElementById('filter-input');

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function applyFilter() {
      const q = filterInput.value.toLowerCase().trim();
      let visible = 0;
      for (const btn of list.querySelectorAll('.option-btn')) {
        const label = (btn.dataset.label || '').toLowerCase();
        const match = q.length === 0 || label.indexOf(q) !== -1;
        btn.style.display = match ? '' : 'none';
        if (match) visible++;
      }
      noMatch.style.display = visible === 0 ? 'block' : 'none';
    }

    function wireOptionButtons() {
      list.querySelectorAll('.option-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const label = btn.dataset.label;
          btn.classList.add('selected');
          list.querySelectorAll('.option-btn').forEach(b => { b.disabled = true; });
          document.getElementById('cancel-btn').disabled = true;
          try {
            const res = await fetch('/select', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: id, label: label }),
            });
            if (!res.ok) throw new Error(await res.text());
            document.getElementById('picker').style.display = 'none';
            document.getElementById('selected-label').textContent = label;
            document.getElementById('done').style.display = 'block';
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
          } catch (err) {
            document.getElementById('error').style.display = 'block';
            document.getElementById('error').textContent = 'Failed: ' + err.message;
            list.querySelectorAll('.option-btn').forEach(b => { b.disabled = false; });
            document.getElementById('cancel-btn').disabled = false;
            btn.classList.remove('selected');
          }
        });
      });
    }

    wireOptionButtons();
    applyFilter();
    filterInput.addEventListener('input', applyFilter);

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
          applyFilter();
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
      await fetch('/cancel', { method: 'POST' }).catch(() => {});
      window.close();
    });`,
  });
}
