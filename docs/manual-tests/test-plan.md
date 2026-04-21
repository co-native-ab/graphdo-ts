# graphdo-ts manual test plan

A human-in-the-loop acceptance script for graphdo-ts. An AI coding agent
(GitHub Copilot CLI, Claude Code, or any compatible MCP-aware agent)
walks a human tester through every feature, asks short verification
questions, and persists the answers to a per-run markdown file under
[`runs/`](./runs/).

> **Single entry-point prompt to give the agent**
>
> > Run the graphdo-ts manual test plan in `docs/manual-tests/test-plan.md`.
> > Walk me through every section, ask me each verification question, and
> > write the results into a new file under `docs/manual-tests/runs/`.

The plan is **stable** — it changes only when graphdo-ts behaviour
changes. The runs directory grows over time and lets us compare regressions
and visual changes across releases.

---

## 0. Audience and prerequisites

### Audience

- **The human tester** has the graphdo-ts MCP server installed (either via
  `npx @co-native-ab/graphdo-ts` or the MCPB bundle) and connected to
  their AI agent of choice.
- **The AI agent** has the graphdo-ts tools available and the ability to
  ask the human follow-up questions (e.g. `ask_user`, an inline prompt,
  or "type your answer in chat").

### Prerequisites

| Requirement                                  | Why                                          |
| -------------------------------------------- | -------------------------------------------- |
| Microsoft 365 / personal account             | Login + `User.Read`                          |
| Mailbox with `Mail.Send`                     | Section 7                                    |
| Microsoft To Do enabled                      | Sections 4–6                                 |
| OneDrive with a writable folder              | Sections 8–9                                 |
| Modern browser available                     | All loopback pages (login, picker, logout)   |
| Optional: ability to flip OS dark/light mode | Visual checks                                |
| Optional: a second account inbox to send to  | Section 7 if you don't want to mail yourself |

### Recommended hygiene

- Run from a fresh config directory so a previous session's todo list /
  markdown root choice doesn't bias the picker:

  ```sh
  export GRAPHDO_CONFIG_DIR="$(mktemp -d)"
  echo "Using $GRAPHDO_CONFIG_DIR"
  ```

  Restore the original directory at the end of the run (Section 14).

- Close any existing browser tabs pointing at `127.0.0.1:<random-port>`
  from prior graphdo runs.

---

## 1. Agent operating instructions

The AI agent **MUST** follow these rules verbatim when running this plan:

