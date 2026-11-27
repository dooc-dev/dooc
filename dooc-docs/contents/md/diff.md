Status: **Proposed; not implemented.** This page specifies the comparison command, shared comparison data, reader/editor behavior, and portable review artifacts. Examples below describe the proposed interface, not commands available in the current release.

The primary sharing workflow is to compare two versions, automatically find the files that changed, and send one small review HTML file through Slack or another file-sharing service. Users do not select a chapter or assemble dependencies by hand. When only one chapter changes, only that chapter's changes enter the review artifact.

The reader and editor also need a complete document with changes marked in context. These experiences share one comparison result, but a portable artifact does not carry the reader's entire document data.

## Command

```text
dooc diff [<to> | <from> <to>] [options]

--format text|json|html|pdf  Output format; default: text
--project <path>            Workspace folder or manifest; default: ./dooc.yaml
--out <file>               Output file; relative to the invocation directory
--exit-code                Return 1 when differences exist; errors return 2
--help, -h                 Show usage and selector examples
```

Use one command with an output option. Formats do not become subcommands: `dooc diff html` would unnecessarily occupy a position intended for a version. Terminal output is named `text`; a TUI means an interactive application, not colored text. If keyboard-driven terminal review becomes necessary, add `--interactive` separately, using the same comparison result. It is outside the initial implementation.

```sh
# Compare committed HEAD with saved working files.
dooc diff

# Compare the preceding document version with the latest document version.
dooc diff latest

# Compare two explicit document versions, in the written direction.
dooc diff 1.2.0 1.3.0
dooc diff latest~2 latest

# Compare two Git snapshots directly.
dooc diff git:main git:feature

# Automatically package only changes for a file attachment.
dooc diff --format html --out review.html
dooc diff latest --format html --out release-review.html

# Reuse the comparison for automation or a printable review.
dooc diff latest --format json --out review.json
dooc diff latest --format pdf --out review.pdf
dooc diff git:HEAD current --exit-code
```

`--project` follows the existing workspace commands. A positional project path would conflict with version operands, so it is not accepted here. The format remains explicit; a file extension does not change the serializer. The initial command has no manual chapter selection, full-workspace export, Slack integration, or manifest configuration switches.

### Endpoint selection

| Selector | Meaning |
| --- | --- |
| `current` | A frozen capture of the current workspace's saved files |
| `latest` | The highest available committed or retained document version, using existing numeric version ordering |
| `latest~N` | Entry N positions below `latest` in that descending version list; `latest~0` equals `latest` |
| `1.2.3` | That exact document version in the selected manifest's catalog |
| `git:<ref>` | A Git commit selected by a branch, tag, SHA, or supported ancestry suffix, for example `git:HEAD~2` |

`latest~1` counts document versions, not commits and not subtraction from the patch number. Unrelated commits do not create a new document version. `git:HEAD~1` follows the first parent by Git's [revision rules](https://git-scm.com/docs/gitrevisions). Bare integers such as `0` and `1`, `latest-1`, and the misspelling `latast` are not aliases. Errors suggest the supported spelling without silently changing the requested endpoint.

The existing meaning of `latest` must remain unchanged. It is a numeric maximum and can differ from HEAD if a branch lowers or reuses version numbers. The selected manifest and current branch's existing first-parent catalog determine document selectors. Repeated version labels use the catalog's existing representative revision; a caller requiring a specific occurrence uses `git:<SHA>`. Every report includes the concrete source identity alongside the human version label.

| Operands | Expanded comparison |
| --- | --- |
| None | `git:HEAD` to `current` in a Git workspace; this default is confirmed |
| `current` | The same comparison as no operands |
| One document selector | Its preceding lower entry in the available version catalog to the selected entry |
| One `git:<ref>` | The selected commit's first parent to that commit |
| Two selectors | The first endpoint to the second endpoint, without reordering |

For example, `dooc diff latest~1` compares `latest~2` to `latest~1`. A single argument means "the change introduced by this version"; this differs from Git's single-commit working-tree shorthand and must be explicit in help. When a predecessor is unavailable, fail with a clear explanation; do not invent an empty version or silently compare with the working tree. Equal endpoints produce a valid empty report. Explicit reversed endpoints intentionally reverse additions and deletions.

Outside Git, reuse existing retained snapshots for document selectors. If a baseline exists, no operands compare the latest retained snapshot with `current`. Otherwise report that a historical baseline is required. `git:` always requires Git. No new snapshot store is introduced.

