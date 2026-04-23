# `config.json` JSON Schemas

Stable, public JSON Schemas for the on-disk `config.json` file written by
[`graphdo-ts`](https://github.com/co-native-ab/graphdo-ts). One file per
schema version; new versions are added (never edited in place) so that
older releases keep validating.

## How to reference

Every `config.json` written by graphdo-ts ≥ the release that introduced
versioned configs embeds a `$schema` field pointing at the
version-pinned URL on `main`:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v2.json",
  "config_version": 2,
  "todo": { "list_id": "…", "list_name": "…" },
  "markdown": {
    "root_folder_id": "…",
    "root_folder_name": "…",
    "root_folder_path": "…",
  },
}
```

Editors that understand JSON Schema (VS Code, JetBrains IDEs, neovim
with `coc-json`, …) pick this up automatically and offer completion +
validation when the user hand-edits the file.

The URL is intentionally pinned to **`main`** rather than to a release
tag: bug-fix updates to the schema (tightened `pattern`s, added
`description`s) should reach existing users without a graphdo-ts
upgrade. Breaking shape changes get a new version (`config-v3.json`) and
a new `config_version` literal — never an in-place edit of an existing
version file.

## Available versions

| Version | URL                                                                                     | Status     | Written by                                                |
| ------- | --------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------- |
| v1      | `https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v1.json` | Legacy     | Pre-versioning builds; auto-migrated to v2 on next launch |
| v2      | `https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v2.json` | **Active** | All current builds                                        |

## Adding a new version

1. Copy the latest `config-vN.json` to `config-vN+1.json` and edit the
   new file (keys, `$id`, `title`, `const` for `config_version`).
2. Bump `CURRENT_CONFIG_VERSION` and add `ConfigFileSchemaVN+1` +
   migration in `src/config.ts` (see ADR-0009).
3. Update `CONFIG_SCHEMA_URL` so newly-saved files point at the new
   schema.
4. Add a row to the table above. Do **not** delete or edit the older
   `config-vN.json` files.
