A record reference is a project-relative file path. Schemas describe which paths a field accepts; dooc uses those definitions to offer record choices and draw relationships. Keep the complete working data in its own workspace, as in the [project delivery and SaaS operations samples](contents/md/samples.md).

## Model one fact once

```graphth Record relationships
[team]: Team
[project]: Project
[milestone]: Milestone
[issue]: Issue
[note]: Decision or meeting
[project] -> [team]: owned by
[milestone] -> [project]: delivers
[issue] -> [milestone]: contributes to
[note] -> [issue]: explains
```

A project names its team. The team does not need a second list of projects: reverse references can be derived from the projects. This avoids maintaining the same relationship in two places.

## Publish a reference definition

The project schema in `sample/dooc-sample-project` publishes the shape of a project path:

```json
{
  "$defs": {
    "ref": {
      "type": "string",
      "pattern": "^contents/project/[a-z0-9-]+\\.project$"
    }
  }
}
```

An issue schema uses that definition:

```json
{
  "properties": {
    "project": { "$ref": "project.schema.json#/$defs/ref" },
    "blocked_by": { "type": "array", "items": { "$ref": "#/$defs/ref" } }
  }
}
```

| Form | Meaning | Example use |
| --- | --- | --- |
| `other.schema.json#/$defs/ref` | A definition in a sibling schema | An issue belongs to a project |
| `#/$defs/ref` | A definition in the same schema | An issue waits for another issue |
| `$ref` with a sibling `title` | Reuse a rule with a field-specific label | Owner and assignee share an identifier format |
| `anyOf` containing two `$ref` entries | Accept one of several record types | A service depends on another service or a datastore |

## Shared definitions

A schema may contain only `$defs` and need no subformat registration. In the SaaS sample, `runtime.schema.json` defines environments, ports, resources and dependencies for several record types. Fields that resolve to an enum remain available for board grouping.

Schema validation checks a value's shape. A path-shaped string alone does not prove that a target exists, that a team member belongs to the selected team, or that a subnet belongs to a network. Keep actual references inside the workspace, use the editor's reference choices, and check these business relationships when consuming records in another tool.

## Explore a complete model

| Workspace | Follow this chain |
| --- | --- |
| `sample/dooc-sample-project` | Team → project → milestone → issue → decision |
| `sample/dooc-sample-saas` | Network → service → datastore → log stream, with SLOs and incidents |

Both workspaces have editable boards and schemas. Their data is fictional; dooc's own feature tracking remains in this document's **Development → Feature gaps** board.
