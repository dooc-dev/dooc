Commands that operate on a workspace accept an optional manifest path and default to `./dooc.yaml`. A named manifest, `<name>.dooc.yaml`, works the same way. `edit` and `view` also accept a folder or local `file://` URL. Add `--repo <url>` to resolve the document path inside a Git clone instead of the local filesystem. `client`, `build client`, and `self` do not take a manifest. Run `dooc help`, or `dooc <command> --help` for command details.

## Commands

| Command                                 | Use it to                                           |
| --------------------------------------- | --------------------------------------------------- |
| `dooc init [path]`                      | Create a manifest; never overwrites an existing one |
| `dooc edit [path] [port]`               | Write and reorganize pages, records, and schemas    |
| `dooc view [path] [port]`               | Read the workspace without editing controls         |
| `dooc server [dooc.yaml] [port]`        | Serve the workspace WebSocket without frontend assets |
| `dooc client [port]`                    | Serve the static editor without a workspace API     |
| `dooc check [dooc.yaml]`                | Print a JSON consistency report                     |
| `dooc build html [dooc.yaml] [out-dir]` | Build a standalone `bundle.html`                    |
| `dooc build zip [dooc.yaml] [out-dir]`  | Build `bundle.zip`                                  |
| `dooc build client [out-dir]`           | Generate a static editor for independent hosting    |
| `dooc export [dooc.yaml] [out-dir]`     | Collect the source files the workspace depends on   |
| `dooc mcp [dooc.yaml]`                  | Serve read and write operations to an MCP client    |
| `dooc plugin pack <built-dir> [zip]`    | Package a plugin as a ZIP                           |
| `dooc plugin add <zip> [dooc.yaml] [port]` | Install a plugin ZIP and print login links        |
| `dooc plugin login <id> [dooc.yaml] [port]` | Open the login flow of an installed plugin      |
| `dooc font add <file> [dooc.yaml]`       | Register a font in `.dooc/fonts/`                   |
| `dooc font list [dooc.yaml]`             | List project fonts                                  |
| `dooc font remove <name> [dooc.yaml]`    | Remove a project font                               |
| `dooc self update`                      | Update dooc to the latest release                   |
| `dooc self docs`                        | Download GitHub documentation and open a local viewer |

