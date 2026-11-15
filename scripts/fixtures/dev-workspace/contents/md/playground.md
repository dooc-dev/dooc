# Edit this page

Change this paragraph and watch the preview. Try **bold**, *emphasis*, `inline code`, and a [link to the forms](contents/md/form-controls.md). Follow [a heading](contents/md/playground.md#format-and-validate), [a figure](contents/svg/workflow.svg), and the [workspace term](contents/termth/workspace.termth).

> Use split view to compare themes or branches while editing the same source.

- [ ] Edit and save a paragraph
- [ ] Copy a section link and find the section with search
- [ ] Fold this list and undo an edit
- [x] Open the generated workspace

1. Select a preview pane.
2. Edit its source, then use Ctrl+S.
3. Inspect the Git markers and try Ctrl+Z.

| Control | First value | Second value |
| --- | --- | --- |
| Theme | Light | Dark |
| Layout | One pane | Split panes |
| Record view | Cards | List |

## Format and validate

The workspace includes a JSON formatter and linter under `.dooc/editor-tools/`. Press **Shift+Alt+F** to format the following JSON. The sample linter warns while `debug` is true; change it to false and validate again. Temporarily remove a closing brace to inspect an error, then undo.

```json
{"title":"Formatting playground","debug":true,"items":["tables","forms","previews"]}
```

```typescript
const summarize = (names: string[]) => names.map((name) => name.toUpperCase());
console.log(summarize(["write", "preview", "review"]));
```

```diff
- Preview one branch
+ Compare two branches in split view
```

## Custom highlighting

The `taskplan` fence uses a project grammar in `.dooc/code-languages/taskplan.json`. Pick `udev-gothic-regular.woff2` in **Editor font** or **Viewer font** to try a project font. The [font license](.dooc/fonts/LICENSE.txt) ships with this workspace.

```taskplan
task "Review the demo"
owner "Alice"
status doing
```

## Shared content

Edit the embedded source file and inspect its other uses in Library.

![](contents/ts/preview.ts)

![](contents/js/filter.js#L2-L5)

![Header-aware table](contents/tsv/inventory.tsv#H)

![Theme-aware figure](contents/svg/workflow.svg)

![Reusable Markdown fragment](contents/md/fragment.md)
