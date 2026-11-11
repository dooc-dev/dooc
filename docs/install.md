# Install dooc

Standalone releases support Linux (glibc) and macOS on x64 and arm64. Node.js,
npm, and Bun are not needed to run them. The executable includes the editor,
fonts, syntax grammars, and Japanese proofreading dictionary.

These commands become available with the first release that includes binary assets.

## mise

```sh
mise use -g github:dooc-dev/dooc@latest
dooc --help
```

## curl

```sh
curl -fsSL https://github.com/dooc-dev/dooc/releases/latest/download/install.sh | sh
```

The installer verifies SHA-256 and installs to `~/.local/bin/dooc`. Add
`~/.local/bin` to your PATH if necessary. It does not require sudo or change
shell configuration. A failed download or checksum leaves the current executable
untouched. To choose the version and directory:

```sh
curl -fsSL https://github.com/dooc-dev/dooc/releases/latest/download/install.sh |
  DOOC_VERSION=0.0.2 DOOC_INSTALL_DIR="$HOME/bin" sh
```

## Homebrew

The source repository also acts as the tap; no separate tap repository is needed.

```sh
brew tap dooc-dev/dooc https://github.com/dooc-dev/dooc
brew install dooc-dev/dooc/dooc
```

Use `brew update && brew upgrade dooc-dev/dooc/dooc` for upgrades.

## Build and release

```sh
mise install
mise run dev edit
mise run dev view
mise run dooc --help
mise run dooc view sample/dooc.yaml
mise run dooc build html sample/dooc.yaml
mise run binary
./build/bin/dooc --help
mise run release dooc patch
mise run release dooc-plugin patch
```

`mise run dev edit` starts the sample editor; `mise run dev view` starts the read-only
viewer. Both enable demo plugins and hot reload for content and application code.
Omitting the mode defaults to `edit`. To use another workspace or port, run
`mise run dev view ../my-docs/dooc.yaml 5180`.
`mise run dooc ...` runs the current local source and forwards arguments to the CLI.
Paths are relative to the directory where you invoke it; the default manifest is
`./dooc.yaml`. `mise run binary` builds and tests the standalone executable.

CI builds and tests the executable on all four platforms before release. The
release workflow adds the archives, `SHA256SUMS`, and `install.sh` to GitHub
Releases, and commits the package version bump.
Maintain `Formula/dooc.rb` directly: after each dooc release, update its version,
all four download URLs, and SHA-256 values from that release's `SHA256SUMS`, then
commit and push the formula. Homebrew uses the previous version until this update.
`mise run release dooc patch` bumps and publishes `@dooc-dev/dooc`, then waits
until the binary assets and GitHub release have been published.
`mise run release dooc-plugin patch` bumps and publishes `@dooc-dev/dooc-plugin`
and waits until npm publishing succeeds. Both commands accept `minor` and `major`
instead of `patch`. Versions are committed on the default branch, with `dooc-v<version>`
tags for dooc and `dooc-plugin-v<version>` tags for the SDK.
Both npm releases run only through `workflow_dispatch`, started by these commands
or GitHub Actions' **Run workflow** button. Pushes and tags do not publish packages.
The mise commands dispatch workflows on `main` in `dooc-dev/dooc` (origin).

Windows and musl Linux are not built. Git-backed textfile sources still need Git,
and configured external formatters or linters still need their own tools.
