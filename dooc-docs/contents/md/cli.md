Commands that operate on a workspace accept an optional manifest path and default to `./dooc.yaml`. A named manifest, `<name>.dooc.yaml`, works the same way. `client`, `build client`, and `self` do not take a manifest. Run `dooc help`, or `dooc <command> --help` for `init`, `server`, `client`, `build`, `check`, `plugin`, `font`, `self`, and `mcp`.

## Commands

| Command                                 | Use it to                                           |
| --------------------------------------- | --------------------------------------------------- |
| `dooc init [path]`                      | Create a manifest; never overwrites an existing one |
| `dooc edit [dooc.yaml] [port]`          | Write and reorganize pages, records, and schemas    |
| `dooc view [dooc.yaml] [port]`          | Read the workspace without editing controls         |
| `dooc server [dooc.yaml] [port]`        | Serve the workspace WebSocket without frontend assets |
| `dooc client [port]`                    | Serve the static editor without a workspace API     |
| `dooc check [dooc.yaml]`                | Print a JSON consistency report                     |
| `dooc build html [dooc.yaml] [out-dir]` | Build a standalone `bundle.html`                    |
| `dooc build zip [dooc.yaml] [out-dir]`  | Build `bundle.zip`                                  |
| `dooc build client [out-dir]`           | Generate a static editor for independent hosting    |
| `dooc export [dooc.yaml] [out-dir]`     | Collect the source files the workspace depends on   |
| `dooc mcp [dooc.yaml]`                  | Serve read and write operations to an MCP client    |
| `dooc plugin pack <built-dir> [zip]`    | Package a plugin as a ZIP                           |
| `dooc plugin add <zip>`                 | Install a plugin ZIP and print login links          |
| `dooc plugin login <id>`                | Open the login flow of an installed plugin          |
| `dooc font add <file>`                  | Register a font in `.dooc/fonts/`                   |
| `dooc font list`                        | List project fonts                                  |
| `dooc font remove <name>`               | Remove a project font                               |
| `dooc self update`                      | Update dooc to the latest release                   |
| `dooc self docs`                        | Download GitHub documentation and open a local viewer |

`edit`, `view`, and `server` default to port `5179`; `client` defaults to `5180`. All bind to loopback. Workspace bundles default to `dist/` beside the manifest; `build client` defaults to `./dooc-client`. See [Editor](contents/md/editor.md#separate-server-and-client) for origin, proxy, and static-host requirements.

## Options

| Command        | Option                             | Effect                                                |
| -------------- | ---------------------------------- | ----------------------------------------------------- |
| `edit`         | `--shared <branch>`                | Several people edit; snapshots go to the branch       |
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

| Environment variable            | Same as                          |
| ------------------------------- | -------------------------------- |
| `DOOC_TLS_CERT`, `DOOC_TLS_KEY` | `--tls-cert`, `--tls-key`        |
| `DOOC_VIEWER_PLUGINS`           | `--viewer-plugins`               |
| `DOOC_USER_DIR`                 | Moves `~/.dooc/` (plugin logins) |

## Typical session

```sh
mkdir my-docs && cd my-docs
dooc init
dooc edit
dooc check
dooc build html ./dooc.yaml ./dist
```

See [Install](contents/md/install.md#open-the-documentation) for the network requirement and temporary files used by `self docs`, [Update](contents/md/install.md#update) for installation-specific update behavior, and [Development](contents/md/development.md) for source builds and release commands.

## Check report

`dooc check` prints one JSON report and sets the exit code. Use it as the first step of a [pipeline](contents/md/ci.md).

| Check       | Verifies                                                      |
| ----------- | ------------------------------------------------------------- |
| `render`    | Every page compiles; links and embeds resolve                 |
| `languages` | Translations exist under `locales/` and are in their language |
| `themes`    | Theme variants exist under `themes/` and differ               |

| Exit code | Meaning                                         |
| --------- | ----------------------------------------------- |
| `0`       | Passed                                          |
| `1`       | Errors, or warnings with `--warnings-as-errors` |
| `2`       | The command could not run                       |

Each diagnostic has a `code`, a `severity`, a `file`, and a one-based `line`. Language detection is a heuristic and reports warnings, not errors.

## Build output

| Build                              | Opens                 | URL embeds                                 |
| ---------------------------------- | --------------------- | ------------------------------------------ |
| `build html`                       | Offline, as one file  | Stored in the file                         |
| `build html --url_preview network` | As one file           | Fetched when opened                        |
| `build zip`                        | After unpacking       | Saved in the ZIP; references are rewritten |
| `export`                           | As a source workspace | Kept as URLs; nothing is downloaded        |

Only embeds are downloaded; ordinary links stay links. A remote file is limited to 2 MiB, and a build to 64 MiB and 256 remote assets. A failed download stops the build before the previous output is replaced.

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