Two explicit endpoints are compared directly. There is no implicit merge-base calculation and no `A..B` or `A...B` syntax in the first release. Git also distinguishes a [two-endpoint diff from revision ranges](https://git-scm.com/docs/git-diff). A later PR-review mode must be explicit about choosing a merge base.

### Output behavior

Text and JSON go to stdout unless `--out` is supplied. Text uses color only on an appropriate terminal and respects `NO_COLOR`; redirected output is plain text. JSON is one versioned machine-readable object. Progress, diagnostics outside the report, and written-file paths go to stderr.

HTML and PDF default to `<project>/build/diff.html` and `<project>/build/diff.pdf`, using the existing named-manifest subdirectory convention. `--out` overrides the exact file path. Report the completed artifact's byte size. Write atomically and reject destinations that would overwrite source files, manifests, or Git metadata. A failed export preserves the previous output.

Successful comparisons return 0, including an empty diff. With `--exit-code`, a completed comparison with changes returns 1. Invocation, unavailable-history, snapshot, and export failures return 2. A timeout that prevents detailed text comparison must never be interpreted as no changes.

## Resolve snapshots, then compare

Git supplies committed source data. It does not supply the presentation model. Resolve both selectors once to immutable commit IDs or retained snapshot IDs, capture the working tree if requested, and compare the resulting document inputs. Do not check out another revision, stash, stage, commit, or modify version counters.

`current` contains the final saved working files, including referenced untracked files allowed by existing source rules. Staging does not change the comparison baseline. The index is not a separate endpoint. CLI commands cannot see unsaved browser drafts. The editor may explicitly overlay its drafts when comparing with `Current (unsaved)`; capture that overlay and give it a content digest so an exported review represents exactly what was shown. A later edit marks the displayed comparison as stale instead of silently moving its anchors.

Read the manifest and dependency graph independently at each endpoint. Compare the union of both graphs so deleted files and removed references remain visible. Include relevant manifests, source pages, records, schemas, local embeds, translations, and theme variants under the existing ownership and dependency rules. Exclude unrelated repository files, generated output, caches, and runtime credential stores. A formatting-only source change still appears even if it does not advance the semantic document version.

Use the selected manifest's scope, including local included documents. A remote section has its own source repository and version catalog. Git-hosted dependencies need retained content or an immutable recorded revision; today's moving remote branch is not evidence of its historical content. Missing required historical inputs are errors. External URL content is not compared merely because its live response changes; compare the authored URL and any already captured immutable data.

Resolve refs with argument-based Git calls and validate that they identify one commit. Do not pass user text through a shell, accept option-like refs, run repository-configured diff drivers, or execute historical configuration and plugins. Reuse existing path, symlink, size, and read-only snapshot validation. Freeze a consistent capture or fail if files change during capture. Missing objects and shallow history must produce actionable errors rather than guessed versions.

## One comparison result, two consumers

The engine compares complete authorized snapshots and produces a shared `ChangeSet`. Reader/editor rendering combines that result with full snapshot content. Artifact serialization projects only the review material from that result.

```text
Selected versions -> frozen source snapshots -> ChangeSet
                                               |
                         +---------------------+------------------+
                         |                                        |
                Reader/editor                            Review artifact
                Full document + markers                  Changed files + excerpts
                                                         text / JSON / HTML / PDF
```

Do not make the reader reconstruct a complete document from a patch, and do not serialize the full reader state into a compact attachment.

### Comparison contract

| Field | Contract |
| --- | --- |
| `schemaVersion` | Version of the comparison data contract; initially 1 |
| `comparisonId` | Deterministic digest of ordered snapshot identities, manifest scope, and contract version; not an authorization token |
| `scope` | Selected manifest and source identity; portable metadata excludes local absolute paths and credential-bearing URLs |
| `from`, `to` | Requested selector, resolved revision, optional document version, immutable content digest, and dirty/draft state |
| `changes` | Changed file entries, old/new paths, presence in each document graph, change kind, content hashes, and text hunks or binary metadata |
| `affectedDocuments` | Documents whose rendered content is affected by a changed dependency, with the reason and responsible changed file |
| `diagnostics` | Structured failures or limitations, including unavailable fine-grained rendering; never silently missing changes |

Full snapshots remain separate inputs, accessible through the current source and workspace layers. They are not mandatory fields in serialized JSON. Keep source ranges and identities independent of generated DOM IDs and visual hunk numbering.

Text comparisons retain whitespace and final-newline changes. Hunk display uses one-based line numbers. Source anchors use zero-based, half-open UTF-16 offsets into the exact decoded source, plus its content hash; do not normalize Unicode before identifying an anchor. Unsupported text encodings and binary formats get metadata comparisons instead of lossy text decoding. Source bytes and membership are authoritative; parsed structure improves presentation but does not hide source changes.

Match identical paths first. A unique equal-content deletion/addition pair may be labeled a rename; ambiguous pairs remain additions/deletions. A move with content edits may initially be represented as deletion plus addition. Do not require heuristic rename detection for correctness or comment identity.

### Automatic review selection

The default artifact contains only files whose source, relevant file metadata, or membership in the document graph differs. Relevant metadata means file type, executable mode, or symlink target, not modification timestamps. Do not require a manually selected chapter or include every file under a changed file's directory. An unchanged page that embeds a modified image is an affected document, not another changed source file.

1. Compute differences over the union of the two complete source graphs.
2. Select changed files automatically, including additions, deletions, renames, and changed manifest references.
3. Include each file's changed hunks with three lines of unchanged source context on each side; merge overlapping context.
4. Add minimal labels and rendered excerpts needed to understand the change. Render complete changed Markdown blocks when necessary, without copying unrelated blocks or pages.
5. Include only viewer resources and document assets actually required by those excerpts, deduplicated by content hash. Prefer a clearly labeled metadata card for binary changes over embedding original large images, videos, PDFs, or fonts. A binary card states when original content is not included.

An added or deleted file can legitimately make the artifact large because its complete textual content changed. Do not silently truncate that content to meet a guessed Slack upload limit. Show output size and explicit omitted-preview notices. Large or unsupported semantic rendering falls back to exact source hunks, not an empty difference. Reuse existing export bounds and fail before replacing an artifact if required content exceeds them.

The serialized artifact declares `coverage: "changes"`. Absence from the artifact means omitted unchanged or out-of-scope content, not deletion. File removal and removal from the document graph are distinguished in the change entry. Full-file expansion is unavailable when those bytes were not included; a local attachment must not make hidden network requests to fetch the rest.

For a change to one paragraph in `contents/md/setup.md`, the HTML contains that file's changed excerpt, its context, pair metadata, and small viewer assets. Other chapters and unchanged source files are absent from the payload, not just hidden by the UI. If a schema or shared image also changed, it receives its own change entry and affected-document links.

## Reader and editor

The reader is a reading surface: show the target version's full document with additions and modifications marked. Deleted text or blocks remain available at their previous position or in a clearly labeled adjacent deletion entry. Removed pages remain reachable through the changes list. Offer a switch to a review view listing changed files, unified changes, and optional side-by-side comparison.

Add a Compare action alongside the existing version control. The comparison header names From and To, their actual versions/revisions, and any unsaved state. Selectors use the owning manifest's catalog. A reader defaults to the displayed version and its preceding available published version; the editor defaults to committed HEAD and current content. Opening a comparison never switches branches or saves drafts. Closing it restores the previous reading/editing position.

In the editor, reuse the existing base-text and CodeMirror diff decorations for source editing, but distinguish their normal HEAD baseline from an explicitly selected comparison baseline. A comparison between two historical versions stays read-only. Keep the current draft available when the user returns.

The changes list shows additions, modifications, deletions, and affected dependencies with text labels, not color alone. Provide next/previous change navigation, keyboard focus, accessible version labels, and a narrow-screen stacked layout. Large file lists render incrementally. Empty, loading, stale, missing-history, unavailable-preview, and denied-version states are explicit. If a page disappeared, retain its old content in review instead of routing to an unrelated page.

Reader publication rules apply to both endpoints before any snapshot or diff data is returned. `--versions latest` cannot expose a hidden preceding version through comparison. If only one version is published, explain that comparison requires another published version. Apply the same checks in the Node workspace and browser worker; readers cannot resolve arbitrary `git:` refs or `current` to unpublished local content. A static reader can compare only snapshots already delivered to it.

## Portable HTML and PDF

HTML is a single offline review document. It embeds the compact review data, stylesheet, and optional interaction code; it does not require a running dooc server, original repository, CDN, or complete document bundle. Its default view is the changed-file list and contextual differences. Basic review works without JavaScript through normal links and readable diff sections. JavaScript adds search, collapse/expand, next/previous change, and layout switching over the same included material.

Use the existing typography, light/dark tokens, source renderers, escaping, and preview isolation. Source HTML, SVG scripts, and plugin code are content, not executable review logic. Serialize embedded data safely, retain deleted-file labels and old/new paths, and avoid relying on interactive frames for core review content. Do not load remote embeds automatically when an attachment is opened.

PDF uses the same compact report and print rendering, with all change sections expanded. Include endpoint metadata, file headings, clear addition/deletion labels, and legible pagination; navigation and comment controls are omitted. It is a frozen review copy, not a separate diff algorithm.

The repository currently has PDF previews and Playwright browser tests, but no production PDF export pipeline. Implementing `--format pdf` requires an explicit supported browser-rendering runtime and distribution checks for both npm and standalone executables. Development-only Playwright availability is not sufficient. HTML printing provides the initial manual PDF path; ship the CLI PDF format only when its runtime, missing-browser error, and output verification are complete. Do not advertise an unimplemented format in released CLI help.

## Future connected comments

Reading an attachment stays offline. Connecting to a review service is an explicit later action and does not change the compared snapshots. The service stores comments separately from the HTML. A copied HTML file retains its snapshot and comparison identities, so it can reconnect to the same review without embedding an account or credential. Anyone receiving the attachment can read its embedded content, including deleted old text; later authentication protects service operations, not already delivered content.

A comment anchor records the service's validated repository/document binding, manifest, immutable revision or draft digest, old/new side, source path, content hash, source range, and quoted text with surrounding context. A line number, version number, or generated hunk ID alone is insufficient. Comments on removed text attach to the old side. Do not silently move an ambiguous anchor onto a later version; retain it as outdated or unresolved.

Reuse the existing external-authentication and host-transport boundary described in [Publishing](contents/md/publishing.md). The configured review service owns authorization, login integration, and comment storage. An identity provider URL alone does not provide a comments API. Neither an embedded endpoint nor a matching digest grants permission to read a version or post a comment. Changing services requires a new validated binding and session; credentials do not transfer between destinations.

Local `file://` documents commonly have opaque origins under the browser's [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy#file_origins). Offline reading is the initial guarantee. For connected review, use a trusted HTTPS host that opens the portable data with its authenticated transport. Do not promise that changing an authentication URL makes an arbitrary downloaded HTML file a valid OAuth client, and do not broadly allow credentialed `Origin: null` requests. A future local bridge would need a separate origin and authentication design.

Keep access tokens, cookies, and secrets out of HTML, JSON, and PDF. Connect only after the reviewer selects a trusted destination; never upload source data simply because the file was opened. Posting a comment is a distinct permission from editing the document. The initial release creates no authentication UI, comment backend, synchronization queue, or Slack sender.

## Implementation reach

| Area | Existing code to reuse or extend |
| --- | --- |
| Version selection and source capture | `packages/engine/src/core/document-version.ts`, `packages/server/src/document-versions.ts`, `packages/workspace/src/browser-versions.ts`, retained snapshot helpers |
| Dependency scope | `packages/engine/src/compiler/export.ts`, `version-input.ts`, manifest ownership and source-origin helpers; collect both endpoints without executing configuration |
| Shared comparison | A small engine module using the already installed `diff` package; pure inputs and one change model for Node and browser |
| CLI and output | `packages/server/src/cli.ts`, `build-output.ts`; dedicated comparison dispatch and compact serializers |
| Workspace access | `packages/server/src/workspace-server.ts`, `packages/frontend/src/workspace-worker.ts`, `packages/workspace/src/read-only.ts`, capability advertisement and request tests |
| Reader/editor | `packages/frontend/src/document-versions-ui.ts`, `edit-git-diff.ts`, `document-application.ts`, shared controls and localization files |
| Portable rendering | Existing compiler/frontend rendering and bundle infrastructure; a compact review entry without the whole editor application |
| Packaging | `package.json`, lockfile and build assets; if Node imports `diff` directly, move it from development-only to runtime dependencies; explicitly solve PDF runtime packaging |
| Documentation and verification | CLI/version documentation when released; version, section, browser-version, diff, read-only, CLI, build, package, and browser fixtures |

Do not replace existing Git status operations or version-switch behavior with this feature. In particular, the editor can open the catalog's current entry as a mutable workspace today; comparison must use its pinned historical source reader instead. Raw Git endpoints require validated immutable snapshot access rather than bypassing published-version checks through the existing open-version operation. No new public SDK or MCP tool is required for this design.

Implement in coherent steps: shared comparison and text/JSON; compact standalone HTML and shared reader/editor views; then the production PDF path. All requested output formats remain in scope. Connected comments and a terminal TUI follow only as separate requested features. Each released step must label its actual supported formats accurately.

### Acceptance cases

- No operands compare HEAD with final saved working content, including staged edits and referenced untracked additions; unsaved editor drafts require the explicitly labeled overlay.
- Document offsets skip unrelated commits, preserve existing numeric ordering, and differ correctly from first-parent Git offsets. Initial versions, unavailable predecessors, detached HEAD, reused labels, and reversed endpoints have defined results.
- Added/deleted files, reference removal, identical-content renames, changed dependencies, binary files, whitespace, missing final newlines, and malformed renderable content remain visible.
- A one-paragraph change produces a compact artifact containing that file's hunks; an unrelated unchanged chapter with a sentinel string is absent from serialized JSON and HTML, not merely collapsed. Unchanged media bytes are absent unless actually needed by an included excerpt.
- Original files, drafts, index, HEAD, branches, and retained version state are unchanged after both successful and failed comparisons.
- A reader cannot compare or export a hidden old version, unpublished dirty content, or an arbitrary SHA. Node and browser workspaces enforce the same endpoint restrictions.
- Text and JSON stdout remain clean; exit codes distinguish differences from errors. Failed writes retain the prior artifact, and source destinations are rejected.
- A copied HTML file opened offline shows additions, deletions, comparison identity, and binary omission notices without repository access or network requests. Embedded hostile markup stays inert.
- Reader full-document markers, deleted-page navigation, editor draft return, narrow layouts, keyboard review, and stale results are checked in browser tests.
- PDF includes every changed section without clipped lines or hidden collapsed blocks. Packaged npm and standalone distributions verify the chosen PDF runtime before the format is released.

This document is the implementation design only. Existing commands and application behavior remain unchanged until the corresponding code and checks are added.

## Local sample experiment

The first runnable experiment lives under `.tmp/diff-lab/` and does not add a production CLI command. It creates an isolated Git fixture with committed revisions and working changes, then generates text, JSON, static HTML, interactive HTML, and a browser-printed PDF from real comparisons. Scenarios cover a small single-file edit, mixed additions/deletions/renames, working-tree changes, and no changes. A separate reader sample combines the complete selected document with the same change markers; it is deliberately not the compact sharing artifact.

Use existing `diff` functions, Markdown parsing/rendering, and reader colors. The review surface is a restrained reading tool: comparison identity first, a changed-file navigation list, clearly labeled old/new excerpts, and optional source or side-by-side views. No fabricated comment connection or authentication controls are included. A local index links the generated examples and their actual file sizes.

The generator must verify that unchanged fixture content is absent from compact artifacts, that additions and deletions are retained, that empty comparisons are valid, and that original Git state is preserved. Browser checks cover offline reading, disabled JavaScript, filtering, layout switching, narrow screens, inert hostile source text, and PDF generation. Record the results alongside the samples and open the index in totex. The experiment does not establish production support for all manifest features, remote history, or packaged PDF runtimes.

The local experiment produced comparisons with 1, 7, 3, and 0 changed files. The single-chapter case contains 21,723 bytes of interactive HTML, 18,226 bytes of static HTML, or 1,883 bytes of JSON, against 119,317 bytes of target source data. The unchanged appendix sentinel is absent from the exported content. Exact source hunks and rendered before/after excerpts share the report; rendered excerpts additionally highlight changed words, while the reader sample retains the complete chapter.

Generator assertions, offline and JavaScript-disabled browser checks, 390-pixel layouts, hostile-markup checks, and PDF content/page-bound checks passed. The four PDF samples contain 2, 6, 4, and 1 pages respectively. The scripts, Git fixture, retained source snapshots, screenshots, reports, and generated files remain in `.tmp/diff-lab/`; `RUN.txt` records how to repeat the experiment. These results validate the local sample, not a shipped `dooc diff` command.