1. **Create the run-log file first.** Pick today's UTC date and the
   tester's short name (e.g. `simon`):

   ```sh
   git rev-parse HEAD                       # capture commit SHA
   date -u +"%Y-%m-%d"                      # capture date
   ```

   Create `docs/manual-tests/runs/YYYY-MM-DD-<tester>.md` from the
   [run-log template](#run-log-template) below. Fill in the header
   immediately. Do not commit yet.

2. **Run sections strictly in order.** No skipping. If a prerequisite
   fails (e.g. no internet), record `SKIP` with the reason and continue
   to the next section.

3. **Announce each step before doing it.** Paste the step ID, title,
   and the tool call you're about to make into the chat so the human
   can follow along, e.g.:

   > **Step 4.2** — calling `todo_select_list`. A browser window should
   > open with a list of your To Do lists.

4. **Ask each verification question.** Use the agent's normal Q&A
   mechanism (`ask_user`, terminal prompt, etc.). Accept exactly:
   `Y` (pass) · `N` (fail) · `SKIP` (skip with reason) · or a freeform
   note. Use the **exact wording** from the plan; do not paraphrase.

5. **Record results immediately.** After every question, append the
   answer (and any freeform note) to the run-log file before moving to
   the next step. A crash mid-run must not lose results.

6. **Failures don't abort.** On `N` ask **one** short follow-up to
   capture the symptom (e.g. "What did you see instead?"), record it,
   then continue. The summary table makes it easy to spot patterns.

7. **Cleanup at the end.** Run Section 14 even if earlier sections
   failed.

8. **Hand the run log back to the human** for review and committing —
   do not auto-commit.

---

## 2. Conventions used in this plan

- `>` blocks are things the agent should **say** to the human.
- `▶` blocks are **agent actions** (tool calls, shell commands).
- `❓` blocks are **verification questions** to ask the human.
- `✔` blocks describe the **expected outcome**.
- `🧹` blocks are cleanup steps after a section.

Every verification question is numbered `<section>.<n>` so it lines up
with the run log.

---

## Section 0 — Preflight

✔ The tester is on a fresh config dir, no graphdo browser windows are
already open, and they know which Microsoft account they'll sign in with.

▶ Agent runs:

```sh
echo "Config dir: ${GRAPHDO_CONFIG_DIR:-<default>}"
node --version
```

▶ Agent calls `auth_status`.

✔ Expected: `Status: Logged out` (or "Not logged in"). Todo list and
markdown root unset.

❓ **0.1** Is `auth_status` reporting **Logged out** with no todo list and
no markdown root configured? `[Y/N]`

❓ **0.2** Are you running on a fresh config dir (or one you're happy to
overwrite)? `[Y/N]`

If 0.1 is `N` because the tester is still logged in from a previous
session, agent calls `logout` once, then re-runs `auth_status` before
re-asking 0.1.

---

## Section 1 — Login (happy path + branded landing + success page)

▶ Agent calls `login`.

> A browser tab should open to a graphdo-branded **landing page** (not
> directly to Microsoft). The landing page has a "Sign in with Microsoft"
> button and a Cancel button.

❓ **1.1** Did the branded landing page open in your browser? `[Y/N]`

❓ **1.2** Does the landing page show the **graphdo logo** at the top
and the **"Sign in with Microsoft"** primary button? `[Y/N]`

❓ **1.3** Is **only** the landing card visible — no success message
("Authentication successful"), no error block, no "manual close"
fallback text rendered alongside it? `[Y/N]`
_(This guards the CSP-safe `hidden` primitive — see the regression fixed
in commit `fix(templates): use the HTML hidden attribute …`.)_

❓ **1.4** Toggle your OS to **dark mode**, refresh the page. Does the
logo swap to its dark-mode variant and the colours adapt? `[Y/N/SKIP]`
_(Skip if you can't easily flip OS theme.)_

> Click **Sign in with Microsoft**, complete the Microsoft login flow.

✔ After auth, the browser shows the branded **success page** with a
"Authentication successful" heading, a teal checkmark, and a 5-second
countdown.

❓ **1.5** Did the success page show with a checkmark and a countdown
that reached 0? `[Y/N]`

❓ **1.6** After the countdown reached 0 (and only after), did the
"If this window didn't close automatically…" fallback text appear?
`[Y/N]`

▶ Agent calls `auth_status`.

✔ Expected: `Status: Logged in`, the user's email shown, scopes include
`Mail.Send`, `Tasks.ReadWrite`, `User.Read`, and `Files.ReadWrite`.

❓ **1.7** Does `auth_status` now report you as **Logged in** with the
expected scopes? `[Y/N]`

▶ Agent calls `login` a second time.

✔ Expected: tool returns "Already logged in. Use the logout tool first
if you want to re-authenticate." (no browser opens).

❓ **1.8** Was the second `login` call idempotent (no new browser tab,
returned an "already logged in" message)? `[Y/N]`

---

## Section 2 — Login: cancel

▶ Agent calls `logout` to reset, then `login` again.

> When the branded landing page opens, click **Cancel** instead of
> "Sign in with Microsoft".

✔ Tool returns `Login cancelled.` Browser tab closes itself.

❓ **2.1** Did the agent receive `Login cancelled.`? `[Y/N]`
❓ **2.2** Did the cancel browser tab close itself within a few seconds?
`[Y/N]`

▶ Agent calls `auth_status`.

❓ **2.3** Is `auth_status` still reporting **Logged out**? `[Y/N]`

---

## Section 3 — Login: browser-fallback path

> We're going to simulate a headless / no-browser environment.

▶ Agent runs:

```sh
BROWSER=/bin/false graphdo-login   # or however your agent invokes the tool
```

(The exact mechanism depends on the agent. The goal is to make
`xdg-open` / `open` fail. On Windows, temporarily set `BROWSER=` to a
non-existent path. If the agent can't override env per-call, restart the
MCP server with `BROWSER=/bin/false`.)

✔ Expected: tool returns an error containing the auth URL so the user
can open it manually.

❓ **3.1** Did the tool fail gracefully and surface the **auth URL** in
its error message (instead of crashing or hanging)? `[Y/N/SKIP]`
_(Skip if you can't override the browser launcher in your agent.)_

🧹 Restore the normal `BROWSER` setting and complete a real login again
before continuing. End the section with `auth_status` showing logged in.

---

## Section 4 — `todo_select_list` (browser picker + visual regressions)

▶ Agent calls `todo_select_list`.

> A browser tab opens with a card titled "Select a todo list" and a
> filter input.

❓ **4.1** Did the picker page open with your To Do lists rendered as
clickable buttons? `[Y/N]`

❓ **4.2** On first paint, are **all of these** correctly hidden (you
should NOT see any of them on the page)? `[Y/N]`

- the "No matches." message
- the prev / next pagination bar (unless you genuinely have >10 lists)
- the "If this window didn't close automatically…" fallback
- any error block

_(This is the CSP-safe `[hidden]` regression check — the bug was that all
of these used to render visible until the user interacted.)_

❓ **4.3** Type a few characters into the filter. Does the visible button
list narrow to matches only? `[Y/N]`

❓ **4.4** Clear the filter to a non-matching string. Does the **"No
matches."** message now appear? `[Y/N]`

❓ **4.5** If you have more than 10 To Do lists, does the prev/next
pagination bar show up with a "Page 1 of N (M total)" counter?
`[Y/N/SKIP]`

❓ **4.6** Click the refresh (↻) button if present. Does the list reload
without a full page refresh? `[Y/N/SKIP]`

> Click one of the lists to select it (pick one you can write throwaway
> tasks to — e.g. a "Test" list).

✔ Picker closes itself, agent receives `Todo list configured: <name>
(<id>)`.

❓ **4.7** Did the picker close itself and the agent receive a
confirmation with the list name? `[Y/N]`

▶ Agent calls `auth_status`.

❓ **4.8** Does `auth_status` now show the selected todo list? `[Y/N]`

---

## Section 5 — Todo CRUD

▶ Agent calls `todo_list`.

❓ **5.1** Did `todo_list` return successfully (empty result is fine)?
`[Y/N]`

▶ Agent calls `todo_create` with: title `"graphdo manual test"`, body
`"smoke-test task — safe to delete"`, importance `high`, a due date 7
days from now. Capture the returned task id.

❓ **5.2** Was the task created and an id returned? `[Y/N]`

▶ Agent calls `todo_show` on the new task id.

❓ **5.3** Does `todo_show` print the title, body, importance `high`,
and the due date you set? `[Y/N]`

▶ Agent calls `todo_update` to change the importance to `normal` and
the body to `"updated body"`.

❓ **5.4** Did `todo_update` return success and `todo_show` confirm the
new importance and body (title unchanged)? `[Y/N]`

▶ Agent calls `todo_create` with a recurrence pattern `weekly`.

❓ **5.5** Was the recurring task created? `[Y/N]`

▶ Agent calls `todo_complete` on the first task id.

❓ **5.6** Did the task move to completed and `todo_show` reflect the
completed state? `[Y/N]`

▶ Agent calls `todo_delete` on both task ids.

❓ **5.7** Did `todo_delete` succeed and a follow-up `todo_show` return
a not-found error? `[Y/N]`

🧹 Cleanup: leave the test list empty. If anything was left behind,
delete it before moving on.

---

## Section 6 — Todo steps (checklist items)

▶ Agent calls `todo_create` with title `"steps test"`. Capture the id.
Then `todo_add_step` three times with display names "first", "second",
"third".

❓ **6.1** Did all three steps get added? Returned ids are non-empty?
`[Y/N]`

▶ Agent calls `todo_steps` on the task id.

❓ **6.2** Does `todo_steps` list all three in order? `[Y/N]`

▶ Agent calls `todo_update_step` to mark "second" as checked, and
rename "third" to "third (renamed)".

❓ **6.3** Does a follow-up `todo_steps` show "second" as checked and
"third (renamed)" as the new display name? `[Y/N]`

▶ Agent calls `todo_delete_step` on the "first" step.

❓ **6.4** Is "first" gone from `todo_steps`? `[Y/N]`

🧹 `todo_delete` the parent task.

---

## Section 7 — `mail_send`

> Pick a destination address. **Self is fine** — sending to your own
> mailbox is the simplest test.

▶ Agent calls `mail_send` with subject `"graphdo manual test"`, a body
mentioning today's date, and the destination address.

✔ Tool returns success. Microsoft Graph responds with HTTP 202.

❓ **7.1** Did `mail_send` return success without an error? `[Y/N]`

❓ **7.2** Open the destination inbox. Did the message arrive within 1
minute, with the correct subject and body? `[Y/N]`

🧹 Delete the test mail from the inbox.

---

## Section 8 — `markdown_select_root_folder`

▶ Agent calls `markdown_select_root_folder`.

> A browser tab opens with a picker listing OneDrive folders directly
> under your drive root.

❓ **8.1** Did the picker open and list folders? `[Y/N]`

❓ **8.2** Same regression check as 4.2 — on first paint, are **all of
these** correctly hidden (no visible "No matches.", no pagination bar
unless needed, no manual-close fallback, no error block)? `[Y/N]`

❓ **8.3** If a "Create folder" link is present, does it open OneDrive
in a new tab? `[Y/N/SKIP]`

> Pick a folder you can use for throwaway markdown files (e.g. one
> called `graphdo-test`).

✔ Agent receives `Markdown root folder configured: /<name> (<id>)`.

❓ **8.4** Did the picker close and the agent receive the confirmation?
`[Y/N]`

❓ **8.5** Does `auth_status` now show the markdown root folder? `[Y/N]`

---

## Section 9 — Markdown CRUD, version history, diff, preview

▶ Agent calls `markdown_create_file` with name `manual-test.md` and
content:

```md
# graphdo manual test

initial content — safe to delete
```

❓ **9.1** Was the file created and the response includes the new
file's id and webUrl? `[Y/N]`

▶ Agent calls `markdown_list_files`.

❓ **9.2** Does `manual-test.md` appear in the listing? `[Y/N]`

▶ Agent calls `markdown_get_file` with name `manual-test.md`.

❓ **9.3** Does the returned content match exactly what you created?
`[Y/N]`

▶ Agent calls `markdown_update_file` to change the body to:

```md
# graphdo manual test

second revision — still safe to delete
```

❓ **9.4** Did the update succeed (no etag/cTag conflict)? `[Y/N]`

▶ Agent immediately calls `markdown_update_file` **again** with another
revision (`third revision`). This exercises cTag concurrency on a fresh
content tag.

❓ **9.5** Did the second update also succeed (cTag was refreshed
correctly between calls)? `[Y/N]`

▶ Agent calls `markdown_list_file_versions` for the file.

❓ **9.6** Are there at least 2 versions listed (the API tracks edits)?
`[Y/N]`

▶ Agent calls `markdown_get_file_version` for the **earliest** version
id from 9.6.

❓ **9.7** Did the historical version return your **initial** content?
`[Y/N]`

▶ Agent calls `markdown_diff_file_versions` between the earliest and
the current version.

❓ **9.8** Does the diff clearly show the body changes between
"initial content" and "third revision"? `[Y/N]`

▶ Agent calls `markdown_preview_file` for `manual-test.md`.

❓ **9.9** Did your browser open with a rendered HTML preview of the
markdown? `[Y/N]`

❓ **9.10** Optionally simulate a no-browser environment and re-run
`markdown_preview_file`. Did the tool surface the preview URL as text
instead of crashing? `[Y/N/SKIP]`

▶ Agent calls `markdown_delete_file` for `manual-test.md`.

❓ **9.11** Did `markdown_delete_file` succeed and `markdown_list_files`
no longer show the file? `[Y/N]`

🧹 Optional: empty your OneDrive recycle bin if the test folder was
auto-restored from a prior run.

---

## Section 10 — Status / scopes

▶ Agent calls `auth_status`.

❓ **10.1** Does the output include all of: version, logged-in user,
granted scopes (`Files.ReadWrite`, `Mail.Send`, `Tasks.ReadWrite`,
`User.Read`), the **selected todo list name + id**, and the **markdown
root folder**? `[Y/N]`

❓ **10.2** Are there any extra scopes you didn't expect to be granted?
`[Y/freeform]`

---

## Section 11 — Logout (happy path + visual regression)

▶ Agent calls `logout`.

> A browser tab opens with the branded **logout confirmation** page,
> showing a "Sign out?" prompt and Sign Out / Cancel buttons.

❓ **11.1** Did the logout confirmation page open with the **Sign Out**
and **Cancel** buttons? `[Y/N]`

❓ **11.2** **CRITICAL** — Is the "Signed out successfully" success
view **NOT** visible on first paint? It must only appear after you click
Sign Out. `[Y/N]`
_(This is the bug fixed in commit `fix(templates): use the HTML hidden
attribute …`. The success view used to render below the buttons because
inline `style="display:none"` was blocked by the strict CSP.)_

❓ **11.3** Is the "If this window didn't close automatically…" fallback
also **NOT** visible on first paint? `[Y/N]`

> Click **Sign Out**.

✔ The success view replaces the confirm view with a teal checkmark,
"Signed out successfully" heading, "Your cached tokens have been
cleared" message, and a 5-second countdown.

❓ **11.4** Did the success view appear after clicking Sign Out, with
the checkmark and countdown? `[Y/N]`

❓ **11.5** After the countdown reached 0 (and only after), did the
manual-close fallback text appear? `[Y/N]`

❓ **11.6** Did the agent receive `Logged out successfully. Token cache
cleared.`? `[Y/N]`

▶ Agent calls `auth_status`.

❓ **11.7** Does `auth_status` now report **Logged out**? `[Y/N]`

---

## Section 12 — Logout: cancel

▶ Agent calls `login` and completes auth, then calls `logout`.

> When the confirmation page opens, click **Cancel**.

✔ Browser closes. The agent's `logout` call may either return a
"cancelled" message or a success — the **important** check is that the
token cache is preserved.

▶ Agent calls `auth_status`.

❓ **12.1** Are you still **Logged in** after cancelling the logout?
`[Y/N]`
_(If `auth_status` reports logged out, that's a regression — Cancel
must not clear tokens.)_

---

## Section 13 — Logout: browser-fallback

> We'll simulate a no-browser environment for the logout flow.

▶ Agent re-invokes the server (or the tool) with `BROWSER=/bin/false`,
then calls `logout`.

✔ Expected: tokens are cleared **silently** — no crash, no hang. The
tool returns a success message even though it couldn't show the
confirmation page.

❓ **13.1** Did `logout` succeed silently with no browser? `[Y/N/SKIP]`

▶ Agent calls `auth_status`.

❓ **13.2** Does `auth_status` now report **Logged out**? `[Y/N/SKIP]`

🧹 Restore the normal `BROWSER` setting.

---

## Section 14 — Cleanup

🧹 Run, in order:

1. Final `logout` if still logged in.
2. Verify no leftover test tasks in your To Do list (delete if any).
3. Verify no leftover test files in your OneDrive markdown folder
   (delete if any).
4. Restore your previous `GRAPHDO_CONFIG_DIR`:

   ```sh
   unset GRAPHDO_CONFIG_DIR     # or restore your saved value
   ```

5. Hand the run-log file back to the human for review.
6. Human commits the run log:

   ```sh
   git add docs/manual-tests/runs/YYYY-MM-DD-<tester>.md
   git commit -m "docs(manual-tests): run YYYY-MM-DD by <tester>"
   ```

❓ **14.1** Are all test artefacts (tasks, mail, markdown files) cleaned
up? `[Y/N]`

❓ **14.2** Is your environment back to its pre-test state (config dir,
browser env)? `[Y/N]`

---

## Visual checklist (eyeball once per run)

The agent asks the human these once at the end. They cover things that
are easy to spot in passing during the run.

| #   | Check                                                                                  | Y/N |
| --- | -------------------------------------------------------------------------------------- | --- |
| V.1 | Logo renders correctly on every loopback page (login landing, success, picker, logout) |     |
| V.2 | Dark-mode logo swap works on at least one page (if you tested dark mode)               |     |
| V.3 | Favicon is set to the graphdo glyph (visible in tab bar)                               |     |
| V.4 | Lexend font is loaded (no fallback "Times" / "Arial" look)                             |     |
| V.5 | No FOUC (flash of unstyled content) on any loopback page                               |     |
| V.6 | Browser console shows no CSP violations or 4xx/5xx network errors                      |     |
| V.7 | All countdowns reach 0 and either auto-close or show the manual-close fallback         |     |
| V.8 | No hidden-by-default element renders visible on first paint anywhere                   |     |

---

## Run-log template

The agent **copies this entire block verbatim** into the new run file
at the start of the run, then fills it in.

```md
# Manual test run — YYYY-MM-DD

- **Tester:** <name>
- **Operator agent:** <e.g. GitHub Copilot CLI 1.0.34, Claude Sonnet 4.6>
- **graphdo-ts commit:** <git rev-parse HEAD>
- **graphdo-ts version (package.json):** <x.y.z>
- **OS / browser:** <e.g. macOS 14.5, Chrome 124>
- **Started (UTC):** <ISO timestamp>
- **Finished (UTC):** <ISO timestamp>

## Summary

| Section                        | Result                   | Notes |
| ------------------------------ | ------------------------ | ----- |
| 0. Preflight                   | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 1. Login (happy + branded)     | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 2. Login: cancel               | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 3. Login: browser-fallback     | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 4. todo_select_list            | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 5. Todo CRUD                   | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 6. Todo steps                  | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 7. mail_send                   | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 8. markdown_select_root_folder | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 9. Markdown CRUD + history     | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 10. Status / scopes            | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 11. Logout (happy + visual)    | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 12. Logout: cancel             | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 13. Logout: browser-fallback   | ☐ Pass / ☐ Fail / ☐ Skip |       |
| 14. Cleanup                    | ☐ Pass / ☐ Fail / ☐ Skip |       |
| Visual checklist               | ☐ Pass / ☐ Fail / ☐ Skip |       |

## Step-by-step results

### 0. Preflight

- 0.1 …: ☐ Y ☐ N — _notes_
- 0.2 …: ☐ Y ☐ N — _notes_

### 1. Login flow

- 1.1 Branded landing page opened: ☐ Y ☐ N — _notes_
- 1.2 Logo + "Sign in with Microsoft" button: ☐ Y ☐ N — _notes_
- 1.3 Only landing card visible (no premature success / fallback): ☐ Y ☐ N — _notes_
- 1.4 Dark-mode swap: ☐ Y ☐ N ☐ SKIP — _notes_
- 1.5 Success page + countdown: ☐ Y ☐ N — _notes_
- 1.6 Manual-close appears only after countdown: ☐ Y ☐ N — _notes_
- 1.7 auth*status shows logged in with expected scopes: ☐ Y ☐ N — \_notes*
- 1.8 Second login is idempotent: ☐ Y ☐ N — _notes_

### 2. Login: cancel

- 2.1 …
- 2.2 …
- 2.3 …

### 3. Login: browser-fallback

- 3.1 …

### 4. todo_select_list

- 4.1 …
- 4.2 No hidden-by-default element rendered visible: ☐ Y ☐ N — _notes_
- 4.3 …
- 4.4 …
- 4.5 …
- 4.6 …
- 4.7 …
- 4.8 …

### 5. Todo CRUD

- 5.1 …
- 5.2 …
- 5.3 …
- 5.4 …
- 5.5 …
- 5.6 …
- 5.7 …

### 6. Todo steps

- 6.1 …
- 6.2 …
- 6.3 …
- 6.4 …

### 7. mail_send

- 7.1 …
- 7.2 …

### 8. markdown_select_root_folder

- 8.1 …
- 8.2 No hidden-by-default element rendered visible: ☐ Y ☐ N — _notes_
- 8.3 …
- 8.4 …
- 8.5 …

### 9. Markdown CRUD + version history

- 9.1 …
- 9.2 …
- 9.3 …
- 9.4 …
- 9.5 cTag concurrency on rapid second update: ☐ Y ☐ N — _notes_
- 9.6 …
- 9.7 …
- 9.8 …
- 9.9 …
- 9.10 …
- 9.11 …

### 10. Status / scopes

- 10.1 …
- 10.2 …

### 11. Logout (happy + visual regression)

- 11.1 Confirm page opened with Sign Out / Cancel: ☐ Y ☐ N — _notes_
- 11.2 Success view NOT visible on first paint: ☐ Y ☐ N — _notes_
- 11.3 Manual-close NOT visible on first paint: ☐ Y ☐ N — _notes_
- 11.4 Success view appears after clicking Sign Out: ☐ Y ☐ N — _notes_
- 11.5 Manual-close appears only after countdown: ☐ Y ☐ N — _notes_
- 11.6 Tool returned success message: ☐ Y ☐ N — _notes_
- 11.7 auth*status reports logged out: ☐ Y ☐ N — \_notes*

### 12. Logout: cancel

- 12.1 Tokens preserved after Cancel: ☐ Y ☐ N — _notes_

### 13. Logout: browser-fallback

- 13.1 …
- 13.2 …

### 14. Cleanup

- 14.1 …
- 14.2 …

## Visual checklist

- V.1 Logo renders on every loopback page: ☐ Y ☐ N
- V.2 Dark-mode swap works: ☐ Y ☐ N ☐ SKIP
- V.3 Favicon set: ☐ Y ☐ N
- V.4 Lexend font loaded: ☐ Y ☐ N
- V.5 No FOUC: ☐ Y ☐ N
- V.6 No CSP violations / network errors in console: ☐ Y ☐ N
- V.7 Countdowns reach 0 with proper fallback: ☐ Y ☐ N
- V.8 No hidden-by-default element renders visible on first paint: ☐ Y ☐ N

## Issues found

(One bullet per failure. Include screenshots / URLs / error messages as
needed. File issues in the tracker and link them here.)

- …

## Follow-ups

- …
```
