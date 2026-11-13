`![caption](path)` on its own line embeds a file. The path is relative to `dooc.yaml`. An embed stores the path, not a copy: edit the file and every page that embeds it follows.

## Previewers

The file extension selects the previewer.

| Previewer | Extensions                                                                                                                                                                                                               | Example                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Table     | `csv`, `tsv`                                                                                                                                                                                                             | [Tables](contents/md/embeds.md#tables)           |
| Code      | `txt`, `log`, `json`, `yaml`, `yml`, `toml`, `xml`, `css`, `js`, `jsx`, `ts`, `tsx`, `mjs`, `cjs`, `py`, `rs`, `go`, `java`, `c`, `h`, `cpp`, `hpp`, `cs`, `rb`, `php`, `swift`, `kt`, `sh`, `bash`, `ps1`, `sql`, `tdl` | [Source code](contents/md/embeds.md#source-code) |
| Markdown  | `md`, `markdown`                                                                                                                                                                                                         | [Blocks](contents/md/blocks.md)                  |
| Image     | `svg`, `png`, `jpg`, `jpeg`, `webp`, `gif`                                                                                                                                                                               | [Media](contents/md/media.md)                    |
| Video     | `mp4`, `webm`                                                                                                                                                                                                            | [Media](contents/md/media.md)                    |
| HTML      | `html`, `htm`                                                                                                                                                                                                            | [Media](contents/md/media.md)                    |
| PDF       | `pdf`                                                                                                                                                                                                                    | [Media](contents/md/media.md)                    |
| DXF       | `dxf`                                                                                                                                                                                                                    | [Media](contents/md/media.md)                    |

Block files (`.callouth`, `.graphth`, `.schemath`, `.termth`, `.mermaid`) and record files (`.issue` and other registered extensions) are covered in [Blocks](contents/md/blocks.md) and [Linked records](contents/md/records.md).

## Fragments

| Fragment   | Applies to    | Effect                                 |
| ---------- | ------------- | -------------------------------------- |
| `#L10`     | any text file | Show one line as source                |
| `#L10-L20` | any text file | Show an inclusive line range as source |
| `#H`       | `csv`, `tsv`  | Use the first row as column headings   |

Without `#H`, columns are numbered and every row is data. A line fragment always shows source, so `![](file.csv#L1-L3)` shows raw CSV lines instead of a table.

## Tables

`![Release readiness](contents/csv/release.csv)`

![Release readiness](contents/csv/release.csv)

`![Preview inventory](contents/tsv/inventory.tsv#H)`

![Preview inventory](contents/tsv/inventory.tsv#H)

`![](contents/csv/release.csv#L1-L2)`

![](contents/csv/release.csv#L1-L2)

## Source code

A whole file:

![](contents/ts/preview.ts)

Lines 2 to 5 of a file, `![](contents/js/filter.js#L2-L5)`:

![](contents/js/filter.js#L2-L5)

![](contents/py/report.py)

![](contents/sh/check.sh)

## Structured data

JSON, YAML, TOML, and XML use the code previewer.

![](contents/json/workspace.json)

![](contents/yaml/project.yaml)

![](contents/toml/settings.toml)

![](contents/xml/feed.xml)

## URLs

| Source                             | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| `https://` URL matched by a plugin | [Plugin card](contents/md/plugins.md)      |
| `https://` URL of a text file      | Remote source embed, fetched by the viewer |
| Any other URL                      | Stays a link                               |

Use a public HTTPS file URL, such as a Git host's raw file URL. Git repository references such as `https://host/repo.git#ref:path` are not supported as embeds. To open a whole Git workspace, use [the CLI's `--repo` option](contents/md/cli.md#git-repositories).

URLs with credentials are rejected. `dooc build` stores fetched content in the bundle by default. `--url_preview network` keeps URL references instead; live HTML selects network mode automatically. See [Build output](contents/md/cli.md#build-output) for mode constraints and snapshot limits.
