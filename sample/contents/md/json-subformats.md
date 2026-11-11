---
title: "JSON subformats"
---

One file is one record. A JSON Schema defines the record's fields. Each extension has exactly one storage format, selected in `dooc.yaml`.

## Try the cards

1. Open **Subformats** in the bottom-left workspace tools.
2. Select **issue** from the dropdown. Subformats appear in configuration order.
3. Group by **Status** or **Priority**. Drag a card anywhere in another column, including the space below its cards: a card preview follows the pointer and the destination is highlighted in gray. Expand a card with its arrow to move it using the selection field.
4. Sort by **Due date**, **Points**, **Title**, or an enum field. Enum values use schema order; dates use chronological order. Toggle ascending or descending order.
5. Click a card to edit its file directly in the right-hand editor. In view mode, clicking opens a detail dialog instead. Focus the card title and press Enter or Space to do the same with the keyboard.
6. Use the arrow to expand or collapse details on the board; this choice stays when filtering, sorting, or switching subformats.

Choose the field displayed as the card heading with **card title**. Selecting an option changes only the current view. In edit mode, click its **✓** to save the default in `dooc.yaml`. The **group by**, **sort by**, and **sort order** menus work the same way; defaults are stored in `layouts.card_title`, `layouts.group_by`, `layouts.sort_by`, and `layouts.sort_order` (`asc` or `desc`). Reloading and built HTML start with those defaults. Without a configured title field, or when its value is missing or null, the heading uses the file name. Fields named `title` or `name` have no automatic priority. Use **Ctrl+F** to search.

Use **Create** at the top right to enter a file name and record content. Saving opens the new file in the right-hand editor. New files have green borders and modified files have orange borders, based on Git status. Counts use the same colors. The filename, collapse control, and reference dropdown sit on each card's top-right border. Open the reference dropdown to see the referring files and lines, including repeated references from the same file.

Moves are validated against the schema and saved in the original file format. YAML and TOML comments are preserved. A concurrent file change prevents overwriting it. Failed moves show a temporary error toast without shifting the board.

Invalid source edits stay unsaved in the editor. Correcting a validation error resumes auto-save; other save failures can be retried with **Retry**.

## Declare the formats

Choose **Add subformat…** in the leftmost dropdown to open the right-hand editor. Enter the extension, storage format and optional path in the sidebar header. The path shows `ext.schema.json` as you type the extension; leaving it empty saves to that filename at the project root. Enter a different path to override it. Adding registers the definition and opens its schema file for further editing. Existing schema files are never overwritten by this action. Added definitions or schema files appear green; changed definitions or schema files appear orange.

Schemas use JSON Schema **2020-12**, validated with **AJV 8.20.0** and `strict: true`. Other declared schema versions, unknown keywords or formats, and inconsistent constraints are rejected before saving. An omitted `$schema` still uses 2020-12. JSON completion suggests schema keywords and types; JSON record files also suggest their schema's properties and enum values. **Validate and apply** or **Shift+Alt+F** formats JSON without a separate formatter configuration.

The right sidebar's mode icon switches between **JSON text** (braces) and **Build kit** (fields) with one click. New schemas open in **Build kit** with no fields. Add fields by name and type, toggle required fields, then use the icons on the right of each field to add **Constraints** (validation rules and choices) or **Semantic** (title, description, defaults, examples and annotations). Only selected or existing parameters appear below that field. Objects and array items keep separate, collapsible tree rows with connecting lines. Available types and constraint controls come from the bundled 2020-12 meta-schema.

Both modes edit the same schema and share undo history. Switching modes alone does not rewrite the file. Existing references, conditions and other advanced rules are preserved; edit those in **JSON text**. Schemas containing linked rules keep field names fixed in Build kit to avoid breaking references. Incomplete JSON stays in text mode until it can be read safely.

This sample's `dooc.yaml` registers `.issue` files as YAML. Other subformats may declare `json` or `toml`; each extension is read and saved only in its declared format.

```yaml
default_subformat_folder: contents/issue
json_subformats:
  - ext: issue
    format: yaml
    schema: contents/json/issue.schema.json
    layouts: { card_title: title }
```

Records are collected even when no document references them. `default_subformat_folder` is a project-relative folder used for new cards. Its subfolders are also scanned for configured subformat extensions, including matching files excluded by Git ignore rules. Other ignored files, hidden folders, and symbolic links stay excluded. Omitting the setting keeps the existing workspace-wide collection and creation location.

Schema paths are local to the project. Top-level `enum` properties provide columns. String properties with `format: date` or `format: date-time` provide chronological sorting. `readOnly` enum fields can be used for grouping, but cannot be changed from cards.

## More detailed examples

The dropdown also includes three formats with two records each:

| Subformat | Storage | Schema features |
| --- | --- | --- |
| release | JSON | Owners and artifacts through `$defs`/`$ref`, checksum patterns, risk objects, unique labels, dates and URLs |
| experiment | YAML | Weighted variants, multiple owners, a fixed two-number interval, and results required only when complete |
| deployment | TOML | Service arrays with resource tables, rollout and rollback settings, port limits, and approval required for production |

Each schema includes a valid example to populate **Create**. Expand cards to see nested values, or click them to edit their full source. JSON files offer property and enum completion. All examples use fictional teams and `example.org` links.

[Desktop release](contents/release/desktop-2.4.release) has multiple artifacts and a pending check. [Card density research](contents/experiment/card-density.experiment) is still running. [Production canary](contents/deployment/search-canary.deployment) contains two services and an automatic rollback policy.

The second record in each format is deliberately unreferenced here; it still appears in **Subformats** with a reference count of zero.

## Issue schema

![Issue schema](contents/json/issue.schema.json)

## YAML record

![YAML issue](contents/issue/board.issue)

## Code blocks

Use the registered extension as the fence language, including its leading dot. For example, `.issue` uses the YAML storage format configured above:

````markdown
```.issue
title: Example issue
status: Todo
due: 2026-11-20
```
````

The editor offers `/code-.issue` in its completion menu. Preview and editor highlighting use the declared storage format. **Create file** keeps the `.issue` extension and validates the record against its schema before saving. Inline code examples remain code blocks and are not added to the record board.

## Copy source references

Each card has a copy icon on its upper-right border. The copied reference uses the following order:

1. An explicit source directory URL supplied when building HTML.
2. The local GitHub `origin` remote and current commit: `https://github.com/owner/repo/blob/<commit>/<path>`.
3. A local reference such as `repo/folder/file.issue`. Nested document roots retain their path inside the repository; linked worktrees use the original repository name. Outside Git, the project folder name is used.

GitHub discovery reads local Git metadata without contacting GitHub. A commit link resolves when that commit and file exist on the remote. File path segments are URL-encoded; local references retain their original characters.

Inject a source directory for deployed pages:

```sh
dooc build html ./dooc.yaml ./dist --source-url https://example.com/source/
```

The base corresponds to the directory containing `dooc.yaml`: `records/task.issue` becomes `https://example.com/source/records/task.issue`. For a project in a repository subdirectory, include that subdirectory in an explicit GitHub base, for example `https://github.com/owner/repo/blob/main/docs/`. Place the source files at the configured URL with the same relative paths.

`--source-url` accepts an absolute HTTP(S) directory URL without credentials, query or fragment. A trailing slash is added automatically. It applies to static and live HTML builds. The build API exposes `sourceUrl`, and the MCP build tool exposes `source_url`. The resolved base is embedded in the artifact using the original workspace, so copying continues to work after deployment without access to the build machine or local Git metadata. Source ZIPs do not use this HTML option.
