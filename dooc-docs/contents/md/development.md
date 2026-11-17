Work from a source checkout to change dooc itself. Project authoring starts with [First document](contents/md/quickstart.md), and installation is covered in [Install](contents/md/install.md); plugin authors can start with [Write a plugin](contents/md/plugin-dev.md).

## Set up and run

```sh
mise install
pnpm install --frozen-lockfile
mise run dev
```

Use `mise run dev` to start editor and reader as separate processes, with source hot reload and their own MCP endpoints. Editor uses port 2000; reader uses port 2001. Both use the same generated development document.

```text
dooc · editor
  Client: http://localhost:2000/client/
  MCP:    http://localhost:2000/mcp
  Server: ws://localhost:2000/server

dooc · reader
  Client: http://localhost:2001/client/
  MCP:    http://localhost:2001/mcp
```

Use `mise run editor` or `mise run reader` to start either one independently. Choose another port with `--port`, or pass `--editor-port 2100 --reader-port 2101` to `mise run dev`.

On each port, `/` redirects to `/client/`. Editor exposes its editable workspace at `/server`. Reader carries its read-only connection through `/client` and has no `/server` endpoint. Reader MCP lists only read tools and rejects mutation tools even when called by name. Its pages and MCP read the current working files, including saved edits that have not been committed. Published reader commands still use their document version selection.

The pnpm workspace and its `packages/*` and `plugins` packages remain the development and build structure.

Opening either client URL connects to the generated workspace directly. Source changes restart the server and reload the browser; unsaved editor changes defer the browser reload until they are saved.

The combined task first generates one shared disposable workspace under `build/dev/workspace/`. The independent editor and reader tasks use `build/dev/editor/` and `build/dev/reader/` respectively. `build/` is ignored by the source repository. The generated pages include Markdown, code, a figure, a diagram, records and a schema for feature checks. The workspace has its own Git repository with `main` and `example` branches, so Git checks stay inside the disposable documents. Starting a task again resets its generated workspace. Application source hot reload restarts only the application and preserves the current disposable edits.

While the task runs, changes in `dooc-docs`, `sample/dooc-sample-project`, and `scripts/fixtures/dev-workspace` update their generated copies and trigger document hot reload. A file changed locally in the playground is kept; the terminal lists any conflicting source update. Git history, runtime settings and unrelated local files remain in place. Other sample workspaces, including the URL gallery, are opened explicitly with `--project` and watch their own files directly.

The development task loads the local demo plugins into the generated workspace. It copies the documentation into that playground. Use the regular CLI to edit real documents, including this documentation:

```sh
mise run dooc --help
mise run dooc editor run node --client --server --project dooc-docs
mise run dooc reader run node --client --server --project dooc-docs
mise run dooc build dooc-docs/dooc.yaml
```

From inside `dooc-docs/`, `mise run dooc editor` or `mise run dooc reader` opens that directory's `dooc.yaml` with all components. These are aliases for `run node --all`; options such as `--port 4000` and `--project team.dooc.yaml` override the defaults.

`mise run dooc` forwards arguments unchanged and resolves project paths from the invocation directory. Regular editor and reader commands watch document changes and update the page automatically. `mise run dev` also watches application source code. `mise run packed` takes the same CLI arguments, builds first, and runs only the npm package's published files through its `bin` entry.

## Build and verify

```sh
pnpm exec playwright install --with-deps chromium
pnpm check
mise run packed --help
mise run binary
./build/bin/dooc --help
```

`pnpm check` runs Biome, TypeScript, the production build, unit tests, Chromium browser tests, installer tests, npm package contents checks, and a packed plugin SDK consumer check. Install Chromium once after installing dependencies. To rerun only browser checks, use `pnpm build && pnpm test:browser`; each check uses an isolated browser context and disposable document workspaces. Check and release CI install Chromium before running the same suite. `pnpm test:package` verifies that the npm package includes runtime files without bundling documentation or sample workspaces. `mise run binary` builds and tests a standalone executable for the current machine. Binary CI builds and tests Linux (glibc) and macOS on x64 and arm64; Windows and musl Linux are not targets.

Production npm packages and standalone executables include runtime assets such as fonts, syntax grammars, and the Japanese proofreading dictionary. They do not bundle `dooc-docs`; `dooc reader run node --client --server --project dooc-docs --repo https://github.com/dooc-dev/dooc.git` clones the repository at runtime using system Git. Edit this documentation in `dooc-docs`, and register new pages in its `dooc.yaml`.

## Release

```sh
mise run release dooc patch
mise run release dooc-plugin patch
```

Both commands dispatch GitHub Actions on `main` and wait for publishing to finish. The checklist, what each workflow publishes, and failure recovery are in [Release](contents/md/release.md).

## Repository documents and samples

`dooc-docs/` contains the product reference, UX notes and development guides. Standalone fictional workspaces live in `sample/dooc-sample-saas/` and `sample/dooc-sample-project/`. `sample/dooc-sample-urls/` demonstrates every document URL kind and click behavior; see [Sample workspaces](contents/md/samples.md) for their contents and launch commands.

Integration source lives in `sample/examples/`. The development task loads `sample/examples/reader-plugins/index.mjs` automatically. Pass `--reader-plugins ./sample/examples/reader-plugins/index.mjs` to a regular CLI command to check the same demo integrations. Build its installable extension with `pnpm build:sample-extension`; the output is `build/sample-extension.zip`.

Keep each sample self-contained: no links or schema references to sibling workspaces. Update its authored HTML snapshots when the source data changes. The workspace tests check compilation, local links, record templates, and paths stored in records.

## Keep documentation organized

The sidebar groups pages by reader task: getting started, writing, editing, publishing, reference and development. Put a procedure in its task guide and link to the command or configuration reference for exact options. The screen guide names visible UI areas; the editor guide explains how to use them. Keep fictional operational content in the standalone samples.

Register new pages in `dooc-docs/dooc.yaml`, update links when a section moves, and run the document export checks after changing embedded assets. The dated license audit is retained as a historical appendix.
