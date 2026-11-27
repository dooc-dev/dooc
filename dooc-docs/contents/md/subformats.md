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
document:
  children:
    - document:
        subformat: feature
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

Each board has one title, showing the type icon and registered extension, such as **project**. In the editor, this title opens the existing type menu, including **Edit** for its schema. In the reader and standalone HTML, the same icon and name link to the type's schema page. Do not display a second schema-name link beside the editor's type selector. Embedded collections retain their schema link with the same icon and name.

The schema page shows fields, types, required conditions, descriptions and constraints. Expand nested fields and referenced definitions, or open **JSON text** for the complete source. The page is available in the editor, reader and standalone HTML. Configured SVGs stay isolated in decorative images so their styles and identifiers cannot affect the surrounding page; types without an icon use the standard Subformats symbol.

Schema pages follow the active document theme and font. Reuse the file browser's disclosure chevrons, document border and hover colors, and visible keyboard focus for fields, schema settings and JSON text. Keep property names in the document monospace font; use muted text for types and requirement labels, with requirements aligned to the row end. Nested fields and long constraints must remain readable on narrow screens.

Schema pages use the registered extension in their URL, such as `/_files/schema/feature` (or `#/_files/schema/feature` in standalone HTML). The URL stays the same when the schema file moves and its registration is updated. The file link on the schema page opens its source for editing in the editor.

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

![Feature records](contents/json/feature.schema.json)

## Board actions

| Action                        | How                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Open the board                | **Subformats** in the workspace tools, or a board page                         |
| Switch cards or list          | **View** menu; save its **✓** to set `layouts.view` to `card` or `list`        |
| Set the type icon             | **SVG icon**; enter an existing local `.svg` path, or leave it empty to remove |
| Change column field           | **group by** menu                                                              |
| Order cards                   | **sort by** and **sort order** menus                                           |
| Change the heading field      | **card title** menu                                                            |
| Reorder parameters in each list row | **Parameter order**; move fields up or down                              |
| Save a menu choice as default | Its **✓**, in edit mode; writes `layouts` in `dooc.yaml`                       |
| Move a card                   | Drag it to another column; the file is rewritten                               |
| Edit a record                 | Click the card; view mode opens a detail dialog                                |
| New record                    | **Create**; choose the file path in the form                                   |
| Find what links to a record   | Reference dropdown on the card                                                 |
| Copy a source link            | Copy icon on the card                                                          |
| Search                        | **Ctrl+F**                                                                     |

Cards are the default when `layouts.view` is omitted. List view is a flat, sorted list: every field other than the heading appears as a parameter, including status and nested values. Grouping and dragging between columns apply only to Cards. List view keeps search, record editing, and expandable details.

Board actions start at the left content edge with the single type title, followed by view, title, grouping, sorting and filters. In reader and standalone board pages, theme and font controls share that row on the right. Keep the existing controls and navigation behavior; narrower screens wrap board actions without overlapping the theme and font controls or widening the page. Schema pages retain the normal content inset, without an additional empty header area.

The schema name uses the same 18px heading size as the subformat selector. Hover keeps the link background transparent; retain its underline and visible keyboard focus.

List parameters stay on one horizontal row. Scroll the parameter area to reach more fields; expand the record for complete long values. **Fields** selects the visible parameters and changes their left-to-right order, independently of row sorting. Toggling visibility keeps each field in place; use the arrow buttons to reorder fields. These choices are kept while switching views, but are not saved to the schema or board defaults. **Filters** combines conditions on fields, including text, numbers, dates, and empty values.

Card borders and list dividers follow Git status: green for new files, orange for modified ones. Moves keep YAML and TOML comments.

The Create form suggests a path under `default_subformat_folder`, or an existing record's folder when no default is set. You can change the path before saving; keep the registered file extension.

## Records in a page

A link, an embed, and an inline fence all work with a registered extension.

