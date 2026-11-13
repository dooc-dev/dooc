Five record types track the work on this workspace. A reference is the project-relative path of another record, and the schemas share the definition of that path with `$ref`.

![Record model](contents/schemath/records.schemath)

## Who references whom

| Record    | Storage | References                                                            |
| --------- | ------- | --------------------------------------------------------------------- |
| team      | TOML    | none; lists its members and their ids                                 |
| project   | JSON    | `team`, `owner` (member id), `docs` (pages)                           |
| milestone | TOML    | `project`, `owner` (member id)                                        |
| issue     | YAML    | `project`, `milestone`, `assignee` (member id), `blocked_by` (issues) |
| note      | YAML    | `team`, `project`, `milestone`, `issues`, `attendees` (member ids)    |

References point one way: note → issue → milestone → project → team. A team does not list its projects, so each fact is stored once.

## Shared definitions

Each schema publishes the path pattern of its own records in `$defs/ref`. The team schema also publishes `$defs/member_id`. Other schemas reuse them instead of repeating the pattern.

| Definition                          | Used by                               |
| ----------------------------------- | ------------------------------------- |
| `team.schema.json#/$defs/ref`       | project, note                         |
| `team.schema.json#/$defs/member_id` | team, project, milestone, issue, note |
| `project.schema.json#/$defs/ref`    | milestone, issue, note                |
| `milestone.schema.json#/$defs/ref`  | issue, note                           |
| `issue.schema.json#/$defs/ref`      | issue (`blocked_by`), note            |

The three ways to write the reference:

```json
{
  "project": { "$ref": "project.schema.json#/$defs/ref" },
  "assignee": { "$ref": "team.schema.json#/$defs/member_id", "title": "Assignee" },
  "blocked_by": { "type": "array", "items": { "$ref": "#/$defs/ref" } }
}
```

| Form                            | Meaning                                          |
| ------------------------------- | ------------------------------------------------ |
| `other.schema.json#/$defs/name` | A definition in a sibling schema file            |
| `$ref` with a sibling `title`   | The same definition under a field-specific label |
| `#/$defs/name`                  | A definition in the same file                    |

Renaming a record folder means changing one pattern. A schema checks the shape of a reference, not that the target file exists.

## The five schemas

![Team schema](contents/json/team.schema.json)

![Project schema](contents/json/project.schema.json)

![Milestone schema](contents/json/milestone.schema.json)

![Issue schema](contents/json/issue.schema.json)

![Note schema](contents/json/note.schema.json)

## One thread through all five

The [Docs team](contents/team/docs.team) owns the project:

![Feature reference](contents/project/feature-reference.project)

The project has a milestone:

![Cheat sheet draft](contents/milestone/cheat-sheet-draft.milestone)

An issue belongs to both and waits for [another issue](contents/issue/write-cheat-sheet.issue):

![List every embed format with one example](contents/issue/list-embed-formats.issue)

The kickoff note names the team, the project, the milestone, and two issues:

![Feature reference kickoff](contents/note/reference-kickoff.note)

The [Platform team](contents/team/platform.team) runs [Record model](contents/project/record-model.project) with the milestone [Five record types](contents/milestone/five-record-types.milestone). The decision to use paths is [a note](contents/note/path-references.note) that cites [the schema issue](contents/issue/share-reference-definitions.issue).

Each link above adds this page to the reference dropdown on the target's card.
