# `config.json` JSON Schemas

Stable, public JSON Schemas for the on-disk `config.json` file written
by [`graphdo-ts`](https://github.com/co-native-ab/graphdo-ts). One file
per schema version; new versions are added (never edited in place) so
that older releases keep validating.

> [!IMPORTANT]
> **These files are generated.** The single source of truth lives in
> the Zod schemas (`ConfigFileSchemaV1`, `ConfigFileSchemaV2`, …) in
> [`src/config.ts`](../src/config.ts). The generator
> ([`scripts/generate-schemas.ts`](../scripts/generate-schemas.ts))
> walks `SCHEMAS` and emits one `config-vN.json` per registered version
> via `z.toJSONSchema()`. **Do not hand-edit these files** — `npm run
> check` (and CI) will fail if they drift from the Zod source.
>
> - Regenerate: `npm run schemas:generate` (also runs as part of `npm run build`)
> - Verify no drift: `npm run schemas:check`

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
upgrade. Breaking shape changes get a new version (`config-v3.json`)
and a new `config_version` literal — never an in-place edit of an
existing version file.

## Available versions

| Version | URL                                                                                     | Status     | Written by                                                |
| ------- | --------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------- |
| v1      | `https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v1.json` | Legacy     | Pre-versioning builds; auto-migrated to v2 on next launch |
| v2      | `https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v2.json` | **Active** | All current builds                                        |

## Adding a new version (vN+1)

1. **Define the new Zod schema** in
   [`src/config.ts`](../src/config.ts): `ConfigFileSchemaVN+1` with
   field-level `.describe()` and a top-level
   `.meta({ $id: configSchemaUrl(N+1), title, description })`.
2. **Register it** in `SCHEMAS` and bump `CURRENT_CONFIG_VERSION`.
3. **Add a migration** in `MIGRATIONS` from vN to vN+1.
4. **Run `npm run schemas:generate`** — the new
   `schemas/config-vN+1.json` is written automatically.
5. **Add a frozen-history snapshot** at
   `test/fixtures/schemas-frozen/config-vN+1.json` (copy of the freshly
   generated file). The snapshot test refuses to run without it.
6. **Add a row** to the table above. Do **not** delete or edit the
   older `config-vN.json` files — they are an immutable contract for
   anyone who downloaded one of them via the raw URL.

The breaking-change guard is enforced by the
`test/schemas-generated.test.ts` snapshot test: any change to a
published version's Zod schema causes the corresponding
`test/fixtures/schemas-frozen/config-vN.json` to drift, which fails the
test with a message directing the developer to add a new version
instead.
