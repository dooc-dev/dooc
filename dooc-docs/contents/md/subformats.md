A subformat is a record type: one file is one record, a JSON Schema defines its fields, and the records appear as cards or a list. This documentation uses `feature` to track dooc itself. The [sample workspaces](contents/md/samples.md) contain the larger project-management and SaaS-operations models.

The **Development → Feature gaps** board uses [the feature schema](contents/json/feature.schema.json). Each entry records an area, status, priority and summary. [Linked records](contents/md/records.md) explains how to connect types when a model needs more than one.

## Declare a type

```yaml
json_subformats:
  - ext: feature
    format: yaml
    schema: contents/json/feature.schema.json
    icon: contents/svg/icons/feature.svg
    layouts:
      view: list
      card_title: name
      group_by: status
      sort_by: priority
      sort_order: asc
center_contents:
  - subformat: feature
    title: Feature gaps
default_subformat_folder: contents/feature
```

| Key       | Required | Value                                        |
| --------- | -------- | -------------------------------------------- |
| `ext`     | yes      | File extension without the dot               |
| `format`  | yes      | `yaml`, `json`, or `toml`; one per extension |
| `schema`  | yes      | Local JSON Schema path                       |
| `icon`    | no       | Local SVG shown wherever the type is listed  |
| `layouts` | no       | Board defaults                               |

Files with a registered extension are collected even when no page links to them. In the editor, **Add subformat…** in the Subformats tool registers a type and creates its schema file. Because the list lives in `dooc.yaml`, a script can read it too: see [CI/CD](contents/md/ci.md).

The optional SVG path can be entered when registering a type, or changed later with **SVG icon**. When adding the type to **Pages**, dooc copies that path into the new page’s icon setting. Changing the type icon later does not replace existing page icons; each page can override or clear its icon independently.

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

![Feature schema](contents/json/feature.schema.json)

## Board actions

| Action                        | How                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Open the board                | **Subformats** in the workspace tools, or a board page                         |
| Switch cards or list          | **View** menu; save its **✓** to set `layouts.view` to `card` or `list`        |
| Set the type icon             | **SVG icon**; enter an existing local `.svg` path, or leave it empty to remove |
| Change column field           | **group by** menu                                                              |
| Order cards                   | **sort by** and **sort order** menus                                           |
| Change the heading field      | **card title** menu                                                            |
| Save a menu choice as default | Its **✓**, in edit mode; writes `layouts` in `dooc.yaml`                       |
| Move a card                   | Drag it to another column; the file is rewritten                               |
| Edit a record                 | Click the card; view mode opens a detail dialog                                |
| New record                    | **Create**; choose the file path in the form                                   |
| Find what links to a record   | Reference dropdown on the card                                                 |
| Copy a source link            | Copy icon on the card                                                          |
| Search                        | **Ctrl+F**                                                                     |

Cards are the default when `layouts.view` is omitted. List view keeps grouping, sorting, search, record editing, details, and drag-to-group actions.

Card borders and list dividers follow Git status: green for new files, orange for modified ones. Moves keep YAML and TOML comments.

The Create form suggests a path under `default_subformat_folder`, or an existing record's folder when no default is set. You can change the path before saving; keep the registered file extension.

## Records in a page

A link, an embed, and an inline fence all work with a registered extension.

| Form  | Syntax                                           |
| ----- | ------------------------------------------------ |
| Link  | `[text](contents/feature/mcp-subformat-tools.feature)` |
| Embed | `![](contents/feature/mcp-subformat-tools.feature)`    |
| Fence | ` ```.feature ` with the record as its body        |

![MCP subformat tools](contents/feature/mcp-subformat-tools.feature)

A fenced record is validated and highlighted in its storage format, and stays in the page; it is not added to the board.

```.feature
name: Example feature
area: Runtime
status: Planned
priority: Normal
summary: Describe the intended behavior.
```

## Copied source links

The copy icon on a card resolves in this order:

1. The URL given to `dooc build html --source-url <url>`.
2. The GitHub `origin` remote and current commit, read from local Git metadata.
3. A local reference such as `repo/folder/file.feature`.