| Form  | Syntax                                           |
| ----- | ------------------------------------------------ |
| Link  | `[text](contents/feature/mcp-subformat-tools.feature)` |
| Embed | `![](contents/feature/mcp-subformat-tools.feature)`    |
| Collection | `![](contents/json/feature.schema.json)` |
| Fence | ` ```.feature ` with the record as its body        |

![MCP subformat tools](contents/feature/mcp-subformat-tools.feature)

Embedding a record shows a card. Embedding its registered schema shows all records of that type as a table. Both use the current files, including unsaved record edits in the editor preview. Open a record to edit it in edit mode or inspect its details in the reader.

Every embed has controls above it for search, Cards / List / Table, sorting, and filters. The search icon opens an input alongside the other controls; press it again or Escape to close and clear the search. Cards also allow grouping; Cards and List can choose a heading field. List and Table offer **Fields** to select and order the displayed fields. Open a record to see its complete details regardless of the field selection. These choices affect only that embed for the current preview; they do not save board defaults or change the source URL.

Long embeds scroll within an automatic height limit, with a smaller limit on phones. The controls stay above the scroll area, and table headers stay visible while scrolling.

Use URL query parameters to customize an embed:

```md
![](contents/json/feature.schema.json?view=table&title=Planned%20features&filter.status=Planned)
![](contents/json/feature.schema.json?view=card&filter.area=Runtime)
![](contents/json/feature.schema.json?view=list&fields=status,priority&sort_by=priority&sort_order=desc&filter.status[in]=Planned,Building)
![](contents/feature/mcp-subformat-tools.feature?view=list)
```

| Parameter | Meaning |
| --------- | ------- |
| `view` | `table`, `card`, or `list`; defaults to `table` for a schema and `card` for a record |
| `title` | Heading for this embed; URL-encode spaces and special characters |
| `fields` | Comma-separated field names in display order; empty shows only the record heading or file column |
| `card_title` | Field used as the Card / List heading; empty uses the file name |
| `group_by` | Enum field used to group Cards; empty disables grouping |
| `sort_by` | Scalar field used for sorting; empty sorts by file name |
| `sort_order` | `asc` or `desc`; enum fields follow their schema order, and dates sort chronologically |
| `q` | Case-insensitive search of file names and record source; all space-separated words must match |
| `filter.<field>` | Exact, case-sensitive match on a top-level scalar field |
| `filter.<field>[eq]`, `[ne]` | Equals or does not equal a scalar value |
| `filter.<field>[contains]` | Case-insensitive text substring, or exact scalar item in an array |
| `filter.<field>[in]` | Matches any of the comma-separated scalar values |
| `filter.<field>[gt]`, `[gte]`, `[lt]`, `[lte]` | Greater than, at least, less than, or at most; number and date fields only |
| `filter.<field>[empty]` | `true` matches missing, null, empty text or an empty array; `false` matches other values |

All filter conditions must match. For example, `filter.points[gte]=0&filter.points[lt]=10` selects a range. Boolean and numeric values use their text form, such as `filter.ready=false` or `filter.points=0`. Missing fields do not match comparisons, including `[ne]`; use `[empty]` to find them. Query filters and `q` determine which records are included in the embed. The interactive search and filters can further narrow those records; clearing them does not undo the query filters.

Each parameter may appear once. Unknown parameters, fields, operators, and invalid comparison values are reported as errors; no matching records shows an empty view. Parameters affect this embed only and do not change board defaults. Field selection controls presentation; it does not remove data from the record details.

A line range such as `![](file.feature#L1-L3)` still shows source code. Line ranges cannot be combined with embed parameters.

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

1. The URL given to `dooc build --source-url <url>`.
2. The GitHub `origin` remote and current commit, read from local Git metadata.
3. A local reference such as `repo/folder/file.feature`.

## Planned renderer extensions

The accepted [plugin architecture](contents/md/plugin-architecture.md) defines `sandbox` and `host` execution, with `kit` as the display API. Runtime renderers are not implemented yet; current `layouts` settings select only the documented board behavior.

Record parsing, schema validation and reference checks remain dooc responsibilities. The [migration design](contents/md/plugin-architecture.md#subformats-and-publishing) covers `callouth`, `termth`, `graphth` and `schemath`, retaining their existing extensions, fences and semantics.
