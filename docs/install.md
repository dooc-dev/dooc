# Install dooc

Standalone releases support Linux (glibc) and macOS on x64 and arm64. Node.js,
npm, and Bun are not needed to run them. The executable includes the editor,
fonts, syntax grammars, and Japanese proofreading dictionary.

These commands become available with the first release that includes binary assets.

## mise

```sh
mise use -g github:sasaki-s-sci/dooc@latest
dooc --help
```

## curl

```sh
curl -fsSL https://github.com/sasaki-s-sci/dooc/releases/latest/download/install.sh | sh
```

The installer verifies SHA-256 and installs to `~/.local/bin/dooc`. Add
`~/.local/bin` to your PATH if necessary. It does not require sudo or change
shell configuration. A failed download or checksum leaves the current executable
untouched. To choose the version and directory:

```sh
curl -fsSL https://github.com/sasaki-s-sci/dooc/releases/latest/download/install.sh |
  DOOC_VERSION=0.0.16 DOOC_INSTALL_DIR="$HOME/bin" sh
```

## Homebrew

The source repository also acts as the tap; no separate tap repository is needed.

```sh
brew tap sasaki-s-sci/dooc https://github.com/sasaki-s-sci/dooc
brew install sasaki-s-sci/dooc/dooc
```

Use `brew update && brew upgrade sasaki-s-sci/dooc/dooc` for upgrades.

## Build and release

```sh
mise install
mise run build:binary
./build/bin/dooc --help
mise run release patch
```

CI builds and tests the executable on all four platforms before release. The
release workflow adds the archives, `SHA256SUMS`, and `install.sh` to GitHub
Releases, and commits the matching Homebrew formula with the version bump.
`mise run release` waits until the binary assets have been uploaded and the
GitHub release has been published.

Windows and musl Linux are not built. Git-backed textfile sources still need Git,
and configured external formatters or linters still need their own tools.
