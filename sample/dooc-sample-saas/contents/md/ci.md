`dooc.yaml` already says which record types exist, how each is stored, and which schema describes it. A pipeline can read that list instead of repeating it, so a new record type is picked up without touching the pipeline.

![From dooc.yaml to a pipeline](contents/graphth/pipeline.graphth)

## What a pipeline reads

| From `json_subformats` | Tells the pipeline                           |
| ---------------------- | -------------------------------------------- |
| `ext`                  | Which files are records of this type         |
| `format`               | How to parse them: `yaml`, `json`, or `toml` |
| `schema`               | Which JSON Schema validates them             |

## The script

[records.mjs](contents/mjs/records.mjs) reads `dooc.yaml`, validates every record against its schema, and prints all records as one JSON array. It exits with `1` when a record is invalid.

```sh
node contents/mjs/records.mjs dooc.yaml              # every type
node contents/mjs/records.mjs dooc.yaml container    # one type
```

![](contents/mjs/records.mjs)

Each element of the output has the type, the file, and the parsed data:

```json
{
  "type": "container",
  "file": "contents/container/api.container",
  "data": { "name": "API", "runtime": "Kubernetes", "image": "registry.example.org/fieldnotes/api:2.4.1" }
}
```

A `$ref` to another schema file, such as `runtime.schema.json#/$defs/image`, is loaded when it is first needed, so [shared definitions](contents/md/architecture.md#shared-definitions) work without extra configuration.

## The workflow

A GitHub Actions workflow built on the script. It checks the document, validates the records, builds the HTML bundle, and prints one proposed rollout per [container record](contents/md/architecture.md#compute).

![](contents/yaml/records-pipeline.yaml)

| Step              | Uses                                   | Fails when                                  |
| ----------------- | -------------------------------------- | ------------------------------------------- |
| `dooc check`      | Pages, local links and embeds          | A page does not compile or a local reference is broken |
| `records.mjs`     | `ext`, `format`, `schema` of each type | A record does not match its schema          |
| `jq` filter       | Record data                            | Never; it selects what to deploy            |
| `dooc build html` | The whole workspace                    | Compilation or a remote embed download fails |
| `deploy` matrix   | One selected record per job            | The illustrative command fails                   |

`dooc check` runs offline and reports remote content as unchecked. The HTML build downloads embedded URLs by default; ordinary links stay links. See [release and recovery](contents/md/releases.md) for network mode and download limits.

## Other things to do with records

| Record type                        | Pipeline action                                         |
| ---------------------------------- | ------------------------------------------------------- |
| `container`, `worker`              | Deploy the image; set replicas, schedule, and resources |
| `vpc`, `loadbalancer`, `datastore` | Generate infrastructure variables                       |
| `log`                              | Configure retention and sinks                           |
| `slo`, `incident`               | Review service objectives and open incidents before a change           |
| any                                | Publish `records.json` for other tools                  |

The schema checks the shape of a reference, not that its target exists. To check targets, compare each path-valued field in the output against the `file` values.

## Run it from a checkout

With this repository's dependencies installed, run from the repository root:

```sh
node sample/dooc-sample-saas/contents/mjs/records.mjs sample/dooc-sample-saas/dooc.yaml
```

A copied standalone workspace needs `ajv`, `ajv-formats`, `smol-toml` and `yaml` installed to run this illustrative script. Normal `dooc reader run node --client --server`, `dooc check` and `dooc build` commands do not need these extra script dependencies installed in the workspace.

The workflow is stored under `contents/yaml/` as a document asset and does not run automatically. Its deploy job only prints the proposed image and replica count. Real deployment requires explicit environment selection and a rollout implementation; the inventory includes production, staging and on-premise workloads.
