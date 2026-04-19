# Cross-host browser smoke checklist

This document defines the **manual** smoke-test procedure for the
loopback-backed browser flows in `graphdo-ts` (`login`, `logout`, and
`todo_select_list`). It is referenced from `collab-v1.md` §9 (W0
Days 4–5 buffer and W5 Day 5) and from `collab-v1-progress.md`.

The automated tests in `test/picker.test.ts`, `test/loopback.test.ts`,
and `test/loopback-security.test.ts` exercise the §5.4 hardening
(CSRF, Host pin, Origin pin, Sec-Fetch-Site pin, Content-Type pin,
hardened CSP) against a synthetic `node:http` client. They prove
the server **rejects** forged requests. They cannot prove that a
real browser, on a real desktop, against a real MCP host, still
**accepts** the legitimate requests.

That gap is closed manually with this checklist. Run it:

- At the end of W0 (Days 4–5 buffer) — gate for entering W1.
- At the end of W5 (Day 5) — gate for the v1 release.
- After any change to `src/picker.ts`, `src/loopback.ts`,
  `src/loopback-security.ts`, `src/templates/login.ts`,
  `src/templates/picker.ts`, `src/templates/logout.ts`, or
  `src/tools/collab-forms.ts`.

## Hosts under test

| Host                                  | Notes                                            |
| ------------------------------------- | ------------------------------------------------ |
| **Claude Desktop** (macOS + Windows)  | Reference target; ships the `.mcpb` bundle path. |
| **VS Code Copilot** (macOS + Windows) | Uses the standalone `.js` path via `mcp.json`.   |

If only one OS is available on a given run, record which one was
exercised in the PR description and note the deferred OS as a
follow-up smoke item.

## Browsers under test

The MCP server delegates browser launching to the OS default
(`open` on macOS, `start` on Windows, `xdg-open` on Linux). Run the
smoke against whichever browser is the OS default; if time
permits, also run against a non-default browser by temporarily
changing the OS setting.

## Pre-flight

1. Build the bundle: `npm run build` (for VS Code) and the MCPB
   bundle as documented in `README.md` (for Claude Desktop).
2. Confirm no stale `graphdo-ts` process is bound to a loopback
   port (`lsof -iTCP -sTCP:LISTEN | grep -i node` on macOS/Linux;
   Resource Monitor on Windows).
3. Confirm the test tenant + account is the one expected.

## Smoke matrix

For **each** (host, OS) cell, run the steps below in order. Mark
each step ✅ / ❌ and capture screenshots for any ❌ result.

### S1. Login — happy path

1. Trigger the `login` tool from the host UI.
2. **Expect:** the OS default browser opens to the branded
   `http://127.0.0.1:<port>/` landing page (per `src/loopback.ts`
   - `src/templates/login.ts`).
3. **Expect:** the page renders without browser-console CSP
   violations. Open DevTools → Console; there should be **zero**
   CSP `Refused to ...` messages and zero `Refused to apply
inline ...` warnings (the per-request nonce on `<script>` and
   `<style>` should satisfy CSP).
4. Click **Sign in with Microsoft**. Complete the Microsoft auth
   flow.
5. **Expect:** redirect back to `http://127.0.0.1:<port>/done`
   showing the success page with the auto-close countdown.
6. **Expect:** the host UI receives a successful `login` tool
   response naming the signed-in account.

### S2. Login — cancel

1. Trigger `login` again (after `logout`, or on a fresh session).
2. On the landing page, click **Cancel**.
3. **Expect:** the success/cancel HTML renders; the host UI
   receives a `UserCancelledError` (or equivalent surfaced text)
   from the `login` tool.

### S3. Login — DNS-rebinding sanity (negative test)

This step does **not** require a real attacker — it just confirms
the Host-pin is wired live.

1. Trigger `login` and capture the `http://127.0.0.1:<port>/`
   URL from the browser address bar (DevTools → Network → take
   any request).
2. In a terminal, send a forged `POST /cancel` with a non-loopback
   `Host` header (substitute the captured port):

   ```
   curl -i -X POST \
     -H 'Host: evil.example' \
     -H 'Content-Type: application/json' \
     -H 'Origin: http://127.0.0.1:<port>' \
     --data '{"csrfToken":"deadbeef"}' \
     http://127.0.0.1:<port>/cancel
   ```

3. **Expect:** HTTP 403 (or 4xx) and the in-browser flow is
   **not** cancelled. Click the legitimate **Sign in** button and
   confirm S1 still completes.

### S4. `todo_select_list` — happy path

1. Trigger the `todo_select_list` tool from the host UI.
2. **Expect:** the browser opens the branded picker page (per
   `src/picker.ts` + `src/templates/picker.ts`) listing the
   account's todo lists.
3. **Expect:** zero CSP console errors.
4. Use the filter input; pick a list; click its button.
5. **Expect:** the success page renders; the tool response
   confirms the persisted selection; `config.json` in the
   configured `GRAPHDO_CONFIG_DIR` is updated atomically.

### S5. `todo_select_list` — cancel

1. Trigger `todo_select_list` again.
2. Click **Cancel** on the picker page.
3. **Expect:** `UserCancelledError` surfaced; no change to
   `config.json`.

### S6. Form-busy lock (cross-tool)

1. Trigger `login` and leave the landing page open without
   clicking anything.
2. From the host UI, immediately trigger `todo_select_list`.
3. **Expect:** the second tool returns `FormBusyError` with the
   in-flight `login` URL embedded in the error text (per
   `src/tools/collab-forms.ts`). No second browser tab opens.
4. Complete the `login` flow.
5. Re-trigger `todo_select_list`.
6. **Expect:** picker opens normally; lock has been released.

### S7. Logout

1. Trigger `logout`.
2. **Expect:** the branded confirmation page renders in the
   browser; the tool response confirms cached tokens were
   cleared.
3. Trigger `login` again to confirm a fresh interactive sign-in
   is required.

### S8. Headless / no-browser fallback

If the host runs in an environment where the OS default browser
cannot be launched (e.g. a headless dev container), repeat **S1**
and **S4** and confirm the tool response includes the loopback
URL as text so the human can paste it into a browser manually.
This is the documented fallback path in `src/tools/login.ts` and
`src/tools/config.ts`.

## Reporting

For each smoke run, append a short note to the PR description (or
to `collab-v1-progress.md` "In flight" sub-status) with:

- Date.
- Host + OS + browser combinations exercised.
- Any ❌ steps and the captured screenshot(s).
- Any new follow-up issues filed.

A clean run is **not** a long-form report — a one-line "Ran S1–S8
on Claude Desktop / macOS / Safari and VS Code Copilot / macOS /
Safari; all green" is sufficient.
