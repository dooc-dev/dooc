# Feature playground

This disposable workspace contains working examples of every built-in preview, linked records, editor controls, and local demo plugins. Edit freely: starting `mise run editor` again recreates the workspace. Hot reload preserves edits during the current run.

## Choose something to try

| Feature | Open | Try |
| --- | --- | --- |
| Live Markdown editing | [Editing playground](contents/md/playground.md) | Change text, follow links, fold sections, validate, save, and undo |
| Diagrams and semantic blocks | [Diagrams and blocks](contents/md/blocks.md) | Mermaid, graphth, schemath, callouth, termth, CSV, and TSV |
| Embedded source and data | [File embeds](contents/md/embeds.md) | Edit a shared file, inspect line ranges, sort and resize tables |
| Images, video, HTML, PDF, and CAD | [Media gallery](contents/md/media.md) | Expand a preview, zoom, pan, download, and play a video |
| Draw.io SVG | [Editable architecture drawing](contents/svg/hosting.drawio.svg) | Open an SVG that retains its diagram source |
| Forms and schema builder | [Form controls](contents/md/form-controls.md) | Dates, booleans, numbers, enums, arrays, nested objects, and references |
| Linked JSON, YAML, and TOML records | [Atlas project](contents/md/atlas.md) | Drag cards, switch to lists, sort, group, and follow record references |
| Theme variants | [Themes and languages](contents/md/variants.md) | Split the preview and compare Light and Dark |
| Content languages | This page's language picker | Switch between English, Japanese, and Chinese |
| Fonts and custom syntax | [Editing playground](contents/md/playground.md#custom-highlighting) | Choose the bundled project font and inspect the taskplan grammar |
| Plugins and sign-in | [Local integrations](contents/md/integrations.md) | Edit a ticket, review a pull request, reply, and react |
| Git, history, and versions | [History playground](contents/md/history.md) | Compare main with example and browse two document versions |
| Files, search, and Library | [Editor guide](contents/md/editor.md) | Search across pages, inspect references, upload, rename, and move files |
| Formatting and diagnostics | [Editing playground](contents/md/playground.md#format-and-validate) | Run the included JSON formatter and linter with Shift+Alt+F |
| Workspaces and collaboration | [Workspaces](contents/md/workspaces.md) | Open another pane, create a branch, or connect another client |
| MCP and publishing | [Local integrations](contents/md/integrations.md#mcp-and-export) | Connect an assistant, export sources, or build a standalone viewer |

## A short editing loop

1. Open [the first task](contents/task/first.task), change its priority and due date, and save.
2. Open **Form controls → Tasks** and inspect the changed card. Try another grouping or the list view.
3. Open **Files → History** or **Git** to inspect your changes.
4. Use the sidebar **Version** picker to compare an earlier read-only snapshot with the latest document.

The **Project delivery** section contains a complete fictional launch with teams, projects, milestones, issues, and decision notes. **Feature reference** contains the full documentation and its reusable media examples.

All records and service identities are illustrative. Plugin previews use the local mock service; they need no real account. Features that connect to an external Git host or assistant use your explicitly chosen connection.
