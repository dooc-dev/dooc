Releases are published only by GitHub Actions, dispatched from a source checkout. Pushes and tags never publish anything. For the checkout itself, see [Development](contents/md/development.md).

| Package       | Command                         | Tag                        | Publishes                                                                                     |
| ------------- | ------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `dooc`        | `mise run release dooc <bump>`        | `dooc-v<version>`          | `@dooc-dev/dooc` on npm, a GitHub release with four executables, and the Homebrew formula     |
| `dooc-plugin` | `mise run release dooc-plugin <bump>` | `dooc-plugin-v<version>`   | `@dooc-dev/dooc-plugin` on npm                                                                |

`<bump>` is `patch`, `minor`, or `major`. The workflow computes the next version itself; never edit `version` in a `package.json` by hand.

## Before you release

1. Commit and push everything to `main`. The workflow releases the remote `main` branch, not your working tree.
2. Confirm the **Check** workflow passed for that commit with the command below.
3. Update `dooc-docs` for the changes being released. `dooc reader run node --client --server --project dooc-docs --repo …` serves the documentation from `main`, so it goes live with the push, not with the release.
4. Confirm GitHub CLI is signed in to an account that may run the repository's workflows: `gh auth status`.
5. Release `dooc-plugin` only when `plugins/` changed. Both workflows share one concurrency group, so two releases started together run one after the other.

```sh
gh run list --repo dooc-dev/dooc --workflow check.yml --branch main --limit 1
gh auth status
```

## Release

```sh
mise run release dooc patch
```

The command dispatches the workflow on `main`, prints the run URL, and waits up to 30 minutes. It reports `status: success` with the new version once the GitHub release (or, for `dooc-plugin`, the npm package) is published. The **Run workflow** button in GitHub Actions starts the same workflow.

If the command times out or is interrupted, the workflow keeps running. Inspect that run before dispatching again; a second dispatch publishes a second version.

## What the dooc workflow does

1. Builds and tests the standalone executable on Linux and macOS, x64 and arm64, with the new version already applied so each executable embeds the version it is released as. In parallel, a separate job bumps `package.json`, runs `pnpm check`, and packs the tested npm package.
2. Waits for both validation jobs to succeed, then downloads the tested npm package, its versioned `package.json`, and the four executables. The publishing job uses that exact package without rebuilding it.
3. Writes `SHA256SUMS` for the four archives.
4. Commits `Release dooc-v<version>`, tags it, and pushes both atomically. Nothing is public before this step.
5. Publishes `@dooc-dev/dooc` to npm.
6. Publishes the GitHub release with the archives, `SHA256SUMS`, `install.sh`, and generated notes, and marks it latest.
7. Updates `Formula/dooc.rb` and the pinned version in the [Install](contents/md/install.md) example from the published `SHA256SUMS`, and pushes that as a second commit. The source repository is also the Homebrew tap, so this push is what makes Homebrew serve the new version.

The plugin workflow tests the plugin runtime, verifies the packed SDK in a separate consumer, commits and tags the bumped `plugins/package.json`, and publishes to npm. It has no executables, GitHub release, or formula.

Check runs cancel older runs for the same branch or pull request. Release runs remain serialized and never cancel an active release. Build and validation jobs have a 15-minute execution limit; publishing has a 10-minute execution limit. These limits start after a runner is assigned and do not shorten GitHub's runner queue.

## After the release

```sh
git pull
npm view @dooc-dev/dooc version
gh release view --repo dooc-dev/dooc
```

`git pull` brings in the release commit and the formula commit. To check an installation, run `dooc self update` or `brew update && brew upgrade dooc`.

## When a release fails

Do not use **Re-run failed jobs** once the tag exists: the run would try to create the same tag again. Dispatch a new release instead. A skipped version number is harmless.

| Failed step                          | State                                                         | Recovery                                                                 |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Binaries, `pnpm check`               | Nothing published                                             | Fix `main` and release again; the same version is reused                 |
| Commit and tag (push rejected)       | Nothing published; `main` moved during the run                | Release again                                                            |
| Publish npm package                  | Tag and version commit exist; no package                      | Fix the cause and release again; the next version is published           |
| Publish GitHub release               | npm has the version; curl and Homebrew still serve the old one | Release again                                                            |
| Update Homebrew formula (push rejected) | Release is complete; Homebrew still serves the old version | Update the formula manually (below)                                      |

### Update the Homebrew formula manually

```sh
git pull
node --import tsx scripts/release/formula.ts
git commit -m "Update Homebrew formula and install example for dooc-v<version>" Formula/dooc.rb dooc-docs/contents/md/install.md
git push
```

The script reads the version from `package.json` and the checksums from that version's published `SHA256SUMS`, so it only works after the GitHub release exists.
