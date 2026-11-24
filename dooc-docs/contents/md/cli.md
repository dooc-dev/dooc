Workspace application commands use `--project <path>` and default to `./dooc.yaml`. Local folders, named manifests (`<name>.dooc.yaml`) and local `file://` URLs are accepted. Add `--repo <url>` to `run node` to resolve the project inside a Git clone. Document commands such as `check`, `build` and `zip` accept a positional manifest path. Run `dooc help` or `dooc <command> --help` for details.

`dooc editor` and `dooc reader` are aliases for `dooc editor run node --all` and `dooc reader run node --all`. They read `dooc.yaml` from the directory where the command is run and start the client, workspace server and MCP on port `3000`. Reader workspace and MCP operations remain read-only. Options are forwarded: `dooc editor --port 4000 --project docs/team.dooc.yaml` overrides the port and manifest, and `--no-mcp` disables MCP.

For source development, `mise run dev` starts independent editor and reader processes on ports `2000` and `2001`, or use `mise run editor` / `mise run reader` individually. Those tasks use generated playgrounds and application hot reload; see [Development](contents/md/development.md).

Use the explicit `build`/`run` form to choose components and runtimes. [App runtimes](contents/md/runtimes.md) describes these options and single-port routing.

## Commands

| Command | Purpose |
| --- | --- |
| `dooc editor [options]` | Alias for `dooc editor run node --all [options]` |
| `dooc reader [options]` | Alias for `dooc reader run node --all [options]` |
| `dooc editor <build\|run> <node\|web> [components]` | Build or run selected editor components |
| `dooc reader <build\|run> <node\|web> [components]` | Build or run selected read-only components |
| `dooc init [path]` | Create a manifest without overwriting an existing one |
| `dooc check [dooc.yaml]` | Print a JSON consistency report |
| `dooc build [dooc.yaml] [out-dir]` | Build the reading page as one file: `build/index.html` |
| `dooc zip [dooc.yaml] [out-dir]` | Archive the workspace: `dist/bundle.zip` |
| `dooc editor run node --mcp --mcp-transport stdio` | Serve editable workspace operations over stdio |
| `dooc reader run node --mcp --mcp-transport stdio` | Serve read-only published content over stdio |
| `dooc relay --stdio` | Connect a Desktop MCP host to a browser workspace |
| `dooc relay --public-url <origin> --client-origin <origin>` | Host a browser MCP relay |
| `dooc plugin pack <built-dir> [zip]` | Package a plugin |
| `dooc plugin add <zip> [dooc.yaml] [port]` | Install a plugin and print login links |
| `dooc plugin login <id> [dooc.yaml] [port]` | Open an installed plugin's login flow |
| `dooc plugin remove <zip> [dooc.yaml]` | Remove an installed plugin ZIP and its workspace approval |
| `dooc font add <file> [dooc.yaml]` | Register a project font |
| `dooc font list [dooc.yaml]` | List project fonts |
| `dooc font remove <name> [dooc.yaml]` | Remove a project font |
| `dooc self update` | Update this dooc installation |
| `dooc self docs` | Download documentation and open a local reader |
| `dooc help`, `dooc --help`, `dooc -h` | Show command help |

Explicit application commands require at least one of `--client`, `--server`, or `--mcp`; `--all` selects all three. The shortcuts supply `run node --all` when no action or runtime is given. Runs default to port `3000` and bind to loopback. Document HTML defaults to `build/` and source ZIPs to `dist/` beside the manifest; named manifests use a subdirectory with the manifest name. Explicit relative output paths use the current working directory. Application builds default to `./dooc-<editor\|reader>-<node\|web>` and require an empty output directory.

## Options

| Command | Option | Effect |
| --- | --- | --- |
| `editor run node` | `--shared <branch>` | Record shared-workspace snapshots on the named branch; requires `--server` without `--mcp` |
| `editor/reader run node` | `--repo <url>` | Resolve `--project` inside a Git clone; requires `--server` or `--mcp` |
| `editor/reader run node` | `--tls-cert <pem> --tls-key <pem>` | Serve HTTPS and secure WebSockets |
| `editor/reader … node` | `--reader-plugins <module>` | Load an explicit workspace plugin module |
| `editor/reader … node` | `--server-url <ws-url>` | Set the client's workspace connection |
| `reader` | `--versions <selection>` | Select published versions; default `latest`, or quote `*` for all |
| `build`, `zip` | `--reader-plugins <module>` | Load a build plugin module |
| `build`, `zip` | `--url_preview network\|embed` | Keep URL references (default) or capture remote embeds; static HTML uses `embed` |
| `build` | `--mode static\|live` | Snapshot plugin cards or keep them fetching |
| `build` | `--auth external` | Use host authentication for live HTML |
| `build` | `--source-url <url>` | Set the base URL for record copy links |
| `build` | `--download easy\|normal\|block` | Add resource downloads, keep browser defaults, or suppress in-page saving; default `normal` |
| `check` | `--only render,languages,themes` | Select checks; repeat the flag or use commas; the manifest is always checked |
| `check` | `--allow-shared-svg` | Allow identical SVG bytes across themes |
| `check` | `--warnings-as-errors` | Fail on warnings |
| `editor/reader … node --mcp` | `--mcp-transport stdio\|http` | Select Node MCP transport; default `http` |

