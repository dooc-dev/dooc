A document pipeline should check the source before creating a shareable artifact. Keep document validation separate from any action that changes an external service.

![Document validation pipeline](contents/graphth/pipeline.graphth)

## Check and build

Run these commands from the folder containing `dooc.yaml`:

```sh
dooc check dooc.yaml
dooc build dooc.yaml
dooc zip dooc.yaml
```

| Stage | Input | Output | Failure means |
| --- | --- | --- | --- |
| Check | Pages, manifests, schemas and local assets | A JSON diagnostic report | Source content needs correction |
| HTML build | Checked source and selected URL mode | `build/index.html` | The document could not be compiled or packaged |
| ZIP build | Source workspace | `dist/bundle.zip` | Editable source could not be collected |
| Review | The built artifacts | A release decision | A reviewer has not accepted the output |

`dooc check` runs offline and reports remote content as unchecked. Network-mode HTML preserves supported remote references; it does not make those resources available offline. See [Build output](contents/md/cli.md#build-output) for embed mode and download limits.

## Consume structured records

Each `json_subformats` declaration supplies an extension, storage format and schema. A pipeline can read those declarations rather than hard-coding a second list of types.

| Manifest field | Pipeline use |
| --- | --- |
| `ext` | Find records with that extension |
| `format` | Choose JSON, YAML or TOML parsing |
| `schema` | Validate the parsed record |

The [SaaS operations sample](contents/md/samples.md) contains `contents/mjs/records.mjs`, which validates registered records and prints JSON, plus an illustrative workflow under `contents/yaml/records-pipeline.yaml`. The workflow is a document asset, so keeping the sample in this repository does not run it.

From a source checkout with dependencies installed:

```sh
node sample/dooc-sample-saas/contents/mjs/records.mjs sample/dooc-sample-saas/dooc.yaml
node sample/dooc-sample-saas/contents/mjs/records.mjs sample/dooc-sample-saas/dooc.yaml container
```

The sample's rollout step only prints a proposed action. Deployment needs a platform-specific implementation, credentials, target selection and a review policy supplied by its operator.
