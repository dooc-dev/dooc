A subformat is a record type: one file is one record, a JSON Schema defines its fields, and the records show as cards on a board. This workspace declares eleven: five that track work, listed here, and six that describe a running system, listed in [System design](contents/md/system.md).

| Type                                             | Storage | Board grouped by | Records               |
| ------------------------------------------------ | ------- | ---------------- | --------------------- |
| [team](contents/json/team.schema.json)           | TOML    | Focus            | `contents/team/`      |
| [project](contents/json/project.schema.json)     | JSON    | Status           | `contents/project/`   |
| [milestone](contents/json/milestone.schema.json) | TOML    | State            | `contents/milestone/` |
| [issue](contents/json/issue.schema.json)         | YAML    | Status           | `contents/issue/`     |
| [note](contents/json/note.schema.json)           | YAML    | Kind             | `contents/note/`      |

Their boards are the pages below this one in the tree. [Linked records](contents/md/records.md) shows how these five schemas reference each other, and [CI/CD](contents/md/ci.md) reads the same declarations from a pipeline.

## Declare a type

```yaml
json_subformats:
  - ext: issue
    format: yaml
    schema: contents/json/issue.schema.json
    icon: contents/svg/icons/issue.svg
    layouts:
      card_title: title
      group_by: status
      sort_by: due
      sort_order: asc
center_contents:
  - subformat: issue
    title: Issues
default_subformat_folder: contents/issue
```

| Key       | Required | Value                                        |
| --------- | -------- | -------------------------------------------- |
| `ext`     | yes      | File extension without the dot               |
| `format`  | yes      | `yaml`, `json`, or `toml`; one per extension |
| `schema`  | yes      | Local JSON Schema path                       |
| `icon`    | no       | Local SVG shown wherever the type is listed  |
| `layouts` | no       | Board defaults                               |

Files with a registered extension are collected even when no page links to them. In the editor, **Add subformat…** in the Subformats tool registers a type and creates its schema file. Because the list lives in `dooc.yaml`, a script can read it too: see [CI/CD](contents/md/ci.md).

Open the type selector in **Subformats** to manage an existing type. Its **Edit** button opens the schema; **Delete** removes the registration and its sidebar page after confirmation. The record files and schema file are kept.

## What the schema controls

Schemas use JSON Schema 2020-12 and are validated strictly: unknown keywords and formats are rejected.

| Schema                              | Effect on the board                                               |
| ----------------------------------- | ----------------------------------------------------------------- |
| `title` on a property               | Field label                                                       |
| Top-level property with `enum`      | Can be used for columns; enum order is kept                       |
| `format: date` or `date-time`       | Sorts chronologically                                             |
| `readOnly` on an enum property      | Groups, but cards cannot be dragged                               |
| `required`, `pattern`, `minimum`, … | Checked on every save and card move                               |
| First entry of `examples`           | Pre-fills **Create**                                              |
| `$ref` to another schema file       | Reuses a definition; see [Linked records](contents/md/records.md) |

![Issue schema](contents/json/issue.schema.json)

## Board actions

| Action                        | How                                                      |
| ----------------------------- | -------------------------------------------------------- |
| Open the board                | **Subformats** in the workspace tools, or a board page   |
| Change column field           | **group by** menu                                        |
| Order cards                   | **sort by** and **sort order** menus                     |
| Change the heading field      | **card title** menu                                      |
| Save a menu choice as default | Its **✓**, in edit mode; writes `layouts` in `dooc.yaml` |
| Move a card                   | Drag it to another column; the file is rewritten         |
| Edit a record                 | Click the card; view mode opens a detail dialog          |
| New record                    | **Create**; choose the file path in the form             |
| Find what links to a record   | Reference dropdown on the card                           |
| Copy a source link            | Copy icon on the card                                    |
| Search                        | **Ctrl+F**                                               |

Card borders follow Git status: green for new files, orange for modified ones. Moves keep YAML and TOML comments.

The Create form suggests a path under `default_subformat_folder`, or an existing record's folder when no default is set. You can change the path before saving; keep the registered file extension.

## Records in a page

A link, an embed, and an inline fence all work with a registered extension.

| Form  | Syntax                                           |
| ----- | ------------------------------------------------ |
| Link  | `[text](contents/issue/write-cheat-sheet.issue)` |
| Embed | `![](contents/issue/write-cheat-sheet.issue)`    |
| Fence | ` ```.issue ` with the record as its body        |

![Write the cheat sheet page](contents/issue/write-cheat-sheet.issue)

A fenced record is validated and highlighted in its storage format, and stays in the page; it is not added to the board.

```.issue
title: Example issue
status: Todo
due: 2026-11-30
project: contents/project/feature-reference.project
```

## Copied source links

The copy icon on a card resolves in this order:

1. The URL given to `dooc build html --source-url <url>`.
2. The GitHub `origin` remote and current commit, read from local Git metadata.
3. A local reference such as `repo/folder/file.issue`.
