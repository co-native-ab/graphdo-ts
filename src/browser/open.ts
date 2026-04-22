// System browser opener - cross-platform utility.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

// Detect WSL once at module load by checking the kernel version string.
let _isWsl: boolean | undefined;
function isWsl(): boolean {
  if (_isWsl === undefined) {
    try {
      const version = readFileSync("/proc/version", "utf-8");
      _isWsl = /microsoft|wsl/i.test(version);
    } catch {
      _isWsl = false;
    }
  }
  return _isWsl;
}

/** Open a URL in the system browser. Throws on failure. */
export function openBrowser(url: string): Promise<void> {
  // Security: validate URL to prevent command injection via crafted strings.
  // Only http: and https: protocols are allowed.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error("Invalid URL"));
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.reject(new Error(`Unsupported URL protocol: ${parsed.protocol}`));
  }

  // Two callers open URLs through this helper:
  //   1. The loopback / picker / logout pages on a local 127.0.0.1 server
  //      (always plain http://localhost or http://127.0.0.1 with a random port).
  //   2. Tools that deep-link the user into an external site (e.g. the
  //      markdown preview tool opening a SharePoint URL). These are always
  //      https.
  //
  // Plain http to a non-local host is never something this app emits — and
  // letting it through would risk silently opening a cleartext page to an
  // attacker-controlled URL — so we reject that combination.
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "http:" && !isLocal) {
    return Promise.reject(
      new Error(`Plain http:// URLs must be a localhost address, got: ${parsed.hostname}`),
    );
  }

  const os = platform();

  // macOS and Linux: use execFile (no shell) to prevent command injection.
  // The URL is passed as an argument array element, never interpolated into
  // a shell command string, so metacharacters like $() and `` are harmless.
  if (os !== "win32") {
    // WSL: use wslview (from wslu) to open the host Windows browser.
    // Native Linux: use xdg-open.
    const cmd = os === "darwin" ? "open" : isWsl() ? "wslview" : "xdg-open";
    return new Promise((resolve, reject) => {
      execFile(cmd, [url], (err) => {
        if (err) {
          reject(new Error(`Failed to open browser: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  // Windows: use execFile with cmd.exe /c start to avoid shell string injection.
  // Arguments are passed as array elements, not interpolated into a command string.
  return new Promise((resolve, reject) => {
    execFile("cmd.exe", ["/c", "start", "", url], (err) => {
      if (err) {
        reject(new Error(`Failed to open browser: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}
