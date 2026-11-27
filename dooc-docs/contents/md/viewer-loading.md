# Viewer loading and mobile layout

The viewer is a reading surface. Its existing colors, navigation, controls and desktop layout remain the design authority.

## Viewport and header

Use the dynamic viewport height for the sidebar, document, editor and docked search. The document tree owns sidebar scrolling; the sidebar frame must fit the visible viewport. Keep document controls at the top of their own scroll container, including split previews and narrow screens. Content scrolls beneath an opaque header without moving the section picker out of view.

## Downloads

Keep the existing download security policy and byte-preserving transport. Show short, actionable status beside the control: progress, access denied, unavailable file, or a retryable download failure. Do not suggest permissions for every failure or display raw exception text. Bound the message width so that it cannot widen the document header or overlap adjacent controls. Preserve cancellation, repeated-click protection and retry.

## Progressive startup

1. Serve the viewer frame and its actual shared stylesheet before connecting to a workspace. Restore the stored document/editor themes before the first paint. Display a local loading status in the document area; never replace the viewer with a separate white loading screen.
2. Request navigation metadata derived from `dooc.yaml`. Populate the title, icon and sidebar without compiling document bodies. This read is available to both editor and reader connections and retains their existing access controls.
3. Request the selected page. Compile its Markdown and referenced assets on demand, retaining manifest metadata for other sidebar entries. Full compilation remains available for publishing, checks, search and collection/resource views that require a complete index.
4. Mount the loaded document using the existing reader/editor runtime. Lazy previews continue to load as they become visible. Ignore canceled or superseded responses. Show a retry action in the same themed frame if startup fails.

Navigation can select another page while startup is pending. Use the existing workspace ownership, language, version and abort handling. Remote Git workspace acquisition and browser-folder initialization retain their existing storage and trust boundaries; this change does not add a new transport or weaken download restrictions.

Editor completion candidates use the existing file index even when their bodies have not been loaded. Unloaded term files use their filenames until their definitions are available; loaded terms retain their names and definitions.

## Verification

Check portrait, landscape and desktop layouts with expanded/collapsed sidebars and scrolled documents. Delay navigation and page responses to inspect each startup stage in light and dark themes, including saved themes that differ from the OS. Verify failure/retry and latest-selection behavior. Assert that metadata requests never compile content and selected-page compilation does not read unrelated Markdown or visual assets. Keep full-build, cross-document-link and download security regressions passing.
