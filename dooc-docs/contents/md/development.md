Work from a source checkout to change dooc itself. Project authoring and installation are covered in [Install](contents/md/install.md); plugin authors can start with [Write a plugin](contents/md/plugin-dev.md).

## Set up and run

```sh
mise install
pnpm install --frozen-lockfile
mise run dev edit
```

`mise.toml` pins Node.js, pnpm, and Bun. `mise run dev` defaults to the editor for `dooc-docs/dooc.yaml`, with demo plugins and hot reload for content and application code. Choose the viewer, another manifest, or a port explicitly:

```sh
mise run dev view
mise run dev view ../my-docs/dooc.yaml 5180
```

Run the local source CLI with `mise run dooc`. Arguments are forwarded unchanged, paths use the directory where you invoke it, and the default manifest is `./dooc.yaml`:

```sh
mise run dooc --help
mise run dooc view dooc-docs/dooc.yaml
mise run dooc build html dooc-docs/dooc.yaml
```

`mise run packed` accepts the same arguments, builds first, and runs only the npm package's published files through its `bin` entry. Use it to catch files that are present in a checkout but missing from an installation.

## Build and verify

```sh
pnpm check
mise run packed --help
mise run binary
./build/bin/dooc --help
```

`pnpm check` runs Biome, TypeScript, the production build, unit tests, installer tests, and a packed plugin SDK consumer check. `mise run binary` builds and tests a standalone executable for the current machine. Binary CI builds and tests Linux (glibc) and macOS on x64 and arm64; Windows and musl Linux are not targets.

Production npm packages and standalone executables include runtime assets such as fonts, syntax grammars, and the Japanese proofreading dictionary. They do not bundle `dooc-docs`; `dooc view dooc-docs --repo https://github.com/dooc-dev/dooc.git` clones the repository at runtime using system Git. Edit this documentation in `dooc-docs`, and register new pages in its `dooc.yaml`.

## Release

Authenticate GitHub CLI with an account permitted to run the repository's release workflows, then dispatch the appropriate release:

```sh
mise run release dooc patch
mise run release dooc-plugin patch
```

Both commands also accept `minor` or `major`. They dispatch GitHub Actions on `main` in `dooc-dev/dooc` and wait for publishing to finish. If a command times out, inspect its existing workflow run before retrying.

The dooc workflow tests all four binary targets, bumps and commits the package version on the default branch, tags it as `dooc-v<version>`, publishes `@dooc-dev/dooc`, and attaches the executable archives, `SHA256SUMS`, and `install.sh` to a GitHub release. The command reports success after the GitHub release is published.

The plugin workflow validates the runtime and packed SDK, commits the SDK version, tags it as `dooc-plugin-v<version>`, and publishes `@dooc-dev/dooc-plugin`. Its command waits for npm publishing to succeed. Both workflows run only through `workflow_dispatch`, either from these commands or GitHub Actions' **Run workflow** button. Pushes and tags do not publish packages.

### Update the Homebrew formula manually

After each dooc release, update `Formula/dooc.rb` with the new version, all four release archive URLs, and their SHA-256 values from the release's `SHA256SUMS`. Commit and push that formula change. The source repository is also the Homebrew tap; Homebrew keeps installing the previous version until this manual update is published.
