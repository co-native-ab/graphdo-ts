// System browser opener — cross-platform utility.

import { exec } from "node:child_process";
import { platform } from "node:os";

/** Open a URL in the system browser. Throws on failure. */
export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const os = platform();
    let cmd: string;
    if (os === "darwin") {
      cmd = `open "${url}"`;
    } else if (os === "win32") {
      cmd = `start "" "${url}"`;
    } else {
      cmd = `xdg-open "${url}"`;
    }

    exec(cmd, (err) => {
      if (err) {
        reject(new Error(`Failed to open browser: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}
