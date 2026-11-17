Document versions identify the document set defined by one [manifest](contents/md/manifest.md), including its referenced files. Each `dooc.yaml` or `<name>.dooc.yaml` has its own version, separate from the dooc application version.

Document versions apply to one manifest and its referenced files. The Node and browser readers use the same numbering and publication selectors.

When a document tree includes other manifests, the version control follows the currently open page. Pages owned by the root use the root manifest's version; pages from an included `dooc.yaml` or named manifest use that manifest's configuration and history. A remote section uses its source Git repository's history, independently of the including workspace. Moving between sections updates the available versions and current selection.

Opening a historical section shows that section's document tree in a read-only workspace. The selected manifest and version are recorded in the URL, so reloading a child section does not select the parent's version. Returning to the current workspace restores its drafts. The original manifest, checkout, and working files stay unchanged while viewing history.

## Configuration

Add `version` at the top level of the manifest. In a Git workspace, omitted settings default to `major: 0`, `minor: git`, and `patch: git`. Major remains a user-controlled number. Outside Git, omit `version` to keep the document unversioned, or explicitly choose fixed values or `hash`.

```yaml
version:
  major: 1
  minor: git
  patch: git
```

The resolved version is `major.minor.patch`.

| Component | Accepted values | Meaning |
| --- | --- | --- |
| `major` | Non-negative integer | Chosen by the user; defaults to `0` |
| `minor` | Non-negative integer, `git`, or `hash` | Fixed value, or automatic increments for manifest definition changes |
| `patch` | Non-negative integer, `git`, or `hash` | Fixed value, or automatic increments for referenced file changes |

A number is a fixed value, not a starting value for a counter. Each component selects exactly one fixed value or automatic source; there are no separate `auto` or `manual` keys. Numeric strings, negative values, fractions, and unknown sources are invalid.

Automatic components must use the same source within one manifest. `minor: git` with `patch: hash`, or the reverse, is invalid because the sources count changes at different times. Numbers can be combined with either source.

To choose major and minor manually while tracking content changes with Git:

```yaml
version:
  major: 1
  minor: 4
  patch: git
```

For a fully manual version:

```yaml
version:
  major: 1
  minor: 4
  patch: 2
```

For automatic versioning without Git:

```yaml
version:
  major: 1
  minor: hash
  patch: hash
```

Fully manual versions need no automatic counter. They change only when the user edits their numbers. Git history or retained build snapshots supply the content for browsing older versions.

## Increment and reset rules

Git counts committed changes. Hash mode counts changes since the previous successful build. Each such comparison is one change unit, regardless of how many files changed.

1. On first activation, automatic components start at `0`; fixed components keep their configured values.
2. When an upper component changes, reset automatic lower components to `0`. Fixed lower components keep their values.
3. Otherwise, a manifest definition change increments an automatic minor once. If minor increments, reset an automatic patch to `0`, even if referenced files also changed.
4. Otherwise, referenced file changes increment an automatic patch once. No relevant change means no increment.

When minor is fixed, a manifest definition change alone does not advance it or patch. Referenced file changes in the same change unit can still advance an automatic patch. Editing a fixed minor explicitly resets an automatic patch.

| Configuration | Change | Result |
| --- | --- | --- |
| `major: 1`, `minor: git`, `patch: git` | First activation | `1.0.0` |
| Automatic minor and patch | Referenced files change | `1.3.2` to `1.3.3` |
| Automatic minor and patch | Manifest definition changes, with or without file changes | `1.3.2` to `1.4.0` |
| Automatic minor and patch | User changes major to `2` | `1.3.2` to `2.0.0` |
| `minor: 4`, `patch: git` | User changes minor to `5` | `1.4.2` to `1.5.0` |
| `minor: git`, `patch: 3` | Manifest definition changes | `1.2.3` to `1.3.3` |
| `minor: 4`, `patch: git` | User changes major to `2` | `1.4.2` to `2.4.0` |
| Any configuration | No relevant change | Unchanged |

## Change detection

Minor compares the parsed manifest definition, excluding the entire top-level `version` block. Comments, formatting, and mapping key order do not count; ordered lists such as the page tree do. Changes to version settings follow the increment and reset rules instead of counting as definition changes.

Patch compares the paths and contents of local files that belong to the document's dependency graph. Include direct manifest references and transitive dependencies, such as Markdown links, images, embeds, schemas, records included by a subformat, translations, and theme variants. Additions and removals count; a rename is a removal and an addition within the same change unit. Use the dependency sets on both sides of a comparison so removed references are not lost.

Unrelated files, generated output, version state, and modification timestamps alone do not count. Changes only to content served by an external URL are outside automatic versioning; changing the URL in a local source still changes that source normally.

## Git source

Git is the preferred source when the document is already in a repository. Derive the counters from committed history without writing a version file, requiring tags, or modifying the repository.

Use the commit where versioning is enabled, or the most recent major change, as the baseline. Walk from that baseline to the target commit along first-parent history, comparing each commit with its first parent. Initialize automatic components at zero, then apply the increment and reset rules, including resets when a fixed minor changes. Read the manifest and its dependencies as they existed at each commit, rather than using only the current file list.

A merge is one change unit relative to its first parent. Its individual side-branch commits are not counted again on the receiving branch. Unrelated commits do not advance the version. Git's [first-parent traversal](https://git-scm.com/docs/git-log#Documentation/git-log.txt---first-parent) defines the history used for this calculation.

Rebuilding the same commit produces the same version. Relevant uncommitted changes keep the committed numeric version and add `+dirty`; saving, staging, or previewing does not advance a committed counter. Before the initial baseline is committed, no committed version is available.

