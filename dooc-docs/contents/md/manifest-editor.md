# Manifest editor

## Design

The editor's workspace tools card starts with **dooc.yaml**, above Files and Library. It opens `/_manifest` in the existing resource pane. A named manifest is edited in place; the tool never creates a second `dooc.yaml`.

Workspaces without a Markdown page open the same settings editor as a standalone tool. Its runtime is loaded only on that tool page, and protects unsaved changes through the existing hot-reload bridge and browser navigation guard.

This is an Operate surface inside the current editor. Reuse the resource toolbar, compact outlined fields with the existing border-overlapping labels, disclosure controls, CodeMirror, and theme tokens. Keep the existing sidebar, pane switching, and keyboard behavior. On narrow panes, fields stack and paths can shrink without horizontal page scrolling.

**Settings** mirrors the YAML hierarchy. Labels show the actual keys instead of explanatory headings or descriptions. Native collapsible groups expose `document` and `system`; nesting and indentation connect `document.icon`, `system.format.<extension>.files`, `system.files.default_layout`, and `system.skills` to their owners. The `icon` group contains `light` and `dark` paths with completion, directly under `document`. A scalar icon supplies both fields until a theme path is edited. Older `document.sidebar.icon` values appear in the same controls and move to `document.icon` on save. `document`, `system`, and Format paths start expanded; secondary branches start collapsed. Group disclosure remains independent and survives switching between Settings and YAML without changing the draft.

Scalar labels interrupt the top border of their input, using the same label treatment as the editor's existing controls. Path arrays use a matching outlined group labeled with the array key, one path per row, and compact add/remove icon buttons with accessible names. Completion uses the workspace's existing file completion operation; suggestions follow the typed directory and stay relative to the selected manifest. An empty list keeps the current automatic discovery behavior. `default_subformat_folder` and the existing `json_subformats` manager link stay at the root level.

Path completion uses an anchored popover with the existing picker colors and option styling. Its width follows the input, its height is capped at 240 px and the available viewport space, and long lists scroll inside the menu. It opens below the input when there is room and above it near the bottom edge. Long paths stay on one line with ellipsis and a full-path tooltip. The input keeps keyboard focus: arrows move through candidates, Enter accepts, Escape closes, and Tab continues through the form. Selecting a directory continues completion for file fields and accepts the directory for folder fields. Blur, outside clicks, pane scrolling, tab changes, and disposal dismiss the menu; late responses cannot reopen it. Resizing repositions it against the input. All manifest path fields share this behavior.

Opening dooc.yaml also opens that native file in the editor pane on the right. Settings and the native YAML editor share the existing text-file draft, including undo, validation, conflicts and workspace ownership. Form changes update the YAML document rather than reconstructing it, preserving comments and fields not represented in the form. YAML edits update the form; invalid YAML remains editable and cannot overwrite the saved manifest. A standalone workspace without a document editor retains Settings and YAML tabs backed by the same text-file controller.

Do not add manifest-specific Save, Reload or Saved text. Follow the editor's auto-save setting: when enabled, save after editing pauses; when disabled, keep the draft until the shared Save control or Ctrl/Cmd+S is used. This setting also governs other native text-file editors. Drafts survive changing tools and panes. External changes never overwrite a dirty draft; use the shared conflict dialog on save. Show actionable validation and save errors through the existing file controls. Requests retain the owning workspace even when another pane becomes active.

## Collection sources

Library contains references selected by `system.library`: `urls` and `url-previews`. Format contains files and fenced blocks, grouped by extension. Add an extension under `system.format` and edit its `codeblock`, `folders`, and `files` controls. Folder selection accepts a directory; file selection continues into directories. Both use the existing completion menu.

The implementation design below defines collection and migration behavior.

## Verification

Cover manifest validation and serialization, included-manifest paths, Library indexing and deduplication, file moves, source exports, save validation and conflicts. Exercise native YAML/form synchronization, undo, auto-save on and off, manual saving, edits during a save, conflict resolution, and drafts retained across tool navigation. Confirm that disclosure preserves drafts and keyboard access. Check long completion lists at both viewport edges, mouse and keyboard selection, nested directories, dismissal, and late responses. Inspect desktop and narrow layouts in light and dark themes with the completion menu open.

## Library and Format implementation design

This section records the approved design and implemented behavior for the collection split.

Library collects references, starting with `urls` and `url-previews`, including their source locations. Format collects content by file extension or code-fence format. A format's collection includes matching files and code blocks; code blocks are not a third collection tool.

```yaml
system:
  library:
    - urls
    - url-previews
  format:
    svg:
      codeblock: true
      folders:
        - contents/svg
    csv:
      folders:
        - contents/data
      files:
        - extras/prices.csv
    ts:
      codeblock: false
      folders:
        - src
```

Format keys omit the leading dot. File extensions select files, and known fence aliases select the corresponding format (`typescript` and `ts` fences belong to `ts`). Unlabelled code blocks belong to `text`. Discover formats already used in document content automatically; `system.format` adds per-format folder and file sources. Folder paths are relative to their owning manifest, recurse into descendants, and collect matching extensions. A folder with no matching files, including an absent folder, yields an empty collection so that fresh workspaces and source exports retain the same configuration. Apply workspace boundaries and Git ignore rules, deduplicate file sources by path, and retain distinct inline blocks and their locations.

Each format accepts `codeblock: boolean`, defaulting to `true`. Setting it to `false` excludes inline fenced blocks of that format from Format collections while retaining file sources and reference extraction. The setting applies to fence aliases too, does not change document rendering, and does not disable registered subformat records. Settings exposes the boolean alongside the format's `folders` and `files` controls.

The Library tool offers reference views. The Format tool offers every discovered or configured format, including image, PDF, video, table, diagram and code formats, using existing previewers and a file link for formats without a preview. Registered subformats reuse their schema, card and list views. The page-add menu uses the same discovered format list. Page sources become `document.library: urls` for a reference view and `document.format: svg` for a format collection.

Settings mirrors `system.library` and `system.format`. Each format has a collapsible group with outlined `folders` and `files` fields and the existing bounded path completion. Folder selection accepts a directory; file selection continues through directories to a file.

Migration must retain current manifests: map `system.library.files` into per-format file sources and content-format `document.library` pages into `document.format` pages. Preserve reference views, comments, page identities and links. Reject conflicting definitions rather than silently choosing one. The existing subformat schema registration remains the authority for structured records.

Implementation must cover manifest parsing and comment-preserving saves, included manifests, shared collection indexing, all preview types, page creation and routing, file moves, source exports, single and split HTML, reader updates and MCP compatibility. Regressions must cover folder boundaries, ignored files, overlapping sources, fence aliases, binary previews, unknown formats, legacy migration, source locations and existing Subformat views.
