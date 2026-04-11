// HTML template for the browser-based option picker page.

import { escapeHtml } from "./styles.js";

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo - ${escapeHtml(config.title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      color: #333;
      display: flex;
      justify-content: center;
      padding: 40px 20px;
    }
    .container { max-width: 480px; width: 100%; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 24px; font-size: 0.95rem; }
    .option-btn {
      display: block;
      width: 100%;
      padding: 14px 18px;
      margin-bottom: 10px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .option-btn:hover { border-color: #0078d4; box-shadow: 0 2px 8px rgba(0,120,212,0.15); }
    .option-btn:active { background: #f0f7ff; }
    .option-btn.selected { border-color: #0078d4; background: #f0f7ff; pointer-events: none; }
    .done { text-align: center; padding: 32px 0; }
    .done h2 { color: #107c10; margin-bottom: 8px; }
    .done p { color: #666; }
    .error { color: #d13438; margin-top: 16px; }
    .countdown { color: #999; margin-top: 8px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <div id="picker">
      <h1>${escapeHtml(config.title)}</h1>
      <p class="subtitle">${escapeHtml(config.subtitle)}</p>
      ${optionButtons}
    </div>
    <div id="done" style="display:none" class="done">
      <h2>&#10003; Done</h2>
      <p>Selected: <strong id="selected-label"></strong></p>
      <p style="margin-top: 24px;">You can switch back to your AI assistant now.</p>
      <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
      <p id="manual-close" style="display:none; margin-top: 16px; color: #666; font-size: 0.9rem;">If this window didn&rsquo;t close automatically, please close it manually.</p>
    </div>
    <div id="error" class="error" style="display:none"></div>
  </div>
  <script>
    document.querySelectorAll('.option-btn').forEach(btn => {
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
    });
  </script>
</body>
</html>`;
}
