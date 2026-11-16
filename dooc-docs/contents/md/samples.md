The repository separates product documentation from complete example workspaces. Each document has its own `dooc.yaml`; the two samples can be copied out and edited independently.

| Directory | Audience | Contents |
| --- | --- | --- |
| `dooc-docs/` | dooc users and contributors | Commands, authoring, formats, architecture, UX and development |
| `sample/dooc-sample-saas/` | Engineers operating a SaaS product | System inventory, SLOs, incident response, releases and recovery |
| `sample/dooc-sample-project/` | A team delivering a product change | Roadmap, teams, milestones, issues, decisions and acceptance criteria |
| `sample/examples/` | Integration authors | Reader plugin mocks, an installable extension and a Git origin adapter |

The sample companies, people, operational measurements and dates are fictional. Their HTML figures are authored snapshots, not connections to monitoring or project-management services.

## Open a workspace

From this repository's root after installing dooc:

```sh
dooc reader run node --client --server --project dooc-docs/dooc.yaml
dooc editor run node --client --server --project sample/dooc-sample-saas/dooc.yaml
dooc editor run node --client --server --project sample/dooc-sample-project/dooc.yaml
```

From a source checkout, use `mise run dooc editor run node --client --server --project sample/dooc-sample-saas` or select the project sample. `mise run editor` and `mise run reader` generate separate disposable workspaces for development; they do not open these authored samples.

With Git installed, a published repository can also be opened directly:

```sh
dooc reader run node --client --server --project sample/dooc-sample-saas --repo https://github.com/dooc-dev/dooc.git
dooc reader run node --client --server --project sample/dooc-sample-project --repo https://github.com/dooc-dev/dooc.git
```

## Build and copy

```sh
dooc check sample/dooc-sample-saas/dooc.yaml
dooc build html sample/dooc-sample-saas/dooc.yaml build/saas --url_preview network
dooc check sample/dooc-sample-project/dooc.yaml
dooc build html sample/dooc-sample-project/dooc.yaml build/project --url_preview network
```

To start your own document, copy one entire workspace directory. Change its title, replace the fictional data, and update records and figures together. Each sample includes its own schemas and assets, including any shared schema definitions; it has no dependency on files inside `dooc-docs` or the other sample.

`sample/examples` holds executable integration examples rather than a document workspace. [Write a plugin](contents/md/plugin-dev.md) explains the plugin contract, and [Development](contents/md/development.md) explains how to build the sample extension.
