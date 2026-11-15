Five record types track the fictional Atlas launch. A reference is the project-relative path of another record, and the schemas share the definition of that path with `$ref`.

![Atlas record model](contents/schemath/records.schemath)

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

Each referenced schema publishes the path pattern of its own records in `$defs/ref`. The team schema also publishes `$defs/member_id`. Other schemas reuse them instead of repeating the pattern.

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

The [Product team](contents/team/product.team) owns the project:

![Customer portal](contents/project/customer-portal.project)

The project has a milestone:

![Portal beta](contents/milestone/portal-beta.milestone)

An issue belongs to both and waits for [another issue](contents/issue/draft-onboarding.issue):

![Test invitations and expired links](contents/issue/test-invitations.issue)

The kickoff note names the team, the project, the milestone, and two issues:

![Customer portal kickoff](contents/note/portal-kickoff.note)

The [Platform team](contents/team/platform.team) runs [Tenant migration](contents/project/tenant-migration.project) with the milestone [Migration rehearsal](contents/milestone/migration-rehearsal.milestone). The decision to rehearse first is [a note](contents/note/migration-decision.note) that cites [the migration issue](contents/issue/rehearse-migration.issue).

Each link above adds this page to the reference dropdown on the target's card.
