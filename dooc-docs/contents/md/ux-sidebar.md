The sidebar chooses what to open and which workspace tools to use. The document tree follows `document.children` in `dooc.yaml`; its selected page appears in the active preview pane.

Selecting a page highlights it immediately while its content loads. You can open or close branches and select another page during loading; the last selection wins. Reader navigation preserves the sidebar and its open branches. Branches and the sidebar expand and collapse smoothly, with movement disabled when reduced motion is requested.

Select the site name at the top to open the root document. The name is highlighted while the root is open; its children appear in the tree below. In edit mode, focus the name and press F2 to rename it, or double-click it.

Titles that link to another document, site page or website are underlined and use the link color. Ordinary content titles keep their normal styling, and no auxiliary destination icon is shown. Regular clicks open content inside dooc; Web URLs fill the central pane with a borderless iframe on desktop and mobile, retaining the sidebar in both reader and editor. Middle clicks and Ctrl/Cmd-clicks open another tab; Web URLs open the original website directly in that tab. Only a confirmed framing refusal shows the external-opening action. See [Clicks and link titles](contents/md/manifest.md#clicks-and-link-titles).

![Sidebar](contents/html/ux-sidebar.html)

## Interaction and update model

### Space + arrow page jump

While the reader content has focus, hold Space and press an arrow key to follow the document tree. In editor mode this applies to the active preview pane. The setting is enabled by default; the editor's upper-right **View settings** menu contains the **space+矢印 page jump** checkbox, whose value is retained in this browser.

| Shortcut | Destination |
| --- | --- |
| Space + Up | Previous page at the same level |
| Space + Down | Next page at the same level |
| Space + Right | First child page; expand the current branch and enter its child in the same action |
| Space + Left | Parent page; top-level pages return to the root document |

The root document has no siblings or parent. At a boundary, the shortcut leaves the selection in place. Navigation follows the authored tree, including branches hidden by narrow-sidebar presentation. A collapsed sidebar does not require an extra keypress before navigation. Moving to a child opens its branch before selecting it, and preserves the existing sidebar motion and reduced-motion behavior.

The shortcut never intercepts typing, IME composition, source editing, form controls, buttons, interactive diagrams, media controls, dialogs, menus, or embedded frames. Focus stays in the reading pane through navigation so repeated commands continue to work. Standalone arrow keys retain their normal behavior. Space is held as a possible chord without scrolling; releasing Space without an arrow scrolls the reading pane down by one page. Releasing Space after a page jump does not scroll. Blur, hidden tabs, focus leaving the reading area, and disabling the setting clear the held-key state.

Selection and branch expansion update synchronously. Page content loads through the same navigation path as ordinary links, sharing cancellation, unsaved-draft handling, browser history, and stale-response protection. Each repeated arrow starts from the latest requested page, even while its content is loading; it never waits for an earlier request or a collapse animation. A canceled or failed navigation restores the actual selection. The same shortcut works in live Node/browser readers, the editor preview, and standalone HTML.

Chrome and Firefox document Space as page scrolling, but do not list a Space-plus-arrow chord as a built-in browser shortcut. Input focus and native control behavior still take precedence. See [Chrome shortcuts](https://support.google.com/chrome/answer/157179?hl=en) and [Firefox shortcuts](https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly).

Implementation touches the shared page shell and shortcut handler, existing navigation/focus integration, the editor setting, and browser regressions. Checks cover sibling/parent/child boundaries, closed branches, collapsed sidebars, held-key repeats, delayed and reversed responses, split panes, checkbox persistence, typing, Space-only scrolling, blur/reset, and standalone readers.

Navigation must respond to the user's latest selection independently of document rendering. `/api/nav` reads the manifest, icons and language availability without compiling document bodies or loading resource collections. The Node workspace allows concurrent reads between writes; Git reads remain ordered with each other, while mutations wait for earlier reads and writes. Browser storage retains its transaction lock because operations share one filesystem snapshot.

| Area | Required behavior |
| --- | --- |
| Page and pane navigation | Highlight the requested destination immediately. Share cancellation across clicks and browser history. Refresh a restored pane in the background, and never replace a newer selection with its response. Wait for short state changes without dropping the latest click. |
| Transport | Carry `AbortSignal` through workspace HTTP, scoped clients and protocol messages. Reject canceled calls immediately, skip canceled operations before execution, and keep an already started write atomic. |
| External changes | Apply only the latest document and navigation response. Retain the union of changed files until that update completes, so a later image change cannot hide an earlier document change. |
| Sidebar motion | Keep the inner layout width stable during the outer width transition. Suppress per-row geometry transitions while the sidebar moves, restore branch animations when it finishes, and honor reduced motion. |
| Drag and drop | Accept moves before, after or inside a page, and back to the root through the site header, final add row or empty tree area. Keep markers aligned with the actual destination, open a closed parent on hover, reject cycles and read-only sources, and capture the original workspace until the move finishes. Clear drag state on cancellation and defer tree reconciliation during a drag. |
| Focus and current page | Keep `aria-current` aligned with the visible selection. Restore the corresponding file row control after redraws. Move keyboard focus from an activated article link to the destination heading without taking focus from sidebar controls. |
| Tool refresh | Keep each Files pane bound to its workspace during language changes. Refresh Git and open search results on content events while preserving drafts, queries, selection and focus. |
| Themes and menus | Restore each preview pane's document theme after visiting tools. Escape closes the active language picker before its parent settings menu. |
| Expanded figures | Support zoom buttons, keyboard zoom and pan, middle-button pan, and touch pan and pinch. Release pointer state on button release, cancellation, lost capture, blur, hidden tabs and dialog close. |

Regression checks exercise delayed pane loads, repeated Back/Forward, reversed responses, overlapping content notifications, multiple Files panes, focused drafts during background updates, large trees, and mouse, keyboard and touch input. External websites continue to fill the central pane in a borderless iframe; sites that refuse framing retain the external-opening fallback.

## Use the workspace tools

| Task | Guide |
| --- | --- |
| Add, rename or move a page | [Organize content](contents/md/editor.md#organize-content) |
| Set the site title or define the page tree in source | [Manifest](contents/md/manifest.md) |
| Embed a file from the workspace | [File embeds](contents/md/embeds.md) |
| Open a record board and edit its schema | [Structured records](contents/md/subformats.md) |
| Save or restore a checkpoint | [History](contents/md/workspaces.md#history) |
| Connect a content service | [Plugins](contents/md/plugins.md) |

Return to [Screen layout](contents/md/ux-layout.md) for the whole screen, or continue to [Editor header](contents/md/ux-header.md) for the editing controls.