Missing Git or insufficient history is an error, including a shallow clone that does not contain the required baseline. Do not silently switch to hash mode or guess a counter. Each manifest is evaluated independently, including when several manifests share one repository.

Rewriting history can change the derived version. Different branches can also produce the same numeric version, so retain the source commit SHA alongside the version in generated metadata.

## Hash source

Hash mode supports documents without Git. A hash detects a change but cannot recover how many changes occurred, so this mode requires persistent state. Store it under `.dooc/versions.json`, with separate entries for each manifest name in that document root.

Each entry retains the previous resolved version, its version settings, a hash of the normalized manifest definition, and a hash of the referenced paths and file contents. Paths are sorted consistently before hashing. The definition hash excludes `version`; the content hash excludes the manifest, generated output, and the state file itself. Source snapshots are retained under `.dooc/versions/` so historical hash versions remain readable. Back up this directory together with `versions.json`.

For a successful build, compare the build's inputs with the saved state and apply the increment and reset rules once. A repeat build with identical inputs keeps the same number. Multiple edits between builds count as one change unit; edits reverted before the next build do not count. Checking or previewing can calculate a candidate version but must not advance the saved counters.

Save the new state only after a successful build. Failed builds preserve the previous state. Serialize updates with a temporary `.dooc/versions.lock` and replace the state file atomically. Overlapping builds must retry. If a process is terminated while holding the lock, remove that lock only after confirming no build is running.

A manifest without saved state starts with automatic components at zero. Copy the state with the document when continuing its version sequence elsewhere. If the state is lost, the previous counters cannot be reconstructed from the current files alone.

## Resolved version

Expose the resolved version in generated document metadata. Automatic calculation must not write its numeric result back into `dooc.yaml`; the manifest retains the user's fixed values and source selections. Git metadata also retains the source commit and whether the document had relevant uncommitted changes.

## Published versions

Reader run and build commands select the versions available to readers through `--versions`. The default is `latest`, a shorthand for `latest.latest.latest`; it selects exactly one complete version. Version ordering is numeric, not a comparison of publication dates or strings.

```sh
dooc reader run node --all --versions "latest"
dooc reader build node --all --versions "*.*.latest"
dooc reader run node --all --versions ">=1.2.0 <2.0.0"
```

A three-component selector uses `.` as its separator. Each component is a fixed integer, `*` for all values, or `latest` for the greatest available value within its selected parent group. Resolve components from major to minor to patch, using only versions that actually exist.

| Selection | Published versions |
| --- | --- |
| `latest` or `latest.latest.latest` | The single latest complete version |
| `latest.*.*` | All versions in the latest major |
| `latest.latest.*` | All patches in the latest major and minor |
| `1.2.latest` | The latest patch in the 1.2 series |
| `*.latest.latest` | One latest complete version per major |
| `*.*.latest` | One latest patch per major and minor pair |
| `*` or `*.*.*` | All available versions |
| `1.2.3` | Exactly 1.2.3 |
| `>=1.2.0` | All versions from 1.2.0 onward, including later majors |
| `>=1.2.0 <2.0.0` | Versions from 1.2.0 up to, but excluding, 2.0.0 |

For `1.2.9`, `1.3.2`, and `2.0.0`, `latest.latest.latest` selects `2.0.0`, while `*.*.latest` selects all three. Never combine independent maxima into a nonexistent version such as `2.3.9`. A fixed component with no match produces no candidate; do not silently choose an older parent group instead.

Versions outside the selected range are excluded from delivery as well as from the visible list. Reject invalid selectors or an explicit selection with no available version. A document without versioning keeps its existing reader behavior.

`reader build` generates an application rather than copying document history. Store the selection in the generated reader configuration and resolve it against that reader's document source. A static document artifact can offer only the historical content included when it was built; it cannot retrieve later versions on its own.

## Reader selection

When multiple versions are published, place the version pulldown at the bottom of the left sidebar, outside the scrolling document tree. Initially open the latest published version, unless the URL selects a specific published version. Show available versions in descending order and include the concrete version number in the current label.

For `latest` or its full shorthand expansion, publish only the latest version and do not show a version pulldown. Selecting a broader range permits switching among its matching versions.

Keep the current document open when switching versions if it exists in the destination. Otherwise open that version's first document. Include the selected version in the URL so reloads and shared links preserve the selection.

## Editing and drafts

Only the current Git workspace version is editable. This means the selected branch's current working tree and its pending changes, not whichever version has the highest number. Historical versions are read-only: readers can select and copy their content, but cannot save edits into that revision. Opening history must not check out, restore, or overwrite the editable working tree.

Keep drafts attached to their original workspace, version context, and file. Switching versions must retain unsaved text, file and form drafts, and undo history; returning to the editable workspace restores them. Neither switching nor copying historical text implicitly saves, discards, or moves a draft.

Preserve the ability to locate pending work. The editor must identify which workspace or version context and files contain unsaved drafts, including drafts outside the currently displayed version, and allow returning to their owner. Historical views must retain access to this draft navigation even though the historical content itself is read-only. Reader publication filters must not hide the editable workspace or its pending drafts from the editor.

Git history supplies historical source files without adding version tracking files to the repository. Hash mode retains source snapshots after successful `dooc build html` or `dooc build zip` artifact delivery. The programmatic `buildBundle` API returns `version`, `revision` when available, and an optional `commitVersion()` callback; call that callback only after successfully writing the artifact. HTML artifacts include `dooc-version` metadata. Git builds with relevant working changes report `+dirty` without advancing the committed number.

The Git catalog requires complete first-parent history. Browser workspaces support ordinary Git repositories; linked worktrees and symbolic links require the Node runtime. Unsaved editor drafts live in the editing session: switching versions preserves them, while closing the tab still requires saving pending work.
