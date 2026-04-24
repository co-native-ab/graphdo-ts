---
title: "ADR-0011: Delegate Browser Launch to the `open` Package"
status: "Accepted"
date: "2026-04-24"
authors: "co-native-ab"
tags: ["architecture", "browser", "dependencies", "cross-platform", "windows"]
supersedes: ""
superseded_by: ""
---

# ADR-0011: Delegate Browser Launch to the `open` Package

## Status

**Accepted**

## Context

graphdo-ts opens the system browser from several places:

- The MSAL login loopback page (ADR-0003, ADR-0008).
- The picker page used by `todo_select_list` and the markdown
  workspace selector (ADR-0008).
- The logout confirmation page (ADR-0008).
- The `markdown_preview_file` tool, which deep-links into the
  SharePoint OneDrive web preview for the user's file.

All of these go through a single platform shim, `src/browser/open.ts`
(`openBrowser(url)`), per the architecture in ADR-0008. Until this
ADR, that shim was hand-rolled:

| Platform | Implementation                                             |
| -------- | ---------------------------------------------------------- |
| macOS    | `execFile("open", [url])`                                  |
| Linux    | `execFile("xdg-open", [url])`                              |
| WSL      | `execFile("wslview", [url])` (sniffed via `/proc/version`) |
| Windows  | `execFile("cmd.exe", ["/c", "start", "", url])`            |

The Windows path turned out to be broken in two distinct ways on
Windows + Claude Desktop (the MCPB bundle runs as a stdio child of
Claude Desktop, with no console attached):

1. **URL mangling.** `cmd.exe` parses its command line and treats `&`
   as a command separator. A SharePoint preview URL of the form
   `…?id=…&parent=…` had everything from `&parent=` onwards silently
   dropped before reaching the browser. The portion that did make it
   through was further re-encoded by Windows ShellExecute, with
   unreserved characters (`_`, `-`, `.`) percent-encoded into `%5F`,
   `%2D`, `%2E`. SharePoint's `/my` view requires `parent` to render
   the item, so the link was effectively broken.
2. **False failure detection.** The exit code from `cmd /c start ""`
   is unreliable in non-console spawn contexts. `execFile` saw a
   non-zero exit and the tool reported "Could not open a browser
   automatically", even though the browser had in fact opened (to the
   broken URL).

Both bugs manifest only on Windows + Claude Desktop. Linux, WSL,
macOS, and Windows + GitHub Copilot CLI all worked. Fixing this
correctly on Windows means avoiding `cmd.exe` entirely so the URL
never goes through cmd's parser, and using a launch mechanism whose
exit code reliably reflects whether the launch succeeded — both of
which point at PowerShell's `Start-Process`.

