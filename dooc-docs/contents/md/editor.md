Use `dooc editor run node --client --server` to work on pages, files and records. It opens a browser editor and keeps a local service running until you stop it with **Ctrl+C**. `dooc reader run node --client --server` opens the same document without editing controls. Both default to `http://localhost:3000/client/`.

## Find your place

The [screen layout](contents/md/ux-layout.md) shows the sidebar, preview panes and source editor. The [sidebar](contents/md/ux-sidebar.md) chooses content; the [editor header](contents/md/ux-header.md) chooses the active context and provides validation, save and view controls.

| Area | Use it to |
| --- | --- |
| Document tree | Open pages and boards; add, rename, move and set icons |
| Preview pane | Read the rendered draft and follow its links |
| Source editor | Change the selected page, record or schema |
| Workspace tools | Browse Files, Library, Subformats, Plugins and Git |

The editor header sits above the source editor. Its language control is on the left, workspace and branch selectors are in the center, and actions are on the right. The folder button opens a workspace for the active pane.

## Edit and save a page

1. Select a page in the document tree. In split view, select the preview pane you want to work on first.
2. Edit its source. The preview follows the draft, and diagnostics identify problems in the content.
3. Use **Shift+Alt+F** to format and validate the page when you want to apply formatting.
4. Save with **Ctrl+S**, or leave **Auto save** on. Wait for the saved state before closing the page.

Errors never block saving a page. **Auto save** starts on and **Auto validate** starts off; both retain your choice. Validation checks a draft, saving writes source files, and [publishing](contents/md/publishing.md) creates an output artifact.

| Save state | Meaning | Action |
| --- | --- | --- |
| Saved · green | The write succeeded | Continue working |
| Pending · orange | Manual changes have not been saved | Save or enable Auto save |
| Failed · red | The write did not succeed | Read the error and retry after fixing its cause |

## Organize content

Tree edits rewrite `dooc.yaml`; hand edits to the manifest appear in the tree. Renaming a file updates references to it.

| Task | Where |
| --- | --- |
| Add or move a page | Document tree |
| Upload or reorganize source files | Files |
| Copy a path for an embed | Files; see [File embeds](contents/md/embeds.md) |
| Search pages and files | **Ctrl+F** |
| Find blocks, terms and their uses | Library |
| Edit a record or its schema | Subformats; see [Structured records](contents/md/subformats.md) |
| Add a translation | Page language menu; see [Themes and languages](contents/md/variants.md) |

## Adjust the view

Use **Preview theme** in a preview pane to choose Auto, Light or Dark for that pane. **Reader font** changes the reading font; **Editor font** in the editor header's settings changes the source font. Font choices stay with the browser tab.

The [editor header](contents/md/ux-header.md) also controls split view, line wrapping, source mapping and Git change markers. Record pages offer a form or their YAML, JSON or TOML source; schemas offer a field builder or JSON source.

## Keep changes safe

A file changed outside the editor is reloaded. If both the editor and the file changed, choose which edits to keep. Leaving an unsaved record or schema form prompts before discarding its changes.

Drafts and undo history are not a backup. Save source changes before closing the page, and use [History](contents/md/workspaces.md#history) or Git for durable checkpoints.

## Continue with a specific task

| Task | Guide |
| --- | --- |
| Compare branches or open another workspace | [Workspaces and branches](contents/md/workspaces.md) |
| Edit in browser storage or share an editing session | [Workspace storage and collaboration](contents/md/workspaces.md) |
| Configure formatters and linters | [Code tools](contents/md/code-tools.md) |
| Change preview or source-editor settings | [Editor header](contents/md/ux-header.md) |
| Run client and workspace services independently | [App runtimes](contents/md/runtimes.md) |
