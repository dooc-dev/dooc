`dooc.yaml` lists the pages, record types, and display settings. Every path in it is relative to its own folder. A named manifest, `<name>.dooc.yaml`, works the same way. Unknown keys are errors.

## Keys

| Key                           | Value                                                      |
| ----------------------------- | ---------------------------------------------------------- |
| `system.default_lang`         | Language tag of the source pages; `en` when omitted        |
| `system.languages`            | Offered languages; must include the default                |
| `system.themes`               | Offered themes: `light`, `dark`                            |
| `system.licence`              | Local licence file, included in source exports             |
| `system.files.default_layout` | Layout option of the file card                             |
| `left_sidebar.title`          | Site title per language; must include the default language |
| `left_sidebar.icon`           | `light` and `dark` SVG files                               |
| `center_contents`             | Page tree; a list of entries                               |
| `json_subformats`             | Record types                                               |
| `default_subformat_folder`    | Folder scanned for records and used by **Create**          |

## Page tree entries

| Entry        | Keys                                                |
| ------------ | --------------------------------------------------- |
| Page         | `file` (a `.md` path), `title`, `icon`, `children`  |
| Record board | `subformat` (an `ext`), `title`, `icon`, `children` |
| Library page | `library` (a view), `title`, `icon`, `children`     |

`title` is the page name in the tree and at the top of the page; a page without one shows its file name. `icon` is a local SVG file shown beside the entry in the tree. It is drawn as an image, so give it fixed colours that read on both themes; `currentColor` does not follow the theme. A board without an `icon` uses the icon of its record type.

A Library page lists one kind of content from the whole workspace. Its view is a block label (`callouth`, `graphth`, `schemath`, `termth`, `mermaid`, `csv`, `tsv`), `urls`, or `url-previews`.

## Record type entries

| Key                  | Value                           |
| -------------------- | ------------------------------- |
| `ext`                | File extension without the dot  |
| `format`             | `yaml`, `json`, or `toml`       |
| `schema`             | Local JSON Schema path          |
| `icon`               | Local SVG file for the type     |
| `layouts.card_title` | Field shown as the card heading |
| `layouts.group_by`   | Enum field used for columns     |
| `layouts.sort_by`    | Field used for ordering         |
| `layouts.sort_order` | `asc` or `desc`                 |

## This workspace

![](dooc.yaml)

The editor rewrites this file when pages are added, moved, or renamed, so hand edits and tree edits are interchangeable.

## Files beside it

| Path                             | Purpose                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `themes/<theme>/…`               | [Theme variants](contents/md/variants.md)                                    |
| `locales/<lang>/…`               | [Translations](contents/md/variants.md)                                      |
| `.dooc/fonts/`                   | Project fonts, managed with `dooc font`                                      |
| `.dooc/plugins/`                 | Installed [plugin](contents/md/plugins.md) ZIPs                              |
| `.dooc/snapshots/`               | [History](contents/md/editor.md#history) when the workspace is not under Git |
| `.dooc/code-languages/`          | Extra TextMate grammars for code highlighting                                |
| `.dooc/editor-tools/<lang>.json` | Formatter and linter commands for code fences                                |
| `docs.config.mjs`                | Language adapters for term matching and prose linting                        |

Folder names such as `contents/md/` are a convention. Only the paths written in `dooc.yaml`, links, and embeds matter.

An editor tool configuration, for example `.dooc/editor-tools/typescript.json`:

```json
{
  "formatter": ["pnpm", "exec", "prettier", "--stdin-filepath", "example.ts"],
  "linter": ["node", ".dooc/editor-tools/check-typescript.mjs"]
}
```
