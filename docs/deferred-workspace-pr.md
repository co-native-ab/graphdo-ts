# Deferred follow-up: cross-drive workspace + Graph generalisation

> **Temporary scratchpad.** This file is a hand-off note for the _next_ coding
> session. **Delete `docs/deferred-workspace-pr.md` as part of the PR that
> lands the work below** — it must not survive into `main` once implemented.
> If you find this file on `main` and the items below are done, the deletion
> was missed; remove it.

## Why this exists

The previous PR ([versioned snake_case `config.json` with auto-migration])
intentionally stopped at the on-disk schema cutover so that one PR had one
shape: config schema + migrations + ADRs. The plan we were executing has
several later steps that all hang together but depend on data the picker
doesn't yet collect and on Graph-layer generalisation that would have made
that PR unfocused and risky to land in one shot.

This file enumerates exactly what was deferred so the next session can pick
it up without re-discovering the plan.

## Deferred items

Each item lists the rough surface area touched. Order is the suggested
implementation order — earlier items unblock later ones.

### 1. Cross-drive workspace data model (config v3)

- Replace `markdown: { rootFolderId, rootFolderName, rootFolderPath }` with a
  workspace shape that can address an item on **any** drive the user can
  reach (personal OneDrive, OneDrive for Business, a SharePoint document
  library, or a shared folder), not just the signed-in user's drive root.
- On disk (snake_case, nested — same convention as `todo` / `markdown`):
  ```jsonc
  "workspace": {
    "drive_id":   "…",   // Graph drive id (b!… or personal driveId)
    "item_id":    "…",   // Graph driveItem id of the workspace folder
    "drive_name": "…",   // human label for status / picker echo
    "item_name":  "…",   // folder display name
    "item_path":  "…"    // optional; for display only, never used to address
  }
  ```
- In memory (camelCase): `Config.workspace: { driveId, itemId, driveName, itemName, itemPath? }`.
- Add `ConfigFileSchemaV3` + a `MIGRATIONS` entry `v2 → v3` that maps the
  legacy `markdown.rootFolderId` to `workspace.itemId` on **the user's own
  drive** (look up `me/drive` once at migration time? — no: migrations are
  pure. Either record `drive_id: "me"` as a sentinel and resolve at first
  use, or have the next picker run overwrite the migrated value. Decide in
  the PR; sentinel is probably cleanest.)
- Bump `CURRENT_CONFIG_VERSION = 3`. Add fixtures under
  `test/fixtures/config/v3/`. Add a row to the round-trip matrix in
  `test/config-migrations.test.ts`.
- `loadAndValidateMarkdownConfig` becomes `loadAndValidateWorkspaceConfig`
  and returns `{ workspace: { driveId: ValidatedGraphId, itemId: ValidatedGraphId, … } }`.
- `hasMarkdownConfig` → `hasWorkspaceConfig`. `markdownRootFolderIdError`
  → `workspaceItemIdError` (same rules: opaque, no `/`, no whitespace).

### 2. Tool rename: `markdown_select_root_folder` → `markdown_select_workspace`

- The user-facing concept is "workspace", not "root folder". Rename the
  tool, the picker title/subtitle, and the `auth_status` label.
- Keep the file name `src/tools/markdown/select-root-folder.ts` for the
  rename commit, then move it to `select-workspace.ts` in the same PR so
  reviewers can see the diff cleanly.
- Update CHANGELOG with a Breaking entry for the tool rename (clients that
  pinned the old name need to update).

### 3. Graph layer: `DriveScope` + `driveItemPath` + `resolveShareLink`

- Introduce a small `DriveScope` discriminator in `src/graph/drives.ts`:
  ```ts
  type DriveScope =
    | { kind: "me" } // /me/drive
    | { kind: "drive"; driveId: ValidatedGraphId }; // /drives/{id}
  ```
- `driveItemPath(scope, itemId, suffix?)` builds the right `/me/drive/items/{id}…`
  or `/drives/{driveId}/items/{itemId}…` URL. All existing markdown
  operations (`listChildren`, `getItem`, `uploadContent`, `downloadContent`,
  …) move from hard-coded `/me/drive/…` to `driveItemPath(scope, …)`.
- `resolveShareLink(client, url, signal)` calls
  `POST /shares/{encoded-share-id}/driveItem` (or the `u!`-base64 form) and
  returns `{ driveId, itemId, name, webUrl }` — used by item-4 below to let
  a user paste a "Share" link from OneDrive / SharePoint into the picker
  and pick a workspace on a drive they don't normally browse.
- All Graph helpers continue to accept `signal: AbortSignal` as the
  required last parameter.

### 4. Picker navigation + URL paste

- The current picker is single-page (a flat list of options + Refresh +
  optional Create link). The workspace picker needs:
  - Drive switcher at the top (`me` + recent shared drives + a "Paste
    share link…" affordance).
  - Folder breadcrumbs + `..` to walk into subfolders within a chosen
    drive.
  - "Use this folder as workspace" button at each level.
- Keep the existing generic `startBrowserPicker()` for the simple flat
  case (todo list selection still uses it). Add a second
  `startBrowserNavigator()` for the navigable case rather than overloading
  the simple one — the templates and JS are different enough.
- Continue routing browser-opening through `ServerConfig.openBrowser` so
  tests can keep using a spy.

### 5. Scope widening to `Files.ReadWrite.All`

- Current scopes: `Mail.Send`, `Tasks.ReadWrite`, `User.Read`,
  `offline_access`, `Files.ReadWrite`.
- For SharePoint / shared drives we need `Files.ReadWrite.All` (and
  `Sites.Read.All` if we surface site-document-library browsing).
- Update the scope list in `src/auth.ts`, the README, and the
  CONTRIBUTING / docs that enumerate scopes.
- Note in the CHANGELOG that the next consent prompt will list the new
  scopes — existing users will be re-prompted on first run.

## Out of scope for the next PR (push to a later one)

- Multi-workspace support (a list of workspaces with one "active"). The
  v3 schema above is single-workspace deliberately so the migration stays
  small. A future v4 can wrap it in `workspaces: [...]` + `active_index`.
- Caching `me/drive` lookups across restarts.

## Definition of done for the next session

- [ ] Config v3 schema + migration + fixtures + round-trip test row.
- [ ] Tool renamed; `auth_status` label updated; CHANGELOG Breaking note.
- [ ] `DriveScope` plumbed through every markdown Graph helper; old
      hard-coded `/me/drive` paths gone.
- [ ] `resolveShareLink` implemented + unit-tested against the mock Graph
      server (add a `/shares/:id/driveItem` handler).
- [ ] Workspace picker with drive switcher + breadcrumbs + share-link
      paste; integration test via the `openBrowser` spy.
- [ ] Scopes updated; consent re-prompt note in README + CHANGELOG.
- [ ] **`docs/deferred-workspace-pr.md` deleted in the same PR** (this
      file). `npm run check` green.
