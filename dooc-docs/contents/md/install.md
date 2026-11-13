The standalone executable runs on Linux (glibc) and macOS, on x64 and arm64. It needs no Node.js, npm, or Bun and includes the editor, fonts, syntax grammars, and Japanese proofreading dictionary. Windows and musl Linux are not built.

## Install

| Method   | Command                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------- |
| curl     | `curl -fsSL https://github.com/dooc-dev/dooc/releases/latest/download/install.sh \| sh`           |
| mise     | `mise use -g github:dooc-dev/dooc@latest`                                                         |
| Homebrew | `brew tap dooc-dev/dooc https://github.com/dooc-dev/dooc`, then `brew install dooc-dev/dooc/dooc` |
| npm      | `npm install -g @dooc-dev/dooc` (Node.js 22 or later)                                             |

The curl installer verifies SHA-256 and writes `~/.local/bin/dooc`. A failed download or checksum leaves the current executable untouched. It does not use sudo or touch shell configuration; add `~/.local/bin` to `PATH` if needed. Pick a version or a directory with environment variables:

```sh
curl -fsSL https://github.com/dooc-dev/dooc/releases/latest/download/install.sh |
  DOOC_VERSION=0.0.11 DOOC_INSTALL_DIR="$HOME/bin" sh
```

The source repository also serves as the Homebrew tap. Opening a Git repository URL requires system Git, including when using the standalone executable. Configured external formatters and linters require their own tools.

## Start a project

```sh
mkdir my-docs && cd my-docs
dooc init
dooc edit
```

Open the URL printed in the terminal and add your first page. Keep the command running while using the editor or viewer; **Ctrl+C** stops it. Save your changes before stopping, then run `dooc check` or build commands, or use another terminal for them.

| Command      | Result                                                              |
| ------------ | ------------------------------------------------------------------- |
| `dooc init`  | Creates an empty `dooc.yaml`; never overwrites an existing one      |
| `dooc edit`  | Opens the [editor](contents/md/editor.md); add the first page there |
| `dooc view`  | Opens the same workspace read-only                                  |
| `dooc check` | Reports broken links, embeds, and missing variants                  |

A workspace is the folder that holds `dooc.yaml`. Every path in pages and in the manifest is relative to that folder.

```text
my-docs/
  dooc.yaml          page tree, record types, display settings
  contents/          your files; the folder names are yours to choose
  themes/dark/       optional dark-theme copies
  locales/jpn/       optional translations
  .dooc/             project fonts, plugins, editor tools
```

## Update

| Installed with | Update with                                      |
| -------------- | ------------------------------------------------ |
| curl, npm `-g` | `dooc self update`                               |
| mise           | `mise upgrade github:dooc-dev/dooc`              |
| Homebrew       | `brew update && brew upgrade dooc-dev/dooc/dooc` |

For standalone installations, `dooc self update` verifies SHA-256 before replacing the executable, including custom paths and symlink targets. A failed download or checksum leaves the current installation untouched. Updating requires `sh`, `curl`, `tar`, and either `sha256sum` or `shasum`.

For global npm installations, the command runs `npm install -g @dooc-dev/dooc@latest`. Under mise or Homebrew it prints the package-manager command instead. Update source checkouts, local npm packages, and npx caches through their original installation method.

## Open the documentation

```sh
dooc view dooc-docs --repo https://github.com/dooc-dev/dooc.git
```

This uses system Git to clone the repository's default branch and opens its `dooc-docs` folder in a local read-only viewer. It requires Git and a network connection on each launch; the documentation is not bundled in the npm package or standalone executable and may describe changes newer than your installed version.

Run it from any directory and keep the command running while you read. If the browser does not open automatically, open the printed URL. The clone lives in a temporary directory that is removed when the command exits.

Use `dooc edit dooc-docs --repo https://github.com/dooc-dev/dooc.git` to keep an editable clone with Git history. Repeating the command reopens the saved clone, including offline, without fetching, pulling, or resetting it. To update its documents, use **Fetch** and **Pull** in the editor's Git tool, or run Git in the printed workspace directory. Commit pending changes before using **Pull**. `dooc self update` updates dooc itself; it does not update saved workspaces.

Other Git hosts and SSH URLs are supported; see [Git repositories](contents/md/cli.md#git-repositories) for storage and execution limits. The compatibility command `dooc self docs` downloads read-only documentation from GitHub `main` as a ZIP, so it requires a network connection but no system Git. Its temporary files are removed on exit.

## Share the result

| Goal                            | Command           | Output                 |
| ------------------------------- | ----------------- | ---------------------- |
| One file that opens anywhere    | `dooc build html` | `dist/bundle.html`     |
| Bundle with fetched URL content | `dooc build zip`  | `dist/bundle.zip`      |
| Source files only               | `dooc export`     | `dist/bundle.zip`      |
| Let an agent read and write     | `dooc mcp`        | An MCP server on stdio |

Options are listed in [Commands](contents/md/cli.md). For browser-only editing or separate server/client deployment, see [Editor](contents/md/editor.md#separate-server-and-client). For source builds and releases, see [Development](contents/md/development.md).
