dooc has four implementation packages: the engine reads and compiles a document, the frontend renders and edits it, the workspace layer carries requests, and the server hosts the application and CLI. A document workspace is a separate folder containing `dooc.yaml` and its source files.

![From source files to a document](contents/html/architecture.html)

## Package boundaries

| Package | Responsibility | Source of truth |
| --- | --- | --- |
| `packages/engine` | Parse manifests and Markdown; validate schemas; resolve references; compile pages and figures | Files below the selected manifest |
| `packages/frontend` | Navigation, previews, source editing, record forms and browser workspace support | The selected workspace and editor state |
| `packages/workspace` | Request protocol, connections, workspace operations and MCP tools | Requests sent to a workspace |
| `packages/server` | CLI, local HTTP services, plugin execution, build and export commands | Explicit command options and project configuration |
| `plugins` | Public plugin SDK and service integrations | A plugin's declared capabilities |

The engine does not require the documentation or sample directories at runtime. Installed packages and standalone executables load a user's workspace from disk or a repository selected with `--repo`.

## Compile and publish

![Compilation and publishing](contents/graphth/compiler.graphth)

| Input | Processing | Result |
| --- | --- | --- |
| `dooc.yaml` | Validate settings, flatten the page tree and register subformats | Navigation and workspace configuration |
| Markdown | Parse blocks, resolve local links and collect embeds | Page content, headings and source locations |
| Schemas and records | Load local schema references and validate records | Boards, fields, forms and relationship graphs |
| Diagrams and media | Parse diagrams or select the matching previewer | Figures embedded in pages |
| Theme and language variants | Select files for the requested theme and language | A consistent document variant |

`dooc check` audits local inputs without fetching remote URLs. `dooc build html` compiles the document and, by default, downloads supported remote embeds into a standalone bundle. Use `--url_preview network` to retain network references. [Commands](contents/md/cli.md) documents the exact build options.

## Editing a page

![Edit, preview and save](contents/mermaid/edit-cycle.mermaid)

A preview is a rendering of a draft. Saving writes source files; publishing creates an output artifact. These are separate steps, so reviewing a preview alone does not publish a document.

## Document model

![Document relationships](contents/schemath/document.schemath)

Paths are relative to the selected manifest's folder. Two workspaces can have files named `contents/md/index.md` without sharing their pages, records or configuration. This is why each [sample workspace](contents/md/samples.md) includes its own manifest, schemas and assets.

## Runtime boundaries

| Mode | Editable | Needs a running service | Intended use |
| --- | --- | --- | --- |
| `dooc editor run node --client --server` | Yes | Yes | Author and save source files |
| `dooc reader run node --client --server` | No | Yes | Review a local or cloned workspace |
| Standalone HTML | No | No for embedded local content | Share a document snapshot |
| Source ZIP | After opening with dooc | Only while viewing or editing | Hand off editable source files |

Remote links, live plugin data and network-mode embeds still need their services. Repository workspaces also have execution restrictions; see [Git repositories](contents/md/cli.md#git-repositories) and [Plugins](contents/md/plugins.md).
