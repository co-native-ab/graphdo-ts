// System browser opener - cross-platform utility.

import { execFile } from "node:child_process";
import { platform } from "node:os";

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
    return Promise.reject(
      new Error(`Unsupported URL protocol: ${parsed.protocol}`),
    );
  }

  const os = platform();

  // macOS and Linux: use execFile (no shell) to prevent command injection.
  // The URL is passed as an argument array element, never interpolated into
  // a shell command string, so metacharacters like $() and `` are harmless.
  if (os !== "win32") {
    const cmd = os === "darwin" ? "open" : "xdg-open";
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