Rather than rebuild a Windows-correct PowerShell launcher (and deal
with the long tail of cross-platform browser-launch edge cases:
default-browser detection, WSL→Windows path conversion, sandboxed WSL
environments, electron, SSH sessions, Linux distros with broken
`xdg-open`, etc.), we evaluated `open`
(<https://github.com/sindresorhus/open>), the de-facto Node.js
cross-platform browser launcher.

`open`'s implementation:

- **Windows / WSL**: PowerShell `Start-Process` (URL passed verbatim,
  no shell parsing, structured exit codes).
- **macOS**: `open(1)`.
- **Linux**: an upstream copy of the latest `xdg-open` script,
  bundled with the package, with fallback to system `xdg-open` when
  the bundled copy isn't accessible (e.g. inside an esbuild bundle).
- **WSL**: detects sandboxed environments, converts WSL paths to
  Windows paths when needed, falls back to native Linux behavior when
  PowerShell isn't reachable.
- Uses `spawn` instead of `exec` (no shell, no string interpolation).
- ESM-only (matches our package).

Trade-off: `open` is a small package itself (a few hundred lines)
but pulls in transitive dependencies — `wsl-utils`,
`powershell-utils`, `default-browser`, `is-inside-container`,
`is-in-ssh`, `define-lazy-prop`. We currently keep our runtime
dependency list deliberately small (ADR-0001 leans on this for
auditability). Adding `open` brings us from four runtime deps to
five, with `open` itself bringing in roughly a dozen transitive
packages. None of these are large or notably risky.

`open`'s README explicitly disclaims security guarantees. Our
existing URL validation (allowlist of `http:` / `https:`, plain
`http:` restricted to localhost) is the gatekeeper that makes the
delegation safe.

## Decision

`src/browser/open.ts` keeps its public shape — same `openBrowser(url)`
signature, same dependency-injection thread through
`ServerConfig.openBrowser`, same test spy pattern. The body becomes:

1. Parse and validate the URL (allowlist + plain-http-localhost-only
   guard). This is the security gatekeeper and runs **before** any
   handoff.
2. `await open(url)` — let the upstream package handle platform,
   spawning, and quoting.
3. Wrap any rejection as `Failed to open browser: <message>` so the
   external contract callers depend on (e.g. `markdown_preview_file`'s
   "could not open browser" fallback path) is unchanged.

We do **not** move the validation into a wrapper around `open` or
expose `open` directly. The single seam in `src/browser/open.ts`
remains the only place in the codebase that talks to the system
browser, which keeps ADR-0008's flow architecture intact and keeps
URL validation impossible to bypass.

## Consequences

### Positive

- **Windows + Claude Desktop is fixed.** PowerShell `Start-Process`
  passes the URL verbatim (no `&` splitting, no unreserved-char
  re-encoding) and reports launch success reliably.
- **WSL handling is improved.** `open` knows about sandboxed WSL,
  PowerShell reachability, and WSL→Windows path conversion. Our
  `/proc/version` sniff and `wslview` fallback go away.
- **Linux handling is improved.** `open` bundles the latest upstream
  `xdg-open` script, which fixes a long tail of distro-specific
  quirks. When the bundled copy isn't accessible (inside our esbuild
  bundle), it falls back to system `xdg-open` — same behavior as
  before.
- **Less code to maintain.** `src/browser/open.ts` shrinks from ~85
  lines of platform branching to ~50 lines, almost entirely
  validation.
- **No call-site changes.** The seam is identical, so ADR-0008's flow
  architecture, the `ServerConfig.openBrowser` DI thread, and every
  test spy continue to work.

### Negative

- **One additional runtime dependency.** Five runtime deps instead of
  four. ADR-0001's auditability concern is partly offset by `open`
  being a heavily-used, actively-maintained, single-purpose package.
- **MCPB bundle size grows modestly.** A few transitive deps get
  bundled; the total increase is small relative to the bundled
  Node.js runtime that already ships in the MCPB.
- **No security guarantees from `open` itself.** Mitigated by keeping
  our pre-flight URL validation as the gatekeeper, and by the fact
  that `open` uses `spawn` (no shell) under the hood.

## Alternatives considered

### A. Hand-roll a Windows PowerShell launcher

Replace the `cmd.exe /c start ""` invocation with
`powershell.exe -NoProfile -Command Start-Process <url>`, keeping the
rest of `open.ts` as-is. Fixes the immediate Windows bug.

Rejected because it leaves us owning the long tail of cross-platform
browser-launch concerns (sandboxed WSL, WSL→Windows path conversion,
distro-specific `xdg-open` quirks, default-browser detection if we
ever need it). `open` already has all of this and is widely
exercised. Doing it ourselves would also mean re-discovering the
same bugs `open` has already fixed.

### B. Use `rundll32 url.dll,FileProtocolHandler <url>` on Windows

Another well-known Windows opener that bypasses `cmd.exe`. Lighter
than PowerShell.

Rejected for the same reason as A — fixes the Windows symptom but
keeps us in the cross-platform browser-launch business. Also less
robust to bizarre URL inputs than PowerShell `Start-Process`.

### C. Status quo with workaround in `markdown_preview_file`

Quote-escape `&` for cmd.exe in `markdown_preview_file` only, leave
everything else alone.

Rejected. The bug is in the platform shim, not in any individual
caller; moving the workaround out of the shim leaks Windows quoting
concerns into every call site that builds a URL with `&`. The false
failure-detection bug also wouldn't be addressed.

## Related

- ADR-0001: Minimize Blast Radius for AI Agent Access — establishes
  the small-dependency posture this ADR weighs against.
- ADR-0003: Browser-Only Authentication — `openBrowser` is critical
  to the login UX.
- ADR-0008: Browser Flow Pattern — defines the single-platform-shim
  architecture that this ADR preserves; only what's _inside_ the
  shim changes.
