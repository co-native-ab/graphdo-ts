// HTML template for the browser-based option picker page.

import { escapeHtml, PICKER_STYLE } from "./styles.js";
import { iconDarkDataUri } from "./icons.js";
import { layoutHtml } from "./layout.js";

interface PickerPageOption {
  id: string;
  label: string;
}

interface PickerPageConfig {
  title: string;
  subtitle: string;
  options: PickerPageOption[];
}

export function pickerPageHtml(config: PickerPageConfig): string {
  const optionButtons = config.options
    .map(
      (opt) =>
        `<button class="option-btn" data-id="${escapeHtml(opt.id)}" data-label="${escapeHtml(opt.label)}">${escapeHtml(opt.label)}</button>`,
    )
    .join("\n          ");

  return layoutHtml({
    title: `graphdo - ${escapeHtml(config.title)}`,
    extraStyles: PICKER_STYLE,
    body: `<div class="container">
    <div id="picker">
      <img src="${iconDarkDataUri}" alt="" class="page-icon">
      <h1>${escapeHtml(config.title)}</h1>
      <p class="subtitle">${escapeHtml(config.subtitle)}</p>
      ${optionButtons}
    </div>
    <div id="done" style="display:none" class="done">
      <h2>&#10003; Done</h2>
      <p>Selected: <strong id="selected-label"></strong></p>
      <p style="margin-top: 24px;">You can switch back to your AI assistant now.</p>
      <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
      <p id="manual-close" style="display:none">If this window didn&rsquo;t close automatically, please close it manually.</p>
    </div>
    <div id="error" class="error" style="display:none"></div>
  </div>`,
    script: `    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const label = btn.dataset.label;
        btn.classList.add('selected');
        document.querySelectorAll('.option-btn').forEach(b => { b.disabled = true; });
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
          document.querySelectorAll('.option-btn').forEach(b => { b.disabled = false; });
          btn.classList.remove('selected');
        }
      });
    });`,
  });
}
