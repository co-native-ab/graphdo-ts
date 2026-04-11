// Extracted inline JavaScript for browser-facing pages.
//
// Each function returns a JS string for injection into a <script> block.
// Parameterized to avoid hardcoding DOM element IDs.

/**
 * Countdown timer that attempts to close the window, then shows a
 * manual-close message if `window.close()` was blocked by the browser.
 */
export function countdownScript(
  countdownId: string,
  manualCloseId: string,
  seconds: number,
): string {
  return `
    let remaining = ${String(seconds)};
    const el = document.getElementById('${countdownId}');
    const tick = setInterval(() => {
      remaining--;
      el.textContent = String(remaining);
      if (remaining <= 0) {
        clearInterval(tick);
        window.close();
        setTimeout(() => {
          document.getElementById('${countdownId}').parentElement.style.display = 'none';
          document.getElementById('${manualCloseId}').style.display = 'block';
        }, 500);
      }
    }, 1000);`;
}

/**
 * Picker selection handler — attaches click listeners to option buttons,
 * POSTs the selection, shows a success view with countdown, or shows errors.
 */
export function pickerSelectionScript(
  countdownId: string,
  manualCloseId: string,
  seconds: number,
): string {
  return `
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
          let remaining = ${String(seconds)};
          const el = document.getElementById('${countdownId}');
          const tick = setInterval(() => {
            remaining--;
            el.textContent = String(remaining);
            if (remaining <= 0) {
              clearInterval(tick);
              window.close();
              setTimeout(() => {
                document.getElementById('${countdownId}').parentElement.style.display = 'none';
                document.getElementById('${manualCloseId}').style.display = 'block';
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
    });`;
}
