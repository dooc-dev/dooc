Development status as of 2026-11-25. This page reconciles the current implementation, the UX follow-up, and the **Development → Feature gaps** board before the next patch release after 0.0.22. A feature marked **Shipped** on the board is implemented in the source; publication is tracked separately below.

## Implemented for this patch

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

The full-size embedded website behavior already published in 0.0.22 remains part of this release baseline.

## UX follow-up

All 17 findings from the 2026-11-24 audit and the additional root drag-and-drop issue have implementation fixes and targeted regressions. They cover navigation ordering, canceled transport calls, stale refreshes, Files pane identity/focus, Git and search refresh, theme restoration, sidebar motion, figure interaction and menu dismissal. The original evidence remains in the repository's `dooc-ux-audit-report.md` / `.html` and `dooc-ux-fix-report.md` / `.html`; their measurements describe that dated run, not universal performance guarantees.

The earlier 1,000-row sidebar measurement still contained 33.4 ms frames. Touch checks use synthetic Chromium input. Firefox, Safari and physical touch devices have not been certified by those regressions.

## Open work

The following items retain their existing board status; this patch does not claim to complete them.

- **Planned:** manifest step-up authorization; the unreproduced resource-preview overflow on initial load. The latter still needs an affected source file before a layout change is justified.
- **Missing MCP capabilities:** structured subformat/record tools and filtered Library queries. Project skills provide instructions and resources, not these query or mutation APIs.
- **Missing release and supply-chain work:** curated changelog policy, executable attestations/signatures, commit-pinned Actions, dependency audit, automated dependency updates and recurring license checks.
- **Missing security documentation/tooling:** a private reporting policy, one consolidated security-model page and code scanning.

## Release verification

The release candidate must pass the repository's complete `pnpm check`: Biome, TypeScript, production build, unit tests, Chromium browser tests, installer checks, npm contents checks and a packed plugin consumer. Local binary checks exercise the current host. The remote **Check** workflow must pass for the exact commit before dispatching the patch release; the release workflow repeats validation and tests all four Linux/macOS executable targets.

Current gate: validation pending. Publication uses the [Release procedure](contents/md/release.md); the workflow owns the package version bump. This page will record the completed validation before dispatch.
