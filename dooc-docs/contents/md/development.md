Work from a source checkout to change dooc itself. Project authoring starts with [First document](contents/md/quickstart.md), and installation is covered in [Install](contents/md/install.md); plugin authors can start with [Write a plugin](contents/md/plugin-dev.md).

## Set up and run

```sh
mise install
pnpm install --frozen-lockfile
mise run editor
```

Use `mise run editor` or `mise run reader` to develop dooc itself with source hot reload. The editor opens at `http://localhost:3000/client/`; the reader uses `http://localhost:3001/client/`. Choose another port with `mise run editor --port 3100` or `mise run reader --port 3101`.

Opening that URL connects to the generated workspace directly. Source changes restart the server and reload the browser; unsaved editor changes defer the browser reload until they are saved.

Each task first generates a disposable workspace under `build/dev/editor/` or `build/dev/reader/`. `build/` is ignored by the source repository. The generated pages include Markdown, code, a figure, a diagram, records and a schema for feature checks. Each workspace has its own Git repository with `main` and `example` branches, so Git checks stay inside the disposable documents. Starting the task again resets its workspace. Source hot reload restarts only the application and preserves the current disposable edits.

These tasks do not open `dooc-docs` or load sample plugins automatically. Use the regular CLI to edit real documents, including this documentation:

```sh
mise run dooc --help
mise run dooc editor run node --client --server --project dooc-docs
mise run dooc reader run node --client --server --project dooc-docs
mise run dooc build dooc-docs/dooc.yaml
```

From inside `dooc-docs/`, `mise run dooc editor` or `mise run dooc reader` opens that directory's `dooc.yaml` with all components. These are aliases for `run node --all`; options such as `--port 4000` and `--project team.dooc.yaml` override the defaults.

`mise run dooc` forwards arguments unchanged and resolves project paths from the invocation directory. Regular editor and reader commands watch document changes and update the page automatically. Only `mise run editor` and `mise run reader` also watch application source code. `mise run packed` takes the same CLI arguments, builds first, and runs only the npm package's published files through its `bin` entry.

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

`dooc-docs/` contains the product reference, UX notes and development guides. Standalone fictional workspaces live in `sample/dooc-sample-saas/` and `sample/dooc-sample-project/`; see [Sample workspaces](contents/md/samples.md) for their contents and launch commands.

Integration source lives in `sample/examples/`. Pass `--reader-plugins ./sample/examples/reader-plugins/index.mjs` explicitly when checking demo integrations. Build its installable extension with `pnpm build:sample-extension`; the output is `build/sample-extension.zip`.

Keep each sample self-contained: no links or schema references to sibling workspaces. Update its authored HTML snapshots when the source data changes. The workspace tests check compilation, local links, record templates, and paths stored in records.

## Keep documentation organized

The sidebar groups pages by reader task: getting started, writing, editing, publishing, reference and development. Put a procedure in its task guide and link to the command or configuration reference for exact options. The screen guide names visible UI areas; the editor guide explains how to use them. Keep fictional operational content in the standalone samples.

Register new pages in `dooc-docs/dooc.yaml`, update links when a section moves, and run the document export checks after changing embedded assets. The dated license audit is retained as a historical appendix.
