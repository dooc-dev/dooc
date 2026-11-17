Look up syntax and configuration here, then follow the linked guide for behavior and examples. [Commands](contents/md/cli.md) covers CLI flags and output; [dooc.yaml](contents/md/manifest.md) defines the document configuration; [App runtimes](contents/md/runtimes.md) covers application components and hosting.

## Writing

| Feature            | Syntax                                              | Page                                    |
| ------------------ | --------------------------------------------------- | --------------------------------------- |
| Page title         | `title` on the page entry in `dooc.yaml`            | [dooc.yaml](contents/md/manifest.md)    |
| Text               | headings, lists, tables, quotes, `**bold**`, `*em*` | [Markdown](contents/md/markdown.md)     |
| Page link          | `[text](contents/md/page.md#heading)`               | [Markdown](contents/md/markdown.md)     |
| Figure link        | `[text](contents/svg/file.svg)`                     | [Markdown](contents/md/markdown.md)     |
| Term link          | `[text](contents/termth/file.termth)`               | [Markdown](contents/md/markdown.md)     |
| Code fence         | ` ```typescript `                                   | [Markdown](contents/md/markdown.md)     |
| Callout            | ` ```callouth <caption> `                           | [Blocks](contents/md/blocks.md)         |
| Relationship graph | ` ```graphth <caption> `                            | [Blocks](contents/md/blocks.md)         |
| ER diagram         | ` ```schemath <caption> `                           | [Blocks](contents/md/blocks.md)         |
| Term definition    | ` ```termth `                                       | [Blocks](contents/md/blocks.md)         |
| Mermaid            | ` ```mermaid `                                      | [Blocks](contents/md/blocks.md)         |
| Inline table       | ` ```csv <caption> `, ` ```tsv <caption> `          | [Blocks](contents/md/blocks.md)         |
| Inline record      | ` ```.feature `                                       | [Subformats](contents/md/subformats.md) |

## Embedding

| Feature       | Syntax                                                             | Page                                     |
| ------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| Embed a file  | `![caption](path/from/dooc.yaml)`                                  | [File embeds](contents/md/embeds.md)     |
| Line range    | `![](file.js#L2-L5)`                                               | [File embeds](contents/md/embeds.md)     |
| Table         | `.csv`, `.tsv`; `#H` treats row one as header                      | [File embeds](contents/md/embeds.md)     |
| Source code   | `.ts`, `.py`, `.json`, `.yaml`, `.txt`, …                          | [File embeds](contents/md/embeds.md)     |
| Block files   | `.md`, `.callouth`, `.graphth`, `.schemath`, `.termth`, `.mermaid` | [Blocks](contents/md/blocks.md)          |
| Image         | `.svg`, `.png`, `.jpg`, `.webp`, `.gif`                            | [Media](contents/md/media.md)            |
| Video         | `.mp4`, `.webm`                                                    | [Media](contents/md/media.md)            |
| HTML fragment | `.html`                                                            | [Media](contents/md/media.md)            |
| PDF           | `.pdf`                                                             | [Media](contents/md/media.md)            |
| DXF drawing   | `.dxf`                                                             | [Media](contents/md/media.md)            |
| Record card   | `![](contents/feature/file.feature)`                                   | [Linked records](contents/md/records.md) |
| Plugin card   | `![](https://service/item)` with a plugin                          | [Plugins](contents/md/plugins.md)        |

## Variants

| Feature       | Where                                | Page                                 |
| ------------- | ------------------------------------ | ------------------------------------ |
| Theme variant | `themes/<theme>/<same path>`         | [Variants](contents/md/variants.md)  |
| Translation   | `locales/<ISO 639-3>/<same path>.md` | [Variants](contents/md/variants.md)  |
| Site icon     | `document.sidebar.icon.light` / `.dark`  | [dooc.yaml](contents/md/manifest.md) |
| Page icon     | `icon` on a `document` entry  | [dooc.yaml](contents/md/manifest.md) |

## Records

| Feature                     | Where                                                        | Page                                     |
| --------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Record type                 | `json_subformats` entry: `ext`, `format`, `schema`, `icon`   | [Subformats](contents/md/subformats.md)  |
| Board defaults              | `layouts`: `card_title`, `group_by`, `sort_by`, `sort_order` | [Subformats](contents/md/subformats.md)  |
| Board page                  | `document` entry: `subformat`, `title`                | [Subformats](contents/md/subformats.md)  |
| Columns                     | top-level `enum` property                                    | [Subformats](contents/md/subformats.md)  |
| Date sorting                | `format: date` or `date-time`                                | [Subformats](contents/md/subformats.md)  |
| Create template             | first entry of schema `examples`                             | [Subformats](contents/md/subformats.md)  |
| Cross-schema `$ref`         | `other.schema.json#/$defs/ref`                               | [Linked records](contents/md/records.md) |
| Shared definitions file     | a schema with only `$defs`                                   | [Linked records](contents/md/records.md)   |
| Enum behind `$ref`          | still usable for columns                                     | [Linked records](contents/md/records.md)   |
| One of several record types | `anyOf` of two `$ref`                                        | [Linked records](contents/md/records.md)   |
| Pipeline input              | `json_subformats` read by a script                           | [CI/CD](contents/md/ci.md)               |

## Project and tools

| Feature           | Where                                                | Page                                 |
| ----------------- | ---------------------------------------------------- | ------------------------------------ |
| Page tree         | `document.children`                                    | [dooc.yaml](contents/md/manifest.md) |
| Languages, themes | `system`                                             | [dooc.yaml](contents/md/manifest.md) |
| Project folder    | `.dooc/fonts`, `.dooc/plugins`, `.dooc/editor-tools` | [dooc.yaml](contents/md/manifest.md) |
| Edit and view     | `dooc editor run node --client --server`, `dooc reader run node --client --server`                             | [Commands](contents/md/cli.md)       |
| Edit together     | `dooc editor run node --client --server --shared <branch>`                        | [Editor](contents/md/editor.md)      |
| Validate          | `dooc check`                                         | [Commands](contents/md/cli.md)       |
| Share             | `dooc build`, `dooc zip`                             | [Commands](contents/md/cli.md)       |
| Agents            | `dooc editor/reader run node --mcp`                   | [Commands](contents/md/cli.md)       |
