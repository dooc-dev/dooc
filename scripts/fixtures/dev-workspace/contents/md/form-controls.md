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

![A task with every control](contents/task/first.task)

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
