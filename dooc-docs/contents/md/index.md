dooc turns a folder of Markdown, diagrams, media and structured records into one browsable document. The files remain the source; `dooc.yaml` supplies the page tree and record definitions.

![A document workspace at a glance](contents/html/overview.html)

## Start here

| You want to | Start with | Then |
| --- | --- | --- |
| Create your first document | [Install](contents/md/install.md) | [First document](contents/md/quickstart.md) |
| Learn from a complete workspace | [Sample workspaces](contents/md/samples.md) | Open the SaaS operations or project delivery sample |
| Write or edit content | [Writing content](contents/md/markdown.md) | [Using the editor](contents/md/editor.md) |
| Share a document | [Publish and integrate](contents/md/publishing.md) | [Validation pipeline](contents/md/ci.md) |
| Look up a syntax or option | [Reference](contents/md/reference.md) | [Commands](contents/md/cli.md) or [dooc.yaml](contents/md/manifest.md) |
| Change dooc itself | [Development](contents/md/development.md) | [Architecture](contents/md/system.md) |

## The working loop

![From files to a shared document](contents/graphth/workflow.graphth)

| Step | What changes | Command |
| --- | --- | --- |
| Author | Pages, records and source assets | `dooc editor run node --client --server` |
| Review | Your understanding of the current source | `dooc reader run node --client --server` |
| Check | A report about local consistency | `dooc check` |
| Share | An HTML document or source bundle | `dooc build`, `dooc zip` |

Start with one Markdown page. Add diagrams or records when they make the subject easier to understand. [First document](contents/md/quickstart.md) walks through a complete create, edit, check and share cycle.

## How these docs are arranged

| Section | Purpose |
| --- | --- |
| Getting started | Installation, a first document and complete samples |
| Writing content | Markdown, blocks, file embeds, media, variants and records |
| Using the editor | Everyday editing, the UX screen maps, workspaces and code tools |
| Publish and integrate | Shareable artifacts, CI, plugins and MCP connections |
| Reference | Syntax, manifest keys, command options and app runtimes |
| Development | Source builds, package architecture, release work and product gaps |

This document describes dooc. Fictional operational data belongs to the separate [sample workspaces](contents/md/samples.md). To download this documentation with an installed dooc, follow [Open the documentation](contents/md/install.md#open-the-documentation).
