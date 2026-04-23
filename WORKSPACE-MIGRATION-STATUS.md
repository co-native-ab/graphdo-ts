# Workspace Migration Status

## Completed Work

### Phase 1 (Config v3) ✅
- `CURRENT_CONFIG_VERSION = 3` in `src/config.ts`
- `ConfigFileSchemaV3` with workspace shape (`drive_id`, `item_id`, `drive_name`, `item_name`, `item_path`)
- Migration v2→v3 implemented (maps `markdown.root_folder_id` to `workspace.item_id` with `drive_id: "me"` sentinel)
- `WorkspaceConfig` type and validators (`workspaceItemIdError`, `workspaceDriveIdError`, `hasWorkspaceConfig`)
- `loadAndValidateWorkspaceConfig` returns `driveId: "me" | ValidatedGraphId` + `itemId: ValidatedGraphId`
- v3 fixtures and schemas generated
- Tests updated for v3

### Phase 2 (Tool Rename) ✅
- Tool renamed: `markdown_select_root_folder` → `markdown_select_workspace`
- File moved: `src/tools/markdown/select-root-folder.ts` → `select-workspace.ts` (via git mv)
- `src/tools/markdown/index.ts` updated (export + MARKDOWN_TOOLS array)
- `src/tools/auth/auth-status.ts` updated to show workspace info instead of root folder
- `manifest.json` updated with new tool name and description

### Phase 3 (DriveScope + Graph Layer) ✅
- `DriveScope` type in `src/graph/drives.ts`: `{ kind: "me" } | { kind: "drive"; driveId: ValidatedGraphId }`
- `meDriveScope`, `driveMetadataPath`, `driveRootChildrenPath`, `driveItemPath` helpers
- `resolveShareLink(client, sharingUrl, signal)` implemented (encodes URL as `u!`+base64url, calls `/shares/{id}/driveItem`)
- All markdown Graph operations (`src/graph/markdown.ts`) now take `scope: DriveScope` as first parameter after `client`
- Mock Graph server (`test/mock-graph.ts`) routes `/drives/{driveId}/...` and `/shares/{id}/driveItem`
- All markdown tools updated to use `loadAndValidateWorkspaceConfig` and pass `DriveScope` to Graph calls
- Helper `resolveDriveItem` in `src/tools/markdown/helpers.ts` updated to accept `scope`

### Phase 4 (Navigator Flow) ✅
- `src/browser/flows/navigator.ts` created with `navigatorFlow` and `runNavigator`
- Features implemented:
  - Drive tabs (OneDrive + discovered shared drives)
  - Breadcrumbs with clickable navigation
  - Folder list (filters out files, shows folders only)
  - "Use this folder as workspace" button
  - "Paste share link" input + "Add shared drive" button
  - HTTP routes: `GET /`, `GET /children`, `POST /resolve-share`, `POST /select`, `POST /cancel`
  - CSRF protection, CSP nonces, 2-minute timeout
- `src/templates/navigator.ts` created with HTML/CSS/JS for the navigator UI
- `src/tools/markdown/select-workspace.ts` wired to use `runNavigator` instead of `runPicker`
- `onSelect` callback persists via `updateConfig({ workspace: { driveId, itemId, driveName, itemName, itemPath } })`

### Phase 5 (Scope Widening) ✅
- Added `GraphScope.FilesReadWriteAll = "Files.ReadWrite.All"` to `src/scopes.ts`
- Added `GraphScope.SitesReadAll = "Sites.Read.All"` to `src/scopes.ts`
- Updated `AVAILABLE_SCOPES` with metadata for both new scopes (marked as `required: false`)
- `markdown_select_workspace` tool's `requiredScopes` includes `[FilesReadWrite, FilesReadWriteAll]`
- All other markdown tools keep `[FilesReadWrite]` only

### Documentation Updates ✅
- `manifest.json`: tool renamed, descriptions updated to reference "workspace" not "root folder"
- `manifest.json`: `long_description` updated to mention SharePoint, shared drives, and new scopes

## Remaining Work

### Integration Tests (60+ typecheck errors remaining)
Most remaining errors are in integration tests that need to be updated:

1. **`test/integration/markdown/*.test.ts`** (~12 files)
   - Replace `markdown: { rootFolderId: ... }` with `workspace: { driveId: "me", itemId: ..., itemName: ... }`
   - Update assertions that check for "Markdown root folder" to check for "Markdown workspace"
   - Update tool name from `markdown_select_root_folder` to `markdown_select_workspace`

2. **`test/integration/auth/auth-status.test.ts`**
   - Update config fixture to use `workspace` instead of `markdown`
   - Update assertion for status output

3. **`test/integration/dynamic-tools.test.ts`**
   - Update tool name references

4. **Navigator Flow Tests**
   - Add `test/browser/navigator.test.ts` (unit tests for HTML rendering, navigation, share resolution, XSS escaping, timeout)
   - Add `test/integration/markdown/select-workspace.test.ts` (e2e test via openBrowser spy, mirror existing `select-root-folder.test.ts` pattern)
   - **Delete** `test/integration/markdown/select-root-folder.test.ts` (tool no longer exists)

5. **`test/integration/markdown/_helpers.ts`**
   - `seedDrive()` is fine, but update any display assertions

### README Updates
- Update "Markdown Files" section to talk about "workspace" instead of "root folder"
- Update tool table row (`markdown_select_root_folder` → `markdown_select_workspace`)
- Update Security paragraph (`workspace.itemId` instead of `markdown.rootFolderId`)
- Update scope table to include `Files.ReadWrite.All` and `Sites.Read.All`

### AGENTS.md Updates
- Update `config.json` description to mention `workspace` and `config_version: 3`

### CHANGELOG
- Add Breaking entry for tool rename (`markdown_select_root_folder` → `markdown_select_workspace`)
- Note that next consent prompt will list new scopes (existing users re-prompted on first run)

### Final Step
- Delete `docs/deferred-workspace-pr.md` per its own instructions (only after ALL above is done)
- Run `npm run check` (format:check + icons:check + schemas:check + lint + typecheck + test)
- Run `npx prettier --write .` to fix formatting
- Run `npm run schemas:generate` if any Zod schemas were changed

## Current Status

**Tool layer and Graph layer**: ✅ Complete  
**Config v3**: ✅ Complete  
**Navigator flow**: ✅ Complete (implementation done, tests pending)  
**Integration tests**: ⏳ ~60 errors remaining (mechanical updates needed)  
**Documentation**: ⏳ README, AGENTS.md, CHANGELOG pending  
**Final cleanup**: ⏳ Pending (delete deferred doc, run checks)

## How to Complete

1. Update all integration test files to use `workspace` config shape and new tool name
2. Add navigator flow tests (unit + integration)
3. Update README, AGENTS.md, CHANGELOG
4. Delete `docs/deferred-workspace-pr.md`
5. Run `npx prettier --write .` and `npm run check` until green
6. Commit and push

## Commands for Quick Testing

```bash
# Run only markdown graph tests (should be mostly green now)
npm run test -- test/graph/markdown.test.ts

# Check integration test errors
npm run typecheck 2>&1 | grep "test/integration"

# Fix formatting
npx prettier --write .

# Full check
npm run check
```
