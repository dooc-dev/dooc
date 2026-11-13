dooc turns a folder of Markdown, data files, and records into one browsable document. You write plain files, `dooc.yaml` arranges them, and dooc edits, checks, and ships the result.

| Step  | You do                                            | dooc gives you                                 |
| ----- | ------------------------------------------------- | ---------------------------------------------- |
| Write | Markdown pages, diagrams, tables, any source file | A live editor and a read-only viewer           |
| Model | Records with a JSON Schema                        | Boards, forms, and validation                  |
| Check | `dooc check`                                      | One JSON report for people and CI              |
| Ship  | `dooc build html`, `dooc build zip`               | A single offline HTML file, or a source bundle |

![From files to a shared document](contents/graphth/workflow.graphth)

## Start in a minute

```sh
curl -fsSL https://github.com/dooc-dev/dooc/releases/latest/download/install.sh | sh
mkdir my-docs && cd my-docs
dooc init
dooc edit
```

Other install methods and updates are in [Install](contents/md/install.md). Run `dooc self docs` to download this documentation from GitHub and open it locally.

## Where to look

| You want to                               | Read                                    |
| ----------------------------------------- | --------------------------------------- |
| Install, update, start a project          | [Install](contents/md/install.md)       |
| Learn the editor and its tools            | [Editor](contents/md/editor.md)         |
| Write pages                               | [Markdown](contents/md/markdown.md)     |
| Add callouts, graphs, diagrams, tables    | [Blocks](contents/md/blocks.md)         |
| Show code, data, images, video, PDF, DXF  | [File embeds](contents/md/embeds.md)    |
| Provide dark-theme files and translations | [Variants](contents/md/variants.md)     |
| Keep structured records on boards         | [Subformats](contents/md/subformats.md) |
| Drive a pipeline from records             | [CI/CD](contents/md/ci.md)              |
| See a whole design written as records     | [System design](contents/md/system.md)  |
| Show live data from other services        | [Plugins](contents/md/plugins.md)       |
| Look up a manifest key                    | [dooc.yaml](contents/md/manifest.md)    |
| Look up a command or option               | [Commands](contents/md/cli.md)          |

## Cheat sheet

### Writing

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
| Inline record      | ` ```.issue `                                       | [Subformats](contents/md/subformats.md) |

### Embedding

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
| Record card   | `![](contents/issue/file.issue)`                                   | [Linked records](contents/md/records.md) |
| Plugin card   | `![](https://service/item)` with a plugin                          | [Plugins](contents/md/plugins.md)        |

### Variants

| Feature       | Where                                | Page                                 |
| ------------- | ------------------------------------ | ------------------------------------ |
| Theme variant | `themes/<theme>/<same path>`         | [Variants](contents/md/variants.md)  |
| Translation   | `locales/<ISO 639-3>/<same path>.md` | [Variants](contents/md/variants.md)  |
| Site icon     | `left_sidebar.icon.light` / `.dark`  | [dooc.yaml](contents/md/manifest.md) |
| Page icon     | `icon` on a `center_contents` entry  | [dooc.yaml](contents/md/manifest.md) |

### Records

| Feature                     | Where                                                        | Page                                     |
| --------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Record type                 | `json_subformats` entry: `ext`, `format`, `schema`, `icon`   | [Subformats](contents/md/subformats.md)  |
| Board defaults              | `layouts`: `card_title`, `group_by`, `sort_by`, `sort_order` | [Subformats](contents/md/subformats.md)  |
| Board page                  | `center_contents` entry: `subformat`, `title`                | [Subformats](contents/md/subformats.md)  |
| Columns                     | top-level `enum` property                                    | [Subformats](contents/md/subformats.md)  |
| Date sorting                | `format: date` or `date-time`                                | [Subformats](contents/md/subformats.md)  |
| Create template             | first entry of schema `examples`                             | [Subformats](contents/md/subformats.md)  |
| Cross-schema `$ref`         | `other.schema.json#/$defs/ref`                               | [Linked records](contents/md/records.md) |
| Shared definitions file     | a schema with only `$defs`                                   | [System design](contents/md/system.md)   |
| Enum behind `$ref`          | still usable for columns                                     | [System design](contents/md/system.md)   |
| One of several record types | `anyOf` of two `$ref`                                        | [System design](contents/md/system.md)   |
| Pipeline input              | `json_subformats` read by a script                           | [CI/CD](contents/md/ci.md)               |

### Project and tools

| Feature           | Where                                                | Page                                 |
| ----------------- | ---------------------------------------------------- | ------------------------------------ |
| Page tree         | `center_contents`                                    | [dooc.yaml](contents/md/manifest.md) |
| Languages, themes | `system`                                             | [dooc.yaml](contents/md/manifest.md) |
| Project folder    | `.dooc/fonts`, `.dooc/plugins`, `.dooc/editor-tools` | [dooc.yaml](contents/md/manifest.md) |
| Edit and view     | `dooc edit`, `dooc view`                             | [Commands](contents/md/cli.md)       |
| Edit together     | `dooc edit --shared <branch>`                        | [Editor](contents/md/editor.md)      |
| Validate          | `dooc check`                                         | [Commands](contents/md/cli.md)       |
| Share             | `dooc build html`, `dooc build zip`, `dooc export`   | [Commands](contents/md/cli.md)       |
| Agents            | `dooc mcp`                                           | [Commands](contents/md/cli.md)       |
