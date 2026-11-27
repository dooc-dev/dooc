Development status as of 2026-11-27. Version 0.0.23 is published; the next patch release targets 0.0.24. This page separates the release candidate, published baseline and remaining work. A feature marked **Shipped** on the **Development → Feature gaps** board is implemented in the source; publication is tracked separately.

## Patch release plan

Reconcile the implementation guides and feature records before publication. Release the current dooc changes through the existing GitHub Actions workflow with a patch increment; the workflow owns the version bump. The plugin SDK has no source changes and does not need a separate release.

Run the complete repository checks and current-host binary checks, then push the candidate to `main`. Require the remote **Check** workflow to pass for that commit before dispatching the release. Verify npm, all four executable archives, checksums and the Homebrew formula afterward. Preserve README files and the existing unresolved feature statuses.

Startup now uses the shared viewer shell. The static-client regression retains the real shell and checks its inline stylesheet and font/script paths at root and nested client paths. New design guides are registered in the documentation; the static icon comparison has figure metadata, and the interactive theme comparison is linked from the source repository because embedded figures do not run scripts.

## Implemented for 0.0.24

| Area | Result | Reference and regression coverage |
| --- | --- | --- |
| Library and Format | Library collects URL references; Format collects files and fenced blocks by extension, with recursive folders, explicit files and optional code blocks. Existing collection pages and source lists migrate on save while preserving page IDs and comments. Included manifests, file moves, exports and published HTML share the settings. | [Collection design](contents/md/manifest-editor.md#library-and-format-implementation-design); formats, manifest-settings, resource-library, build and browser tests |
| Shared settings draft | Settings and the native YAML editor share text-file drafts, undo, validation, conflicts and the editor's auto-save preference. Manual saves, edits during saves and drafts across tool changes use the same controls. | [Manifest editor](contents/md/manifest-editor.md), [Editor](contents/md/editor.md); edit-textfile, manifest-settings and browser tests |
| Viewer startup and mobile layout | The themed viewer frame appears before workspace loading; navigation metadata precedes selected-page compilation. Unrelated page bodies and visual assets stay unloaded. Headers remain visible in their scroll containers, and download failures show bounded, actionable messages. | [Viewer loading](contents/md/viewer-loading.md); compile-page, client-entry, static-client, viewer-startup and resource-download tests |
| Navigation and collection controls | Selected labels show estimated waiting progress and available response-byte progress. Collapsed sidebars retain add-page and version controls; nested collection menus fit the viewport. Subformat choices retain already-added types, and card titles/actions and file-type icons use consistent controls. | [Sidebar behavior](contents/md/ux-sidebar.md), [Subformats](contents/md/subformats.md); nav-loading, file-icons, nav-create, document-versions, subformat-cards and UX browser tests |
| Documentation and branding | The documentation mark uses the selected Solid stroke with its original light/dark colors. Authored icon/theme comparison assets remain design references; generated audit reports and the dated license inventory leave the source tree. | [Icon decision](contents/md/icon-variants.md), [Theme study](contents/md/theme-variants.md), [Generated-file policy](contents/md/development.md#generated-files-and-reports) |

Old Library source lists and content pages remain readable. Saving migrates them to the new Format configuration. Theme palette alternatives are comparison assets; this patch does not adopt a new application palette.

## Published in 0.0.23

| Area | Result | Reference and regression coverage |
| --- | --- | --- |
| Manifest settings | The first workspace tool opens Settings and YAML with one draft, validation, conflict-safe saves, hierarchical disclosure, outlined field labels, and bounded keyboard-accessible path completion. Explicit Library files are indexed, moved and exported. | [Manifest editor](contents/md/manifest-editor.md); manifest-editor, manifest-settings and browser tests |
| Document identity | `document.icon` is the single source for the sidebar header and browser tab, accepting one SVG or light/dark paths. Older sidebar icons migrate on save; duplicate definitions are rejected. Reader and published HTML tabs retain the root title across navigation. | [Document icon](contents/md/manifest.md#document-icon), [Browser tab identity](contents/md/publishing.md#browser-tab-identity); manifest, upload, build and reader checks |
| Navigation and workspace state | Latest-click and Back/Forward handling share cancellation. Stale document/tree responses cannot replace newer state. Node reads can proceed between ordered writes, and navigation avoids body compilation. Files, Git, search, themes and keyboard focus retain their workspace context. | [Sidebar behavior](contents/md/ux-sidebar.md); transport, edit-races, workspace-ux, ux-navigation and ux-state tests |
| Sidebar and figure interaction | Large trees avoid per-row animation work; drag and drop supports return to the root and rejects cycles. Expanded figures support keyboard, middle-button and touch pan/zoom. Escape closes the active language picker first. | [Sidebar behavior](contents/md/ux-sidebar.md); sidebar-collapse, drag-and-drop and resource-download tests |
| Page shortcuts | Space plus arrows traverses siblings, parent and first child without intercepting editable controls. The editor setting persists; plain Space still scrolls. | [Sidebar shortcuts](contents/md/ux-sidebar.md); editor, reader and standalone page-jump tests |
| HTML publishing | Split builds emit immutable assets and replace the entry point atomically. Optional media compression preserves original downloads; size limits and warning failures run before publication. Navigation loads split page content and preserves media and diagram assets. | [Build output](contents/md/cli.md#build-output); build, split-build, media, CLI, MCP and browser tests |
| Project skills over MCP | Explicit `system.skills` paths expose metadata and skill files over Node, browser Worker and relay connections. Reads enforce project/skill boundaries, reject symlinks, respect ignored files and impose size limits. Source ZIPs retain the published directories. | [Project skills](contents/md/web-mcp.md#project-skills); compiler, Node, browser and relay tests |
| Development runtime | Editor and reader share one generated playground while keeping separate processes and endpoints. Reader previews current working files with read-only tools; source reload preserves edits to generated documents. | [Development](contents/md/development.md); dev-workspace, application and browser checks |

The full-size embedded website behavior published in 0.0.22 remains part of this release baseline.

## UX follow-up

All 17 findings from the 2026-11-24 audit and the additional root drag-and-drop issue have implementation fixes and targeted regressions. They cover navigation ordering, canceled transport calls, stale refreshes, Files pane identity/focus, Git and search refresh, theme restoration, sidebar motion, figure interaction and menu dismissal. Implementation notes and regression tests retain the follow-up; one-off report exports are excluded from the source tree under the [generated-file policy](contents/md/development.md#generated-files-and-reports).

The earlier 1,000-row sidebar measurement still contained 33.4 ms frames. Touch checks use synthetic Chromium input. Firefox, Safari and physical touch devices have not been certified by those regressions.

## Open work

The following items retain their existing board status; this patch does not claim to complete them.

- **Planned:** manifest step-up authorization; the unreproduced resource-preview overflow on initial load. The latter still needs an affected source file before a layout change is justified.
- **Design only:** [Diff and portable review artifacts](contents/md/diff.md), and the accepted [sandbox/host plugin architecture](contents/md/plugin-architecture.md). Neither is implemented; the current service-plugin runtime retains its existing trust model.
- **Missing MCP capabilities:** structured subformat/record tools and filtered Library queries. Project skills provide instructions and resources, not these query or mutation APIs.
- **Missing release and supply-chain work:** curated changelog policy, executable attestations/signatures, commit-pinned Actions, dependency audit, automated dependency updates and recurring license checks.
- **Missing security documentation/tooling:** a private reporting policy, one consolidated security-model page and code scanning.

## Release verification

The release candidate must pass the repository's complete `pnpm check`: Biome, TypeScript, production build, unit tests, Chromium browser tests, installer checks, npm contents checks and a packed plugin consumer. Local binary checks exercise the current host. The remote **Check** workflow must pass for the exact commit before dispatching the patch release; the release workflow repeats validation and tests all four Linux/macOS executable targets.

Navigation regressions check immediate selection separately from completed rendering: the selected destination updates before its asynchronous page response, so content assertions wait for the destination body rather than treating the selection marker as a load-completion signal.

Document-link appearance checks use the shared page-opening helper to wait for the mounted reader/editor and fonts before measuring link styles. Startup navigation metadata appears before the final page replaces its sidebar, so the presence of a sidebar link alone does not make its DOM stable for style inspection.

Root and included-document regressions wait for the destination's index or embedded file before checking its body. Manifest settings use a dedicated workspace with a Markdown page, light/dark icons, file collections and the existing 40-directory completion fixture. Keep every completion, draft, undo, validation, conflict and auto-save assertion while avoiding repeated indexing of the unrelated full development playground during form edits; retain the existing timeout.

Workspace picker regressions resolve live option rows and inspect their inherited colors and keyboard positions in one browser evaluation. Opening the picker refreshes its options asynchronously, so a previously resolved element handle may already be detached. Keep all disabled-state, color, keyboard and draft-preservation assertions while removing that test-only race.

Local candidate verification completed on 2026-11-27:

| Check | Result |
| --- | --- |
| Complete `pnpm check` | Passed: Biome, TypeScript, production build, 1,706 unit tests in 170 files, 68 Chromium browser tests, installer checks, npm contents and packed plugin consumer |
| `pnpm build:binary` and `pnpm test:binary` | Passed on Linux x64: standalone CLI, MCP, HTML and reader builds, editor assets, Japanese lint, installer and self update |
| Documentation | Passed: 44 pages compile; the independent source-export and generated-development-workspace regressions pass |
| Workspace picker refresh race | Reproduced the detached-element failure, then passed the affected Chromium branch/unavailable-workspace regression three consecutive times after resolving and inspecting live rows in one evaluation |
| Document-link startup timing | Passed the link appearance, gestures and external-confirmation regression three consecutive times after waiting for the mounted page and fonts |
| Root navigation and manifest settings | Both affected regressions passed three consecutive times; the dedicated settings fixture completed all assertions in 5.8–5.9 seconds locally under the original 120-second limit |
| Test exclusions | No skipped unit or browser tests in the local run; Firefox, Safari and physical touch devices remain untested |

Publication follows the [Release procedure](contents/md/release.md); the workflow owns the package version bump. Published versions and their artifacts are recorded in [GitHub Releases](https://github.com/dooc-dev/dooc/releases), with cross-platform validation in the linked release workflow.
