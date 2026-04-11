// HTML template for the browser-based option picker page.

import { PICKER_STYLES, escapeHtml } from "./styles.js";
import { pickerSelectionScript } from "./scripts.js";

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
    ${PICKER_STYLES}
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
      <p id="manual-close" style="display:none; margin-top: 16px; color: var(--color-text-secondary); font-size: 0.9rem;">If this window didn&rsquo;t close automatically, please close it manually.</p>
    </div>
    <div id="error" class="error" style="display:none"></div>
  </div>
  <script>${pickerSelectionScript("countdown", "manual-close", 5)}</script>
</body>
</html>`;
}
