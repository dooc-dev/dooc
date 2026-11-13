A page is a Markdown file. dooc accepts a fixed subset of Markdown and reports anything else as an error instead of dropping it.

A page has no front matter: a leading `---` block is an error. Its title and its position in the tree are set in [dooc.yaml](contents/md/manifest.md), and a translated page takes its language from its `locales/<language>/` path.

## Text

Paragraphs take **bold**, *emphasis*, `inline code`, and [links](contents/md/index.md).

> A quote keeps its own block, including **inline** formatting.

- Unordered item
- Item with a nested list
  - Nested item

1. Ordered item
2. Second item

| Column | Other column |
| ------ | ------------ |
| Cell   | `code` cell  |

## Links

| Target   | Syntax                                               | Result                                             |
| -------- | ---------------------------------------------------- | -------------------------------------------------- |
| Page     | `[Blocks](contents/md/blocks.md)`                    | [Blocks](contents/md/blocks.md)                    |
| Heading  | `[Text](contents/md/markdown.md#text)`               | [Text](contents/md/markdown.md#text)               |
| Figure   | `[the workflow](contents/svg/workflow.svg)`          | [the workflow](contents/svg/workflow.svg)          |
| Term     | `[workspace](contents/termth/workspace.termth)`      | [workspace](contents/termth/workspace.termth)      |
| Record   | `[an issue](contents/issue/write-cheat-sheet.issue)` | [an issue](contents/issue/write-cheat-sheet.issue) |
| External | `[example](https://example.org/)`                    | [example](https://example.org/)                    |

Local paths are relative to `dooc.yaml`, never to the current page. Query strings are not allowed on local paths.

## Code fences

Any fence label is valid. Known languages are highlighted; unknown labels render as plain text.

```typescript
const formats = ["Markdown", "HTML", "SVG"];
```

```diff
- old line
+ new line
```

The labels `callouth`, `graphth`, `schemath`, `termth`, `mermaid`, `csv`, and `tsv` render as [blocks](contents/md/blocks.md) and must sit at the top level of the page.

## Not accepted

| Input                             | Use instead                                  |
| --------------------------------- | -------------------------------------------- |
| Raw HTML                          | Embed an `.html` file, or escape `<` as `\<` |
| An image inside a sentence        | Put `![](file)` in its own paragraph         |
| Code or tables inside a list item | Move them out of the list                    |
| `::directive` lines               | A file link or a block code fence            |
| `doc:` links                      | A Markdown file link                         |
| Strikethrough, footnotes, rules   | Not supported                                |
