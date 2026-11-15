Create one page, edit it, check it and share it. [Install dooc](contents/md/install.md) first, then run the commands below in a terminal.

## Create a workspace

```sh
mkdir my-docs
cd my-docs
dooc init
dooc editor
```

`dooc init` creates an empty `dooc.yaml` and never replaces an existing manifest. `dooc editor` is an alias for `dooc editor run node --all`: it reads that directory's manifest and starts the client, workspace server and MCP. It prints a local URL; open it and keep the command running while you work. Use `dooc viewer` for read-only access. Pass `--port 4000` or `--project docs/dooc.yaml` to override the port or manifest path.

## Add your first page

1. Use **Add a page** in the document tree and create a Markdown page named **Overview**.
2. Put the text below in its source editor.
3. Save with **Ctrl+S** and wait for the saved state. Auto save is on by default.

```markdown
This handbook keeps the team's decisions close to the work.

## First review

- Name an owner for the document.
- Add the information a reader needs first.
- Review the page before sharing it.
```

The tree provides the page title. Use headings inside the page for its sections. The [screen layout](contents/md/ux-layout.md) identifies the source editor and preview; [Using the editor](contents/md/editor.md) explains saving and diagnostics.

## Add one source file

Upload a small text file through **Files**, or create one inside the workspace. Copy its project-relative path and embed it on its own line:

```markdown
![Review notes](contents/txt/review.txt)
```

Replace the example path with the file you actually created. Paths resolve from the manifest's folder, not from the Markdown file. See [File embeds](contents/md/embeds.md) for tables, code and other formats.

## Check and build

Save the page and stop the editor with **Ctrl+C**, or open a second terminal in the same folder:

```sh
dooc check
dooc build html
```

Fix reported errors before building. Open `dist/bundle.html` to review the result. It is a document snapshot; further source edits require another build.

## Choose the next step

| Next task | Guide |
| --- | --- |
| Add diagrams and reusable blocks | [Blocks](contents/md/blocks.md) |
| Add a board of validated records | [Structured records](contents/md/subformats.md) |
| Hand off editable source files | [Publish and integrate](contents/md/publishing.md) |
| Open a realistic example | [Sample workspaces](contents/md/samples.md) |
| Inspect syntax without a tutorial | [Reference](contents/md/reference.md) |
