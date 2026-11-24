# Manifest editor

## Design

The editor's workspace tools card starts with **dooc.yaml**, above Files and Library. It opens `/_manifest` in the existing resource pane. A named manifest is edited in place; the tool never creates a second `dooc.yaml`.

Workspaces without a Markdown page open the same settings editor as a standalone tool. Its runtime is loaded only on that tool page, and protects unsaved changes through the existing hot-reload bridge and browser navigation guard.

This is an Operate surface inside the current editor. Reuse the resource toolbar, compact outlined fields with the existing border-overlapping labels, disclosure controls, CodeMirror, and theme tokens. Keep the existing sidebar, pane switching, and keyboard behavior. On narrow panes, fields stack and paths can shrink without horizontal page scrolling.

**Settings** mirrors the YAML hierarchy. Labels show the actual keys instead of explanatory headings or descriptions. Native collapsible groups expose `document` and `system`; nesting and indentation connect `document.icon`, `system.library.files`, `system.files.default_layout`, and `system.skills` to their owners. The `icon` group contains `light` and `dark` paths with completion, directly under `document`. A scalar icon supplies both fields until a theme path is edited. Older `document.sidebar.icon` values appear in the same controls and move to `document.icon` on save. `document`, `system`, and Library paths start expanded; secondary branches start collapsed. Group disclosure remains independent and survives switching between Settings and YAML without changing the draft.

Scalar labels interrupt the top border of their input, using the same label treatment as the editor's existing controls. Path arrays use a matching outlined group labeled with the array key, one path per row, and compact add/remove icon buttons with accessible names. Completion uses the workspace's existing file completion operation; suggestions follow the typed directory and stay relative to the selected manifest. An empty list keeps the current automatic discovery behavior. `default_subformat_folder` and the existing `json_subformats` manager link stay at the root level.

Path completion uses an anchored popover with the existing picker colors and option styling. Its width follows the input, its height is capped at 240 px and the available viewport space, and long lists scroll inside the menu. It opens below the input when there is room and above it near the bottom edge. Long paths stay on one line with ellipsis and a full-path tooltip. The input keeps keyboard focus: arrows move through candidates, Enter accepts, Escape closes, and Tab continues through the form. Selecting a directory continues completion inside it. Blur, outside clicks, pane scrolling, tab changes, and disposal dismiss the menu; late responses cannot reopen it. Resizing repositions it against the input. All manifest path fields share this behavior.

**YAML** edits the whole manifest for document hierarchy, localized sidebar titles, version configuration, and all other supported settings. Switching views keeps the same draft. Form changes update the YAML document rather than reconstructing it, preserving comments and fields not represented in the form. Invalid YAML remains editable in the source view and cannot overwrite the saved manifest.

Save and Reload are explicit. Show pending, saving, saved, loading, validation failure, and conflict states next to the actions. Reload asks before discarding a draft. Navigation and closing a pane protect unsaved edits. Requests retain the owning workspace even when another pane becomes active. Saving compares the original file contents and refuses an external conflict.

## Library source paths

```yaml
system:
  library:
    files:
      - contents/csv/prices.csv
      - contents/ts/example.ts
document:
  title: Handbook
```

`system.library.files` is an optional list of unique local text file paths. It adds explicit sources to Library without adding sidebar pages or changing automatic Markdown, term, and record discovery. Known extensions keep their Library rendering; other text files appear as code. Already indexed files are not duplicated. Paths are relative to the manifest, including included manifests. Absolute paths, parent traversal, ignored files, and files outside the workspace are unavailable. Missing or binary files produce Library errors.

Explicit sources are retained by manifest rewrites, updated when Files moves them, checked as dependencies, and included in source exports. This first version accepts file paths, not directory scans or glob expressions; automatic discovery already serves directory-wide collection.

## Verification

Cover manifest validation and serialization, included-manifest paths, Library indexing and deduplication, file moves, source exports, save validation and conflicts. Exercise the browser flow from the first tool item through disclosure, form edits, path addition/removal, completion, YAML switching, saving, reloading, and unsaved navigation. Confirm that disclosure preserves drafts and keyboard access. Check long completion lists at both viewport edges, mouse and keyboard selection, nested directories, dismissal, and late responses. Inspect desktop and narrow layouts in light and dark themes with the completion menu open.
