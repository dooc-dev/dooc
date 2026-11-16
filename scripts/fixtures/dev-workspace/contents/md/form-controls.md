# Form controls

Open [the first task](contents/task/first.task) to try each input. Switch between **Form** and **JSON text**; both edit the same record. Open [the task schema](contents/json/task.schema.json) to switch between the schema builder and JSON.

| Field | Control or rule | Try |
| --- | --- | --- |
| ID | Read-only string | Inspect it in the form and source |
| Title | Required text, 1–80 characters | Clear it to inspect validation, then undo |
| Status and priority | Local and referenced enums | Choose a value; priority shares its choices with the issue schema |
| Due | Date | Open the calendar and choose another day |
| Progress | Integer, 0–100 | Change the numeric value and inspect the range rule |
| Estimate | Number in half-day steps | Enter 2.5 |
| Approved | Boolean | Choose true or false |
| Project and owner | Shared schema references | Follow the linked Atlas project and team definitions |
| Notes | Multiline string | Add another paragraph |
| Tags | Unique string array | Edit the JSON value |
| Review | Nested object | Edit the reviewer and approval fields |
| Updated | Read-only date-time | Compare its rendered value with the JSON source |

## Embedded records

A record file renders as a card. Expand it to see every field, or open it to edit the record. In the reader, opening it shows a detail dialog.

`![](contents/task/first.task)`

![A task with every control](contents/task/first.task)

### All tasks as a table

Embed the registered schema to display its records as a table. Open a file name to inspect that record; on narrow screens, scroll the table horizontally.

`![](contents/json/task.schema.json)`

![All tasks](contents/json/task.schema.json)

### Filtered cards

Set `view=card`, give the whole collection a `title`, and filter a boolean field. Spaces in the title are encoded as `%20`. Try the menus above the cards to change the heading field, grouping, sort field, or sort order. Each embed keeps its own temporary choices.

`![](contents/json/task.schema.json?view=card&title=Awaiting%20approval&filter.approved=false)`

![](contents/json/task.schema.json?view=card&title=Awaiting%20approval&filter.approved=false)

### Filtered list

Set `view=list` and combine filters. Every condition must match, so this list contains only completed, approved tasks. The list is flat; status and all other fields appear as parameters alongside the heading.

Scroll the parameters horizontally to see every field without wrapping the row. Open **Parameter order** and move **Priority** before **Status**; this changes the fields inside each row. **sort by** and **sort order** still control the order of records. Expand a record to read long values in full.

`![](contents/json/task.schema.json?view=list&title=Completed%20and%20approved&filter.status=Done&filter.approved=true)`

![](contents/json/task.schema.json?view=list&title=Completed%20and%20approved&filter.status=Done&filter.approved=true)

Try changing `view` between `table`, `card`, and `list`, or replace a condition with `filter.progress=0`. Open the first task, change **Approved**, and save to see it enter or leave the filtered cards. These parameters affect only the embed; board defaults stay the same. A filter with no matching records shows an empty view.

To inspect the original source instead, add a line range such as `![](contents/task/first.task#L1-L6)` without query parameters.

## Compare storage formats

The Atlas model uses all three storage formats, with links between records:

- JSON: [Customer portal project](contents/project/customer-portal.project)
- YAML: [Invitation issue](contents/issue/test-invitations.issue)
- TOML: [Portal beta milestone](contents/milestone/portal-beta.milestone)

Read [the linked record model](contents/md/atlas-records.md), then try the **Relations** view in the Subformats tool. Cards also list the pages that reference them.

## Change the schema

1. Open the task schema and add a field in the builder.
2. Use **Parameters** to add a default, enum, description, or validation rule.
3. Save, return to the task, and inspect the new form field.
4. Use the Subformats tool to register a new JSON, YAML, or TOML type, or change its icon.

An inline record is also supported. This example stays in the page and does not add a board card.

```.task
{"id":"TASK-010","title":"An inline record","status":"Todo","priority":"Normal","due":"2026-12-18","progress":0,"estimate":0.5,"approved":false,"owner":"alice","project":"contents/project/customer-portal.project"}
```
