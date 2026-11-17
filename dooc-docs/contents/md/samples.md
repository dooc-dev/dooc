The repository separates product documentation from complete example workspaces. Each document has its own `dooc.yaml`; the samples can be copied out and edited independently.

| Directory | Audience | Contents |
| --- | --- | --- |
| `dooc-docs/` | dooc users and contributors | Commands, authoring, formats, architecture, UX and development |
| `sample/dooc-sample-saas/` | Engineers operating a SaaS product | System inventory, SLOs, incident response, releases and recovery |
| `sample/dooc-sample-project/` | A team delivering a product change | Roadmap, teams, milestones, issues, decisions and acceptance criteria |
| `sample/dooc-sample-urls/` | Authors exploring document destinations | Every URL kind, file previews, local and remote documents, and click behavior |
| `sample/examples/` | Integration authors | Reader plugin mocks, an installable extension and a Git origin adapter |

The sample companies, people, operational measurements and dates are fictional. Their HTML figures are authored snapshots, not connections to monitoring or project-management services.

## Open a workspace

From this repository's root after installing dooc:

```sh
dooc reader run node --client --server --project dooc-docs/dooc.yaml
dooc editor run node --client --server --project sample/dooc-sample-saas/dooc.yaml
dooc editor run node --client --server --project sample/dooc-sample-project/dooc.yaml
dooc reader run node --client --server --project sample/dooc-sample-urls/dooc.yaml
```

From a source checkout, use `mise run dooc editor run node --client --server --project sample/dooc-sample-saas` or select the project sample. `mise run dev` opens editor and reader at `/client/` on ports 2000 and 2001 with a shared disposable development workspace; it does not open these authored samples.

The URL gallery opens with generated contents. It includes omitted, empty and null URLs, Markdown, TXT/CSV/JSON/HTML/SVG/PDF previews, local `dooc.yaml` and named manifests, GitHub and explicit Git URLs, internal page/heading links, HTTP(S) websites, and `redirect:first`. The Git examples use the published `dooc-v0.0.16` tag and need network access on first opening. Open `sample/dooc-sample-urls/raw.dooc.yaml` to try the equivalent GitHub raw URL as its own document. The guide inside the gallery explains the link title styling, click behavior and section version for each destination.

With Git installed, a published repository can also be opened directly:

```sh
dooc reader run node --client --server --project sample/dooc-sample-saas --repo https://github.com/dooc-dev/dooc.git
dooc reader run node --client --server --project sample/dooc-sample-project --repo https://github.com/dooc-dev/dooc.git
```

## Build and copy

```sh
dooc check sample/dooc-sample-saas/dooc.yaml
dooc build sample/dooc-sample-saas/dooc.yaml build/saas
dooc check sample/dooc-sample-project/dooc.yaml
dooc build sample/dooc-sample-project/dooc.yaml build/project
dooc check sample/dooc-sample-urls/dooc.yaml
dooc build sample/dooc-sample-urls/dooc.yaml build/urls --url_preview network
```

To start your own document, copy one entire workspace directory. Change its title, replace the fictional data, and update records and figures together. The SaaS and project samples include their own schemas and assets, including any shared schema definitions. The URL gallery includes its local assets and imports its remote examples from the published Git tag; none of the samples require a sibling checkout of `dooc-docs` or another sample.

`sample/examples` holds executable integration examples rather than a document workspace. [Write a plugin](contents/md/plugin-dev.md) explains the plugin contract, and [Development](contents/md/development.md) explains how to build the sample extension.