`edit`, `view`, and `server` default to port `5179`; `client` defaults to `5180`. All bind to loopback. Workspace bundles default to `dist/` beside the manifest; `build client` defaults to `./dooc-client`. See [Editor](contents/md/editor.md#separate-server-and-client) for origin, proxy, and static-host requirements.

## Options

| Command        | Option                             | Effect                                                |
| -------------- | ---------------------------------- | ----------------------------------------------------- |
| `edit`         | `--shared <branch>`                | Several people edit; snapshots go to the branch       |
| `edit`, `view` | `--repo <url>`                     | Resolve the document path inside a Git clone          |
| `edit`, `view` | `--tls-cert <pem> --tls-key <pem>` | Serve over HTTPS                                      |
| `edit`, `view` | `--viewer-plugins <module>`        | Load a viewer plugin module                           |
| `server`       | `--viewer-plugins <module>`        | Load plugins for the workspace service                |
| `server`       | `--client-origin <origin>`         | Allow one browser origin; default `http://localhost:5180` |
| `client`, `build client` | `--server <ws-url>`       | Preconfigure an optional workspace connection          |
| `build`        | `--viewer-plugins <module>`        | Load a build plugin module                            |
| `build`        | `--url_preview embed\|network`     | Store URL content in the bundle, or fetch when opened |
| `build html`   | `--mode static\|live`              | Snapshot plugin cards, or keep them fetching          |
| `build html`   | `--auth external`                  | The host supplies authentication for live HTML        |
| `build html`   | `--source-url <url>`               | Base URL for the copy link on record cards            |
| `build html`   | `--easy-download`                  | Offer each embedded file as a download                |
| `check`        | `--only render,languages,themes`   | Select checks; the manifest is always checked         |
| `check`        | `--allow-shared-svg`               | Allow identical SVG bytes across themes               |
| `check`        | `--warnings-as-errors`             | Fail on warnings                                      |
| `mcp`          | `--git-origin <module>`            | Take the Git origin from a plugin module              |

| Environment variable            | Effect                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| `DOOC_TLS_CERT`, `DOOC_TLS_KEY` | Defaults for `edit`/`view` `--tls-cert` and `--tls-key`       |
| `DOOC_VIEWER_PLUGINS`           | Default for `edit`/`view` `--viewer-plugins`                  |
| `DOOC_USER_DIR`                 | Moves `~/.dooc/` (plugin logins and approvals)                |

Explicit TLS and viewer-plugin flags override their environment defaults. `server` and `build` require the explicit `--viewer-plugins` flag.

## Plugins and fonts

`plugin add` and `plugin login` start a local editor on port `5179` by default and print browser login links. Keep the command running while signing in. Pass the manifest before a custom port: `dooc plugin login tracker ./dooc.yaml 5181`. See [Plugins](contents/md/plugins.md) for package installation and authentication.

`font add` copies a TTF, OTF, WOFF, or WOFF2 file into the selected workspace's `.dooc/fonts/`. Existing names are never overwritten. `font list` prints registered file names as JSON; use that exact name with `font remove`. Registered fonts are included in HTML and ZIP bundles. Reload the viewer after changing them.

## Typical session

```sh
mkdir my-docs && cd my-docs
dooc init
dooc edit
dooc check
dooc build html ./dooc.yaml ./dist
```

`dooc edit` keeps running while the editor is open. Save your changes and stop it with `Ctrl+C` before continuing, or run `check` and `build` in another terminal.

## Git repositories

```sh
dooc view dooc-docs --repo https://github.com/dooc-dev/dooc.git
dooc edit dooc-docs --repo https://github.com/dooc-dev/dooc.git
dooc edit dooc-docs/dooc.yaml --repo https://github.com/dooc-dev/dooc.git
dooc edit handbook --repo git@example.com:team/docs.git
```

The first argument selects a folder or manifest; `--repo` supplies the repository's clone URL. A folder must contain `dooc.yaml`; an explicit path may select `<name>.dooc.yaml`. Omitting the document path with `--repo` selects `dooc.yaml` at the repository root. HTTPS, HTTP, and SSH repositories on GitHub or other Git hosts use system Git and its configured credentials. Install Git before using remote sources. Use a clone URL, not a GitHub page URL, `owner/repo` shorthand, or a URL containing passwords, query parameters, or fragments.

Cloning opens the remote's default branch and retains the full Git repository, including history and the origin remote, so branch switching, commits, and pushes remain available. Use the editor's branch selector to open another branch.

`edit` saves the clone under `$XDG_DATA_HOME/dooc/workspaces` or `~/.local/share/dooc/workspaces`. Repeating the same normalized clone URL reopens that clone without fetching, pulling, or resetting it. Different document paths selected with that URL share the clone and its working tree. Use the editor's Git tools or Git directly to fetch remote updates. `view` creates a fresh temporary clone on each launch and removes it on exit.

Remote sessions do not execute `docs.config.mjs`, activate workspace plugin ZIPs, or run configured external editor commands. An explicit local `--viewer-plugins` module remains supported. Git hooks and checkout filters are disabled in saved clones; submodules are not initialized, and Git LFS content is not downloaded automatically. Documents that depend on these features need a locally prepared checkout opened without `--repo`.

Without `--repo`, the path is local: `dooc edit ./dooc-docs`. Local folders, manifest paths, and local `file://` URLs open directly, without cloning or deleting the original files. With `--repo`, the document path must be relative and stay within the cloned repository.

The terminal shows the local URL, operation logs, and Git clone progress. Other downloads show bytes and a percentage when the server supplies a size. Output is plain when redirected or when `NO_COLOR` is set. These messages go to stderr; JSON reports and MCP stdout stay machine-readable.

See [Install](contents/md/install.md#open-the-documentation) for opening this documentation, [Update](contents/md/install.md#update) for installation-specific update behavior, and [Development](contents/md/development.md) for source builds and release commands.

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

The check runs offline: remote content is not fetched or verified, and is reported as `REMOTE_UNCHECKED`. Language detection is a heuristic; detected mismatches produce warnings. Short text and unsupported formats can produce informational unchecked or inconclusive diagnostics. A passing report does not prove that remote resources are available or that every translation was recognized.

## Build output

| Build                              | Opens                 | URL embeds                                 |
| ---------------------------------- | --------------------- | ------------------------------------------ |
| `build html`                       | Offline, as one file  | Stored in the file                         |
| `build html --url_preview network` | As one file           | Fetched when opened                        |
| `build html --mode live`           | With host integration | Fetched when opened                        |
| `build zip`                        | After unpacking       | Saved in the ZIP; references are rewritten |
| `build zip --url_preview network`  | After unpacking       | Kept as URLs                               |
| `export`                           | As a source workspace | Kept as URLs; nothing is downloaded        |

HTML and ZIP builds default to `--url_preview embed`; live HTML defaults to and requires `network`. An explicit `--mode static` requires `embed`. Modes apply only to HTML, and `--auth external` requires `--mode live`. The host connects live plugin requests through `window.dooc.setPluginTransport(request)`; the bundle provides no login UI or credentials. Build plugin modules must declare their plugins without a viewer `setup` callback. See [Plugins](contents/md/plugins.md#plugins-in-a-build).

Only embeds are downloaded; ordinary links stay links. Snapshots require public HTTPS without credentials or redirects. HTML snapshots capture the server's HTML and declarative assets without executing the source site's JavaScript or signing in. HTML network mode fetches content when opened; remote text requires CORS permission from its server. `export` does not execute configuration or plugins, and does not download remote content.

A remote file is limited to 2 MiB, and a build to 64 MiB and 256 remote assets. A failed download stops the build before the previous output is replaced.

## MCP server

```sh
claude mcp add docs -- dooc mcp /path/to/dooc.yaml
```

| Area    | Tools                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------ |
| Pages   | `list_docs`, `search_docs`, `read_doc`, `add_doc`, `write_doc`, `move_doc`, `rename_doc`, `delete_doc` |
| Figures | `read_figure`, `add_figure`, `delete_figure`                                                           |
| Files   | `list_files`, `read_file`, `write_file`, `upload_file`, `update_files`                                 |
| Library | `list_resources`                                                                                       |
| Fonts   | `list_fonts`, `add_font`, `delete_font`                                                                |
| Output  | `check`, `build`, `export`                                                                             |
| Git     | `git`                                                                                                  |
| History | `history`                                                                                              |