| Environment variable | Effect |
| --- | --- |
| `DOOC_TLS_CERT`, `DOOC_TLS_KEY` | TLS defaults for `run node` |
| `DOOC_READER_PLUGINS` | Reader-plugin default for `run node` |
| `DOOC_USER_DIR` | Move personal plugin logins and approvals from `~/.dooc/` |

Explicit flags override their environment defaults. Builds require explicit plugin flags. See [App runtimes](contents/md/runtimes.md#component-options) for all component options.

## Plugins and fonts

`plugin add` and `plugin login` start a local editor on port `5179` by default and print browser login links. Keep the command running while signing in. Pass the manifest before a custom port: `dooc plugin login tracker ./dooc.yaml 5181`. See [Plugins](contents/md/plugins.md) for package installation and authentication.

`plugin remove` takes the installed ZIP file name shown in the **Plugins** tool: `dooc plugin remove tracker.zip ./dooc.yaml`. It removes that ZIP from `.dooc/plugins/` and clears its workspace approval without executing plugin code or starting a server. Saved logins remain available to other workspaces; sign out before removing the plugin to disconnect the account. Named manifests are accepted, and the default manifest is `./dooc.yaml`.

`font add` copies a TTF, OTF, WOFF, or WOFF2 file into the selected workspace's `.dooc/fonts/`. Existing names are never overwritten. `font list` prints registered file names as JSON; use that exact name with `font remove`. Registered fonts are included in HTML and ZIP bundles. Reload the reader after changing them.

## Typical session

```sh
mkdir my-docs && cd my-docs
dooc init
dooc editor
dooc check
dooc build
```

`dooc editor` keeps running while the editor is open. Save your changes and stop it with `Ctrl+C` before continuing, or run `check` and `build` in another terminal.

## Git repositories

```sh
dooc reader run node --client --server --project dooc-docs --repo https://github.com/dooc-dev/dooc.git
dooc editor run node --client --server --project dooc-docs --repo https://github.com/dooc-dev/dooc.git
dooc editor run node --client --server --project dooc-docs/dooc.yaml --repo https://github.com/dooc-dev/dooc.git
dooc editor run node --client --server --project handbook --repo git@example.com:team/docs.git
```

`--project` selects a folder or manifest; `--repo` supplies the repository's clone URL. A folder must contain `dooc.yaml`; an explicit path may select `<name>.dooc.yaml`. Omitting `--project` with `--repo` selects `dooc.yaml` at the repository root. HTTPS, HTTP, and SSH repositories on GitHub or other Git hosts use system Git and its configured credentials. Install Git before using remote sources. Use a clone URL, not a GitHub page URL, `owner/repo` shorthand, or a URL containing passwords, query parameters, or fragments.

Cloning opens the remote's default branch and retains the full Git repository, including history and the origin remote, so branch switching, commits, and pushes remain available. Use the editor's branch selector to open another branch.

`editor run node` saves the clone under `$XDG_DATA_HOME/dooc/workspaces` or `~/.local/share/dooc/workspaces`. Repeating the same normalized clone URL reopens that clone without fetching, pulling, or resetting it. Different document paths selected with that URL share the clone and its working tree. Use the editor's Git tools or Git directly to fetch remote updates. `reader run node` creates a fresh temporary clone on each launch and removes it on exit.

Remote sessions do not execute `docs.config.mjs`, activate workspace plugin ZIPs, or run configured external editor commands. An explicit local `--reader-plugins` module remains supported. Git hooks and checkout filters are disabled in saved clones; submodules are not initialized, and Git LFS content is not downloaded automatically. Documents that depend on these features need a locally prepared checkout opened without `--repo`.

Without `--repo`, the path is local: `dooc editor run node --client --server --project ./dooc-docs`. Local folders, manifest paths, and local `file://` URLs open directly, without cloning or deleting the original files. With `--repo`, the document path must be relative and stay within the cloned repository.

The terminal shows the local URL, operation logs, and Git clone progress. Other downloads show bytes and a percentage when the server supplies a size. Output is plain when redirected or when `NO_COLOR` is set. These messages go to stderr; JSON reports and MCP stdout stay machine-readable.

See [Install](contents/md/install.md#open-the-documentation) for opening this documentation, [Update](contents/md/install.md#update) for installation-specific update behavior, [Development](contents/md/development.md) for source builds, and [Release](contents/md/release.md) for publishing.

## Check report

`dooc check` prints one JSON report and sets the exit code. Use it as the first step of a [pipeline](contents/md/ci.md).

| Check       | Verifies                                                      |
| ----------- | ------------------------------------------------------------- |
| `render`    | Every page compiles; local links and embeds resolve           |
| `languages` | Translations exist under `locales/` and are in their language |
| `themes`    | Theme variants exist under `themes/` and differ               |

| Exit code | Meaning                                         |
| --------- | ----------------------------------------------- |
| `0`       | Passed                                          |
| `1`       | Errors, or warnings with `--warnings-as-errors` |
| `2`       | The command could not run                       |

Each diagnostic has a `code`, a `severity`, a `message`, and a `file`. `line` and `column` are optional and one-based when present. The report includes `schemaVersion`, `checks`, `diagnostics`, `summary`, and `exitCode`.

The CLI first resolves Git-hosted child manifests, which can require Git and network access. The checks then inspect the resolved local sources; embedded remote content is not fetched or verified and is reported as `REMOTE_UNCHECKED`. Language detection is a heuristic; detected mismatches produce warnings. Short text and unsupported formats can produce informational unchecked or inconclusive diagnostics. A passing report does not prove that remote resources are available or that every translation was recognized.

## Build output

`dooc build` publishes the document; `dooc editor build` and `dooc reader build` produce application assets without copying documents. `dooc zip` collects authored dependencies such as child manifests, local pages, schemas, translations, theme variants, fonts and editor-tool definitions. Add `--url_preview embed` to capture supported remote embeds in the ZIP.

`build` writes `<project>/build/index.html` and `zip` writes `<project>/dist/bundle.zip`. A named manifest (`<name>.dooc.yaml`) uses `build/<name>/` and `dist/<name>/`; an explicit output directory is used as it is. The entry point is replaced atomically. Split builds also write content-addressed files under `dooc-assets/`. The HTML folder can be served as it is: archives are written to a different folder, so serving it does not publish them. `build/` and `dist/` are not treated as project content.

| Build                              | Opens                 | URL embeds                                 |
| ---------------------------------- | --------------------- | ------------------------------------------ |
| `build`                            | As one file           | Fetched when opened                        |
| `build --url_preview embed`        | Offline, as one file  | Stored in the file                         |
| `build --mode live`                | With host integration | Fetched when opened                        |
| `build --split`                    | From an HTTP(S) host  | Selected by `--url_preview`                |
| `zip`                              | As a source workspace | Kept as URLs; embeds are not captured      |
| `zip --url_preview embed`          | After unpacking       | Saved in the ZIP; references are rewritten |

`build` and `zip` default to `--url_preview network`: remote embeds are not captured unless you ask for it. Live HTML requires `network`. `--mode static` selects and requires `embed`. Modes apply only to HTML, and `--auth external` requires `--mode live`. The host connects live plugin requests through `window.dooc.setPluginTransport(request)`; the bundle provides no login UI or credentials. Build plugin modules must declare their plugins without a reader `setup` callback. See [Plugins](contents/md/plugins.md#plugins-in-a-build).

Reader HTML also accepts `--download easy|normal|block` (MCP: `download`). The default `normal` hides download buttons and keeps right-click saving; `easy` adds buttons; `block` suppresses in-page downloads, context menus, save/print shortcuts, printed content and media dragging. It replaces `--easy-download`. This setting does not configure browser administrator policies or prevent saving through browser menus, native PDF viewers or developer tools. See [Download behavior](contents/md/publishing.md#choose-download-behavior).

Only embeds are captured; ordinary links stay links. Snapshots require public HTTPS without credentials or redirects. HTML snapshots capture the server's HTML and declarative assets without executing the source site's JavaScript or signing in. HTML network mode fetches content when opened; remote text requires CORS permission from its server. `zip` without `--url_preview embed` does not execute configuration or plugins, and does not capture remote embeds. Git-hosted child manifests are resolved before `build`, `zip` and `check`, including network-mode builds; this can require Git and network access. Their referenced source files are copied under `dooc-imports/` and included in source ZIPs. Authored manifest URLs are retained.

Remote snapshot downloads are limited to 2 MiB per file and 64 MiB / 256 remote assets per build. These download limits do not impose a hosting quota on local source files or generated artifacts. Local builds do not apply dooc.page's per-file hosting limit; deployment limits belong to the destination. A failed download stops the build before the previous output is replaced.

Reader application assets and document resources can be deployed separately: `dooc reader build web --client --server` builds the reader without copying documents, and a host integration supplies its workspace at runtime. `dooc build` defaults to one standalone HTML file. Use `--split` for a publication with separate pages, scripts, styles and deduplicated resource files. Pages load on navigation while the sidebar stays in place. JavaScript reuses the existing esbuild bundles and ESM diagram chunks; page HTML and styles are emitted as external files during rendering. Serve the complete output directory over HTTP(S), including when using `--mode static`. Opening a split publication with `file://` is not supported.

```sh
dooc build dooc.yaml ./publish --split --compress \
  --max-file-size 25MiB --max-build-size 100MiB \
  --warnings-as-errors
```

`--max-file-size` checks each generated file and `--max-build-size` checks their combined bytes after resource optimization and deduplication, including the entry point, page HTML, JS, CSS, fonts and original downloads. Both limits are optional and imply `--split`; there is no default hosting quota. Values accept bytes or `KB`, `MB`, `GB` (decimal) and `KiB`, `MiB`, `GiB` (binary). Files are not arbitrarily sliced into byte chunks. If one document or resource still exceeds a limit, the build reports its output path and actual bytes and stops before replacing the previous entry point. `dooc check` continues to validate document sources rather than deployment budgets.

`--compress` also implies `--split` and uses locally installed `ffmpeg` and `ffprobe`. PNG previews use lossless WebP; JPEG/WebP previews use WebP quality 80, and videos use H.264 CRF 23 with AAC audio. Lossy compression affects published previews only: source files and `--download easy` downloads retain their bytes. An already compatible smaller original is kept. Unsupported media, animations, high bit depth, HDR, video alpha, extra tracks, or unavailable encoders produce warnings and preserve the original. `--warnings-as-errors` makes these warnings fatal. Font files are preserved, and active HTML/SVG data URLs retain their isolated context. Authored non-base64 data URLs and unknown embedded MIME types stay inline. Compression cannot guarantee any requested size; exceeding a budget always fails.

Additional assets are written before the entry point is switched. Unrelated files and older content-addressed assets are retained so previous pages remain readable; use a fresh output directory for deployment. Budgets cover the current build's output, not unrelated files or retained files from older builds. The build API returns those additional files in `files` and the total in `bytes`; MCP exposes the same options as `split`, `compress`, `max_file_size`, `max_build_size` and `warnings_as_errors`.

## MCP server

```sh
claude mcp add docs -- dooc editor run node --mcp --mcp-transport stdio --project /path/to/dooc.yaml
```

Use `reader` for read-only access with the same publication selection as the reader application (`--versions`, default `latest`). Editor MCP reads and edits the working workspace. Transport does not change these permissions. `--mcp-transport http` is the default and serves `/mcp`; `stdio` reserves stdin/stdout for protocol messages and sends logs to stderr. With only `--mcp` selected, stdio opens no network port. Closing stdin stops the selected application components. Node builds preserve the transport in their launcher.

The root `dooc mcp` command has been removed. Replace it with the editor or reader command above and pass the manifest with `--project`. Replace `--git-origin` with `--reader-plugins`; MCP uses the module's Git origin. The old `dooc mcp relay` command is now `dooc relay`. The following tool table describes editor MCP; reader MCP exposes read and check tools only.

| Area    | Tools                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------ |
| Pages   | `list_docs`, `search_docs`, `read_doc`, `add_doc`, `write_doc`, `move_doc`, `rename_doc`, `delete_doc` |
| Figures | `read_figure`, `add_figure`, `delete_figure`                                                           |
| Files   | `list_files`, `read_file`, `write_file`, `upload_file`, `update_files`                                 |
| Library | `list_resources`                                                                                       |
| Fonts   | `list_fonts`, `add_font`, `delete_font`                                                                |
| Output  | `check`, `build`, `zip`                                                                                |
| Git     | `git`                                                                                                  |
| History | `history`                                                                                              |
